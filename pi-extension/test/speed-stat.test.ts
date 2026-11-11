/**
 * Unit checks for the speed statistics — the numbers the dashboard shows.
 *
 * The rule that carries the weight is in the name: a *window* number is only
 * reported when it was measurable, and a model nobody timed shows no rate at
 * all (null), never zero. Zero is a claim about the model; null is the absence
 * of a measurement, and a dashboard that shows 0 tok/s for a working model says
 * the model is broken.
 *
 * The second rule is about what the speed window may and may not move: token
 * totals are lifetime accounting, and pruning the fast day window to keep the
 * store small must not take the lifetime totals with it.
 *
 * Runs on plain node:  node test/speed-stat.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodeWindow, pruneDays, recordTurn, recordUsage, JsonStore, STATS_INITIAL, migrateStats } from '../dist/gateway/store.js'
import { windowTokens } from '../dist/stream.js'
import { buildStats } from '../dist/core/stats.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 1000)
function check(name: string, fn: () => void | Promise<void>) {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error) { failures++; console.log(`FAIL ${name}\n     ${(error as Error)?.message ?? error}`) }
  })
}

/** The smallest thing recordUsage needs: a get/edit pair over a plain object. */
const store = (value: any) => ({
  value,
  get() { return this.value },
  edit(mutate: (value: any) => any) { this.value = mutate(structuredClone(this.value)); return this.value },
})

check('the decode window keeps reasoning in the numerator only while it streams', () => {
  assert.equal(windowTokens({ outputTokens: 422, reasoningTokens: 291 }, false), 131)
  assert.equal(windowTokens({ outputTokens: 135, reasoningTokens: 23 }, true), 135)
  assert.equal(windowTokens({ outputTokens: 50 }, false), 50)
  assert.equal(windowTokens(undefined, false), 0)
})

check('a window is only a measurement when it is one', () => {
  assert.deepEqual(decodeWindow(1209, 131, true), { measurable: true, decodeMs: 1209, tps: 108 })
  assert.deepEqual(decodeWindow(1, 3, true), { measurable: false, decodeMs: 0, tps: null })
  // 561 tok/s is coalesced SSE frames, not a fast model.
  assert.deepEqual(decodeWindow(358, 201, true), { measurable: false, decodeMs: 0, tps: null })
  assert.deepEqual(decodeWindow(0, 0, false), { measurable: false, decodeMs: 0, tps: null })
  assert.deepEqual(decodeWindow(4000, 0, true), { measurable: false, decodeMs: 0, tps: null })
})

check('the reported rate is token-weighted, not a mean of means', () => {
  const call = (over: Record<string, unknown>) => ({ at: 1, model: 'mimo-v2.6-flash-free', input: 100, output: 100, reasoning: 0, cacheRead: 0, effort: 'balanced', ...over })
  const stats = store(structuredClone(STATS_INITIAL))
  for (const record of [
    call({ ok: true, output: 146, decodeTokens: 146, ttftMs: 1649, decodeMs: 2704 }),
    call({ ok: true, output: 51, decodeTokens: 51, ttftMs: 4431, decodeMs: 1750 }),
    call({ ok: true, output: 63, decodeTokens: 3, ttftMs: 2977, decodeMs: 1 }),
    call({ ok: false, output: 0, decodeTokens: 0, ttftMs: 10732, decodeMs: 0 }),
  ]) recordUsage(stats as never, record as never)
  const row = Object.values(stats.get().days)[0] as any
  const model = row.models['mimo-v2.6-flash-free']
  // An unmeasurable window adds to neither sum, and the failed call is not a
  // first-frame sample.
  assert.deepEqual([model.decodeMs, model.decodeTokens], [4454, 197])
  assert.deepEqual([model.ttftMs, model.ttftSamples], [9057, 3])
  const named = buildStats(stats.get(), [{ id: 'mimo-v2.6-flash-free', name: 'Mimo' }]).models[0]
  assert.equal(named.tps, 44)
  assert.equal(Math.round((54 + 29 + 3000) / 3), 1028, 'the unweighted mean this report is not')
  assert.equal(named.avgTtftMs, 3019)
  assert.deepEqual([named.calls, named.failed], [4, 1])
  assert.equal(stats.get().failedRequests, 1)
})

check('a recovered turn keeps both accounting layers', () => {
  const call = (over: Record<string, unknown>) => ({ at: 1, model: 'mimo-v2.6-flash-free', input: 100, output: 100, reasoning: 0, cacheRead: 0, ...over })
  const stats = store(structuredClone(STATS_INITIAL))
  recordUsage(stats as never, call({ ok: false, recoveryId: 'turn-1', attempt: 0, recoveryScheduled: true, output: 0, decodeTokens: 0, decodeMs: 0 }) as never)
  recordUsage(stats as never, call({ ok: true, recoveryId: 'turn-1', attempt: 1, recoveryAttempt: true, recovered: true, output: 80, decodeTokens: 80, decodeMs: 1000 }) as never)
  recordTurn(stats as never, { at: 1, model: 'mimo-v2.6-flash-free', ok: true, recovered: true, attempts: 2 })
  const recovered = buildStats(stats.get(), [{ id: 'mimo-v2.6-flash-free', name: 'Mimo' }])
  assert.deepEqual([recovered.requests, recovered.requestFailures, recovered.turns, recovered.failedTurns, recovered.recoveredTurns], [2, 1, 1, 0, 1])
  // The logical row does not fall back to counting physical attempts.
  assert.deepEqual([recovered.models[0].calls, recovered.models[0].failed, recovered.models[0].turns, recovered.models[0].failedTurns, recovered.models[0].recoveredTurns], [2, 1, 1, 0, 1])
})

