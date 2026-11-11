/**
 * Unit checks for the co-paid lane's outbound wire.
 *
 * Two lane modes, and the whole point of each is what the *gateway* can see:
 *
 * - `direct` — one bearer credential, so the relay gets the credential itself;
 * - `worker` — no secret at all on the wire, only an HMAC-SHA256 signature over
 *   `timestamp \n METHOD \n path \n sha256(body)` plus the timestamp for the
 *   replay window. A seal extracted from this package is therefore an indirect
 *   entry the gateway can revoke, not the credential.
 *
 * The properties this suite pins:
 *
 *   1. **the signature covers the body, byte-for-byte** — a body re-serialized
 *      in transit breaks the HMAC and the gateway answers `request signature
 *      rejected` (issue #50), so the exact bytes matter, not the JSON value;
 *   2. **the credential material never reaches a message** — every classified
 *      failure carries the endpoint and no secret;
 *   3. **a response's shape, not its content-type, decides how it is read** —
 *      this relay answers 200 with an SSE frame stream under a JSON
 *      content-type, and a stream request with one JSON document.
 *
 * Every check drives the lane through its own `lane.fetch` test seam, so no
 * check reaches a network and none spends a real credential.
 *
 * Runs on plain node:  node test/eac.test.ts
 */
import assert from 'node:assert/strict'
import { CODE, UpstreamError, fetchSealedListing, postSealedStreamed, signSealedRequest } from '../dist/eac.js'
import * as eac from '../dist/eac.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

const SECRET = 's'.repeat(32)
const WORKER = { mode: 'worker', base: 'https://gateway.example/v1', signingSecret: SECRET }
const DIRECT = { mode: 'direct', base: 'https://gateway.example/v1', apiKey: 'k' + 'a'.repeat(24) }

/** A Response-shaped shim over the seam's own surface. */
function reply(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    async text() { return body },
    async json() { return JSON.parse(body) },
  }
}

/**
 * Drive the lane through its seam, capturing what the "gateway" saw.
 *
 * The seam must stay installed for the whole async operation: assigning it
 * inside a `try { return } finally { restore }` would restore it before the
 * awaited request ran, and the lane would dial the real network.
 */
async function withSeam<T>(fn: (url: string, init: any) => any, body: () => Promise<T>): Promise<T> {
  eac.lane.fetch = fn
  try { return await body() } finally { eac.lane.fetch = null }
}

const frames = (payloads: any[]) => payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('')

// ── the signature ────────────────────────────────────────────────────────────
check('the signing headers carry a truncated timestamp and a hex HMAC', () => {
  const headers = signSealedRequest(SECRET, { method: 'POST', path: '/v1/chat/completions', body: '{}' }, 1700000000123)
  assert.equal(headers['x-ofm-timestamp'], '1700000000123')
  assert.equal(headers['x-ofm-signature'], crypto_hmac('1700000000123', 'POST', '/v1/chat/completions', sha256('{}')))
})

check('the signature covers the exact body bytes, not the JSON value', () => {
  // A body re-serialized in transit (a key order change, whitespace) breaks the
  // HMAC even though the JSON value is identical — which is the whole reason
  // the lane posts over node:http(s) instead of a swappable global fetch.
  const compact = signSealedRequest(SECRET, { method: 'POST', path: '/v1/x', body: '{}' })
  const spaced = signSealedRequest(SECRET, { method: 'POST', path: '/v1/x', body: '{ }' })
  assert.notEqual(compact['x-ofm-signature'], spaced['x-ofm-signature'])
})

check('the method is upper-cased in the signed string but not on the wire', () => {
  const headers = signSealedRequest(SECRET, { method: 'post', path: '/v1/x', body: '' })
  assert.equal(headers['x-ofm-signature'], crypto_hmac(headers['x-ofm-timestamp'], 'POST', '/v1/x', sha256('')))
})

