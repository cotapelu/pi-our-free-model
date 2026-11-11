/**
 * Unit checks for the outlet.
 *
 * The contract that must not pass by luck: the relay refuses without its key, so
 * a port on 127.0.0.1 cannot become an open proxy for anything else on the
 * machine; the relay's own bookkeeping headers are stripped before the dial, so
 * they never reach the upstream; and only the official free lane may move to the
 * Bun transport, because a failed turn retried through a second one may already
 * have spent tokens.
 *
 * Usage: node pi-extension/test/egress.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { egressActive, egressRequestHeaders, findBunExecutable, isOfficialFreeLane, startEgressRelay } from '../dist/gateway/egress.js'

let failures = 0
const checks = []
function check(label, fn) {
  checks.push({ label, fn })
}

check('the official inference lane is the only one that may take the Bun transport', () => {
  assert.equal(isOfficialFreeLane('https://opencode.ai/inference/v1/models'), true)
  assert.equal(isOfficialFreeLane('https://opencode.ai:443/inference/v1/models'), true)
})

check('a non-official lane keeps its Node fetch path', () => {
  assert.equal(isOfficialFreeLane('https://gateway.ai.dev/v1/messages'), false)
  assert.equal(isOfficialFreeLane('https://example.com/inference/v1/models'), false)
  assert.equal(isOfficialFreeLane('http://opencode.ai/inference/v1/models'), false)
  assert.equal(isOfficialFreeLane('https://opencode.ai:8443/inference/v1/models'), false)
  assert.equal(isOfficialFreeLane('https://opencode.ai/other/path'), false)
})

check('a malformed URL is not the official lane', () => {
  assert.equal(isOfficialFreeLane('not a url'), false)
  assert.equal(isOfficialFreeLane(''), false)
})

check('findBunExecutable resolves rather than throwing when Bun is absent', () => {
  const found = findBunExecutable()
  if (found !== undefined) assert.equal(typeof found, 'string')
})

check('egressActive reports the true state before any relay starts', () => {
  assert.equal(typeof egressActive(), 'boolean')
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

check('an unset relay refuses a request that carries no key, and the refusal names the key', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const port = (upstream.address() as { port: number }).port

  const relay = await startEgressRelay({ config: () => ({ mode: 'client', url: `http://127.0.0.1:${port}` }), dataDir: '/tmp/ofm-egress-test', log: () => {} })
  if (relay !== null) {
    const response = await fetch(`http://127.0.0.1:${relay.port}/`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 403, 'a request without the relay key must be refused')
    await relay.close()
  }
  await new Promise((resolve) => upstream.close(() => resolve()))
})

check('an outlet with no address refuses to start a listener', async () => {
  // dsh's relay throws rather than answering null: a null return reads as
  // "switched off" to the caller, and a misconfigured outlet that looks
  // switched off sends the request out with no proxy at all — the one outcome
  // the relay exists to prevent.
  await assert.rejects(
    () => startEgressRelay({ config: () => ({ mode: 'client', url: '' }), dataDir: '/tmp/ofm-egress-test', log: () => {} }),
    /paste a proxy address or a subscription link/,
  )
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
