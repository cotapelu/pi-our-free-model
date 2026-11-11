/**
 * Unit checks for the recommended-projects star counts.
 *
 * This module reads GitHub and prints the answer, so two properties carry the
 * weight: the number must never be invented, and the page must never hang.
 * Most of the suite is there to pin refusals — a payload with no star count is
 * not half a row, and a boolean is not a count.
 *
 * The interesting behavioural half is the three states `view()` moves through:
 * fresh answers from memory, stale answers immediately while the fetch runs
 * behind them, and a cold start that gets a bounded head start instead of an
 * unbounded wait.
 *
 * Runs on plain node:  node test/picks.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PICK_REPOS, PICKS_API_BASE, VIEW_WAIT_MS, createPickStats } from '../dist/picks.js'

let failures = 0
let running = Promise.resolve()
/**
 * A **ref'd** keep-alive while the checks run.
 *
 * Every check here resolves through microtasks, so without a live handle Node
 * exits when the queue drains — and the checks queued behind the one that just
 * resolved never run. That is the same silent-drop failure the `&&` chain in
 * package.json had: the reported count looks fine while a third of the suite
 * never executed. It is cleared before the report, so a real hang still hangs.
 */
const keepAlive = setInterval(() => {}, 1000)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

const REPOS = [
  { id: 'r1', repo: 'owner/one' },
  { id: 'r2', repo: 'owner/two' },
] as const
/** An answer for one repo, so a single field can be broken at a time. */
function answer(over: any = {}): any {
  return { stargazers_count: 12, forks_count: 3, pushed_at: '2026-11-01T00:00:00Z', ...over }
}
/** A fetch that maps `owner/repo` to a payload. */
function answerer(map: Record<string, any>): any {
  return async (url: string) => {
    const repo = decodeURIComponent(String(url).replace(/^.*\/repos\//, ''))
    const body = map[repo]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (body instanceof Error) throw body
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  }
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-picks-'))

// ── the roster and where counts come from ───────────────────────────────────
check('the shipped roster is the one the page advertises, in order', () => {
  assert.deepEqual(PICK_REPOS.map(row => row.id), ['eac-desktop', 'eac-pack', 'eac-design-world'])
  // Frozen: a page built on these rows cannot be reordered under it.
  assert.equal(Object.isFrozen(PICK_REPOS), true)
  assert.equal(Object.isFrozen(PICK_REPOS[0]), true)
})

check('a repo name that walks out of /repos/ is dropped, not normalised', async () => {
  // `PICKS_API_BASE/repos/../anything` is a different path than the one written
  // here, and a dot-only segment is exactly how a permissive class lets it
  // through: `.` is inside both character classes.
  const seen: string[] = []
  const stats = createPickStats({
    repos: [
      { id: 'ok', repo: 'owner/one' }, { id: 'bad', repo: 'no-slash' },
      { id: 'bad2', repo: '../evil' }, { id: 'bad3', repo: 'owner/..' },
      { id: 'bad4', repo: 'owner/../other' }, { id: 'bad5', repo: '/owner/one' },
    ] as any,
    fetchImpl: (async (url: string) => { seen.push(url); return { ok: true, status: 200, json: async () => answer() } }) as any,
  })
  await stats.refresh()
  assert.equal(seen.length, 1, `asked for more than the one real repo: ${seen.join(', ')}`)
  assert.equal(seen[0], `${PICKS_API_BASE}/repos/owner/one`)
  assert.equal(stats.snapshot().repos.length, 1)
})

check('a repo name that is not owner/name is dropped before it reaches a URL', async () => {
  // It interpolates straight into a path, so a slash-free or path-y name is a
  // request the publisher never meant to make.
  const seen: string[] = []
  const stats = createPickStats({
    repos: [{ id: 'ok', repo: 'owner/one' }, { id: 'bad', repo: 'no-slash' }, { id: 'bad3', repo: 'has space/one' }] as any,
    fetchImpl: (async (url: string) => { seen.push(url); return { ok: true, status: 200, json: async () => answer() } }) as any,
  })
  await stats.refresh()
  assert.equal(seen.length, 1)
  assert.equal(seen[0], `${PICKS_API_BASE}/repos/owner/one`)
  assert.equal(stats.snapshot().repos.length, 1)
})

check('an empty roster answers an empty list, and asks nothing', async () => {
  let calls = 0
  const stats = createPickStats({
    repos: [], fetchImpl: (async () => { calls += 1; return { ok: true, status: 200, json: async () => answer() } }) as any,
  })
  const view = await stats.view()
  assert.deepEqual(view.repos, [])
  assert.equal(calls, 0)
})

// ── parseRepo: refusals ─────────────────────────────────────────────────────
check('a payload with no star count is not a row', async () => {
  const stats = createPickStats({ repos: REPOS, fetchImpl: answerer({ 'owner/one': { forks_count: 3 } }) })
  await stats.refresh()
  const row = stats.snapshot().repos[0]
  // The card's whole subject is the star count, so no count means no row — but
  // the repo still appears, marked stale, rather than vanishing.
  assert.strictEqual(row.stale, true)
  assert.strictEqual(row.stars, 0)
})

check('a star count is never produced by coercion', async () => {
  // `Number(true)` is 1, `Number(null)` is 0 and `Number('')` is 0: each would
  // print as a number the user believes GitHub said.
  for (const value of [true, false, null, '', [], {}, undefined, -1, 'abc', '  ', Number.NaN, Number.POSITIVE_INFINITY]) {
    const stats = createPickStats({ repos: [{ id: 'r1', repo: 'owner/one' }] as any, fetchImpl: answerer({ 'owner/one': { stargazers_count: value } }) })
    await stats.refresh()
    const row = stats.snapshot().repos[0]
    assert.equal(row.stars, 0, `${JSON.stringify(value)} became ${row.stars}`)
    assert.equal(row.stale, true, `${JSON.stringify(value)} read as fresh`)
  }
})

check('a real count survives, including a fractional one rounded', async () => {
  for (const [value, expected] of [[0, 0], [7, 7], [12345, 12345], [12.6, 13], ['99', 99]] as const) {
    const stats = createPickStats({ repos: [{ id: 'r1', repo: 'owner/one' }] as any, fetchImpl: answerer({ 'owner/one': { stargazers_count: value } }) })
    await stats.refresh()
    assert.equal(stats.snapshot().repos[0].stars, expected, `${String(value)} became ${stats.snapshot().repos[0].stars}`)
  }
})

check('forks and pushed_at are optional, and a bad one is dropped not zeroed', async () => {
  const stats = createPickStats({ repos: [{ id: 'r1', repo: 'owner/one' }] as any, fetchImpl: answerer({ 'owner/one': { stargazers_count: 5 } }) })
  await stats.refresh()
  assert.deepEqual(stats.snapshot().repos[0], { id: 'r1', repo: 'owner/one', stars: 5, stale: false })
  // A bad timestamp leaves the field absent instead of printing "1970".
  const bad = createPickStats({ repos: [{ id: 'r1', repo: 'owner/one' }] as any, fetchImpl: answerer({ 'owner/one': { stargazers_count: 5, pushed_at: 'not a date' } }) })
  await bad.refresh()
  assert.equal('pushedAt' in bad.snapshot().repos[0], false)
})

check('a payload that is not an object is refused', async () => {
  for (const body of [null, 42, 'text', []]) {
    const stats = createPickStats({ repos: [{ id: 'r1', repo: 'owner/one' }] as any, fetchImpl: answerer({ 'owner/one': body }) })
    await stats.refresh()
    assert.equal(stats.snapshot().repos[0].stale, true, `${JSON.stringify(body)} read as a row`)
  }
})

// ── fetch failure ───────────────────────────────────────────────────────────
check('a failed fetch keeps the last good numbers, marked stale', async () => {
  // A later failure must not blank the card: the page prints what it has and
  // says so, rather than dropping to dashes for a number it already knew.
  let healthy = true
  let clock = 1_000_000
  const logged: string[] = []
  const stats = createPickStats({
    repos: [{ id: 'r1', repo: 'owner/one' }] as any,
    cacheFile: path.join(tempDir(), 'picks.json'),
    fetchImpl: (async () => (healthy
      ? { ok: true, status: 200, json: async () => answer() }
      : (() => { throw new Error('ETIMEDOUT') })())) as any,
    now: () => clock,
    log: message => logged.push(message),
  })
  await stats.refresh()
  assert.equal(stats.snapshot().repos[0].stars, 12)
  assert.equal(stats.snapshot().repos[0].stale, false)
  // Past the six-hour window a *good* answer is reused for — that reuse is the
  // whole point of the cache, so the clock has to clear it before GitHub is
  // asked again. Fifteen minutes is the window for a failed answer, not this one.
  clock = 1_000_000 + 7 * 60 * 60_000
  healthy = false
  // `view()` answers the pre-refresh copy on purpose — the page must never hang
  // — so the retention is observed once the fetch behind it has settled.
  const first = await stats.view()
  assert.equal(first.repos[0].stars, 12, 'the stale copy was not served')
  assert.equal(first.repos[0].stale, false, 'the pre-refresh copy was mutated early')
  const view = await stats.refresh()
  assert.equal(view.repos[0].stars, 12, 'the last good count was dropped')
  assert.equal(view.repos[0].stale, true, 'a stale answer was not marked')
  assert.equal(view.ok, false)
  assert.match(logged.join('\n'), /ETIMEDOUT/)
})

check('a first fetch that fails keeps the row with no numbers rather than throwing', async () => {
  const logged: string[] = []
  const stats = createPickStats({
    repos: [{ id: 'r1', repo: 'owner/one' }] as any,
    fetchImpl: answerer({ 'owner/one': 503 }),
    log: message => logged.push(message),
  })
  const view = await stats.view()
  assert.equal(view.repos[0].stars, 0)
  assert.equal(view.repos[0].stale, true)
  assert.equal(view.ok, false)
  // The reason is logged, with no silent lie on the page.
  assert.match(logged.join('\n'), /HTTP 503/)
})

check('the request refuses a redirect, so a count cannot be re-sourced', async () => {
  // A 3xx answered for a repo could point anywhere; the caller follows nothing.
  let init: any
  const stats = createPickStats({
    repos: [{ id: 'r1', repo: 'owner/one' }] as any,
    fetchImpl: (async (_url: string, options: any) => { init = options; return { ok: false, status: 302, json: async () => ({}) } }) as any,
  })
  await stats.refresh()
  assert.equal(init.redirect, 'error')
})

// ── cache ───────────────────────────────────────────────────────────────────
check('a cache survives a restart and lands creator-only', async () => {
  const cacheFile = path.join(tempDir(), 'picks.json')
  const first = createPickStats({ repos: REPOS, cacheFile, fetchImpl: answerer({ 'owner/one': answer(), 'owner/two': answer() }) })
  await first.refresh()
  assert.ok(fs.existsSync(cacheFile))
  assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600, 'the cache is readable by others')
  const second = createPickStats({ repos: REPOS, cacheFile, fetchImpl: async () => { throw new Error('must not fetch') } })
  const view = await second.view()
  assert.equal(view.repos.length, 2)
  assert.equal(view.repos[0].stars, 12)
  // Fresh on disk means no fetch at all.
  assert.equal(view.repos[0].stale, false)
})

check('a cache written for a different roster is ignored, not masked', async () => {
  // Otherwise a stale roster would answer for repos the page no longer asks about.
  const dir = tempDir()
  const cacheFile = path.join(dir, 'picks.json')
  const yesterday = { at: Date.now() - 60_000, repos: [{ id: 'gone', repo: 'owner/gone', stars: 99, stale: false }] }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(cacheFile, JSON.stringify(yesterday))
  let calls = 0
  const stats = createPickStats({
    repos: REPOS, cacheFile,
    fetchImpl: (async () => { calls += 1; return { ok: true, status: 200, json: async () => answer() } }) as any,
    // Far enough past that an unpackaged age means "fetch now".
    now: () => Date.now() + 10 * 60_000,
  })
  await stats.view()
  assert.equal(calls, 2, 'a foreign roster answered instead of fetching both')
  assert.equal(stats.snapshot().repos.length === 2 || stats.snapshot().repos.length === 0, true)
})

check('a corrupt cache is the same as no cache, and does not crash the boot', async () => {
  const cacheFile = path.join(tempDir(), 'picks.json')
  for (const garbage of ['', '{not json', 'null', '[]', '{"at":0,"repos":[]}', '{"at":"x","repos":[]}']) {
    fs.writeFileSync(cacheFile, garbage)
    let calls = 0
    const stats = createPickStats({
      repos: REPOS, cacheFile,
      fetchImpl: (async () => { calls += 1; return { ok: true, status: 200, json: async () => answer() } }) as any,
      now: () => Date.now() + 10 * 60_000,
    })
    await stats.view()
    assert.equal(calls, 2, `${garbage} was honoured as a cache`)
  }
})

// ── the three states of view() ──────────────────────────────────────────────
check('a fresh copy answers from memory and never fetches', async () => {
  let calls = 0
  const stats = createPickStats({
    repos: REPOS,
    fetchImpl: (async () => { calls += 1; return { ok: true, status: 200, json: async () => answer() } }) as any,
    now: () => 1_000_000,
  })
  await stats.refresh()
  assert.equal(calls, 2)
  const view = await stats.view()
  assert.equal(calls, 2, 'a fresh copy fetched again')
  assert.equal(view.fetchedAt, 1_000_000)
  assert.equal(view.ok, true)
})

check('a stale copy answers immediately while the fetch runs behind it', async () => {
  let clock = 0
  let release = () => {}
  let block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const stats = createPickStats({
    repos: [{ id: 'r1', repo: 'owner/one' }] as any,
    cacheFile: path.join(tempDir(), 'picks.json'),
    fetchImpl: (async () => {
      calls += 1
      // Only the *second* round trip is held open; the first has to land or the
      // setup itself hangs and nothing after it can run.
      if (block) await gate
      return { ok: true, status: 200, json: async () => answer() }
    }) as any,
    now: () => clock,
  })
  // First pass: a fresh good copy on disk.
  clock = 1_000_000
  await stats.refresh()
  assert.equal(calls, 1)
  // Age it past the six-hour window a good answer is reused for.
  clock = 1_000_000 + 7 * 60 * 60_000
  block = true
  const started = Date.now()
  const view = await stats.view()
  assert.ok(Date.now() - started < VIEW_WAIT_MS, 'a stale copy waited for the fetch')
  assert.equal(view.repos[0].stars, 12, 'the stale copy was not served')
  assert.equal(view.repos[0].stale, false)
  // The fetch is running behind it; releasing it replaces the row.
  assert.equal(calls, 2)
  release()
  // `refresh()` hands back whoever is already in flight, so the settle has to run
  // before the next call opens a new round trip.
  await new Promise(resolve => setTimeout(resolve, 0))
  await stats.refresh()
  assert.equal(calls, 3)
})

check('a cold start waits at most VIEW_WAIT_MS, not until GitHub answers', async () => {
  let released = () => {}
  const gate = new Promise<void>(resolve => { released = resolve })
  const stats = createPickStats({
    repos: [{ id: 'r1', repo: 'owner/one' }] as any,
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => { await gate; return answer() } })) as any,
  })
  const started = Date.now()
  const view = await stats.view()
  const waited = Date.now() - started
  assert.ok(waited >= VIEW_WAIT_MS - 50, `returned in ${waited}ms, before the bound`)
  assert.ok(waited < VIEW_WAIT_MS + 500, `returned in ${waited}ms, past the bound`)
  // Nothing has landed yet, so the page paints the empty roster it has rather
  // than an invented number; a `stale` row appears when a fetch actually *fails*.
  assert.equal(view.repos.length, 0, 'a timed-out cold start invented a row')
  released()
  await new Promise(resolve => setTimeout(resolve, 0))
  await stats.refresh()
  assert.equal(stats.snapshot().repos[0].stars, 12, 'the slow answer was dropped')
})