check('pruning the speed window keeps lifetime totals', () => {
  const call = (over: Record<string, unknown>) => ({ at: 1, model: 'mimo-v2.6-flash-free', input: 100, output: 10, ok: true, ...over })
  const stats = store(structuredClone(STATS_INITIAL))
  recordUsage(stats as never, call({ at: Date.UTC(2025, 0, 1) }) as never)
  recordTurn(stats as never, { at: Date.UTC(2025, 0, 1), model: 'mimo-v2.6-flash-free', ok: true })
  recordUsage(stats as never, call({ at: Date.UTC(2026, 0, 1), output: 5 }) as never)
  recordTurn(stats as never, { at: Date.UTC(2026, 0, 1), model: 'mimo-v2.6-flash-free', ok: true })
  stats.value = pruneDays(stats.get(), 1)
  const summary = buildStats(stats.get(), [{ id: 'mimo-v2.6-flash-free', name: 'Mimo' }])
  assert.deepEqual([summary.days.length, summary.requests, summary.turns, summary.models[0].calls, summary.models[0].output], [1, 2, 2, 2, 15])
})

check('a migration clears the poisoned speed totals but keeps the real ones', () => {
  const legacy = {
    version: 1,
    requests: 3,
    days: { '2026-09-24': { total: 500, models: { 'space-bunny-free': {
      input: 100, output: 65, reasoning: 0, cacheRead: 0, calls: 2, failed: 1,
      ttftMs: 13709, decodeMs: 2, decodeTokens: 65,
    } } } },
    models: {},
    samples: [
      { at: 1, model: 'space-bunny-free', ok: true, input: 100, output: 63, ttftMs: 2977, tps: 63000 },
      { at: 2, model: 'space-bunny-free', ok: false, input: 0, output: 0, ttftMs: 10732, tps: 0 },
    ],
  }
  const migrated = migrateStats(legacy)
  const row = migrated.days['2026-09-24'].models['space-bunny-free']
  assert.deepEqual([row.decodeMs, row.decodeTokens, row.ttftMs, row.ttftSamples], [0, 0, 0, 0], 'the poisoned totals survived')
  assert.deepEqual([migrated.samples[0].ttftMs, migrated.samples[0].tps, migrated.samples[0].decodeMs], [2977, null, 0])
  assert.deepEqual([migrated.samples[1].ttftMs, migrated.samples[1].tps], [null, null], 'a failure was promoted to a latency sample')
  assert.deepEqual([row.input, row.output, migrated.requests], [100, 65, 3])
  assert.deepEqual(migrateStats(migrated), migrated, 'migration is not idempotent')
})

check('the store survives a reload, and a damaged file is replaced by its backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-stats-'))
  try {
    const file = path.join(dir, 'stats.json')
    const first = new JsonStore({ file, initial: structuredClone(STATS_INITIAL) })
    recordUsage(first as never, { at: 1, model: 'm', ok: false, input: 0, output: 0, reasoning: 0, cacheRead: 0, decodeTokens: 0, decodeMs: 0 } as never)
    recordTurn(first as never, { at: 1, model: 'm', ok: false })
    first.flush()
    const reloaded = new JsonStore({ file, initial: structuredClone(STATS_INITIAL) })
    assert.deepEqual([reloaded.get().requests, reloaded.get().failedRequests, reloaded.get().logical.turns, reloaded.get().logical.failed], [1, 1, 1, 1])
    first.dispose(); reloaded.dispose()
    // A half-written file falls back to defaults, and the damaged bytes are kept
    // beside it rather than silently renamed over.
    const damaged = path.join(dir, 'settings.json')
    fs.writeFileSync(damaged, '{"forwardKey":"ofm-was-here","probeIntervalMinutes":')
    const store2 = new JsonStore({ file: damaged, initial: { forwardKey: '', probeIntervalMinutes: 15 } })
    assert.deepEqual([store2.get().forwardKey, store2.get().probeIntervalMinutes], ['', 15])
    store2.update({ forwardKey: 'ofm-new' })
    store2.flush()
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('settings.json.corrupt-')), 'the damaged bytes were dropped')
    store2.dispose()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

Promise.allSettled([running]).then(() => {
  clearInterval(keepAlive)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
  if (failures > 0) process.exitCode = 1
})
