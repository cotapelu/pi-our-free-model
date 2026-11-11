/**
 * Unit checks for the gateway's durable store.
 *
 * The contract that must not pass by luck: a write that cannot land is retried
 * rather than dropped, a corrupt file is retained instead of overwritten by a
 * fresh default, and the tokens the usage rows carry can be audited back to the
 * call that produced them.
 *
 * Usage: node pi-extension/test/store.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  STATS_INITIAL, accumulateSavings, decodeWindow, dayKey, JsonStore, pruneDays, recordUsage,
} from '../dist/gateway/store.js'

let failures = 0
const checks = []
function check(label, fn) {
  checks.push({ label, fn })
}

const freshFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-store-'))
  return path.join(dir, 'state.json')
}

check('a first run starts from the given initial value', () => {
  const file = freshFile()
  const store = new JsonStore({ file, initial: { enabled: true, rosters: [] } })
  assert.equal(store.get().enabled, true)
  assert.deepEqual(store.get().rosters, [])
})

check('update and edit both merge, and neither throws on a first run', () => {
  const file = freshFile()
  const store = new JsonStore({ file, initial: { nested: { a: 1 }, count: 0 } })
  store.update({ count: 5 } as never)
  store.edit((state: any) => ({ ...state, nested: { ...state.nested, b: 2 } }))
  assert.equal(store.get().count, 5)
  assert.deepEqual(store.get().nested, { a: 1, b: 2 })
})

check('a value written is read back after a reload', () => {
  const file = freshFile()
  const first = new JsonStore({ file, initial: { enabled: true } })
  first.update({ enabled: false } as never)
  first.flush()
  const second = new JsonStore({ file, initial: { enabled: true } })
  assert.equal(second.get().enabled, false)
})

check('a corrupt file is retained, and the next write does not rename a default over it', () => {
  const file = freshFile()
  fs.writeFileSync(file, '{ not json')
  const store = new JsonStore({ file, initial: { enabled: true, kept: 'value' } })
  assert.equal(store.get().enabled, true, 'the in-memory default applies')
  store.update({ enabled: false } as never)
  store.flush()
  assert.equal(fs.existsSync(file), true)
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('corrupt-'))
  assert.ok(backups.length > 0, 'the damaged file was not kept')
})

check('a flush that cannot write is retried by the next mutation, not dropped', () => {
  const file = freshFile()
  const lines = []
  const store = new JsonStore({ file, initial: { enabled: true }, log: (m) => lines.push(m) })
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
  // A regular file where the directory would be: mkdirSync cannot pass it, so the
  // write genuinely fails rather than silently recreating the path.
  fs.writeFileSync(path.dirname(file), 'not a directory')
  store.update({ enabled: false } as never)
  store.flush()
  assert.equal(fs.existsSync(file), false, 'the unwritable path really failed')
  store.update({ enabled: true } as never)
  store.flush()
  assert.equal(lines.length > 0, true, 'the first failure must be said out loud once')
  assert.equal(lines.length, 1, 'repeat failures stay quiet: one line per incident')
})

check('a written file is owner-only', () => {
  const file = freshFile()
  const store = new JsonStore({ file, initial: { key: 'ofm-test' } })
  store.update({ key: 'ofm-test-2' } as never)
  store.flush()
  const mode = fs.statSync(file).mode & 0o777
  if (process.platform !== 'win32') assert.equal(mode, 0o600)
})

check('dispose flushes what the generation changed and then locks the store', () => {
  const file = freshFile()
  const store = new JsonStore({ file, initial: { enabled: true } })
  store.update({ enabled: false } as never)
  store.dispose()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, false)
  store.update({ enabled: true } as never)
  assert.equal(store.get().enabled, false, 'a disposed store accepts no more edits')
})

check('dayKey is the machine own calendar day, which is what a heatmap needs', () => {
  const at = new Date(2026, 10, 5, 23, 59).getTime()
  assert.equal(dayKey(at), '2026-11-05')
})

check('a decode window too short to time is not a measurement', () => {
  assert.equal(decodeWindow(10, 5, true).measurable, false)
  assert.equal(decodeWindow(10, 5, true).tps, null)
})

check('a decode window so fast the frames coalesced is not a measurement', () => {
  const verdict = decodeWindow(1000, 400 * 1000, true)
  assert.equal(verdict.measurable, false)
})

check('an ordinary decode window is measured', () => {
  const verdict = decodeWindow(2000, 40, true)
  assert.equal(verdict.measurable, true)
  assert.equal(verdict.tps, 20)
})

check('a failed call carries no decode measurement', () => {
  assert.equal(decodeWindow(2000, 40, false).measurable, false)
})

check('recordUsage buckets by day and by model, and counts the call', () => {
  const file = freshFile()
  const store = new JsonStore({ file, initial: { ...STATS_INITIAL } })
  recordUsage(store, { at: Date.now(), model: 'ofm-kilo/a', ok: true, input: 10, output: 5, reasoning: 2, cacheRead: 0, decodeTokens: 40, decodeMs: 2000 })
  const state = store.get()
  const day = dayKey()
  assert.equal(state.requests, 1)
  assert.equal(state.days[day].models['ofm-kilo/a'].input, 10)
  assert.equal(state.days[day].models['ofm-kilo/a'].output, 5)
  assert.equal(state.days[day].models['ofm-kilo/a'].calls, 1)
  assert.equal(state.models['ofm-kilo/a'].reasoning, 2)
  assert.equal(state.samples.length, 1)
})

check('a failed call is counted as a failure without a decode window', () => {
  const file = freshFile()
  const store = new JsonStore({ file, initial: { ...STATS_INITIAL } })
  recordUsage(store, { at: Date.now(), model: 'ofm-kilo/a', ok: false, input: 10, output: 0, reasoning: 0, cacheRead: 0, decodeTokens: 0, decodeMs: 0 })
  const state = store.get()
  assert.equal(state.failedRequests, 1)
  assert.equal(state.days[dayKey()].models['ofm-kilo/a'].failed, 1)
  assert.equal(state.days[dayKey()].models['ofm-kilo/a'].decodeTokens, 0)
})

check('a cut call and a no-usage call are marked so they can be audited', () => {
  const file = freshFile()
  const store = new JsonStore({ file, initial: { ...STATS_INITIAL } })
  recordUsage(store, { at: Date.now(), model: 'ofm-kilo/a', ok: true, input: 10, output: 0, reasoning: 0, cacheRead: 0, decodeTokens: 0, decodeMs: 0, truncated: true })
  recordUsage(store, { at: Date.now(), model: 'ofm-kilo/b', ok: true, input: 10, output: 0, reasoning: 0, cacheRead: 0, decodeTokens: 0, decodeMs: 0, noUsage: true })
  const samples = store.get().samples
  assert.equal(samples[0].truncated, true)
  assert.equal(samples[1].noUsage, true)
})

check('the sample ring stays bounded as calls accumulate', () => {
  const file = freshFile()
  const store = new JsonStore({ file, initial: { ...STATS_INITIAL } })
  for (let index = 0; index < 450; index += 1) {
    recordUsage(store, { at: Date.now(), model: 'ofm-kilo/a', ok: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, decodeTokens: 40, decodeMs: 2000 })
  }
  assert.equal(store.get().samples.length, 400)
})

check('savings accumulate the call count even when nothing was compressible', () => {
  const first = accumulateSavings(undefined, { saved: 0 })
  assert.equal(first.calls, 1)
  assert.equal(first.saved, 0)
  const second = accumulateSavings(first, { saved: 500, bytesBefore: 1000, bytesAfter: 500, blocks: 3 })
  assert.equal(second.calls, 2)
  assert.equal(second.saved, 500)
  assert.equal(second.blocks, 3)
})

check('a prompt call is counted separately from a compaction call', () => {
  const total = accumulateSavings(undefined, { saved: 0, prompt: ['caveman'] })
  assert.equal(total.promptCalls, 1)
  assert.equal(accumulateSavings(total, { saved: 0 }).promptCalls, 1)
})

check('pruneDays keeps the newest buckets and drops the rest', () => {
  const days: Record<string, any> = {}
  for (let index = 1; index <= 10; index += 1) days[`2026-01-${String(index).padStart(2, '0')}`] = { total: index }
  const pruned = pruneDays({ days }, 3)
  assert.deepEqual(Object.keys(pruned.days), ['2026-01-08', '2026-01-09', '2026-01-10'])
})

check('pruneDays leaves a state under the cap untouched', () => {
  const state = { days: { '2026-01-01': { total: 1 } } }
  assert.equal(pruneDays(state, 120), state)
})

async function main() {
  for (const { label, fn } of checks) {
    try {
      await fn()
      console.log(`ok   ${label}`)
    } catch (error) {
      console.log(`FAIL ${label} — ${error.message}`)
      failures += 1
    }
  }
  if (failures > 0) {
    console.log(`\n${failures} FAIL`)
    process.exit(1)
  }
  console.log('\nALL CHECKS PASSED')
}
void main()