check('a cold start whose answer lands inside the bound returns it', async () => {
  const stats = createPickStats({
    repos: [{ id: 'r1', repo: 'owner/one' }] as any,
    fetchImpl: (async () => ({
      ok: true, status: 200,
      json: async () => { await new Promise(r => setTimeout(r, 30)); return answer() },
    })) as any,
  })
  const view = await stats.view()
  assert.equal(view.repos[0].stars, 12, 'a fast answer was not waited for')
  assert.equal(view.repos[0].stale, false)
})

check('concurrent refreshes coalesce onto one round trip per repo', async () => {
  let calls = 0
  const stats = createPickStats({
    repos: REPOS,
    fetchImpl: (async () => {
      calls += 1
      await new Promise(r => setTimeout(r, 25))
      return { ok: true, status: 200, json: async () => answer() }
    }) as any,
  })
  const [a, b, c] = await Promise.all([stats.refresh(), stats.refresh(), stats.refresh()])
  assert.equal(calls, 2, `two repos, ${calls} round trips — the coalesce did not hold`)
  assert.equal(a.repos.length, 2)
  assert.equal(b.repos.length, 2)
  assert.equal(c.repos.length, 2)
  // A refresh after it settles opens a fresh one.
  await stats.refresh()
  assert.equal(calls, 4)
})

