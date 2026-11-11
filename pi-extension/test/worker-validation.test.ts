/**
 * Unit checks for the EAC gateway's validation core.
 *
 * This is the module **both hosts share**, so the properties pinned here are the
 * ones a host-specific gap would break:
 *
 *   1. the body cap is measured on the **bytes** that arrived, not on a decoded
 *      string's length — that mismatch let a multibyte body past at up to three
 *      times the configured value and made the two hosts disagree;
 *   2. the replay window is checked **before** the expensive work, and the
 *      signature compare is constant-time;
 *   3. **every** accepted secret is tried, so a rotation's overlap window does
 *      not break the installs still sealed with the old one;
 *   4. the relay base is refused unless it ends in `/v1`, and its scheme is
 *      https unless it is a loopback host.
 *
 * Runs on plain node:  node test/worker-validation.test.ts
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_BODY_BYTES, PASS_HEADERS, ROUTES, acceptedSecrets, admitsSignature, hmacHex,
  jsonError, relayRequest, relayUrl, sha256Hex, signatureMessage, stripPrefix,
  timingSafeEqual, verifySignedRequest,
} from '../dist/worker/validation.js'
const MODELS_ROUTE = ROUTES['GET /v1/models']
const CHAT_ROUTE = ROUTES['POST /v1/chat/completions']

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

const SECRET_A = 'a'.repeat(40)
const SECRET_B = 'b'.repeat(40)
const NOW = 1_800_000_000_000
const realNow = Date.now

/** A signed request, as the plugin builds one. */
async function signed(method: string, path: string, body = '', rawOpts: unknown = {}): Promise<Request> {
  // The options object is validated, not assumed. A helper that read its options
  // through `?.` alone would see `''.at` — `String.prototype.at`, a *function* —
  // and sign a message over that function's source. The result is a 401 that
  // looks exactly like a bad signature and points nowhere near the real cause.
  const opts = (typeof rawOpts === 'object' && rawOpts !== null ? rawOpts : {}) as {
    secret?: string
    at?: number
    timestamp?: string
    signature?: string
    headers?: Record<string, string>
  }
  const secret = opts.secret ?? SECRET_A
  const at = opts.at ?? NOW
  const timestamp = opts.timestamp ?? String(at)
  const signature = opts.signature ?? await hmacHex(secret, await signatureMessage(timestamp, method, path, body))
  const headers: Record<string, string> = {
    'x-ofm-timestamp': timestamp,
    'x-ofm-signature': signature,
    ...opts.headers,
  }
  if (method === 'POST') headers['content-type'] = 'application/json'
  return new Request(`https://gateway.example${path}`, {
    method,
    headers,
    body: method === 'POST' ? body : undefined,
  })
}

check('the lane speaks two routes, and both admit a correctly signed turn', async () => {
  Date.now = () => NOW
  try {
    const models = await signed('GET', '/v1/models')
    assert.equal((await verifySignedRequest(models, [SECRET_A], { route: ROUTES['GET /v1/models'], models: '' })).ok, true)
    const chat = await signed('POST', '/v1/chat/completions', '{"model":"m"}')
    assert.equal((await verifySignedRequest(chat, [SECRET_A], { route: ROUTES['POST /v1/chat/completions'] })).ok, true)
  } finally { Date.now = realNow }
})

check('an unknown route is a 404 before any crypto work', () => {
  // The lane *handler* resolves the route — prefix stripped — and refuses anything
  // that is not one of the two before a signature is even looked at. Asserted on the
  // route table rather than through `verifySignedRequest`, which now receives the
  // resolved route as a parameter.
  for (const key of ['GET /v1/other', 'POST /v1/models', 'GET /admin', 'GET /v1/models/../escape']) {
    assert.equal(ROUTES[key], undefined, `${key} was a known route`)
  }
  assert.notEqual(ROUTES['GET /v1/models'], undefined)
  assert.notEqual(ROUTES['POST /v1/chat/completions'], undefined)
})

check('the default caps are the documented ones', () => {
  assert.equal(DEFAULT_MAX_BODY_BYTES, 8 * 1024 * 1024)
  assert.deepEqual(PASS_HEADERS, ['content-type', 'retry-after'])
  assert.equal(ROUTES['GET /v1/models'].body, false)
  assert.equal(ROUTES['POST /v1/chat/completions'].body, true)
})

