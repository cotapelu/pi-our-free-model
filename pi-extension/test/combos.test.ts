/**
 * Unit checks for the fallback chains (combos).
 *
 * A combo is a *virtual catalog entry*: one selectable name whose links are
 * tried in order, the first one that answers wins. The properties this suite
 * pins are the ones that decide whether the failover is invisible to the user:
 *
 *   1. **capacities are the intersection, not the union** — a chain that
 *      advertises vision because its head supports it hands a fallback an image
 *      it cannot read;
 *   2. **a link that does not exist right now is dropped**, not kept as a
 *      hopeful placeholder;
 *   3. **a cycle is refused**, not walked until the stack dies;
 *   4. **`fallback` is stable, `round-robin` rotates and is sticky** for the
 *      configured number of turns.
 *
 * Runs on plain node:  node test/combos.test.ts
 */
import assert from 'node:assert/strict'
import {
  COMBO_CHANNEL, COMBO_PREFIX, COMBO_STRATEGIES, buildComboCatalog, comboChain, comboId,
  isComboEntry, normalizeCombos, pruneRotation, resetRotation,
} from '../dist/combos.js'

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

const row = (id: string, over: Record<string, any> = {}) => ({
  id, name: id, channel: 'free', vision: false, reasoning: true,
  contextWindow: 131072, maxOutput: 32768, canDisableThinking: true,
  lanes: ['free'], ...over,
})

// ── the id ───────────────────────────────────────────────────────────────────
check('a name becomes a stable, URL-safe id', () => {
  assert.equal(comboId('My Fast Chain'), 'combo:my-fast-chain')
  assert.equal(comboId('  Spaces  '), 'combo:spaces')
  assert.equal(comboId('a!@#$b'), 'combo:a-b')
  assert.equal(comboId(''), '')
  assert.equal(comboId(undefined), '')
})

check('a non-Latin name gets a stable digest suffix', () => {
  const id = comboId('快速链')
  assert.ok(id.startsWith(COMBO_PREFIX), 'the id lost its prefix')
  assert.ok(/^combo:[a-z0-9-]+$/.test(id), `the id is not URL-safe: ${id}`)
  // The same name maps to the same id across a reload.
  assert.equal(comboId('快速链'), id)
})

check('a very long name is truncated but stays unique', () => {
  const id = comboId('x'.repeat(200))
  assert.ok(id.startsWith(COMBO_PREFIX))
  // A long ASCII slug keeps exactly its first 48 characters.
  assert.equal(id, 'combo:' + 'x'.repeat(48))
})

// ── normalizeCombos ──────────────────────────────────────────────────────────
check('a stored combo is coerced, and an unknown strategy falls back', () => {
  const out = normalizeCombos([{
    id: 'combo:one', name: 'One', models: ['a-free', 'b-free', 'a-free'],
    strategy: 'bogus', stickyLimit: 0, enabled: false,
  }])
  assert.equal(out.length, 1)
  assert.equal(out[0].strategy, 'fallback')
  assert.deepEqual(out[0].models, ['a-free', 'b-free'])
  assert.equal(out[0].stickyLimit, 1)
  assert.equal(out[0].enabled, false)
})

check('a combo with no links is dropped — it is a model that cannot answer', () => {
  assert.deepEqual(normalizeCombos([{ id: 'combo:x', models: [] }]), [])
  assert.deepEqual(normalizeCombos([{ id: 'combo:x', models: ['', '  '] }]), [])
  assert.deepEqual(normalizeCombos([{ id: 'combo:x' }]), [])
})

check('a link naming the combo itself is dropped — that would be a self-loop', () => {
  // The self-reference is spelled with the full `combo:` id.
  const out = normalizeCombos([{ name: 'Loop', models: ['combo:loop', 'a-free'] }])
  assert.deepEqual(out[0].models, ['a-free'])
})

check('an id that is not a string is regenerated from the name', () => {
  const out = normalizeCombos([{ id: 42, name: 'Renamed', models: ['a'] }])
  assert.equal(out[0].id, 'combo:renamed')
})

check('duplicate ids are dropped, not merged', () => {
  const out = normalizeCombos([
    { id: 'combo:dup', models: ['a'] },
    { id: 'combo:dup', models: ['b'] },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].models, ['a'])
})

check('a non-array input yields an empty list, never a throw', () => {
  assert.deepEqual(normalizeCombos('nope' as any), [])
  assert.deepEqual(normalizeCombos(undefined), [])
  assert.deepEqual(normalizeCombos(null as any), [])
})