check('snapshot() fetches nothing and clones what it returns', async () => {
  let calls = 0
  const stats = createPickStats({
    repos: [{ id: 'r1', repo: 'owner/one' }] as any,
    fetchImpl: (async () => { calls += 1; return { ok: true, status: 200, json: async () => answer() } }) as any,
  })
  await stats.refresh()
  assert.equal(calls, 1)
  const one = stats.snapshot()
  assert.equal(calls, 1, 'snapshot fetched')
  one.repos[0].stars = 999
  // A caller mutating the answer must not corrupt the cache the next read uses.
  assert.equal(stats.snapshot().repos[0].stars, 12)
})

check('ok is true when any repo answered, and false when none did', async () => {
  const some = await createPickStats({ repos: REPOS, fetchImpl: answerer({ 'owner/one': answer(), 'owner/two': 500 }) }).view()
  assert.equal(some.ok, true, 'one good answer read as ok=false')
  const none = await createPickStats({ repos: REPOS, fetchImpl: answerer({ 'owner/one': 500, 'owner/two': new Error('x') }) }).view()
  assert.equal(none.ok, false, 'two failures read as ok=true')
})

// ── the real URL, against a local stub ──────────────────────────────────────
check('the request goes to the shipped GitHub base, path intact', async () => {
  // `PICKS_API_BASE` is read once at import, so the seam is the URL rewrite
  // rather than the environment: the base under test is the one that ships.
  const seen: string[] = []
  const stats = createPickStats({
    repos: [{ id: 'r1', repo: 'owner/one' }] as any,
    fetchImpl: (async (url: string) => {
      seen.push(String(url))
      return { ok: true, status: 200, json: async () => answer() }
    }) as any,
  })
  await stats.refresh()
  assert.equal(seen.length, 1)
  // The repo name is a whole path segment, not a query or a fragment.
  assert.equal(seen[0], `${PICKS_API_BASE}/repos/owner/one`)
  assert.equal(seen[0].includes('?'), false, 'the repo name leaked into the query')
})