// ── the body cap, on bytes ──────────────────────────────────────────────────
check('the cap is measured on the bytes that arrived, not a decoded length', async () => {
  Date.now = () => NOW
  try {
    // Each of these is 3 UTF-16 code units and 6 UTF-8 bytes, so a decoded
    // `.length` check would pass a body three times the intended size.
    const multibyte = '€'.repeat(1000)
    const body = JSON.stringify({ model: 'm', note: multibyte })
    const bytes = new TextEncoder().encode(body).byteLength
    assert.ok(bytes > body.length, 'this fixture is not actually multibyte')
    // The cap sits *between* the decoded length and the byte count: a `.length`
    // check would admit it, a byte check refuses it.
    const overBytes = await signed('POST', '/v1/chat/completions', body, '', { at: NOW })
    const verdict = await verifySignedRequest(overBytes, [SECRET_A], { route: CHAT_ROUTE, maxBodyBytes: body.length + 1 })
    assert.equal(verdict.status, 413, 'a multibyte body slipped past the byte cap')
    // Under a cap above the byte count it is admitted.
    const underBytes = await verifySignedRequest(await signed('POST', '/v1/chat/completions', body, '', { at: NOW }), [SECRET_A], { route: CHAT_ROUTE, maxBodyBytes: bytes + 1 })
    assert.equal(underBytes.ok, true)
  } finally { Date.now = realNow }
})

check('a GET carries no body to cap, and a cap of zero is not "cap everything"', async () => {
  Date.now = () => NOW
  try {
    const models = await signed('GET', '/v1/models')
    assert.equal((await verifySignedRequest(models, [SECRET_A], { route: MODELS_ROUTE, maxBodyBytes: 0 })).ok, true,
      'a GET was capped as though it carried a body')
    // `Number.parseInt` of a nonsense cap falls back to the default, exactly as
    // the env parsing does — not to zero, which would refuse every turn.
    const chat = await signed('POST', '/v1/chat/completions', '{"model":"m"}', '', { at: NOW })
    assert.equal((await verifySignedRequest(chat, [SECRET_A], { route: CHAT_ROUTE, maxBodyBytes: 0 })).ok, true,
      'a zero cap refused a body instead of falling back')
  } finally { Date.now = realNow }
})

// ── the replay window, before the work ─────────────────────────────────────
check('a clock outside the window is refused before any signature work', async () => {
  Date.now = () => NOW
  try {
    // The signature is *valid*; the timestamp is not. Refusing it proves the
    // window is checked first, because a wrong-window request never reaches it.
    for (const at of [NOW - 601_000, NOW + 601_000, NOW - 86_400_000]) {
      const request = await signed('GET', '/v1/models', '', { at })
      const verdict = await verifySignedRequest(request, [SECRET_A], { route: MODELS_ROUTE, skewSeconds: 600 })
      assert.equal(verdict.status, 401, `a clock ${NOW - at}ms off was admitted`)
    }
    // Inside the window, the same request is admitted.
    const inside = await verifySignedRequest(await signed('GET', '/v1/models', '', { at: NOW - 59_000 }), [SECRET_A], { route: MODELS_ROUTE, skewSeconds: 600 })
    assert.equal(inside.ok, true)
  } finally { Date.now = realNow }
})

check('an unparseable timestamp is refused, not treated as the epoch', async () => {
  Date.now = () => NOW
  try {
    for (const timestamp of ['', 'not a number', 'NaN', 'Infinity', '0x10']) {
      const request = await signed('GET', '/v1/models', '', { timestamp })
      const verdict = await verifySignedRequest(request, [SECRET_A], { route: ROUTES['GET /v1/models'] })
      assert.equal(verdict.status, 401, `${JSON.stringify(timestamp)} was admitted`)
    }
  } finally { Date.now = realNow }
})

// ── the signature ───────────────────────────────────────────────────────────
check('a signature under any accepted secret is admitted', async () => {
  Date.now = () => NOW
  try {
    // The rotation overlap window: the old secret is still accepted, so the
    // installs sealed with it keep working until they are shipped again.
    const withA = await verifySignedRequest(await signed('GET', '/v1/models', '', { secret: SECRET_A, at: NOW }), [SECRET_A, SECRET_B], { route: ROUTES['GET /v1/models'] })
    assert.equal(withA.ok, true)
    const withB = await verifySignedRequest(await signed('GET', '/v1/models', '', { secret: SECRET_B, at: NOW }), [SECRET_A, SECRET_B], { route: ROUTES['GET /v1/models'] })
    assert.equal(withB.ok, true, 'the overlap window refused an old seal')
  } finally { Date.now = realNow }
})

check('a signature under an unaccepted secret is refused', async () => {
  Date.now = () => NOW
  try {
    const verdict = await verifySignedRequest(await signed('GET', '/v1/models', '', { secret: 'c'.repeat(40), at: NOW }), [SECRET_A], { route: MODELS_ROUTE })
    assert.equal(verdict.status, 401)
    // A signature that is the right length but wrong bits is refused too.
    const wrongBits = await hmacHex(SECRET_B, await signatureMessage(String(NOW), 'GET', '/v1/models', ''))
    const forged = await verifySignedRequest(await signed('GET', '/v1/models', '', { signature: wrongBits, at: NOW }), [SECRET_A], { route: ROUTES['GET /v1/models'] })
    assert.equal(forged.status, 401)
  } finally { Date.now = realNow }
})

