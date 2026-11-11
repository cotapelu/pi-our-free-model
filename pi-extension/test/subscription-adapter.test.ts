/**
 * Unit checks for the subscription → catalog projection.
 *
 * A subscription runtime is *injected* by the host: the plugin never opens an
 * account channel itself. `subscriptionCatalog` is the one place its rows are
 * turned into catalog entries the picker and the router already understand, so
 * the properties that matter are the ones that keep private data out of the
 * shared catalog:
 *
 *   1. **only `subscription:` rows are projected** — a runtime whose catalog
 *      carries something else (a bare provider id, an aggregate row) must not
 *      have it adopted as a subscription entry;
 *   2. **a row's own wire is honoured, with a provider default when it names
 *      none** — `codex` answers on `responses`, `claude` on `messages`;
 *   3. **capacities that are not positive numbers fall back**, because a
 *      runtime reporting 0 or a string is a bug, not a model with no window.
 *
 * Runs on plain node:  node test/subscription-adapter.test.ts
 */
import assert from 'node:assert/strict'
import { isSubscriptionEntry, subscriptionCatalog } from '../dist/subscription-adapter.js'

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

/** A minimal runtime: a catalog() and a complete(). */
function runtime(catalog: any[]) {
  return { catalog: () => catalog, complete: async () => ({}) }
}

const row = (over: Record<string, any> = {}) => ({
  id: 'subscription:codex-main/gpt-5', name: 'GPT-5', subscriptionId: 'codex-main',
  subscriptionProvider: 'codex', ...over,
})

check('a runtime with no catalog or no complete projects nothing', () => {
  assert.deepEqual(subscriptionCatalog({ catalog: () => [] }), [])
  assert.deepEqual(subscriptionCatalog({ complete: async () => ({}) }), [])
  assert.deepEqual(subscriptionCatalog({}), [])
  assert.deepEqual(subscriptionCatalog(null), [])
  assert.deepEqual(subscriptionCatalog(undefined), [])
})

check('only subscription-prefixed ids are projected', () => {
  const out = subscriptionCatalog(runtime([
    row(),
    { id: 'aggregate/openai/gpt-5', name: 'other' },
    { id: 'plain-free-model', name: 'free' },
    { id: 42, name: 'nonsense' },
    { id: 'subscription:', name: 'empty suffix' },
  ]))
  assert.equal(out.length, 2, `expected 2 rows, got ${out.length}`)
  assert.ok(out.every(entry => entry.id.startsWith('subscription:')))
})

check('a projected row keeps only the fields the catalog contract carries', () => {
  const [entry] = subscriptionCatalog(runtime([row()]))
  // The wire ids and credentials stay behind the runtime.
  assert.deepEqual(Object.keys(entry).sort(), [
    'channel', 'contextWindow', 'id', 'maxOutput', 'name', 'reasoning',
    'subscriptionId', 'subscriptionProvider', 'vision', 'wire',
  ])
  assert.equal(entry.channel, 'subscription')
  assert.equal(isSubscriptionEntry(entry), true)
  assert.equal(isSubscriptionEntry({ id: 'x', channel: 'free' }), false)
  // The channel tag alone identifies the row: a consumer routing on it never
  // needs the runtime in hand to know what it is looking at.
  assert.equal(isSubscriptionEntry({ id: 'x', channel: 'subscription' }), true)
})

check("a row's own wire wins; the provider default fills in only when absent", () => {
  const out = subscriptionCatalog(runtime([
    row(),                                                  // names no wire → codex default
    row({ id: 'subscription:a/m', subscriptionProvider: 'claude' }),   // → messages
    row({ id: 'subscription:b/m', subscriptionProvider: 'gemini', wire: 'chat' }),
  ]))
  assert.equal(out[0].wire, 'responses')
  assert.equal(out[1].wire, 'messages')
  assert.equal(out[2].wire, 'chat')
})

