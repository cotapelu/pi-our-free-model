/**
 * Unit checks for the outlet relay that fronts the egress relay.
 *
 * The relay is on loopback, strips its own two headers before dialing, and a
 * request without the key is refused *before any connection* — that last part
 * is the whole point: a listener on 127.0.0.1 must not become an open proxy
 * for anything else on the machine.
 *
 * Every check starts a real listener and a real stand-in target, so what is
 * asserted is what goes on the wire.
 *
 * Runs on plain node:  node test/egress-relay.test.ts
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { egressRequestHeaders, startEgressRelay } from '../dist/gateway/egress.js'

let failures = 0
// Checks run one at a time, in registration order. The relay keeps a single
// module-global "the running relay", so two checks that start a relay each
// would race for it: the second start overwrites the first, and the first's
// requests are then refused with the second's key. Same discipline the other
// suites here use (`running = running.then(...)`), and the same reason: a suite
// that reads as green while its checks trample each other is worse than one
// that fails loudly.
let running: Promise<void> = Promise.resolve()
const check = (label: string, fn: () => void | Promise<void>) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}
/** A ref'd keep-alive so the process stays up until the last check reports. */
const keepAlive = setInterval(() => {}, 500)

/** A stand-in target recording what the relay dialed it with. */
function target(seen: { path?: string; target?: string; relayKey?: string; method?: string }) {
  const server = http.createServer((req, res) => {
    seen.path = req.url
    seen.method = req.method
    seen.target = String(req.headers['x-ofm-egress-target'] ?? '')
    seen.relayKey = String(req.headers['x-ofm-egress-key'] ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      resolve({ port, close: () => new Promise(done => server.close(() => done())) })
    })
  })
}

/** Boot the relay pointing at one target. */
async function relayTo(upstream: { port: number }) {
  // The relay's own key is minted per start, so a caller must learn it. The
  // module generates it internally; the relay is only reachable through
  // `egressRequestHeaders`, which is how the real callers attach it.
  const relay = await startEgressRelay({ config: () => ({ mode: 'client', url: `http://127.0.0.1:${upstream.port}` }), dataDir: '/tmp/ofm-egress-test', log: () => {} })
  assert.ok(relay !== null, 'the relay did not start')
  return relay!
}

/**
 * The two headers a real caller attaches for one hop.
 *
 * The relay mints its key per start and rides it on the return, so this is the
 * only shape a caller can produce — and the reason the key is returned at all.
 */
function hopHeaders(url: string, relayKey: string) {
  return egressRequestHeaders({
    'content-type': 'application/json',
    'x-ofm-egress-target': url,
    'x-ofm-egress-key': relayKey,
  })
}

check('an outlet with no address refuses to start a listener', async () => {
  await assert.rejects(
    () => startEgressRelay({ config: () => ({ mode: 'client', url: '' }), dataDir: '/tmp/ofm-egress-test', log: () => {} }),
    /paste a proxy address or a subscription link/,
  )
})

check('a URL that is not a URL starts no relay', async () => {
  await assert.rejects(
    () => startEgressRelay({ config: () => ({ mode: 'client', url: 'not a url' }), dataDir: '/tmp/ofm-egress-test', log: () => {} }),
    /Invalid URL|proxy|scheme/i,
    'an unparseable outlet URL started a listener',
  )
})

check('the relay strips its own target and key from the outgoing headers', () => {
  const cleaned = egressRequestHeaders({
    'content-type': 'application/json',
    'x-ofm-egress-target': 'http://127.0.0.1:9000/v1/messages',
    'x-ofm-egress-key': 'ofm-egress-secret',
    'X-Ofm-Egress-Key': 'ofm-egress-secret',
  })
  assert.equal(cleaned['content-type'], 'application/json')
  assert.equal(cleaned['x-ofm-egress-target'], undefined)
  assert.equal(cleaned['x-ofm-egress-key'], undefined)
  assert.equal(cleaned['X-Ofm-Egress-Key'], undefined)
})