check('a signature covers the full pathname, prefix included', async () => {
  Date.now = () => NOW
  try {
    // The plugin signs `new URL(base + '/models').pathname`, so mounting under a
    // prefix must not silently change what is verified.
    const mounted = '/eac/v1/models'
    // But the *signature* over the mounted path is what the client computed, so
    // verify it directly rather than through the route table.
    assert.equal(await admitsSignature(await hmacHex(SECRET_A, await signatureMessage(String(NOW), 'GET', mounted, '')), await signatureMessage(String(NOW), 'GET', mounted, ''), [SECRET_A]), true)
    // And the stripped path is NOT what the client signed.
    assert.equal(await admitsSignature(await hmacHex(SECRET_A, await signatureMessage(String(NOW), 'GET', '/v1/models', '')), await signatureMessage(String(NOW), 'GET', mounted, ''), [SECRET_A]), false)
  } finally { Date.now = realNow }
})

check('a body tampered with after signing is refused', async () => {
  Date.now = () => NOW
  try {
    // The call signs the bytes it sends; a body modified in flight must not pass
    // even though the timestamp is fresh.
    const original = '{"model":"cheap"}'
    const tampered = '{"model":"expensive"}'
    const verdict = await verifySignedRequest(await signed('POST', '/v1/chat/completions', tampered, { at: NOW, signature: await hmacHex(SECRET_A, await signatureMessage(String(NOW), 'POST', '/v1/chat/completions', original)) }), [SECRET_A], { route: CHAT_ROUTE })
    assert.equal(verdict.status, 401)
  } finally { Date.now = realNow }
})

// ── the secret list ─────────────────────────────────────────────────────────
check('a secret list keeps only entries long enough to be secrets', () => {
  assert.deepEqual(acceptedSecrets('short,' + SECRET_A + ' , ' + SECRET_B), [SECRET_A, SECRET_B])
  assert.deepEqual(acceptedSecrets(''), [])
  assert.deepEqual(acceptedSecrets(undefined), [])
  assert.deepEqual(acceptedSecrets('   '), [])
  // A 31-character secret is a configuration error, not a weaker secret.
  assert.deepEqual(acceptedSecrets('a'.repeat(31)), [])
})

// ── the model allowlist ─────────────────────────────────────────────────────
check('a model allowlist is enforced only on the route that carries one', async () => {
  Date.now = () => NOW
  try {
    const allowed = await verifySignedRequest(await signed('POST', '/v1/chat/completions', '{"model":"yes"}', '', { at: NOW }), [SECRET_A], { route: ROUTES['POST /v1/chat/completions'], models: 'yes,maybe' })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.model, 'yes')
    const refused = await verifySignedRequest(await signed('POST', '/v1/chat/completions', '{"model":"no"}', '', { at: NOW }), [SECRET_A], { route: ROUTES['POST /v1/chat/completions'], models: 'yes,maybe' })
    assert.equal(refused.status, 403)
    // A listing is never filtered: the allowlist is a chat-turn control.
    const listing = await verifySignedRequest(await signed('GET', '/v1/models', '', { at: NOW }), [SECRET_A], { route: ROUTES['GET /v1/models'], models: 'yes' })
    assert.equal(listing.ok, true)
  } finally { Date.now = realNow }
})

check('a malformed body reaches the allowlist as an empty model, and is refused', async () => {
  Date.now = () => NOW
  try {
    // The allowlist is on, and nothing in the body names a model — so nothing is
    // allowed. Refusing here, rather than passing it to the relay, is the point:
    // the relay would answer for whatever it defaulted to.
    const verdict = await verifySignedRequest(await signed('POST', '/v1/chat/completions', 'not json', '', { at: NOW }), [SECRET_A], { route: ROUTES['POST /v1/chat/completions'], models: 'yes' })
    assert.equal(verdict.status, 403)
  } finally { Date.now = realNow }
})

check('no allowlist configured accepts every model', async () => {
  Date.now = () => NOW
  try {
    const verdict = await verifySignedRequest(await signed('POST', '/v1/chat/completions', '{"model":"anything"}', '', { at: NOW }), [SECRET_A], { route: ROUTES['POST /v1/chat/completions'], models: '  ' })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.model, 'anything')
  } finally { Date.now = realNow }
})

