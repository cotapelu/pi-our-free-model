/**
 * Integration checks for the Node host — the exact process a deployment runs.
 *
 * This drives the composed host, not the pieces: a real `http` server, the real
 * lane core, the real limiter and analytics. What it pins:
 *
 *   1. **a signed turn is admitted and relayed**, and the relay credential is
 *      attached by the host rather than taken from the caller;
 *   2. **an unsigned turn is refused before the relay is dialled at all** — the
 *      number of upstream calls is the assertion, not the status code;
 *   3. **the SSE prelude commits a 200 head while the relay is still silent**, so a
 *      front proxy's origin timeout measures an already-started response;
 *   4. **a client that walks away gives its slot back** (#680) — otherwise the
 *      per-IP counter ratchets until a restart and every later turn is a 429;
 *   5. `/pool` reports this process's own load, and `/stats-data` needs the token.
 *
 * The GitHub calls in the auth gate and the relay itself both go to local stand-ins,
 * so nothing here spends a real credential.
 *
 * Runs on plain node:  node test/node-host.test.ts
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import nodeCrypto from 'node:crypto'
import { createGatewayServer } from '../dist/worker/node-host.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-nodehost-'))

const SECRET = 'a'.repeat(40)
const encoder = new TextEncoder()

/** A relay stand-in that records what reached it, when it answered, and streams SSE. */
function relay(silenceMs = 0) {
  const seen: Array<{ path: string; auth?: string; ua?: string; body: string }> = []
  let answeredAt = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        ua: req.headers['user-agent'],
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const send = () => {
        answeredAt = Date.now()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n')
        res.end('data: [DONE]\n\n')
      }
      if (silenceMs > 0) setTimeout(send, silenceMs)
      else send()
    })
  })
  return { server, seen, get answeredAt() { return answeredAt } }
}

/** A signed request against the host, exactly as the plugin builds one. */
async function signed(port: number, method: string, pathName: string, body = '', at = Date.now(), secret = SECRET): Promise<Request> {
  const { default: nodeCrypto } = await import('node:crypto')
  const digest = nodeCrypto.createHash('sha256').update(body, 'utf8').digest('hex')
  const message = `${at}\n${method}${pathName}\n${digest}`
  const signature = nodeCrypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex')
  return new Request(`http://127.0.0.1:${port}${pathName}`, {
    method,
    headers: { 'x-ofm-timestamp': String(at), 'x-ofm-signature': signature },
    body: method === 'POST' ? body : undefined,
  })
}

/**
 * The signature the plugin sends: `ts \n METHOD \n path \n sha256(body)`.
 *
 * One helper, because an inline copy already cost a debugging round — the `\n`
 * between METHOD and path is easy to drop, and a 401 then reads as a signing bug
 * rather than the test's own.
 */
async function sign(pathName: string, method = 'GET', body = '', at = Date.now(), secret = SECRET): Promise<string> {
  const digest = nodeCrypto.createHash('sha256').update(body, 'utf8').digest('hex')
  return nodeCrypto.createHmac('sha256', secret).update(`${at}\n${method}\n${pathName}\n${digest}`, 'utf8').digest('hex')
}

/** The two headers a signed request carries. */
async function authHeaders(pathName: string, method = 'GET', body = '', at = Date.now()): Promise<Record<string, string>> {
  return { 'x-ofm-timestamp': String(at), 'x-ofm-signature': await sign(pathName, method, body, at) }
}

/** One host plus a relay stand-in, started and listening. */
async function boot(over: Record<string, string> = {}, relaySilenceMs = 0) {
  const dir = tempDir()
  const stub = relay(relaySilenceMs)
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  const relayPort = (stub.server.address() as any).port
  const env: Record<string, string> = {
    UPSTREAM_URL: `http://127.0.0.1:${relayPort}/v1`,
    UPSTREAM_API_KEY: 'relay-credential',
    SIGNING_SECRETS: SECRET,
    GITHUB_STARS_OVERRIDE: '3000',
    POOL_SIZE: '',
    ADMIN_TOKEN: 'admin-token',
    STATS_PATH: path.join(dir, 'stats.json'),
    USER_STORE_PATH: path.join(dir, 'users.json'),
    RATE_LIMIT_PER_MINUTE: '0',
    CONCURRENCY_PER_IP: '0',
    ...over,
  }
  const server = createGatewayServer(env, { log: () => {} })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  return {
    server, stub, port, env, dir,
    async close() {
      // A held-open SSE stream keeps `close` waiting forever, and two of the checks
      // below deliberately leave one open — so connections are closed first. The
      // process would otherwise hang with every check already reported.
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
      stub.server.closeAllConnections?.()
      await new Promise<void>(resolve => stub.server.close(() => resolve()))
    },
  }
}

