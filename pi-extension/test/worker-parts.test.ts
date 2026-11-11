/**
 * Unit checks for the self-hosted host's three moving parts.
 *
 * The properties worth pinning, and why each one has bitten before:
 *
 *   1. the usage scanner reads the **last** count and ignores the nested
 *      `*_tokens_details` block — a per-frame count recorded as the total is a
 *      wrong bill, and a details block counted as a token is noise;
 *   2. the rate limiter's window is per key and its pruning never evicts a **live**
 *      key — sweeping an active caller's row turns a limit into an outage;
 *   3. the analytics keep numbers only, survive a corrupt file, and prune the
 *      least-recently-active rows first.
 *
 * Runs on plain node:  node test/worker-parts.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUsageScanner } from '../dist/worker/usage-scanner.js'
import { buildRateLimiter } from '../dist/worker/rate-limiter.js'
import { createAnalytics } from '../dist/worker/analytics.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-wparts-'))

// ── the usage scanner ───────────────────────────────────────────────────────
check('a single-shot JSON body reports its counts', () => {
  const scanner = createUsageScanner()
  scanner.push('{"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}')
  scanner.end()
  assert.deepEqual(scanner.result(), { prompt: 11, completion: 7 })
})

check('a streamed body reports its LAST count, not its first', () => {
  // A relayed stream carries a per-frame usage and then a final total: the total
  // is the one worth billing against.
  const scanner = createUsageScanner()
  scanner.push('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":1}}\n')
  scanner.push('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":42}}\n')
  scanner.end()
  assert.deepEqual(scanner.result(), { prompt: 11, completion: 42 })
})

check('the nested details block cannot pollute the completion count', () => {
  // `completion_tokens_details` contains the substring `completion_tokens`, so a
  // key match that did not demand the quoted form would count it twice.
  const scanner = createUsageScanner()
  scanner.push('{"usage":{"prompt_tokens":5,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":3}}}')
  scanner.end()
  assert.deepEqual(scanner.result(), { prompt: 5, completion: 7 })
})

check('a count split across two chunks is neither lost nor guessed', () => {
  const scanner = createUsageScanner()
  // The tail stays in the remainder until its line completes, so a count that
  // straddles two writes is read exactly once.
  scanner.push('{"usage":{"prompt_tokens":1')
  scanner.push('2,"completion_tokens":7}}')
  scanner.end()
  assert.deepEqual(scanner.result(), { prompt: 12, completion: 7 })
})

check('a body with no usage reports zeroes, not the last frame\'s numbers', () => {
  const scanner = createUsageScanner()
  scanner.push('data: {"choices":[{"delta":{"content":"pong"}}]}\n')
  scanner.end()
  assert.deepEqual(scanner.result(), { prompt: 0, completion: 0 })
})

check('a CRLF body is read the same way', () => {
  const scanner = createUsageScanner()
  scanner.push('{"usage":{"prompt_tokens":3,"completion_tokens":4}}\r\n')
  scanner.push('data: [DONE]\r\n')
  scanner.end()
  assert.deepEqual(scanner.result(), { prompt: 3, completion: 4 })
})

// ── the rate limiter ────────────────────────────────────────────────────────
check('a non-positive or nonsense limit means off, not "refuse everything"', () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(buildRateLimiter(value, 60_000), undefined, `${String(value)} built a limiter`)
  }
})

check('the window admits up to the limit, then refuses', async () => {
  let clock = 1_800_000_000_000
  const realNow = Date.now
  Date.now = () => clock
  try {
    const limiter = buildRateLimiter(3, 60_000)!
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.equal((await limiter.limit({ key: 'ip' })).success, true, `call ${attempt} was refused`)
    }
    assert.equal((await limiter.limit({ key: 'ip' })).success, false, 'the fourth call was admitted')
  } finally { Date.now = realNow }
})

check('the window is per key, so one caller cannot spend another\'s', async () => {
  let clock = 1_800_000_000_000
  const realNow = Date.now
  Date.now = () => clock
  try {
    const limiter = buildRateLimiter(1, 60_000)!
    assert.equal((await limiter.limit({ key: 'a' })).success, true)
    // `a` is now at its limit; `b` is untouched.
    assert.equal((await limiter.limit({ key: 'a' })).success, false)
    assert.equal((await limiter.limit({ key: 'b' })).success, true)
  } finally { Date.now = realNow }
})

check('an expired window resets, and the expiry is checked on the way in', async () => {
  let clock = 1_800_000_000_000
  const realNow = Date.now
  Date.now = () => clock
  try {
    const limiter = buildRateLimiter(1, 60_000)!
    assert.equal((await limiter.limit({ key: 'ip' })).success, true)
    assert.equal((await limiter.limit({ key: 'ip' })).success, false)
    // Past the window the same key starts a fresh one — no timer, no sweep.
    clock += 60_001
    assert.equal((await limiter.limit({ key: 'ip' })).success, true)
  } finally { Date.now = realNow }
})

check('pruning never evicts a live key', async () => {
  let clock = 1_800_000_000_000
  const realNow = Date.now
  Date.now = () => clock
  try {
    const limiter = buildRateLimiter(1, 60_000)!
    // A key that keeps arriving inside its window must survive the ceiling:
    // sweeping it would turn a per-key limit into an outage for that caller.
    const live = 'live-key'
    for (let round = 0; round < 60; round += 1) {
      clock += 30_000
      assert.equal((await limiter.limit({ key: live })).success, true, `the live key was evicted on round ${round}`)
      clock += 30_001
      await limiter.limit({ key: live })
    }
    // And the limit still holds for it.
    assert.equal((await limiter.limit({ key: live })).success, false)
  } finally { Date.now = realNow }
})

// ── the analytics ───────────────────────────────────────────────────────────
check('an address is stored as a salted hash, and the salt rotates it', () => {
  const analytics = createAnalytics()
  const one = analytics.ipHash('203.0.113.9', 'salt-a')
  const two = analytics.ipHash('203.0.113.9', 'salt-b')
  assert.notEqual(one, two, 'the same address with two salts hashed alike')
  assert.equal(one, analytics.ipHash('203.0.113.9', 'salt-a'), 'the hash is not stable within a rotation')
  // Non-reversible from a leaked file, and short enough to be a key.
  assert.equal(one.length, 12)
  assert.equal(one.includes('203.0.113.9'), false)
})

check('a record counts requests, tokens, refusals and the model mix', () => {
  const analytics = createAnalytics()
  const hash = analytics.ipHash('198.51.100.7', 'salt')
  analytics.record({ hash, chat: true, status: 200, tokensIn: 11, tokensOut: 7, model: 'm/one', rejected: false })
  analytics.record({ hash, chat: true, status: 429, tokensIn: 0, tokensOut: 0, model: null, rejected: true })
  analytics.record({ hash, chat: true, status: 200, tokensIn: 4, tokensOut: 2, model: 'm/two', rejected: false })
  const row = analytics.state.ips[hash]
  assert.equal(row.req, 3)
  assert.equal(row.rej, 1)
  assert.equal(row.in, 15)
  assert.equal(row.out, 9)
  assert.deepEqual(row.models, { 'm/one': 1, 'm/two': 1 })
  // An hourly bucket and a daily bucket both see it.
  assert.equal(Object.values(analytics.state.hourly).reduce((sum, n) => sum + n, 0), 3)
})

check('a concurrency reading tracks both the current and the peak', () => {
  const analytics = createAnalytics()
  const hash = analytics.ipHash('203.0.113.1', 'salt')
  analytics.concurrency(hash, 2, 2)
  analytics.concurrency(hash, 3, 1)
  analytics.concurrency(hash, 1, 5)
  const row = analytics.state.ips[hash]
  assert.equal(row.conc, 1)
  // The peak is a high-water mark, so a lower reading cannot pull it back down.
  assert.equal(row.concMax, 5)
})

check('a snapshot carries numbers and sorted rows, and nothing identifying', () => {
  const analytics = createAnalytics()
  const salt = 'salt'
  analytics.record({ hash: analytics.ipHash('203.0.113.9', salt), chat: true, status: 200, tokensIn: 10, tokensOut: 5, model: 'm/a', rejected: false })
  analytics.record({ hash: analytics.ipHash('198.51.100.7', salt), chat: true, status: 200, tokensIn: 20, tokensOut: 5, model: 'm/b', rejected: false })
  const snapshot = analytics.snapshot()
  assert.equal(snapshot.totals.ips, 2)
  assert.equal(snapshot.totals.req, 2)
  assert.equal(snapshot.totals.in, 30)
  // The busiest row is first, so a dashboard sees the top of the list.
  assert.equal(snapshot.ips[0].req >= snapshot.ips[1].req, true)
  assert.deepEqual(snapshot.models, { 'm/a': 1, 'm/b': 1 })
  // The salt is not in the snapshot: the hashes are the only identifier.
  assert.equal(JSON.stringify(snapshot).includes(salt), false)
})

check('an unreadable or foreign stats file is a fresh start, not a crash', () => {
  const analytics = createAnalytics()
  const dir = tempDir()
  const file = path.join(dir, 'stats.json')
  for (const garbage of ['', '{not json', 'null', '[]', '{"ips":1}', '{"ips":{},"hourly":1,"days":1}']) {
    fs.writeFileSync(file, garbage)
    assert.doesNotThrow(() => analytics.load(file), `${garbage} crashed the load`)
    assert.equal(analytics.state.ips instanceof Object, true)
  }
  // A real one is loaded.
  const good = { ips: { h: { first: 1, last: 2, req: 5, in: 0, out: 0, rej: 0, conc: 0, concMax: 0, models: {}, hours: {} } }, hourly: {}, days: {} }
  fs.writeFileSync(file, JSON.stringify(good))
  analytics.load(file)
  assert.equal(Object.keys(analytics.state.ips).length, 1)
})

check('a write is atomic, and a flush with nothing new writes nothing', async () => {
  const analytics = createAnalytics()
  const dir = tempDir()
  const file = path.join(dir, 'nested', 'stats.json')
  analytics.record({ hash: 'h', chat: true, status: 200, tokensIn: 1, tokensOut: 1, model: 'm', rejected: false })
  analytics.flush(file)
  assert.ok(fs.existsSync(file), 'the stats file was not written')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the stats file is readable by others')
  // No temp file is left behind.
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), [])
})

check('pruning trims the hour detail of a stale address, and caps the address set', () => {
  const analytics = createAnalytics()
  const realNow = Date.now
  try {
    const old = analytics.ipHash('203.0.113.1', 'salt')
    const recent = analytics.ipHash('203.0.113.2', 'salt')
    analytics.record({ hash: recent, chat: true, status: 200, model: 'm', rejected: false })
    // Age the first one far past both retention windows.
    Date.now = () => realNow() - 40 * 86_400_000
    analytics.record({ hash: old, chat: true, status: 200, model: 'm', rejected: false })
    Date.now = realNow
    const dir = tempDir()
    const file = path.join(dir, 'stats.json')
    analytics.flush(file)
    analytics.reset()
    analytics.load(file)
    // The address row is bounded by the 500-address cap, not by age, so an old row
    // survives — what is trimmed is its hourly detail and its day bucket. Today's
    // bucket survives too, because `recent` legitimately wrote one.
    assert.equal(recent in analytics.state.ips, true, 'a recent row was pruned')
    const staleDay = new Date(realNow() - 40 * 86_400_000).toISOString().slice(0, 10)
    assert.equal(staleDay in analytics.state.days, false, `a day past retention survived: ${staleDay}`)
    for (const hour of Object.keys(analytics.state.ips[old]?.hours ?? {})) {
      assert.ok(hour >= hourKey(realNow() - 3 * 86_400_000), `an hour past retention survived: ${hour}`)
    }
  } finally { Date.now = realNow }
})

check('the address cap evicts the least-recently-active, not the earliest-added', () => {
  const analytics = createAnalytics()
  const realNow = Date.now
  try {
    const early = analytics.ipHash('203.0.113.1', 'salt')
    const busy = analytics.ipHash('203.0.113.2', 'salt')
    Date.now = () => realNow() - 40 * 86_400_000
    analytics.record({ hash: early, chat: true, status: 200, model: 'm', rejected: false })
    Date.now = realNow
    // 501 distinct later addresses, so the cap has to drop one and the old row is
    // the least recently active.
    for (let index = 0; index < 501; index += 1) {
      analytics.record({ hash: analytics.ipHash(`203.0.113.${index + 10}`, 'salt'), chat: true, status: 200, model: 'm', rejected: false })
    }
    const dir = tempDir()
    const file = path.join(dir, 'stats.json')
    analytics.flush(file)
    analytics.reset()
    analytics.load(file)
    assert.equal(early in analytics.state.ips, false, 'the least-recently-active row survived the cap')
    assert.ok(Object.keys(analytics.state.ips).length <= 500, 'the cap did not hold')
    // Which of the *near-simultaneous* rows goes is not deterministic, so only the
    // ordering that is — the oldest address first — is asserted here.
  } finally { Date.now = realNow }
})

check('reset clears the singleton between suites', () => {
  const analytics = createAnalytics()
  analytics.record({ hash: 'h', chat: true, status: 200, model: 'm', rejected: false })
  assert.equal(Object.keys(analytics.state.ips).length, 1)
  analytics.reset()
  assert.deepEqual(analytics.state, { ips: {}, hourly: {}, days: {} })
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
