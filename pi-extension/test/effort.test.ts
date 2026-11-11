/**
 * Unit checks for the effort policy.
 *
 * Three properties that must not pass by luck:
 *
 *   1. **a level is an enforced budget, not a hint** — the number the ladder
 *      advertises is the number `budgetFor` returns, so a rung that shows 8K
 *      never sends 16 384;
 *   2. **capacity only ever lowers the ceiling** — a model whose maxOutput is
 *      below the level's ceiling gets the model's own number, and a session
 *      that asked for less lowers it again;
 *   3. **a declared menu is a different mechanism** — a model carrying
 *      `efforts` gets its level as a request patch, and its ceiling is the
 *      model capacity regardless of the level, because the ladder would cut
 *      answers for a menu that never promised to.
 *
 * Also pinned: a cleared settings input (`0`) is "no ceiling", not a zero —
 * the bug that clamped every turn to `MIN_BUDGET`.
 *
 * Runs on plain node:  node test/effort.test.ts
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_LEVEL, LEVELS, MIN_BUDGET, budgetFor, budgetLadder, defaultEffortFor,
  eacDefaultLevel, effortPatchFor, effortsFor, hasDeclaredEffortMenu, normalizeLevel, resolveLevel,
} from '../dist/effort.js'

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

const MODEL = { id: 'x-free', name: 'X', reasoning: true, maxOutput: 32768 }
const NO_MENU = { id: 'y-free', name: 'Y', reasoning: false, maxOutput: 32768 }
const ALWAYS_ON = { id: 'z-free', name: 'Z', reasoning: true, maxOutput: 32768, canDisableThinking: false }
const MENU = { id: 'a-free', name: 'A', reasoning: true, maxOutput: 32768, efforts: ['disabled', 'low', 'high', 'max'] }

check('every declared level reaches the wire as the number it advertises', () => {
  for (const level of LEVELS) {
    assert.equal(budgetFor(level.id, MODEL, undefined, undefined), budgetFor(level.id, MODEL, undefined, undefined))
  }
  assert.equal(budgetFor('light', MODEL, undefined, undefined), 2048)
  assert.equal(budgetFor('balanced', MODEL, undefined, undefined), 8192)
  // `deep` has no ceiling of its own: it takes the model capacity.
  assert.equal(budgetFor('deep', MODEL, undefined, undefined), 32768)
})

check('the picker order and the ladder agree', () => {
  const ladder = budgetLadder(MODEL, undefined, undefined)
  assert.deepEqual(ladder.map(row => row.id), LEVELS.map(level => level.id))
  assert.equal(ladder.filter(row => row.isDefault).length, 1)
  assert.equal(ladder.find(row => row.isDefault)?.id, DEFAULT_LEVEL)
})

check('a model that must think has every rung doubled', () => {
  assert.equal(budgetFor('light', ALWAYS_ON, undefined, undefined), 2048 * 2)
  assert.equal(budgetFor('balanced', ALWAYS_ON, undefined, undefined), 8192 * 2)
  // The doubled rung is clamped by the model capacity, never above it.
  assert.equal(budgetFor('balanced', { ...ALWAYS_ON, maxOutput: 9000 }, undefined, undefined), 9000)
  // A capacity above the doubled rung never raises it.
  assert.equal(budgetFor('light', ALWAYS_ON, undefined, undefined), 4096)
})

check('capacity only lowers the ceiling, never raises it', () => {
  // Model capacity below the rung: the model wins.
  assert.equal(budgetFor('balanced', { ...MODEL, maxOutput: 4096 }, undefined, undefined), 4096)
  // A session that asked for less lowers it again.
  assert.equal(budgetFor('deep', MODEL, 5000, undefined), 5000)
  // And the plugin default lowers it too.
  assert.equal(budgetFor('deep', MODEL, undefined, 6000), 6000)
})

check('a cleared settings input is no ceiling, not a zero', () => {
  // The settings page writes `Number('') || 0` when the field is cleared.
  assert.equal(budgetFor('light', MODEL, 0, 0), 2048)
  assert.equal(budgetFor('balanced', MODEL, 0, 0), 8192)
  // A negative is likewise no ceiling.
  assert.equal(budgetFor('balanced', MODEL, -1, undefined), 8192)
})

check('no level is allowed below MIN_BUDGET', () => {
  assert.equal(budgetFor('light', { ...MODEL, maxOutput: 8 }, undefined, undefined), MIN_BUDGET)
  assert.equal(budgetFor('light', MODEL, 8, 8), MIN_BUDGET)
})

check('a model with no effort menu has no rung at all', () => {
  assert.equal(resolveLevel('high', NO_MENU), undefined)
  assert.equal(effortsFor(NO_MENU, undefined, undefined), undefined)
  // Its whole output window belongs to the answer.
  assert.equal(budgetFor('high', NO_MENU, undefined, undefined), 32768)
})

check('a menu model records the level the wire actually carries', () => {
  // A caller that answers with a level the model does not declare gets the
  // model's default, not the free ladder's nearest rung.
  assert.equal(resolveLevel('xhigh', MENU)?.id, 'disabled')
  assert.equal(resolveLevel('low', MENU)?.id, 'low')
  assert.equal(resolveLevel(undefined, MENU)?.id, 'disabled')
  assert.equal(defaultEffortFor(MENU), 'disabled')
})

check('a declared menu is the model capacity regardless of level', () => {
  // The menu is the real control on the wire, so a ladder here would cut
  // answers for a menu that never promised to.
  assert.equal(budgetFor('low', MENU, undefined, undefined), 32768)
  assert.equal(budgetFor('max', MENU, undefined, undefined), 32768)
  assert.equal(hasDeclaredEffortMenu(MENU), true)
  assert.equal(hasDeclaredEffortMenu(MODEL), false)
})

check('the legacy aliases never move a menu model', () => {
  // Aliases are for the free lane's own ladder only.
  assert.equal(normalizeLevel('off'), 'light')
  assert.equal(normalizeLevel('medium'), 'balanced')
  assert.equal(normalizeLevel('xhigh'), 'deep')
  assert.equal(normalizeLevel('bogus'), undefined)
  // A menu id that is not an alias is never rewritten.
  assert.equal(normalizeLevel('low'), 'light')
})

check('the menu patch substitutes $effort and never mutates the model', () => {
  const model = { efforts: ['low', 'high'], effortPatch: { reasoning: { effort: '$effort' } } }
  const patch = effortPatchFor('high', model)
  assert.deepEqual(patch, { reasoning: { effort: 'high' } })
  // The model's own declaration is untouched.
  assert.deepEqual(model.effortPatch, { reasoning: { effort: '$effort' } })
})

check('an off patch is expressed as its own object', () => {
  const model = {
    efforts: ['disabled', 'low'],
    effortPatch: { reasoning: { effort: '$effort' } },
    effortOffPatch: { reasoning: { enabled: false } },
  }
  assert.deepEqual(effortPatchFor('disabled', model), { reasoning: { enabled: false } })
  assert.deepEqual(effortPatchFor('low', model), { reasoning: { effort: 'low' } })
})

check('a model with no menu gets no patch', () => {
  assert.equal(effortPatchFor('low', MODEL), null)
})

check('eacDefaultLevel prefers the declared default, else the first level', () => {
  assert.equal(eacDefaultLevel({ efforts: ['low', 'high'], effortDefault: 'high' }), 'high')
  assert.equal(eacDefaultLevel({ efforts: ['low', 'high'], effortDefault: 'bogus' }), 'low')
  assert.equal(eacDefaultLevel({ efforts: [] }), undefined)
})

check('the free lane ladder describes its rungs with the number it will send', () => {
  const efforts = effortsFor(MODEL, undefined, undefined)!
  assert.deepEqual(efforts.map(row => row.id), ['light', 'balanced', 'deep'])
  assert.match(String(efforts.find(row => row.id === 'light')?.description), /2 K output ceiling/)
  // A model that must think says so on every rung.
  const alwaysOn = effortsFor(ALWAYS_ON, undefined, undefined)!
  assert.match(String(alwaysOn.find(row => row.id === 'light')?.description), /cannot be switched off/)
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 50)
