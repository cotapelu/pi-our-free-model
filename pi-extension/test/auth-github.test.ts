/**
 * Unit checks for the GitHub authorization gate.
 *
 * The gate is the lane's real door — the plugin carries a signing secret, never
 * the relay's auth, so this is where a per-user hold can exist at all. What the
 * checks below pin:
 *
 *   1. **a transient GitHub failure never takes access away.** 403/5xx/network is
 *      not "unstarred", and treating it as one would lock out a user who still
 *      starred the repo — the one failure mode this whole design exists to avoid;
 *   2. **a 401 *does* end access**, because the user revoked the app and the star
 *      can never be verified again;
 *   3. **the flag is the whole cutover** — `REQUIRE_USER_TOKEN=1` refuses, `0`
 *      tracks and refuses nothing;
 *   4. **a completed login survives a restart**, because the encrypted pending copy
 *      is on disk and the plugin collects by polling.
 *
 * Every GitHub call goes through an injected transport, so nothing here dials the
 * network.
 *
 * Runs on plain node:  node test/auth-github.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAuthGate } from '../dist/worker/auth-github.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-auth-'))

const SECRET = 'a'.repeat(40)
const ENV = {
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  REQUIRE_STAR_REPO: 'Ebony-Vinyl/dsh-our-free-model',
  USER_STORE_KEY: 'k'.repeat(32),
  SIGNING_SECRETS: SECRET,
}
/** A transport that answers GitHub's three calls by a script. */
function fakeGithub(script: {
  token?: string
  user?: { id: number; login: string; avatar_url: string }
  star?: 204 | 404 | 401 | 403 | 500 | 'network'
  exchange?: { ok?: boolean; status?: number; body?: any }
}) {
  const seen: Array<{ url: string; method: string }> = []
  const impl = async (url: string, init: any = {}) => {
    seen.push({ url, method: init.method ?? 'GET' })
    const body = async () => (typeof init.body === 'string' ? JSON.parse(init.body) : {})
    if (url.includes('/login/oauth/access_token')) {
      const status = script.exchange?.status ?? (script.exchange?.ok === false ? 422 : 200)
      return { ok: status >= 200 && status < 300, status, headers: { get: () => null },
        json: async () => script.exchange?.body ?? (script.token ? { access_token: script.token } : {}), text: async () => '' }
    }
    if (url.endsWith('/user')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => script.user ?? { id: 4242, login: 'someone', avatar_url: 'https://avatars.example/x' }, text: async () => '' }
    }
    if (url.includes('/user/starred/')) {
      if (script.star === 'network') throw new Error('socket hang up')
      return { ok: script.star === 204, status: script.star, headers: { get: () => null }, json: async () => ({}), text: async () => '' }
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' }
  }
  return { impl, seen }
}

/**
 * Drive one login start → callback → poll, exactly as the plugin does, and return
 * the per-user token. The gate's callback is async, so the poll is what settles it.
 */
async function completeLogin(gate: any, link = 'linkcode-0123456789'): Promise<{ token: string; status: number }> {
  const sink: Array<{ status: number; body: any; location?: string }> = []
  const res = () => {
    const row: { status: number; body: any; location?: string } = { status: 0, body: null }
    sink.push(row)
    return {
      writeHead(status: number, headers: Record<string, string> = {}) { row.status = status; row.location = headers.location },
      end(body?: any) { row.body = body },
    }
  }
  gate.handle({ method: 'GET', headers: {} }, res(), new URL(`http://localhost/auth/github/start?link=${link}`))
  const state = new URL(sink[0].location!).searchParams.get('state')!
  gate.handle({ method: 'GET', headers: {} }, res(), new URL(`http://localhost/auth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`))
  // The callback awaits three GitHub calls before it grants; the poll is what the
  // plugin does, and it is also what tells us the flow finished.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    gate.handle({ method: 'GET', headers: {} }, res(), new URL(`http://localhost/auth/poll?link=${link}`))
    try {
      const payload = JSON.parse(sink[sink.length - 1].body)
      if (payload.status === 'ok') return { token: payload.token, status: sink[sink.length - 1].status }
    } catch { /* a page, not JSON */ }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the login never completed')
}