// ── buildComboCatalog ────────────────────────────────────────────────────────
check('capacities are the intersection, not the union', () => {
  const catalog = [
    row('a', { vision: true, contextWindow: 1048576, maxOutput: 131072 }),
    row('b', { vision: false, contextWindow: 131072, maxOutput: 32768 }),
  ]
  const [combo] = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a', 'b'] }]), catalog)
  assert.equal(combo.vision, false, 'vision leaked from one link to the chain')
  assert.equal(combo.contextWindow, 131072, 'the window is not the minimum')
  assert.equal(combo.maxOutput, 32768, 'the output ceiling is not the minimum')
})

check('a chain requires every link to honour a capability it advertises', () => {
  const catalog = [
    row('a', { canDisableThinking: true }),
    row('b', { canDisableThinking: false }),
  ]
  const [combo] = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a', 'b'] }]), catalog)
  assert.equal(combo.canDisableThinking, false)
})

check('reasoning is the union: one thinking link is enough', () => {
  const catalog = [row('a', { reasoning: false }), row('b', { reasoning: true })]
  const [combo] = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a', 'b'] }]), catalog)
  assert.equal(combo.reasoning, true)
})

check('a link that does not exist right now is dropped', () => {
  const catalog = [row('a')]
  const out = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a', 'ghost'] }]), catalog)
  assert.deepEqual(out[0].combo, ['a'], 'the dead link stayed in the chain')
})

check('a combo whose every link is gone disappears entirely', () => {
  assert.deepEqual(buildComboCatalog(normalizeCombos([{ name: 'C', models: ['ghost'] }]), [row('a')]), [])
})

check('a disabled combo contributes no row', () => {
  const catalog = [row('a')]
  const out = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a'], enabled: false }]), catalog)
  assert.deepEqual(out, [])
})

check('a two-combo cycle is refused, and an honest chain still builds', () => {
  const catalog = [row('a-free'), row('b-free')]
  const out = buildComboCatalog(normalizeCombos([
    { name: 'P', models: ['a-free', 'combo:q'] },
    { name: 'Q', models: ['b-free', 'combo:p'] },
  ]), catalog)
  assert.deepEqual(out, [], 'a cycle produced a row')
  // The same definitions with the back-edge removed build normally.
  const honest = buildComboCatalog(normalizeCombos([
    { name: 'P', models: ['a-free', 'combo:q'] },
    { name: 'Q', models: ['b-free'] },
  ]), catalog)
  assert.equal(honest.length, 2)
})

check('a nested chain keeps the nested combo by id, and flattens only on dispatch', () => {
  const catalog = [row('a-free'), row('b-free'), row('c-free')]
  const out = buildComboCatalog(normalizeCombos([
    { name: 'Inner', models: ['b-free', 'c-free'] },
    { name: 'Outer', models: ['a-free', 'combo:inner'] },
  ]), catalog)
  const outer = out.find(entry => entry.name === 'Outer')!
  // The built row references the nested combo, so a refresh of one link shows up.
  assert.deepEqual(outer.combo, ['a-free', 'combo:inner'])
  // The dispatch path flattens it into the real members, in order.
  assert.deepEqual(comboChain(outer, [...catalog, ...out]).map(r => r.id), ['a-free', 'b-free', 'c-free'])
  // Lanes are the union of every member's.
  assert.deepEqual(outer.lanes, ['free'])
})

check('the built row carries the combo channel and its strategy', () => {
  const [combo] = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a'], strategy: 'round-robin' }]), [row('a')])
  assert.equal(combo.channel, COMBO_CHANNEL)
  assert.equal(combo.strategy, 'round-robin')
  assert.equal(isComboEntry(combo), true)
  assert.equal(isComboEntry(row('a')), false)
})

// ── comboChain ───────────────────────────────────────────────────────────────
resetRotation()
check('fallback always starts at the head', () => {
  const catalog = [row('a'), row('b')]
  const [combo] = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a', 'b'], strategy: 'fallback' }]), catalog)
  assert.deepEqual(comboChain(combo, catalog).map(r => r.id), ['a', 'b'])
  assert.deepEqual(comboChain(combo, catalog).map(r => r.id), ['a', 'b'])
})