// ── the relay base ──────────────────────────────────────────────────────────
check('a relay base must end in /v1, or it would serve the relay\'s front page', () => {
  for (const base of ['https://relay.example', 'https://relay.example/', 'https://relay.example/v2', 'https://relay.example/v1/models']) {
    assert.equal(relayUrl(base), null, `${base} was accepted`)
  }
  // The trailing slash is trimmed *before* the `/v1` check, so a well-formed base
  // with one still works and normalises to the bare suffix.
  const trimmed = relayUrl('https://relay.example/v1/')
  assert.notEqual(trimmed, null, 'a trailing slash made a valid base unusable')
  assert.equal(trimmed!.pathname, '/v1')
})

check('a relay must be https, unless it is a loopback host', () => {
  assert.notEqual(relayUrl('https://relay.example/v1'), null)
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.notEqual(relayUrl(`http://${host}:8443/v1`), null, `${host} was refused over plain http`)
  }
  // A non-loopback http base is refused: the relay credential would cross a
  // network the operator did not choose.
  for (const host of ['192.168.1.10', '10.0.0.5', 'relay.example']) {
    assert.equal(relayUrl(`http://${host}/v1`), null, `${host} was accepted over plain http`)
  }
  // Neither is a non-http scheme.
  assert.equal(relayUrl('ftp://relay.example/v1'), null)
  assert.equal(relayUrl('file:///v1'), null)
  assert.equal(relayUrl(''), null)
  assert.equal(relayUrl(undefined), null)
})

// ── the prefix ──────────────────────────────────────────────────────────────
check('a mount prefix is stripped only for routing', () => {
  assert.equal(stripPrefix('/v1/models', ''), '/v1/models')
  assert.equal(stripPrefix('/eac/v1/models', '/eac'), '/v1/models')
  // A prefix that exactly equals the path is a 404, not the root.
  assert.equal(stripPrefix('/eac', '/eac'), null)
  assert.equal(stripPrefix('/other/v1/models', '/eac'), null)
  // A pre-stripped path is not accepted under the prefix either.
  assert.equal(stripPrefix('/v1/models', '/eac'), null)
})

// ── the crypto helpers ──────────────────────────────────────────────────────
check('a constant-time compare is equal only for equal strings', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true)
  assert.equal(timingSafeEqual('abc', 'abd'), false)
  // A length difference short-circuits, and it is not a false positive.
  assert.equal(timingSafeEqual('abc', 'abcd'), false)
  assert.equal(timingSafeEqual('', ''), true)
})

check('the signature message is the four lines the plugin builds', async () => {
  const message = await signatureMessage('1800000000000', 'POST', '/v1/chat/completions', '{"model":"m"}')
  assert.equal(message, `1800000000000\nPOST\n/v1/chat/completions\n${await sha256Hex('{"model":"m"}')}`)
  // An empty body signs the empty string's digest, whichever route carries it:
  // the body digest is the part that does not depend on method or path, and it is
  // what makes a GET and a bodyless POST agree on a payload.
  assert.match(await signatureMessage('1800000000000', 'GET', '/v1/models', ''),
    new RegExp(`\n${await sha256Hex('')}$`))
  assert.match(await signatureMessage('1800000000000', 'POST', '/v1/chat/completions', ''),
    new RegExp(`\n${await sha256Hex('')}$`))
})

check('the digest is hex and stable', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(await sha256Hex('pong'), await sha256Hex('pong'))
})

// ── the relay request ───────────────────────────────────────────────────────
check('the relay request carries the credential and only two of the caller\'s headers', async () => {
  const request = relayRequest(new URL('https://relay.example/v1/models'), 'GET', '', false, 'application/json')
  assert.equal(request.url, 'https://relay.example/v1/models')
  assert.equal(request.headers.get('content-type'), 'application/json')
  assert.equal(request.headers.get('accept'), 'application/json')
  // The caller's own `authorization` is a header this provider does not
  // forward: the relay credential is attached by the caller of this helper.
  assert.equal(request.headers.get('authorization'), null)
})

check('a chat turn\'s relay request asks for the event stream', async () => {
  const request = relayRequest(new URL('https://relay.example/v1/chat/completions'), 'POST', '{"model":"m"}', true, null)
  assert.equal(request.headers.get('accept'), 'text/event-stream')
  // A caller's own accept wins, because a caller may answer a fold, not a stream.
  const folded = relayRequest(new URL('https://relay.example/v1/chat/completions'), 'POST', '{}', true, 'application/json')
  assert.equal(folded.headers.get('accept'), 'application/json')
})

// ── the error envelope ──────────────────────────────────────────────────────
check('a JSON error never mentions the upstream', () => {
  const response = jsonError(401, 'request signature rejected')
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  // The body names the lane's own reason, not the relay's status — that is what
  // keeps the upstream invisible to a caller probing the gateway.
  return response.text().then(text => {
    assert.deepEqual(JSON.parse(text), { error: { message: 'request signature rejected' } })
  })
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