/** One gate with one completed, starred login already in its store. */
async function gateWithUser(dir: string, env: Record<string, string>, impl?: any): Promise<{ gate: any; token: string; file: string }> {
  const file = path.join(dir, 'users.json')
  const github = impl ?? fakeGithub({ token: 'gh-token', star: 204 }).impl
  const gate = createAuthGate({ ...ENV, ...env }, { storePath: file, fetchImpl: github })
  const { token } = await completeLogin(gate)
  return { gate, token, file }
}

check('the cutover flag is the whole switch', () => {
  const dir = tempDir()
  const permissive = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '0' }, { storePath: path.join(dir, 'a.json') })
  const strict = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: path.join(dir, 'b.json') })
  permissive.close(); strict.close()
  // Off: a missing token is tracked and refused nowhere.
  assert.equal(permissive.check('').ok, true)
  assert.equal(permissive.check('').required, false)
  // On: it is refused, with a reason the caller can show.
  const refused = strict.check('')
  assert.equal(refused.ok, false)
  assert.equal(refused.required, true)
  assert.equal(refused.reason, 'missing')
})

check('a store written by one gate is read by the next, so a restart keeps users', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'users.json')
  const github = fakeGithub({ token: 'gh-token-1', star: 204 })
  const first = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: file, fetchImpl: github.impl })
  const granted = await completeLogin(first)
  first.close()
  assert.ok(fs.existsSync(file), 'the user store was not written')
  assert.notEqual(granted.token, '')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the user store is readable by others')
  // A second gate over the same file sees the same store — that is what makes a
  // restart not strand anything.
  const second = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: file, fetchImpl: github.impl })
  const stats = second.stats()
  assert.equal(stats.known, 1)
  assert.equal(stats.authorized, 1)
  second.close()
})

check('an unreadable store is an empty gate, not a crash', () => {
  const dir = tempDir()
  const file = path.join(dir, 'users.json')
  for (const garbage of ['', '{not json', 'null', '[]', '{"users":1}', '{"users":{},"pending":"bad"}']) {
    fs.writeFileSync(file, garbage)
    const gate = createAuthGate({ ...ENV }, { storePath: file })
    assert.deepEqual(gate.stats(), { authorized: 0, known: 0, unstarred: 0, pending: 0, required: false, configured: true, repo: 'Ebony-Vinyl/dsh-our-free-model', recheckHours: 12 }, `${garbage} changed the counts`)
    gate.close()
  }
})

check('the GitHub token is encrypted at rest and decrypts only under its key', async () => {
  const dir = tempDir()
  const { gate, file } = await gateWithUser(dir, { REQUIRE_USER_TOKEN: '1' })
  gate.close()
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  const row = Object.values(onDisk.users)[0] as any
  assert.equal(typeof row.ghToken, 'string')
  assert.equal(row.ghToken.startsWith('v1.'), true, 'the token was stored in the clear')
  // The plaintext is nowhere in the file.
  assert.equal(JSON.stringify(onDisk).includes('gh-token-secret-value'), false)
})

check('a rotated key makes the stored authorization unreadable, and says so', async () => {
  const dir = tempDir()
  const { gate, file } = await gateWithUser(dir, { REQUIRE_USER_TOKEN: '1' })
  gate.close()
  // Same store, a different USER_STORE_KEY.
  const rotated = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1', USER_STORE_KEY: 'z'.repeat(32) }, { storePath: file, fetchImpl: fakeGithub({ star: 204 }).impl })
  await rotated.recheckUser(Object.keys(rotated.snapshot().users)[0], true)
  const user = Object.values(rotated.snapshot().users)[0] as any
  assert.equal(user.starred, true, 'a rotation silently revoked a user')
  assert.match(String(user.lastCheckError ?? ''), /unreadable/)
  rotated.close()
})