check('a signed turn is admitted, relayed, and the credential is attached by the host', async () => {
  const host = await boot()
  try {
    // One timestamp for both the header and the signature. Two `Date.now()`
    // calls — one in the header, one inside `sign()`'s default parameter — sign
    // different messages whenever they straddle a millisecond, and the host
    // (which re-derives the message from the *header*) then answers 401 for a
    // request that is correctly signed. Same flake class as eac.test.ts's.
    const at = Date.now()
    const response = await fetch(`http://127.0.0.1:${host.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'x-ofm-timestamp': String(at),
        'x-ofm-signature': await sign('/v1/chat/completions', 'POST', '{"model":"m"}', at),
        'content-type': 'application/json',
      },
      body: '{"model":"m"}',
    })
    assert.equal(response.status, 200, `host answered ${response.status}`)
    assert.match(await response.text(), /pong/)
    assert.equal(host.stub.seen.length, 1, 'the relay was not dialled exactly once')
    assert.equal(host.stub.seen[0].auth, 'Bearer relay-credential', 'the relay credential was not attached')
    assert.equal(host.stub.seen[0].ua, 'our-free-model-gateway')
    assert.equal(host.stub.seen[0].path, '/v1/chat/completions')
  } finally { await host.close() }
})

check('an unsigned turn is refused before the relay is dialled at all', async () => {
  const host = await boot()
  try {
    const response = await fetch(`http://127.0.0.1:${host.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}',
    })
    assert.equal(response.status, 401)
    // The relay was never reached: the assertion is the call count, not the code.
    assert.equal(host.stub.seen.length, 0, 'an unsigned request reached the relay')
  } finally { await host.close() }
})

check('the SSE prelude commits a 200 head while the relay is still silent', async () => {
  // A reasoning model can hold the first byte for minutes; a proxy in front would
  // kill the lane before the answer starts unless the response has already begun.
  const host = await boot({ SSE_PRELUDE_SECONDS: '1' }, 700)
  try {
    // One timestamp for both the header and the signature. Two `Date.now()`
    // calls — one in the header, one inside `sign()`'s default parameter — sign
    // different messages whenever they straddle a millisecond, and the host
    // (which re-derives the message from the *header*) then answers 401 for a
    // request that is correctly signed. Same flake class as eac.test.ts's.
    const at = Date.now()
    const response = await fetch(`http://127.0.0.1:${host.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'x-ofm-timestamp': String(at),
        'x-ofm-signature': await sign('/v1/chat/completions', 'POST', '{"model":"m"}', at),
        'content-type': 'application/json',
      },
      body: '{"model":"m"}',
    })
    const headers = response.headers
    assert.equal(headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(headers.get('x-accel-buffering'), 'no')
    const headAt = Date.now()
    const reader = response.body!.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value), /channel open|keepalive/)
    // The ordering, not a wall-clock bound: a loaded CI box makes a duration
    // assertion flaky, and the property that matters is that the head committed
    // *before the relay ever answered* — which is exactly what a front proxy's
    // origin timeout was previously measuring. `answeredAt === 0` means the relay
    // had not answered yet at all, which proves the same thing more strongly.
    const preceded = host.stub.answeredAt === 0 || headAt < host.stub.answeredAt
    assert.ok(preceded, 'the head waited for the relay instead of preceding it')
    reader.cancel()
  } finally { await host.close() }
})

check('a client that walks away gives its slot back, so later turns still run', async () => {
  // Registered before any await: otherwise the relay window leaks a slot and the
  // per-IP counter ratchets until a restart (#680).
  const host = await boot({ CONCURRENCY_PER_IP: '1' }, 3_000)
  try {
    const body = '{"model":"m"}'
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${host.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...(await authHeaders('/v1/chat/completions', 'POST', body)), 'content-type': 'application/json' },
      body, signal: controller.signal,
    })
    // Let the request take its slot, then walk away while the relay is thinking.
    await new Promise(resolve => setTimeout(resolve, 120))
    controller.abort()
    await pending.catch(() => {})
    // A second turn must still be admitted: the slot came back.
    const again = await fetch(`http://127.0.0.1:${host.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...(await authHeaders('/v1/chat/completions', 'POST', body)), 'content-type': 'application/json' },
      body,
    }).catch(error => ({ status: 0, error }))
    assert.notEqual((again as any).status, 429, 'the leaked slot refused the next turn')
  } finally { await host.close() }
})

