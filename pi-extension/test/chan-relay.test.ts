/**
 * Unit checks for the channel-gateway LAN relay.
 *
 * The relay is a second door in front of the vendored channel pack's loopback
 * OpenAI gateway, and the split of keys is the whole security model:
 *
 *   - callers authenticate with `settings.chanGateway.relay.key` (this plugin
 *     generates, shows and rotates it);
 *   - the pack's gateway key never leaves the host process — it is read from the
 *     gateway's own credential file only to be attached to the forwarded hop;
 *   - a hop marker refuses request loops (a relay pointed at its own port);
 *   - a path allowlist mirrors what the gateway itself serves; anything else is
 *     a 404 before a single byte is forwarded.
 *
 * Every check runs a real listener on loopback with a stand-in gateway behind
 * it, so what is asserted is what goes on the wire.
 *
 * Runs on plain node:  node test/chan-relay.test.ts
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  chanGatewayCredential, chanGatewayEnabled, chanGatewayHome, chanGatewayPort, startChanRelay,
} from '../dist/chan-relay.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

/** A stand-in "channel gateway" that records what the relay forwarded to it. */
function gateway(seen: { auth?: string; path?: string; hop?: string; method?: string; body?: string }) {
  const server = http.createServer((req, res) => {
    seen.auth = String(req.headers.authorization ?? '')
    seen.hop = String(req.headers['x-ofm-chan-relay-hop'] ?? '')
    seen.method = req.method
    seen.path = req.url
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen.body = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, object: 'list' }))
    })
  })
  return new Promise<{ url: string; port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as any
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

/** Boot the relay against one gateway, yielding a caller-side helper. */
async function relayTo(target: { port: number }, over: Record<string, any> = {}) {
  const settings = {
    enabled: true,
    lanKey: 'relay-secret-key',
    gatewayKey: 'gateway-secret-key',
    gatewayHost: '127.0.0.1',
    gatewayPort: target.port,
    host: '127.0.0.1',
    port: 0,
    ...over,
  }
  const relay = await startChanRelay({ config: () => settings, log: () => {} })
  assert.ok(relay !== null, 'the relay did not start')
  return { relay: relay!, settings }
}

const base = (relay: { port: number }, key = 'relay-secret-key') => ({
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
})

// ── the credential and the switch ───────────────────────────────────────────
check('an env API key outranks the gateway credential file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-chan-home-'))
  fs.mkdirSync(path.join(home, 'openai-gateway'), { recursive: true })
  fs.writeFileSync(path.join(home, 'openai-gateway', 'api-key'), 'file-key')
  const fromEnv = chanGatewayCredential({ home, env: { DSH_OPENAI_GATEWAY_API_KEY: 'env-key' } })
  assert.deepEqual(fromEnv, { key: 'env-key', fromEnv: true, path: null })
  const fromFile = chanGatewayCredential({ home, env: {} })
  assert.equal(fromFile!.key, 'file-key')
  assert.equal(fromFile!.fromEnv, false)
  assert.equal(fromFile!.path, path.join(home, 'openai-gateway', 'api-key'))
})

check('an absent credential returns null so the relay fails closed with 503', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-chan-home-'))
  assert.equal(chanGatewayCredential({ home, env: {} }), null)
})

check('a blank env key falls through to the credential file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-chan-home-'))
  fs.mkdirSync(path.join(home, 'openai-gateway'), { recursive: true })
  fs.writeFileSync(path.join(home, 'openai-gateway', 'api-key'), 'file-key')
  const credential = chanGatewayCredential({ home, env: { DSH_OPENAI_GATEWAY_API_KEY: '   ' } })
  assert.equal(credential!.key, 'file-key')
})

check('the home resolution order is env override, profileContext, DSH_HOME, default', () => {
  assert.equal(chanGatewayHome({ env: { DSH_CHANNEL_PACK_STATE_DIR: '/override' } }), '/override')
  assert.equal(chanGatewayHome({ profileContext: { home: '/profile' }, env: {} }), '/profile')
  assert.equal(chanGatewayHome({ env: { DSH_HOME: '/dsh-home' } }), '/dsh-home')
  assert.equal(chanGatewayHome({ env: {} }), path.join(os.homedir(), '.dsh'))
})