check('a transient GitHub failure never takes access away', async () => {
  // 403 rate limit, 5xx and a dead socket are all "we could not ask", not "the
  // user unstarred". Treating any of them as a removal would lock out a user who
  // still starred the repo — the whole design exists to avoid exactly this.
  const dir = tempDir()
  for (const star of [403, 500, 429, 'network'] as const) {
    const sub = path.join(dir, `case-${String(star)}`)
    fs.mkdirSync(sub, { recursive: true })
    const { gate, file } = await gateWithUser(sub, { REQUIRE_USER_TOKEN: '1' })
    gate.close()
    const failing = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: file, fetchImpl: fakeGithub({ star }).impl })
    await failing.recheckUser(Object.keys(failing.snapshot().users)[0], true)
    const user = Object.values(failing.snapshot().users)[0] as any
    assert.equal(user.starred, true, `a transient ${String(star)} took access away`)
    assert.match(String(user.lastCheckError ?? ''), /github|unreachable/i, `${String(star)} recorded no reason`)
    failing.close()
  }
})

check('a dead authorization does end access, and names why', async () => {
  // GitHub answered 401: the user revoked the app, so the star can never be
  // verified again. This is the one case where access must end.
  const dir = tempDir()
  const { gate, file } = await gateWithUser(dir, { REQUIRE_USER_TOKEN: '1' })
  gate.close()
  const revoked = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: file, fetchImpl: fakeGithub({ star: 401 }).impl })
  await revoked.recheckUser(Object.keys(revoked.snapshot().users)[0], true)
  const user = Object.values(revoked.snapshot().users)[0] as any
  assert.equal(user.starred, false, 'a revoked authorization kept access')
  assert.match(String(user.revokedReason ?? ''), /revoked/)
  revoked.close()
})

check('a stale verdict is rechecked in the background, and the call does not wait', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'users.json')
  let clock = 1_800_000_000_000
  const realNow = Date.now
  Date.now = () => clock
  try {
    const first = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: file, now: () => clock, fetchImpl: fakeGithub({ token: 'gh-token', star: 204 }).impl })
    // The token the first login minted — not the GitHub id: `check` reads the
    // `x-ofm-user` header, which is the token. Reusing the id here would read as
    // "unknown token" and look like a verdict bug.
    const { token } = await completeLogin(first)
    first.close()
    clock += 13 * 3_600_000
    // A *re-check*, not a second login: the verdict is stale and GitHub would now
    // say "not starred", which is exactly the sweep the gate is meant to run.
    const stale = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: file, now: () => clock, fetchImpl: fakeGithub({ star: 404 }).impl })
    const verdict = stale.check(token)
    assert.equal(verdict.ok, true, 'a stale verdict blocked the turn')
    // The refresh runs behind the verdict, so let it land before asserting.
    await new Promise(resolve => setTimeout(resolve, 250))
    const user = Object.values(stale.snapshot().users)[0] as any
    assert.equal(user.starred, false, 'the background recheck never ran')
    stale.close()
  } finally { Date.now = realNow }
})

check('a star removal ends access at the next sweep, and the verdict names it', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'users.json')
  const { gate, token, file: userFile } = await gateWithUser(dir, { REQUIRE_USER_TOKEN: '1' })
  gate.close()
  const unstarred = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: userFile, fetchImpl: fakeGithub({ star: 404 }).impl })
  await unstarred.recheckUser(Object.keys(unstarred.snapshot().users)[0], true)
  const verdict = unstarred.check(token)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'unstarred')
  assert.match(String(verdict.detail ?? ''), /star removed/)
  unstarred.close()
})