check('hop-by-hop headers leave, so a foreign chunked marker cannot double-frame', () => {
  const cleaned = egressRequestHeaders({
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    'proxy-authorization': 'Basic abc',
    te: 'trailers',
    upgrade: 'h2c',
    'content-length': '42',
  })
  assert.equal(cleaned.connection, undefined)
  assert.equal(cleaned['transfer-encoding'], undefined)
  assert.equal(cleaned['proxy-authorization'], undefined)
  assert.equal(cleaned.te, undefined)
  assert.equal(cleaned.upgrade, undefined)
  assert.equal(cleaned['content-length'], '42')
})

check('a repeated header is joined the way the wire carries it', () => {
  const cleaned = egressRequestHeaders({ 'x-custom': ['a', 'b'] })
  assert.equal(cleaned['x-custom'], 'a, b')
})

check('the only official free lane may take the Bun transport', async () => {
  const { isOfficialFreeLane } = await import('../dist/gateway/egress.js')
  assert.equal(isOfficialFreeLane('https://opencode.ai/inference/v1/models'), true)
  assert.equal(isOfficialFreeLane('https://opencode.ai:443/inference/v1/models'), true)
  // A failed turn retried through a second transport may already have spent
  // tokens, so only the one lane that needs it gets it.
  assert.equal(isOfficialFreeLane('https://gateway.ai.dev/v1/messages'), false)
  assert.equal(isOfficialFreeLane('http://opencode.ai/inference/v1/models'), false)
  assert.equal(isOfficialFreeLane('https://opencode.ai:8443/inference/v1/models'), false)
  assert.equal(isOfficialFreeLane('https://opencode.ai/other/path'), false)
  assert.equal(isOfficialFreeLane('not a url'), false)
  assert.equal(isOfficialFreeLane(''), false)
})

check('the relay hands its key to the caller that started it', async () => {
  const upstream = await target({})
  const relay = await relayTo(upstream)
  try {
    // A relay whose mint the caller never sees is a relay the caller cannot use.
    assert.ok(typeof relay.key === 'string' && relay.key.length > 0, 'the relay minted no key')
    // dsh mints a bare 32-hex key per start — no prefix. The prefix the
    // old stub used was never part of the contract.
    assert.match(relay.key, /^[0-9a-f]{32}$/, `the key is not a bare 32-hex mint: ${relay.key}`)
  } finally { await relay.close(); await upstream.close() }
})

check('a hop without the relay key is refused before any connection', async () => {
  const seen: any = {}
  const upstream = await target(seen)
  const relay = await relayTo(upstream)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 403)
    assert.equal(seen.path, undefined, 'a keyless request was dialed onward')
  } finally { await relay.close(); await upstream.close() }
})

check('a hop with a wrong relay key is refused the same way', async () => {
  const seen: any = {}
  const upstream = await target(seen)
  const relay = await relayTo(upstream)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/`, {
      method: 'POST',
      headers: { 'x-ofm-egress-key': 'ofm-egress-not-the-key' },
      body: '{}',
    })
    assert.equal(res.status, 403)
    assert.equal(seen.path, undefined, 'a bad-key request was dialed onward')
  } finally { await relay.close(); await upstream.close() }
})

check('a hop with no target header is refused after the key, not dialed', async () => {
  const seen: any = {}
  const upstream = await target(seen)
  const relay = await relayTo(upstream)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/`, {
      method: 'POST',
      headers: { 'x-ofm-egress-key': relay.key },
      body: '{}',
    })
    assert.equal(res.status, 400)
    assert.equal(seen.path, undefined, 'a targetless request was dialed onward')
  } finally { await relay.close(); await upstream.close() }
})

check('the relay closes cleanly on demand', async () => {
  const upstream = await target({})
  const relay = await relayTo(upstream)
  await relay.close()
  let refused = false
  try { await fetch(`http://127.0.0.1:${relay.port}/`, { method: 'POST', body: '{}' }) }
  catch { refused = true }
  assert.equal(refused, true, 'the closed relay still answered')
  await upstream.close()
})

check('findBunExecutable resolves rather than throwing when Bun is absent', async () => {
  const { findBunExecutable } = await import('../dist/gateway/egress.js')
  const found = findBunExecutable()
  assert.ok(found === undefined || typeof found === 'string')
})

// The report waits for the chain, not for a wall clock: a fixed 300 ms timeout
// reported on a slow machine before the checks had run, and a fast one before
// the last microtask settled.
void running.then(() => {
  clearInterval(keepAlive)
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exitCode = 1 }
  else console.log('\nALL CHECKS PASSED')
})