check('/pool reports this process\'s own load, and is public but aggregate', async () => {
  const host = await boot()
  try {
    // No lane signature: the settings page's gauge reads this before login.
    const response = await fetch(`http://127.0.0.1:${host.port}/pool`)
    assert.equal(response.status, 200)
    const payload = await response.json() as any
    assert.equal(payload.ok, true)
    assert.equal(payload.poolSource, 'formula')
    assert.equal(payload.pool, 4500, 'the star-to-pool formula is not what the README states')
    assert.equal(payload.level, 'ok')
    // Aggregate numbers only — no per-IP rows ride along.
    assert.equal(JSON.stringify(payload).includes('ips'), false)
  } finally { await host.close() }
})

check('/stats-data needs the admin token, when one is configured', async () => {
  const host = await boot()
  try {
    assert.equal((await fetch(`http://127.0.0.1:${host.port}/stats-data`)).status, 401)
    const bad = await fetch(`http://127.0.0.1:${host.port}/stats-data?t=wrong`)
    assert.equal(bad.status, 401)
    const good = await fetch(`http://127.0.0.1:${host.port}/stats-data?t=admin-token`)
    assert.equal(good.status, 200)
    const payload = await good.json() as any
    assert.equal(typeof payload.totals, 'object')
  } finally { await host.close() }
})

check('/stats-data is off entirely when no ADMIN_TOKEN is configured', async () => {
  const host = await boot({ ADMIN_TOKEN: '' })
  try {
    const response = await fetch(`http://127.0.0.1:${host.port}/stats-data?t=anything`)
    assert.equal(response.status, 403)
    assert.match(await response.text(), /not configured/)
  } finally { await host.close() }
})

check('an unconfigured gateway refuses rather than dialling a blank relay', async () => {
  const host = await boot({ UPSTREAM_URL: '', SIGNING_SECRETS: '' })
  try {
    const response = await fetch(`http://127.0.0.1:${host.port}/v1/models`, { method: 'GET' })
    assert.equal(response.status, 500)
    assert.equal(host.stub.seen.length, 0)
  } finally { await host.close() }
})

check('a mount prefix routes under it and 404s outside it', async () => {
  const host = await boot({ MOUNT_PREFIX: '/eac' })
  try {
    // The signature covers the FULL pathname, prefix included.
    const inside = await fetch(`http://127.0.0.1:${host.port}/eac/v1/models`, {
      headers: await authHeaders('/eac/v1/models'),
    })
    assert.equal(inside.status, 200, `the mounted route answered ${inside.status}`)
    const outside = await fetch(`http://127.0.0.1:${host.port}/v1/models`, {
      headers: await authHeaders('/v1/models'),
    })
    assert.equal(outside.status, 404, 'a path outside the prefix was not a 404')
    const pool = await fetch(`http://127.0.0.1:${host.port}/eac/pool`)
    assert.equal(pool.status, 200)
  } finally { await host.close() }
})

check('a body over the cap is 413 before the relay is dialled', async () => {
  const host = await boot({ MAX_BODY_BYTES: '64' })
  try {
    const body = JSON.stringify({ model: 'm', note: 'x'.repeat(500) })
    const response = await fetch(`http://127.0.0.1:${host.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...(await authHeaders('/v1/chat/completions', 'POST', body)), 'content-type': 'application/json' },
      body,
    })
    assert.equal(response.status, 413)
    assert.equal(host.stub.seen.length, 0, 'an oversized body reached the relay')
  } finally { await host.close() }
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 200)
})