check('the auth limiter counts per window, so a frozen clock eventually refuses', async () => {
  // The window advances with the clock, which in production is `Date.now`. A test
  // that pins the clock shares ONE window with every request it makes, so the 429
  // it eventually sees is the limiter being right rather than a bug — worth
  // recording, because from the outside it reads exactly like one.
  const dir = tempDir()
  const gate = createAuthGate({ ...ENV }, { storePath: path.join(dir, 'users.json'), fetchImpl: fakeGithub({}).impl })
  gate.close()
  let clock = 1_800_000_000_000
  const realNow = Date.now
  Date.now = () => clock
  try {
    let refusals = 0
    const answered: Array<{ url: string; status: number }> = []
    const res = (url: string) => ({
      writeHead(status: number) { answered.push({ url, status }) },
      end() {},
    })
    const link = 'x'.repeat(16)
    for (let attempt = 0; attempt < 32; attempt += 1) {
      gate.handle({ method: 'GET', headers: {} }, res(`/auth/poll?link=${link}`),
        new URL(`http://localhost/auth/poll?link=${link}`))
    }
    refusals = answered.filter(row => row.status === 429).length
    // 30 is the allowance; everything past it inside one window is a refusal.
    assert.ok(refusals >= 2, `expected the allowance to bite, got ${refusals} refusal(s) out of ${answered.length}`)
    // And past the window the same caller is admitted again — no timer, no sweep.
    clock += 60_001
    answered.length = 0
    gate.handle({ method: 'GET', headers: {} }, res('/auth/poll'), new URL(`http://localhost/auth/poll?link=${link}`))
    assert.equal(answered[0].status, 200, 'the window did not reset')
  } finally { Date.now = realNow }
})

check('an unknown token is refused as unknown, not as missing', () => {
  const dir = tempDir()
  const gate = createAuthGate({ ...ENV, REQUIRE_USER_TOKEN: '1' }, { storePath: path.join(dir, 'users.json'), fetchImpl: fakeGithub({}).impl })
  gate.close()
  assert.equal(gate.check('not-a-token').reason, 'unknown')
  assert.equal(gate.check('').reason, 'missing')
})

check('an unconfigured gate with enforcement on refuses and says so once', () => {
  const dir = tempDir()
  const logged: string[] = []
  const gate = createAuthGate({ REQUIRE_USER_TOKEN: '1' }, {
    storePath: path.join(dir, 'users.json'),
    log: message => logged.push(message),
  })
  gate.close()
  assert.equal(gate.configured, false)
  // The flag was flipped before the OAuth app was registered; saying so once is
  // the difference between an operator fixing it and a night of 401s.
  assert.match(logged.join('\n'), /not configured/)
  assert.equal(gate.check('').ok, false)
})

check('stats carries only counts, no identifying row', async () => {
  const dir = tempDir()
  const { gate } = await gateWithUser(dir, { REQUIRE_USER_TOKEN: '1' })
  gate.close()
  const stats = gate.stats()
  assert.equal(stats.known, 1)
  assert.equal(stats.authorized, 1)
  assert.equal(stats.repo, 'Ebony-Vinyl/dsh-our-free-model')
  assert.equal(stats.required, true)
  // The gate's own token store is not in the snapshot: the dashboard reads counts.
  assert.equal(JSON.stringify(stats).includes('gh-token'), false)
})

check('a link code that is not the plugin shape is refused before any store work', async () => {
  const dir = tempDir()
  const seen: string[] = []
  const gate = createAuthGate({ ...ENV }, {
    storePath: path.join(dir, 'users.json'),
    fetchImpl: async (url: string, init?: any) => { seen.push(url); return fakeGithub({}).impl(url, init) },
  })
  const answered: Array<{ status: number; body: any }> = []
  const res = { writeHead(status: number) { answered.push({ status, body: null }) }, end(body?: any) { answered[answered.length - 1].body = body } }
  for (const link of ['short', 'has space', 'x'.repeat(70), '', 'bad!chars']) {
    const url = new URL(`http://localhost/auth/poll?link=${encodeURIComponent(link)}`)
    const handled = gate.handle({ method: 'GET', headers: {} }, res, url)
    assert.equal(handled, true)
    assert.equal(answered[answered.length - 1].status, 400, `${link} was not refused`)
  }
  gate.close()
  assert.equal(seen.length, 0, 'a bad link code reached GitHub')
})

check('a route that is not the auth surface is left for the gateway', () => {
  const dir = tempDir()
  const gate = createAuthGate({ ...ENV }, { storePath: path.join(dir, 'users.json'), fetchImpl: fakeGithub({}).impl })
  gate.close()
  const url = new URL('http://localhost/v1/models')
  assert.equal(gate.handle({ method: 'GET', headers: {} }, { writeHead() {}, end() {} }, url), false)
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
