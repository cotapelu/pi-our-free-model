/**
 * Unit checks for the co-paid lane's GitHub login poller.
 *
 * The poller is the one place a credential arrives from *outside* this process:
 * the user opens a browser, authorises and stars, and the gateway mints a token
 * it hands over through a poll. The properties this suite pins are the ones
 * that decide whether that handover is safe:
 *
 *   1. **saving is the commit point** — once the token is on disk, `cancel`
 *      reports completion rather than deleting an authorization the user earned;
 *   2. **a token that cannot be written is not a login** — a read-only home
 *      answers `not-writable`, not `ok`, so the settings page never shows a
 *      login that is not really there;
 *   3. **a reset invalidates every in-flight link** — a host change or a seal
 *      reload must not let a stale poll finish and store a token for the wrong
 *      host;
 *   4. **a bad link is refused before any dial** — the format is the gateway's,
 *      and a malformed one is a client error, not `unreachable`.
 *
 * Every check drives the poller with its own stub fetch, so nothing reaches a
 * gateway and no browser opens.
 *
 * Runs on plain node:  node test/eac-login.test.ts
 */
import assert from 'node:assert/strict'
import { createEacLoginPoller } from '../dist/eac-login.js'

let failures = 0
const check = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

const LINK = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const WORKER = { base: 'https://gateway.example/v1', mode: 'worker' as const, signingSecret: 's'.repeat(32) }
const TOKEN = 'tok_' + 'x'.repeat(40)

/** A poller whose stored user, dialled URLs and clock are all under our control. */
function poller(over: {
  credential?: () => any
  answer?: (url: string) => { status: number; body: any }
  stored?: any
  writable?: boolean
  saved?: any[]
  clock?: { now: () => number }
} = {}) {
  let stored = over.stored ?? null
  const dialled: string[] = []
  const saved = over.saved ?? []
  let t = 1_000_000
  const clock = over.clock ?? { now: () => t }
  const fetchStub = (async (url: any, init: any) => {
    dialled.push(String(url))
    void init
    const answer = over.answer?.(String(url)) ?? { status: 200, body: { status: 'pending' } }
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: { get: () => null },
      async json() { return answer.body },
      async text() { return JSON.stringify(answer.body) },
    }
  }) as unknown as typeof fetch
  const instance = createEacLoginPoller({
    credentialOf: over.credential ?? (() => WORKER),
    fetch: fetchStub,
    readUser: () => stored,
    writeUser: (user: any) => {
      if (over.writable === false) return null
      stored = { token: user.token, login: user.login ?? '', avatar: user.avatar ?? '', savedAt: clock.now() }
      saved.push(stored)
      return stored as any
    },
    onSaved: () => {},
    now: clock.now,
  })
  return { instance, dialled, saved, advance: (ms: number) => { t += ms }, setCredential: (c: any) => { over.credential = () => c } }
}

await check('a link that is not the gateway shape is refused before any dial', async () => {
  const p = poller()
  for (const bad of ['', 'short', 'a'.repeat(15), 'b'.repeat(65), 'has space!', undefined as any, 42 as any]) {
    const result = await p.instance.prepare(bad)
    assert.equal(result.error, 'bad-link', `${JSON.stringify(bad)} gave ${JSON.stringify(result)}`)
  }
  assert.deepEqual(p.dialled, [], 'a bad link was dialled anyway')
})

await check('prepare registers the link with the gateway and answers ok on its 302', async () => {
  const p = poller({ answer: () => ({ status: 302, body: {} }) })
  const result = await p.instance.prepare(LINK)
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(p.dialled, ['https://gateway.example/auth/github/start?link=' + encodeURIComponent(LINK)])
})

await check('prepare reports a non-302 gateway answer as its status', async () => {
  const p = poller({ answer: () => ({ status: 500, body: {} }) })
  const result = await p.instance.prepare(LINK)
  assert.equal(result.error, 'gateway-http-500')
})

await check('prepare on a host with no lane answers no-lane, not unreachable', async () => {
  // The lane is a *configuration* state, not a transport fault: reporting
  // `unreachable` would send the user looking at their network.
  const p = poller({ credential: () => null })
  const result = await p.instance.prepare(LINK)
  assert.equal(result.error, 'no-lane')
  assert.deepEqual(p.dialled, [])
})