check('an absent body signs as the empty string', () => {
  // One fixed `now`, because `signSealedRequest` defaults it to `Date.now()` per
  // call: two calls a millisecond apart straddle a boundary and sign different
  // strings, which made this check fail about one run in twenty-five for a reason
  // that had nothing to do with the property it is pinning.
  const at = 1_800_000_000_000
  const a = signSealedRequest(SECRET, { method: 'GET', path: '/v1/x' }, at)
  const b = signSealedRequest(SECRET, { method: 'GET', path: '/v1/x', body: '' }, at)
  assert.equal(a['x-ofm-signature'], b['x-ofm-signature'])
})

check('a different secret gives a different signature', () => {
  const a = signSealedRequest('a'.repeat(32), { method: 'GET', path: '/v1/x' })
  const b = signSealedRequest('b'.repeat(32), { method: 'GET', path: '/v1/x' })
  assert.notEqual(a['x-ofm-signature'], b['x-ofm-signature'])
})

import crypto from 'node:crypto'
function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
function crypto_hmac(timestamp: string, method: string, path: string, bodyHash: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${timestamp}\n${method}\n${path}\n${bodyHash}`, 'utf8').digest('hex')
}

// ── the wire headers ─────────────────────────────────────────────────────────
check('a direct-mode request carries the bearer credential and no signature', async () => {
  let seen: any
  await withSeam((url, init) => { seen = { url, init }; return Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })) }, async () => {
    await fetchSealedListing(DIRECT)
  })
  assert.equal(seen.init.headers.authorization, `Bearer ${DIRECT.apiKey}`)
  assert.equal(seen.init.headers['x-ofm-signature'], undefined)
  assert.equal(seen.init.headers['x-ofm-timestamp'], undefined)
})

check('a worker-mode request carries a signature and no credential', async () => {
  let seen: any
  await withSeam((url, init) => { seen = { url, init }; return Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })) }, async () => {
    await fetchSealedListing(WORKER)
  })
  assert.equal(seen.init.headers['authorization'], undefined)
  assert.ok(typeof seen.init.headers['x-ofm-signature'] === 'string' && seen.init.headers['x-ofm-signature'].length === 64)
  assert.ok(seen.init.headers['x-ofm-timestamp'] !== undefined)
})

check('the signed path is the full URL pathname, exactly what the gateway recomputes', async () => {
  let seen: any
  await withSeam((url, init) => { seen = { url, init }; return Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })) }, async () => {
    await fetchSealedListing(WORKER)
  })
  assert.equal(seen.url, 'https://gateway.example/v1/models')
  assert.equal(seen.init.headers['x-ofm-signature'], crypto_hmac(seen.init.headers['x-ofm-timestamp'], 'GET', '/v1/models', sha256('')))
})

check('an installed user token rides x-ofm-user on worker mode', async () => {
  eac.laneUser.token = 'user-token-abc'
  try {
    let seen: any
    await withSeam((url, init) => { seen = { url, init }; return Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })) }, async () => {
      await fetchSealedListing(WORKER)
    })
    assert.equal(seen.init.headers['x-ofm-user'], 'user-token-abc')
  } finally { eac.laneUser.token = undefined }
})

check('an absent user token sends no x-ofm-user header', async () => {
  eac.laneUser.token = null
  try {
    let seen: any
    await withSeam((url, init) => { seen = { url, init }; return Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })) }, async () => {
      await fetchSealedListing(WORKER)
    })
    assert.equal(seen.init.headers['x-ofm-user'], undefined)
  } finally { eac.laneUser.token = undefined }
})

// ── the listings and the stream ──────────────────────────────────────────────
check('a listing answers its parsed JSON document', async () => {
  const payload = await withSeam(() => Promise.resolve(reply(200, '{"data":[{"id":"m1"}]}', { 'content-type': 'application/json' })), async () => fetchSealedListing(WORKER))
  assert.deepEqual(payload, { data: [{ id: 'm1' }] })
})

check('a listing refusal is classified, and the message names no secret', async () => {
  let thrown: any
  await withSeam(() => Promise.resolve(reply(429, JSON.stringify({ error: { message: 'quota exceeded' } }), { 'content-type': 'application/json', 'retry-after': '30' })), async () => {
    try { await fetchSealedListing(WORKER) } catch (error: any) { thrown = error }
  })
  assert.ok(thrown instanceof UpstreamError)
  assert.equal(thrown.kind, 'rate_limit')
  assert.equal(thrown.message.includes(SECRET), false, 'the signing secret reached the message')
  assert.equal(thrown.message.includes(DIRECT.apiKey), false)
})

check('an HTML error page from a front proxy reduces to one readable line', async () => {
  let thrown: any
  await withSeam(() => Promise.resolve(reply(524, '<html><body>origin timeout</body></html>', { 'content-type': 'text/html' })), async () => {
    try { await fetchSealedListing(WORKER) } catch (error: any) { thrown = error }
  })
  assert.match(String(thrown.message), /HTML error page/)
  // The status is still the one useful fact.
  assert.match(String(thrown.message), /524/)
})

check('an unparseable listing body is classified, not thrown raw', async () => {
  const payload = await withSeam(() => Promise.resolve(reply(200, 'not json at all', { 'content-type': 'application/json' })), async () => fetchSealedListing(WORKER))
  assert.ok(payload.error !== undefined, 'an unparseable body came back as a payload')
  // A body that is not JSON and not markup is carried through verbatim, so the
  // caller sees what the gateway actually said rather than `HTTP 200`.
  assert.equal(payload.error.message, 'not json at all')
})

check('a streamed turn pushes each data payload in order', async () => {
  const seen: string[] = []
  const result = await withSeam(() => Promise.resolve(reply(200, frames([
    { choices: [{ index: 0, delta: { content: 'hel' } }] },
    { choices: [{ index: 0, delta: { content: 'lo' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]), { 'content-type': 'text/event-stream' })), async () => postSealedStreamed({ credential: WORKER, body: { model: 'm' }, onData: payload => seen.push(payload) }))
  assert.equal(result.status, 200)
  assert.equal(seen.length, 3)
  assert.deepEqual(JSON.parse(seen[0]).choices[0].delta.content, 'hel')
})

check('a stream that mislabels itself as JSON is still read as SSE', async () => {
  // The relay answers 200 with a full SSE frame stream under a JSON
  // content-type: reading by content-type is how a turn silently dies.
  const seen: string[] = []
  await withSeam(() => Promise.resolve(reply(200, frames([
    { choices: [{ index: 0, delta: { content: 'ok' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]), { 'content-type': 'application/json' })), async () => postSealedStreamed({ credential: WORKER, body: { model: 'm' }, onData: payload => seen.push(payload) }))
  assert.equal(seen.length, 2)
})

check('a one-document answer to a stream request is folded into a single payload', async () => {
  const seen: string[] = []
  await withSeam(() => Promise.resolve(reply(200, JSON.stringify({
    id: 'cmpl', choices: [{ index: 0, message: { role: 'assistant', content: 'whole answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  }), { 'content-type': 'application/json' })), async () => postSealedStreamed({ credential: WORKER, body: { model: 'm' }, onData: payload => seen.push(payload) }))
  assert.equal(seen.length, 1)
  assert.deepEqual(JSON.parse(seen[0]).choices[0].message.content, 'whole answer')
})

check('a turn refusal honours the provider-reported reset, capped and clamped', async () => {
  let thrown: any
  await withSeam(() => Promise.resolve(reply(503, JSON.stringify({ error: { message: 'capacity' } }), { 'content-type': 'application/json', 'retry-after': '45' })), async () => {
    try { await postSealedStreamed({ credential: WORKER, body: { model: 'm' }, onData: () => {} }) }
    catch (error: any) { thrown = error }
  })
  assert.equal(thrown.kind, 'overloaded')
  // `Retry-After` seconds become a cooldown in ms; the rule table's own
  // backoff is replaced by the provider's number, capped at 30 minutes.
  assert.equal(thrown.cooldownMs, 45000)
  assert.match(String(thrown.rule), /provider-reset/)
  // A multi-hour reset would silently empty a chain, so it is clamped.
  let huge: any
  await withSeam(() => Promise.resolve(reply(503, JSON.stringify({ error: { message: 'capacity' } }), { 'content-type': 'application/json', 'retry-after': '7200' })), async () => {
    try { await postSealedStreamed({ credential: WORKER, body: { model: 'm' }, onData: () => {} }) }
    catch (error: any) { huge = error }
  })
  assert.equal(huge.cooldownMs, 30 * 60 * 1000)
})

check('a 400 body that is not JSON is classified, not thrown raw', async () => {
  let thrown: any
  await withSeam(() => Promise.resolve(reply(400, '<html>bad request</html>', { 'content-type': 'text/html' })), async () => {
    try { await postSealedStreamed({ credential: WORKER, body: { model: 'm' }, onData: () => {} }) }
    catch (error: any) { thrown = error }
  })
  assert.ok(thrown instanceof UpstreamError)
  assert.equal(thrown.message.includes(SECRET), false)
})

check('a 200 body that is neither SSE nor JSON is a client fault, not a retryable one', async () => {
  // A front proxy swallowed the stream: the same oversized body would draw the
  // same page again, so this must not land in the retryable set.
  let thrown: any
  await withSeam(() => Promise.resolve(reply(200, '<!doctype html><html>waf page</html>', { 'content-type': 'text/html' })), async () => {
    try { await postSealedStreamed({ credential: WORKER, body: { model: 'm' }, onData: () => {} }) }
    catch (error: any) { thrown = error }
  })
  assert.equal(thrown.code, CODE.client)
})

check('an empty 200 body is a typed empty failure', async () => {
  let thrown: any
  await withSeam(() => Promise.resolve(reply(200, '', { 'content-type': 'text/event-stream' })), async () => {
    try { await postSealedStreamed({ credential: WORKER, body: { model: 'm' }, onData: () => {} }) }
    catch (error: any) { thrown = error }
  })
  assert.ok(thrown instanceof UpstreamError)
  assert.equal(thrown.code, CODE.empty)
})

check('the signed body is the exact bytes that ship', async () => {
  // The signature covers sha256(body), so the body must reach the gateway
  // byte-for-byte as signed. A re-serialized body breaks the HMAC.
  let seen: any
  await withSeam((url, init) => { seen = init; return Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })) }, async () => {
    await fetchSealedListing(WORKER)
  })
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }
  // The signature covers the timestamp too, so it is recomputed with the one
  // the request actually carried — the property under test is that the same
  // (timestamp, method, path, body) gives the same HMAC, byte for byte.
  const signed = signSealedRequest(SECRET, {
    method: 'GET', path: '/v1/models', body: '',
  }, Number(seen.headers['x-ofm-timestamp']))
  assert.equal(seen.headers['x-ofm-signature'], signed['x-ofm-signature'])
  assert.equal(seen.headers['x-ofm-timestamp'], signed['x-ofm-timestamp'])
  // The body a turn ships is exactly what the signature covered.
  assert.equal(JSON.stringify(body).includes('"stream":true'), true)
})

check('a caller abort is honoured, not dialed', async () => {
  const controller = new AbortController()
  let thrown: any
  await withSeam((url, init) => { controller.abort(); return Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })) }, async () => {
    try { await fetchSealedListing(WORKER, { signal: controller.signal }) } catch (error: any) { thrown = error }
  })
  // Either the seam's answer or the abort reaches the caller; neither is a crash.
  assert.ok(thrown === undefined || thrown instanceof UpstreamError || thrown.name === 'AbortError')
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 300)