check('round-robin rotates the start and is sticky for stickyLimit turns', () => {
  const catalog = [row('a'), row('b'), row('c')]
  const [combo] = buildComboCatalog(normalizeCombos([
    { name: 'C', models: ['a', 'b', 'c'], strategy: 'round-robin', stickyLimit: 2 },
  ]), catalog)
  const first = comboChain(combo, catalog).map(r => r.id)
  // Turn 2 is still on the same link (sticky:2).
  const second = comboChain(combo, catalog).map(r => r.id)
  const third = comboChain(combo, catalog).map(r => r.id)
  assert.deepEqual(first, ['a', 'b', 'c'])
  assert.deepEqual(second, ['a', 'b', 'c'])
  assert.deepEqual(third, ['b', 'c', 'a'])
})

check('a peek does not consume a turn', () => {
  resetRotation()
  const catalog = [row('a'), row('b')]
  const [combo] = buildComboCatalog(normalizeCombos([
    { name: 'C', models: ['a', 'b'], strategy: 'round-robin' },
  ]), catalog)
  comboChain(combo, catalog, { peek: true })
  comboChain(combo, catalog, { peek: true })
  // The first real turn is still on the head.
  assert.deepEqual(comboChain(combo, catalog).map(r => r.id), ['a', 'b'])
})

check('a single-member chain is returned as-is', () => {
  const catalog = [row('a')]
  const [combo] = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a'] }]), catalog)
  assert.deepEqual(comboChain(combo, catalog).map(r => r.id), ['a'])
})

check('a duplicate member appears once', () => {
  const catalog = [row('a'), row('b')]
  const entry = { id: 'combo:dup', combo: ['a', 'b', 'a'], channel: 'combo', strategy: 'fallback' }
  assert.deepEqual(comboChain(entry, catalog).map(r => r.id), ['a', 'b'])
})

check('a nested chain is flattened and de-duplicated', () => {
  const catalog = [row('a'), row('b'), row('c')]
  const inner = { id: 'combo:inner', combo: ['b', 'c'], channel: 'combo', strategy: 'fallback' }
  const outer = { id: 'combo:outer', combo: ['a', 'combo:inner', 'a'], channel: 'combo', strategy: 'fallback' }
  assert.deepEqual(comboChain(outer, [...catalog, inner]).map(r => r.id), ['a', 'b', 'c'])
})

check('a self-referencing chain returns nothing rather than looping', () => {
  const entry = { id: 'combo:self', combo: ['combo:self'], channel: 'combo', strategy: 'fallback' }
  assert.deepEqual(comboChain(entry, [entry]), [])
})

check('the smart strategies drop an exhausted link first', () => {
  const catalog = [row('a'), row('b')]
  const entry = { id: 'combo:smart', combo: ['a', 'b'], channel: 'combo', strategy: 'smart' }
  const quota = new Map<string, any>([
    ['a', { status: 'ok', checkedAt: new Date().toISOString(), windows: [{ kind: 'weekly', remainingPercent: 0, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] }],
    ['b', { status: 'ok', checkedAt: new Date().toISOString(), windows: [{ kind: 'weekly', remainingPercent: 80, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] }],
  ])
  // `a` is exhausted, so the chain hands the caller `b` first.
  assert.deepEqual(comboChain(entry, catalog, { quota }).map(r => r.id), ['b'])
})

check('a stale quota reading decides nothing', () => {
  const catalog = [row('a'), row('b')]
  const entry = { id: 'combo:smart', combo: ['a', 'b'], channel: 'combo', strategy: 'smart' }
  const quota = new Map<string, any>([
    ['a', { status: 'ok', checkedAt: new Date(Date.now() - 3600_000).toISOString(), windows: [{ kind: 'weekly', remainingPercent: 0 }] }],
  ])
  // The reading is an hour old, so it is not a verdict: order is untouched.
  assert.deepEqual(comboChain(entry, catalog, { quota }).map(r => r.id), ['a', 'b'])
})

check('pruneRotation drops cursors for combos that no longer exist', () => {
  resetRotation()
  const catalog = [row('a'), row('b')]
  const [combo] = buildComboCatalog(normalizeCombos([
    { name: 'C', models: ['a', 'b'], strategy: 'round-robin' },
  ]), catalog)
  comboChain(combo, catalog)
  pruneRotation([])
  // With the cursor gone the chain starts at the head again.
  assert.deepEqual(comboChain(combo, catalog).map(r => r.id), ['a', 'b'])
})

check('every strategy the settings page offers is understood', () => {
  for (const strategy of COMBO_STRATEGIES) {
    const catalog = [row('a'), row('b')]
    const [combo] = buildComboCatalog(normalizeCombos([{ name: 'C', models: ['a', 'b'], strategy }]), catalog)
    assert.equal(comboChain(combo, catalog).length, 2, `strategy ${strategy} produced nothing`)
  }
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 50)