check('every wire spelling the registry can name resolves onto one vocabulary', () => {
  const out = subscriptionCatalog(runtime([
    'chat', 'responses', 'messages',
    'openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-code-assist',
  ].map((wire, index) => row({ id: `subscription:w${index}/m`, wire }))))
  const wires = out.map(entry => entry.wire)
  assert.deepEqual(wires, ['chat', 'responses', 'messages', 'chat', 'responses', 'messages', 'chat'])
})

check('an unknown provider with no wire falls back to chat', () => {
  const [entry] = subscriptionCatalog(runtime([row({ subscriptionProvider: 'something-new' })]))
  assert.equal(entry.wire, 'chat')
})

check('a missing or invalid capacity falls back, never reaches the wire', () => {
  const out = subscriptionCatalog(runtime([
    row({ id: 'subscription:a/m', contextWindow: undefined, maxOutput: undefined }),
    row({ id: 'subscription:b/m', contextWindow: 0, maxOutput: 0 }),
    row({ id: 'subscription:c/m', contextWindow: 200000, maxOutput: 8192 }),
    row({ id: 'subscription:d/m', contextWindow: -5, maxOutput: 'big' }),
  ]))
  assert.equal(out[0].contextWindow, 131072)
  assert.equal(out[0].maxOutput, 8192)
  assert.equal(out[1].contextWindow, 131072)
  assert.equal(out[1].maxOutput, 8192)
  assert.equal(out[2].contextWindow, 200000, 'a real capacity was overwritten')
  assert.equal(out[2].maxOutput, 8192)
  assert.equal(out[3].contextWindow, 131072)
  assert.equal(out[3].maxOutput, 8192)
})

check('a non-integer capacity is not carried through as a fraction of a token', () => {
  const [entry] = subscriptionCatalog(runtime([row({ contextWindow: 131072.7 })]))
  assert.equal(entry.contextWindow, 131072)
})

check('vision and reasoning are only ever the boolean true', () => {
  const out = subscriptionCatalog(runtime([
    row({ id: 'subscription:a/m', vision: true, reasoning: true }),
    row({ id: 'subscription:b/m', vision: false, reasoning: false }),
    // Truthy-but-not-true is not a declaration: the runtime either says true or
    // it says nothing, and coercing `1`/`'yes'` would advertise a capability
    // nobody confirmed.
    row({ id: 'subscription:c/m', vision: 1 as any, reasoning: 'yes' as any }),
  ]))
  assert.equal(out[0].vision, true)
  assert.equal(out[0].reasoning, true)
  assert.equal(out[1].vision, false)
  assert.equal(out[1].reasoning, false)
  assert.equal(out[2].vision, false)
  assert.equal(out[2].reasoning, false)
})

check('an effort list is projected only when it carries valid levels', () => {
  const out = subscriptionCatalog(runtime([
    row({ id: 'subscription:a/m', efforts: ['low', 'high', 'low', 'bad level!', '', 7] }),
    row({ id: 'subscription:b/m', efforts: [] }),
    row({ id: 'subscription:c/m', efforts: 'low' as any }),
  ]))
  assert.deepEqual(out[0].efforts, ['low', 'high'])
  assert.equal(out[1].efforts, undefined, 'an empty list became an entry')
  assert.equal(out[2].efforts, undefined, 'a non-array list became an entry')
})

check('a level that is not a plain slug is dropped', () => {
  const [entry] = subscriptionCatalog(runtime([row({ efforts: ['ok-level', 'Bad Level', 'a'.repeat(40), 'x!'] })]))
  assert.deepEqual(entry.efforts, ['ok-level'])
})

check('a row with no name falls back to its id', () => {
  const [entry] = subscriptionCatalog(runtime([row({ name: '' })]))
  assert.equal(entry.name, entry.id)
  const [blank] = subscriptionCatalog(runtime([row({ name: undefined })]))
  assert.equal(blank.name, blank.id)
})

check('a non-object row is skipped, not crashed on', () => {
  const out = subscriptionCatalog(runtime([row(), null, 'a string', 42, undefined, [1]]))
  assert.equal(out.length, 1, 'a non-object row was projected')
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 50)