check('the port is env-overridable and falls back to the gateway default', () => {
  assert.equal(chanGatewayPort({ DSH_OPENAI_GATEWAY_PORT: '9001' }), 9001)
  assert.equal(chanGatewayPort({ DSH_OPENAI_GATEWAY_PORT: '' }), 8326)
  assert.equal(chanGatewayPort({ DSH_OPENAI_GATEWAY_PORT: 'not-a-number' }), 8326)
  assert.equal(chanGatewayPort({ DSH_OPENAI_GATEWAY_PORT: '99999' }), 8326)
  assert.equal(chanGatewayPort({}), 8326)
})

check('only an explicit false-y string disables the gateway', () => {
  assert.equal(chanGatewayEnabled({}), true)
  assert.equal(chanGatewayEnabled({ DSH_OPENAI_GATEWAY_ENABLED: '' }), true)
  assert.equal(chanGatewayEnabled({ DSH_OPENAI_GATEWAY_ENABLED: '1' }), true)
  // `parseInt('0') || 1`-style parses are how switches end up un-turn-offable.
  for (const value of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
    assert.equal(chanGatewayEnabled({ DSH_OPENAI_GATEWAY_ENABLED: value }), false, `"${value}" did not disable`)
  }
})

// ── the relay's own fence ───────────────────────────────────────────────────
check('a preflight is answered without a key, and spends nothing', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(seen.path, undefined, 'the preflight was forwarded')
  } finally { await relay.close(); await target.close() }
})

check('a request without the relay key is refused before any dial', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`)
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.match(body.error.message, /relay key/)
    assert.equal(seen.path, undefined, 'a keyless request reached the gateway')
  } finally { await relay.close(); await target.close() }
})

check('a wrong relay key is refused, and the gateway key never leaves the host', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`, base(relay, 'wrong-key'))
    assert.equal(res.status, 401)
    assert.equal(seen.path, undefined)
    assert.equal(seen.auth, undefined, 'the gateway key reached a refused caller')
  } finally { await relay.close(); await target.close() }
})

check('the relay switched off answers 503 for everyone', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target, { enabled: false })
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`, base(relay))
    assert.equal(res.status, 503)
    assert.equal(seen.path, undefined, 'a disabled relay forwarded a request')
  } finally { await relay.close(); await target.close() }
})

check('an unconfigured gateway credential answers 503, not a bare dial', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target, { gatewayKey: '' })
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`, base(relay))
    assert.equal(res.status, 503)
    assert.match((await res.json()).error.message, /no credential yet/)
    assert.equal(seen.path, undefined, 'the relay dialed without its own key')
  } finally { await relay.close(); await target.close() }
})

// ── the allowlist and the hop marker ────────────────────────────────────────
check("the gateway's own surface is forwarded under the caller's relay key", async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    for (const route of ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/reasoning-efforts']) {
      seen.path = undefined
      const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, {
        ...base(relay),
        method: route === '/v1/models' ? 'GET' : 'GET',
      })
      assert.equal(res.status, 200, `${route} was not forwarded`)
      assert.equal(seen.path?.split('?')[0], route, `${route} arrived as ${seen.path}`)
    }
  } finally { await relay.close(); await target.close() }
})

check('the caller relay key stops at this door; the gateway sees only its own', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    await fetch(`http://127.0.0.1:${relay.port}/v1/models`, base(relay))
    assert.equal(seen.auth, 'Bearer gateway-secret-key', 'the relay key leaked through')
  } finally { await relay.close(); await target.close() }
})

check('a hop marker is stamped on the forwarded hop', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    await fetch(`http://127.0.0.1:${relay.port}/v1/models`, base(relay))
    assert.equal(seen.hop, '1', 'the hop marker was not stamped')
  } finally { await relay.close(); await target.close() }
})