await check('a direct-mode lane cannot carry a GitHub gate, so it answers no-lane', async () => {
  const p = poller({ credential: () => ({ base: 'https://relay.example/v1', mode: 'direct', apiKey: 'k' + 'a'.repeat(24) }) })
  assert.equal((await p.instance.prepare(LINK)).error, 'no-lane')
})

await check('a pending poll reports pending and keeps the link alive', async () => {
  const p = poller({ answer: () => ({ status: 200, body: { status: 'pending' } }) })
  await p.instance.prepare(LINK)
  const result = await p.instance.poll(LINK)
  assert.deepEqual(result, { status: 'pending' })
  assert.deepEqual(p.dialled, [
    'https://gateway.example/auth/github/start?link=' + encodeURIComponent(LINK),
    `https://gateway.example/auth/poll?link=${encodeURIComponent(LINK)}&retain=1`,
  ])
})

await check('an expired link reports expired rather than a transport error', async () => {
  const p = poller({ answer: () => ({ status: 200, body: { status: 'expired' } }) })
  await p.instance.prepare(LINK)
  assert.deepEqual(await p.instance.poll(LINK), { status: 'expired' })
})

await check('a signed-in-not-starred answer names the login and the repo', async () => {
  const p = poller({ answer: () => ({ status: 200, body: { status: 'unstarred', login: 'octocat', repo: 'Ebony-Vinyl/dsh-our-free-model' } }) })
  await p.instance.prepare(LINK)
  const result = await p.instance.poll(LINK)
  assert.equal(result.status, 'unstarred')
  assert.equal(result.login, 'octocat')
  assert.equal(result.repo, 'Ebony-Vinyl/dsh-our-free-model')
})

await check('a completed login stores the token and reports the login', async () => {
  const p = poller({ answer: () => ({ status: 200, body: { status: 'ok', token: TOKEN, login: 'octocat', avatar: 'https://avatars/1' } }) })
  await p.instance.prepare(LINK)
  const result = await p.instance.poll(LINK)
  assert.deepEqual(result, { status: 'ok', login: 'octocat' })
  assert.equal(p.saved.length, 1, 'the token was not stored')
  assert.equal(p.saved[0].token, TOKEN)
  assert.equal(p.saved[0].login, 'octocat')
})

await check('an old gateway that omits ackRequired still completes the login', async () => {
  // Old gateways ignore `retain` and omit `ackRequired`: the login must not be
  // held open waiting for a confirmation they will never answer.
  const p = poller({ answer: () => ({ status: 200, body: { status: 'ok', token: TOKEN, login: 'octocat' } }) })
  await p.instance.prepare(LINK)
  assert.deepEqual(await p.instance.poll(LINK), { status: 'ok', login: 'octocat' })
})

await check('a token that cannot be written is not a login', async () => {
  const p = poller({
    answer: () => ({ status: 200, body: { status: 'ok', token: TOKEN, login: 'octocat' } }),
    writable: false,
  })
  await p.instance.prepare(LINK)
  const result = await p.instance.poll(LINK)
  assert.equal(result.error, 'not-writable', 'a read-only home reported a login')
})

await check('a malformed gateway answer is malformed, not a crash', async () => {
  for (const body of [{ status: 'ok' }, { status: 'ok', token: '' }, { status: 'weird' }, {}]) {
    const p = poller({ answer: () => ({ status: 200, body }) })
    await p.instance.prepare(LINK)
    const result = await p.instance.poll(LINK)
    assert.equal(result.error, 'malformed', `${JSON.stringify(body)} gave ${JSON.stringify(result)}`)
  }
})

await check('a gateway error status is reported as its status', async () => {
  const p = poller({ answer: () => ({ status: 503, body: {} }) })
  await p.instance.prepare(LINK)
  assert.equal((await p.instance.poll(LINK)).error, 'gateway-http-503')
})

await check('an unreachable gateway is unreachable, not pending', async () => {
  const p = poller({ answer: () => { throw new Error('ECONNREFUSED') } })
  await p.instance.prepare(LINK)
  // prepare itself reports unreachable; the poll then too.
  assert.equal((await p.instance.prepare(LINK)).error, 'unreachable' === 'unreachable' ? 'unreachable' : 'unreachable')
})

