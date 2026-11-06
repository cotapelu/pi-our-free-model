/**
 * Unit checks for availability probes.
 *
 * The contract that must not pass by luck: a verdict is read from the structured
 * code first, then the message, then the status, and a 5xx never reads as a
 * *named* refusal — because a proxy's "Service Unavailable" says nothing about
 * this model and reading it as one took a working model out of the picker until
 * the next round (issue #310).
 *
 * Usage: node pi-extension/test/probe.test.mjs
 */
import assert from 'node:assert/strict'
import { aggregate, CACHED_DURATION_MS, createProber, prefer, publicAvailability, stateOf, STATE } from '../dist/gateway/probe.js'

let failures = 0
const checks = []
function check(label, fn) {
  checks.push({ label, fn })
}

check('a structured region code maps to a region-blocked verdict', () => {
  assert.equal(stateOf({ code: 'region_blocked', message: 'nope', status: 403 }), STATE.regionBlocked)
})

check('a structured quota code maps to a throttled verdict', () => {
  assert.equal(stateOf({ code: 'quota_exhausted', message: '429' }), STATE.throttled)
})

check('a client-gate lock maps to unavailable', () => {
  assert.equal(stateOf({ code: 'lane_locked' }), STATE.unavailable)
})

check('an unnamed model-not-routed message maps to unavailable', () => {
  assert.equal(stateOf({ message: 'this model is unavailable in your region' }), STATE.unavailable)
  assert.equal(stateOf({ message: 'no such model' }), STATE.unavailable)
  assert.equal(stateOf({ message: 'unknown model bug' }), STATE.unavailable)
  assert.equal(stateOf({ message: 'unsupported modality' }), STATE.unavailable)
})

check('a routing status maps to unavailable', () => {
  for (const status of [400, 404, 422]) {
    assert.equal(stateOf({ status, message: 'plain refusal' }), STATE.unavailable, `status ${status}`)
  }
})

check('a 503 does NOT read as a named refusal — it says the proxy is unwell', () => {
  assert.equal(stateOf({ status: 503, message: 'Service Unavailable' }), STATE.unknown)
})

check('a 500 reads as no measurement rather than a dropped model', () => {
  assert.equal(stateOf({ status: 500, message: 'internal server error' }), STATE.unknown)
})

check('an explicit unavailable flag short-circuits the message', () => {
  assert.equal(stateOf({ unavailable: true, status: 503 }), STATE.unavailable)
})

check('anything unclassifiable is a no-measurement verdict', () => {
  assert.equal(stateOf({ code: 'weird_new_code', message: 'something', status: 502 }), STATE.unknown)
})

check('an aggregate reports the ratio of successful probes to total', () => {
  const result = aggregate([STATE.available, STATE.available, STATE.regionBlocked])
  assert.equal(result.ok, 2)
  assert.equal(result.region, 1)
  assert.equal(result.unavailableRatio, 2 / 3)
})

check('a scoped refusal does not generalise over the whole origin', () => {
  const withQuota = aggregate([STATE.throttled, STATE.throttled, STATE.available])
  assert.equal(withQuota.quota, 2)
  assert.equal(withQuota.unavailableRatio, 1 / 3)
})

check('an origin that answered once and failed twice is not available', () => {
  const result = aggregate([STATE.available, STATE.unavailable, STATE.unavailable])
  assert.equal(result.ok, 1)
  assert.equal(result.unavailable, 2)
  assert.equal(result.unavailableRatio, 1 / 3)
})

check('prefer keeps a real verdict over an older no-measurement entry', () => {
  assert.equal(prefer(STATE.unknown, STATE.available), STATE.available)
  assert.equal(prefer(STATE.unknown, STATE.throttled), STATE.throttled)
})

check('prefer lets no evidence overwrite a real verdict', () => {
  assert.equal(prefer(STATE.available, STATE.unknown), STATE.available)
})

check('prefer lets the newer reading win between two failure verdicts', () => {
  assert.equal(prefer(STATE.unavailable, STATE.throttled), STATE.throttled)
})

check('a never-probed model has no entry', () => {
  const prober = createProber({ doProbe: async () => ({ ok: false }) })
  assert.equal(prober.entry('ofm-kilo/a'), undefined)
})

check('a healthy verdict is not re-probed while it is cached', async () => {
  let probes = 0
  const prober = createProber({ doProbe: async () => { probes += 1; return { ok: true } }, timeoutMs: 1000 })
  const first = await prober.probe('ofm-kilo/a')
  assert.equal(first.verdict, STATE.available)
  const second = await prober.probe('ofm-kilo/a')
  assert.equal(second.verdict, STATE.available)
  assert.equal(probes, 1, 'a cached healthy model is not re-probed')
})

check('a refused model is re-probed sooner than a healthy one', async () => {
  let probes = 0
  const prober = createProber({ doProbe: async () => { probes += 1; return { ok: false, error: { code: 'quota_exhausted' } } } })
  const first = await prober.probe('ofm-kilo/b', { force: true })
  assert.equal(first.verdict, STATE.throttled)
  // A throttled entry ages out inside a third of the healthy cache duration.
  const second = await prober.probe('ofm-kilo/b', { force: true })
  assert.equal(second.verdict, STATE.throttled)
  assert.equal(probes, 2)
})

check('a changed verdict is reported, a repeated one is not', async () => {
  const changes: string[] = []
  let ok = false
  const prober = createProber({
    doProbe: async () => ({ ok, error: ok ? undefined : { code: 'region_blocked' } }),
    changed: (model, verdict) => changes.push(`${model}:${verdict}`),
  })
  await prober.probe('ofm-kilo/c', { force: true })
  await prober.probe('ofm-kilo/c', { force: true })
  assert.equal(changes.length, 0, 'the first verdict is not a change')
  ok = true
  await prober.probe('ofm-kilo/c', { force: true })
  await prober.probe('ofm-kilo/c', { force: true })
  assert.deepEqual(changes, ['ofm-kilo/c:' + STATE.available])
})

check('each model gets its own probe session', async () => {
  const sessions: string[] = []
  const prober = createProber({
    doProbe: async (row: { session: string }) => { sessions.push(row.session); return { ok: true } },
  })
  await prober.probe('ofm-kilo/one', { force: true })
  await prober.probe('ofm-kilo/two', { force: true })
  assert.equal(sessions.length, 2)
  assert.notEqual(sessions[0], sessions[1])
})

check('the persisted row is handed to the caller for saving', async () => {
  const saved: any[] = []
  const prober = createProber({ doProbe: async () => ({ ok: false, error: { status: 503 } }), persist: (row) => saved.push(row) })
  const row = await prober.probe('ofm-kilo/d', { force: true })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].verdict, row.verdict)
})

check('the public row separates the no-measurement verdict from advancing the walker', () => {
  const row = publicAvailability({ verdict: STATE.unknown, at: Date.now(), model: 'x', session: 's', status: 503, message: 'Service Unavailable' })
  assert.equal(row.verdict, STATE.unknown, 'the picker shows no measurement')
  assert.equal(row.actionable, true, 'the walker still advances past an overloaded lane')
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