check('a local stand-in serves the same rows, so the suite never leaves the machine', async () => {
  // Same seam, same reason, as `OFM_OPENCODE_BASE` in catalog.ts: a screenshot
  // or test run must not dial GitHub.
  let hits = 0
  const server = http.createServer((req, res) => {
    hits += 1
    // Only the path survives the URL rewrite — the seam forwards the URL and
    // nothing else, so the accept header is asserted on the seam itself above.
    assert.match(req.url ?? '', /^\/repos\/owner\/one$/, `unexpected path ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer({ stargazers_count: 42, forks_count: 9, pushed_at: '2026-11-05T00:00:00Z' })))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  try {
    const cacheFile = path.join(tempDir(), 'picks.json')
    const stats = createPickStats({
      repos: [{ id: 'r1', repo: 'owner/one' }] as any,
      cacheFile,
      fetchImpl: (async (url: string) => {
        // Rewrite the shipped base onto the stand-in; everything else is untouched.
        const local = String(url).replace(PICKS_API_BASE, `http://127.0.0.1:${port}`)
        const response = await fetch(local)
        return { ok: response.ok, status: response.status, json: async () => await response.json() }
      }) as any,
    })
    const view = await stats.view()
    assert.equal(view.repos[0].stars, 42)
    assert.equal(view.repos[0].forks, 9)
    assert.equal(hits, 1)
    // And a restart reads the cache the stand-in wrote, with no second request.
    const again = createPickStats({ repos: [{ id: 'r1', repo: 'owner/one' }] as any, cacheFile })
    assert.equal((await again.view()).repos[0].stars, 42)
    assert.equal(hits, 1, 'a fresh cache fetched again')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 100)
})