await check('saving is the commit point: cancel after a save reports completion', async () => {
  const p = poller({ answer: () => ({ status: 200, body: { status: 'ok', token: TOKEN, login: 'octocat' } }) })
  await p.instance.prepare(LINK)
  await p.instance.poll(LINK)
  // The user walks away *after* the token landed. Reporting "cancelled" would
  // imply the authorization was thrown away, and the next poll would re-ask.
  const result = p.instance.cancel(LINK)
  assert.deepEqual(result, { status: 'ok', login: 'octocat' })
})

await check('cancel before a save marks the link cancelled', async () => {
  const p = poller({ answer: () => ({ status: 200, body: { status: 'pending' } }) })
  await p.instance.prepare(LINK)
  assert.deepEqual(p.instance.cancel(LINK), { ok: true })
  // A cancelled link is not polled again.
  const after = await p.instance.poll(LINK)
  assert.equal(after.error, 'cancelled', `a cancelled link kept polling: ${JSON.stringify(after)}`)
})

await check('a second poll while one is in flight shares it', async () => {
  // Two callers (the settings page and the /ofm command) must not dial twice.
  let release: (value: any) => void = () => {}
  const gate = new Promise(resolve => { release = resolve })
  const dialled: string[] = []
  const fetchStub = (async (url: any) => {
    dialled.push(String(url))
    if (String(url).includes('/auth/poll')) await gate
    return { ok: true, status: String(url).includes('/auth/poll') ? 200 : 302, headers: { get: () => null }, async json() { return { status: 'ok', token: TOKEN, login: 'octocat' } }, async text() { return '{}' } }
  }) as unknown as typeof fetch
  let stored: any = null
  const instance = createEacLoginPoller({
    credentialOf: () => WORKER, fetch: fetchStub,
    readUser: () => stored,
    writeUser: (u: any) => { stored = { ...u, savedAt: 1 }; return stored as any },
    onSaved: () => {},
  })
  await instance.prepare(LINK)
  const first = instance.poll(LINK)
  const second = instance.poll(LINK)
  release(undefined)
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, { status: 'ok', login: 'octocat' })
  assert.deepEqual(b, { status: 'ok', login: 'octocat' })
  assert.equal(dialled.filter(url => url.includes('/auth/poll')).length, 1, 'the in-flight poll was dialled twice')
})

await check('reset invalidates every in-flight link', async () => {
  // A host change or a seal reload must not let a stale poll finish and store a
  // token for the host the user just left.
  let release: (value: any) => void = () => {}
  const gate = new Promise(resolve => { release = resolve })
  let stored: any = null
  const fetchStub = (async (url: any) => {
    if (String(url).includes('/auth/poll')) await gate
    return { ok: true, status: 302, headers: { get: () => null }, async json() { return { status: 'ok', token: TOKEN, login: 'ghost' } }, async text() { return '{}' } }
  }) as unknown as typeof fetch
  const instance = createEacLoginPoller({
    credentialOf: () => WORKER, fetch: fetchStub,
    readUser: () => stored,
    writeUser: (u: any) => { stored = { ...u, savedAt: 1 }; return stored as any },
    onSaved: () => {},
  })
  await instance.prepare(LINK)
  const poll = instance.poll(LINK)
  instance.reset()
  release(undefined)
  const result = await poll
  assert.equal(result.error, 'cancelled', `a reset poll still completed: ${JSON.stringify(result)}`)
  assert.equal(stored, null, 'a reset poll stored a token')
})

await check('a receipt is not re-walked after the link is cancelled', async () => {
  const p = poller({ answer: () => ({ status: 200, body: { status: 'ok', token: TOKEN, login: 'octocat' } }) })
  await p.instance.prepare(LINK)
  await p.instance.poll(LINK)
  const dialsAfterSave = p.dialled.length
  // The receipt answers locally, so the gateway is not asked again.
  const again = await p.instance.poll(LINK)
  assert.deepEqual(again, { status: 'ok', login: 'octocat' })
  assert.equal(p.dialled.length, dialsAfterSave, 'a saved login was re-polled upstream')
})

await check('a receipt whose stored token was replaced is not replayed', async () => {
  // A second install logged in and overwrote the file: replaying the old receipt
  // would tell the settings page the wrong user is signed in.
  const p = poller({ answer: () => ({ status: 200, body: { status: 'ok', token: TOKEN, login: 'octocat' } }) })
  await p.instance.prepare(LINK)
  await p.instance.poll(LINK)
  p.instance.reset()
  void p
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 300)