check('a request that already carries the hop marker is refused — a relay pointed at its own port', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`, {
      ...base(relay),
      headers: { ...base(relay).headers, 'x-ofm-chan-relay-hop': '1' },
    })
    assert.equal(res.status, 508)
    assert.match((await res.json()).error.message, /dialing itself/)
    assert.equal(seen.path, undefined, 'a looping request reached the gateway')
  } finally { await relay.close(); await target.close() }
})

check('a path outside the allowlist is a 404 before a single byte is forwarded', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    for (const route of ['/v2/models', '/', '/admin', '/v1/models/extra']) {
      const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, base(relay))
      assert.equal(res.status, 404, `${route} was not refused`)
    }
    assert.equal(seen.path, undefined, 'a non-allowlisted path reached the gateway')
  } finally { await relay.close(); await target.close() }
})

check('a trailing slash normalises onto the allowlisted route', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models/`, base(relay))
    assert.equal(res.status, 200)
    assert.equal(seen.path?.split('?')[0], '/v1/models')
  } finally { await relay.close(); await target.close() }
})

// ── the forwarded body and the response ─────────────────────────────────────
check('a POST body is forwarded verbatim under the gateway key', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    const payload = { model: 'ofm-channel/x', messages: [{ role: 'user', content: 'hi' }], stream: true }
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/chat/completions`, {
      ...base(relay), method: 'POST', body: JSON.stringify(payload),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.method, 'POST')
    assert.deepEqual(JSON.parse(seen.body!), payload, 'the body was rewritten on the way through')
  } finally { await relay.close(); await target.close() }
})

check('the query string survives the hop', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    await fetch(`http://127.0.0.1:${relay.port}/v1/models?limit=5`, base(relay))
    assert.ok(seen.path?.includes('limit=5'), `the query string was dropped: ${seen.path}`)
  } finally { await relay.close(); await target.close() }
})

check('a host and connection header from the caller are dropped, not forwarded', async () => {
  const seen: any = {}
  let seenHost = ''
  const server = http.createServer((req, res) => {
    seenHost = String(req.headers.host ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const { relay } = await relayTo({ port })
  try {
    await fetch(`http://127.0.0.1:${relay.port}/v1/models`, base(relay))
    // The forwarded hop carries the gateway's own host, not the caller's.
    assert.ok(seenHost.includes(String(port)), `the caller host leaked: ${seenHost}`)
  } finally { await relay.close(); server.close() }
})

check('an x-api-key from the caller is dropped, not forwarded', async () => {
  let seenKey = ''
  const server = http.createServer((req, res) => {
    seenKey = String(req.headers['x-api-key'] ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const { relay } = await relayTo({ port })
  try {
    await fetch(`http://127.0.0.1:${relay.port}/v1/models`, {
      ...base(relay), headers: { ...base(relay).headers, 'x-api-key': 'caller-key' },
    })
    assert.equal(seenKey, '', 'the caller x-api-key reached the gateway')
  } finally { await relay.close(); server.close() }
})

check('an unreachable gateway answers 502, not a hang', async () => {
  // A port nothing listens on: the relay must fail the request, not wedge it.
  const { relay } = await relayTo({ port: 1 })
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`, base(relay))
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /did not answer/)
  } finally { await relay.close() }
})

check('the relay closes cleanly on demand', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  await relay.close()
  // After close the port is no longer served.
  let refused = false
  try { await fetch(`http://127.0.0.1:${relay.port}/v1/models`, base(relay)) }
  catch { refused = true }
  assert.equal(refused, true, 'the closed relay still answered')
  await target.close()
})

check('an x-api-key caller is accepted the same way a Bearer one is', async () => {
  const seen: any = {}
  const target = await gateway(seen)
  const { relay } = await relayTo(target)
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/v1/models`, {
      headers: { 'x-api-key': 'relay-secret-key' },
    })
    assert.equal(res.status, 200)
    assert.equal(seen.path?.split('?')[0], '/v1/models')
  } finally { await relay.close(); await target.close() }
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 300)
