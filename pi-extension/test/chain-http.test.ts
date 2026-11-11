/**
 * Unit checks for chain failover, driven through the gateway over HTTP.
 *
 * A chain is one selectable name whose links are tried in order and the first
 * one that answers wins. The whole design lives in the commit rule, so these
 * checks are about what a *caller* can observe:
 *
 *   1. **a failed link is discarded whole** — the caller never sees a byte of
 *      it, so switching models is invisible;
 *   2. **reasoning is not the answer** — a candidate that thinks for a long time
 *      and then hits a quota wall is exactly the case worth failing over, so its
 *      held thinking must be dropped rather than committing the chain to it;
 *   3. **a refusal that a replay would reproduce is not advanceable** — a bad
 *      parameter or a non-retryable auth refusal ends the turn, it does not walk
 *      the rest of the chain;
 *   4. **exhausting every candidate is one honest error**, and the message
 *      names what was tried.
 *
 * Every check drives the gateway over a real loopback listener against a
 * stand-in upstream, so nothing dials a provider and no quota is spent.
 *
 * Runs on plain node:  node test/chain-http.test.ts
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway } from '../dist/gateway/server.js'
import { generateKey } from '../dist/gateway/protocol.js'
import { buildLaneModels } from '../dist/gateway/dispatch.js'
import { normalizeChains } from '../dist/chains.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

const GOOD_SSE = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"pong"}}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
  'data: [DONE]',
  '',
].join('\n\n')

/** Reasoning only, then a clean stop: the shape recovery and failover exist for. */
const THINK_ONLY_SSE = [
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"a long private analysis"}}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  '',
].join('\n\n')

/** One upstream that answers per model, recording what reached it. */
function standIn() {
  const seen: Array<{ path: string; model: string; auth?: string }> = []
  const calls = new Map<string, number>()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      let model = ''
      try { model = String(JSON.parse(body || '{}').model ?? '') } catch { /* a malformed body is still a call */ }
      seen.push({ path: url.pathname, model, auth: String(req.headers.authorization ?? '') })
      calls.set(model, (calls.get(model) ?? 0) + 1)
      const refuse = (status: number, message: string) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message, type: 'server_error' } }))
      }
      // The link that must be failed over: a quota wall after long thinking.
      if (model.endsWith('think-then-wall-free')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(THINK_ONLY_SSE)
        return
      }
      // A refusal a replay would reproduce: not advanceable, so the chain must
      // stop here rather than spend the same quota on the rest of its links.
      if (model.endsWith('bad-param-free')) {
        refuse(400, 'temperature must be a number')
        return
      }
      // A quota wall: advanceable, so the chain walks on to the next link.
      if (model.endsWith('rate-limited-free')) {
        refuse(429, 'FreeUsageLimitError: quota spent')
        return
      }
      // A non-retryable auth refusal: not advanceable either.
      if (model.endsWith('no-credential-free')) {
        refuse(401, 'INVALID_TOKEN')
        return
      }
      // A candidate that never answers at all.
      if (model.endsWith('silent-free')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(GOOD_SSE)
    })
  })
  return {
    seen, calls,
    listen: () => new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()).on('listening', () => resolve())),
    port: () => (server.address() as { port: number }).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function laneModels(base: string, ids: string[]) {
  return ids.map((id) => ({
    id,
    name: id,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
    baseUrl: base,
  } as any))
}

/** Boot a gateway whose both lanes answer from the same stand-in. */
async function gatewayOver(upstream: { port: () => number }, chainsRaw: any[], extraLinks: string[] = []) {
  const key = generateKey()
  const base = `http://127.0.0.1:${upstream.port()}`
  const gateway = await startGateway({
    settings: () => ({ host: '127.0.0.1', port: 0, enabled: true, key }),
    models: () => buildLaneModels([
      { id: 'ofm-kilo', models: laneModels(base, ['good-free', 'bad-param-free', 'rate-limited-free', 'no-credential-free', 'silent-free', ...extraLinks]) },
      { id: 'ofm-opencode', models: laneModels(base, ['good-free', 'think-then-wall-free', 'bad-param-free', 'rate-limited-free', 'no-credential-free', 'silent-free']) },
    ]),
    chains: () => normalizeChains(chainsRaw),
    log: () => {},
  })
  return { gateway, key, base: `http://127.0.0.1:${gateway.port}` }
}

const post = (base: string, key: string, body: Record<string, any>) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const CHAIN = { name: 'Fallback Chain', models: ['ofm-kilo/bad-param-free', 'ofm-kilo/good-free'], strategy: 'fallback' }

await check('a chain is advertised under its own name in the model list', async () => {
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [CHAIN])
  try {
    const rows = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).json()
    const ids = rows.data.map((row: any) => row.id)
    assert.ok(ids.some((id: string) => id.startsWith('ofm-chain/')), `no chain row: ${ids.join(', ')}`)
  } finally { await gateway.close(); await upstream.close() }
})

await check('a link that hit a quota wall is discarded whole and the second answers', async () => {
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [{ name: 'C', models: ['ofm-kilo/rate-limited-free', 'ofm-kilo/good-free'], strategy: 'fallback' }])
  try {
    const res = await post(base, key, { model: 'ofm-chain/c', messages: [{ role: 'user', content: 'hi' }], stream: false })
    assert.equal(res.status, 200, `the chain answered ${res.status}`)
    const document = await res.json()
    assert.equal(document.choices[0].message.content, 'pong')
    // Both links were really tried, in order.
    assert.deepEqual(upstream.calls.get('rate-limited-free'), 1)
    assert.deepEqual(upstream.calls.get('good-free'), 1)
    // The quota wall left nothing on the wire for the caller.
    assert.equal(JSON.stringify(document).includes('FreeUsageLimitError'), false, 'the discarded link leaked into the answer')
  } finally { await gateway.close(); await upstream.close() }
})

await check('a candidate that thinks then hits a wall is failed over', async () => {
  // "Thought for a minute, then hit the quota wall" is the single most valuable
  // case to fail over, so its held thinking must not commit the chain.
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [{ name: 'C', models: ['ofm-opencode/think-then-wall-free', 'ofm-kilo/good-free'], strategy: 'fallback' }])
  try {
    const res = await post(base, key, { model: 'ofm-chain/c', messages: [{ role: 'user', content: 'hi' }], stream: false })
    assert.equal(res.status, 200, `the chain answered ${res.status}`)
    const document = await res.json()
    assert.equal(document.choices[0].message.content, 'pong')
    // The held reasoning never reached the caller.
    assert.equal(JSON.stringify(document).includes('a long private analysis'), false, 'the dropped thinking leaked out')
  } finally { await gateway.close(); await upstream.close() }
})

await check('a streamed turn replays only the answering link frames', async () => {
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [{ name: 'C', models: ['ofm-kilo/rate-limited-free', 'ofm-kilo/good-free'], strategy: 'fallback' }])
  try {
    const res = await post(base, key, { model: 'ofm-chain/c', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await res.text()
    assert.match(text, /pong/, 'the answering link produced no text')
    assert.equal(text.includes('FreeUsageLimitError'), false, 'the discarded link leaked into the stream')
  } finally { await gateway.close(); await upstream.close() }
})

await check('a request-scoped refusal ends the turn instead of walking the chain', async () => {
  // A 400 a replay would reproduce benches nothing and advances nothing: walking
  // the rest of the chain would only spend the same quota to reach the same wall.
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [{ name: 'C', models: ['ofm-kilo/bad-param-free', 'ofm-kilo/good-free'], strategy: 'fallback' }])
  try {
    const res = await post(base, key, { model: 'ofm-kilo/bad-param-free', messages: [{ role: 'user', content: 'hi' }], stream: false })
    assert.equal(res.status, 400, `the request-scoped refusal was rewritten as ${res.status}`)
    const body = await res.json()
    assert.match(JSON.stringify(body), /temperature must be/, 'the provider own reason was lost')
    // The good link was never tried: nothing else in the chain could fix a bad parameter.
    assert.equal(upstream.calls.get('good-free'), undefined, 'the chain walked on a request-scoped refusal')
  } finally { await gateway.close(); await upstream.close() }
})

await check('a dead credential is account-scoped, so the chain walks to the next', async () => {
  // A 401 benches the *account* that presented it, not the request. The next
  // link is a different credential, so advancing is the right move — staying
  // would spend the turn on a door that is locked for good.
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [{ name: 'C', models: ['ofm-kilo/no-credential-free', 'ofm-opencode/good-free'], strategy: 'fallback' }])
  try {
    const res = await post(base, key, { model: 'ofm-chain/c', messages: [{ role: 'user', content: 'hi' }], stream: false })
    assert.equal(res.status, 200, `the chain answered ${res.status}`)
    assert.equal((await res.json()).choices[0].message.content, 'pong')
    assert.deepEqual(upstream.calls.get('no-credential-free'), 1, 'the dead credential was not tried once')
    assert.deepEqual(upstream.calls.get('good-free'), 1, 'the chain did not walk past the dead credential')
  } finally { await gateway.close(); await upstream.close() }
})

await check('a candidate that never answers is failed over, not hung on', async () => {
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [{ name: 'C', models: ['ofm-kilo/silent-free', 'ofm-kilo/good-free'], strategy: 'fallback' }])
  try {
    const res = await post(base, key, { model: 'ofm-chain/c', messages: [{ role: 'user', content: 'hi' }], stream: false })
    assert.equal(res.status, 200, `the silent link was not skipped: ${res.status}`)
    assert.equal((await res.json()).choices[0].message.content, 'pong')
  } finally { await gateway.close(); await upstream.close() }
})

await check('exhausting every candidate names what was tried', async () => {
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [{ name: 'C', models: ['ofm-kilo/silent-free', 'ofm-kilo/silent-free'], strategy: 'fallback' }], [])
  try {
    const res = await post(base, key, { model: 'ofm-chain/c', messages: [{ role: 'user', content: 'hi' }], stream: false })
    assert.equal(res.status, 502, `exhaustion answered ${res.status}`)
    const body = await res.json()
    assert.match(JSON.stringify(body), /exhausted/, 'the message did not say the chain was exhausted')
  } finally { await gateway.close(); await upstream.close() }
})

await check('a chain whose links all resolve nowhere is a picker entry that cannot answer', async () => {
  // `normalizeChains` drops a link that does not look like `provider/model`, so a
  // chain of garbage disappears from the list rather than failing at dispatch.
  const rows = normalizeChains([{ name: 'Ghost', models: ['not-an-address', 'ofm-kilo/good-free'], strategy: 'fallback' }])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].models, ['ofm-kilo/good-free'], 'a malformed link was kept')
  assert.deepEqual(normalizeChains([{ name: 'Empty', models: ['garbage'] }]), [], 'a chain with no valid link survived')
})

await check('an unknown chain address is a 404 that names it', async () => {
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [CHAIN])
  try {
    const res = await post(base, key, { model: 'ofm-chain/nope', messages: [{ role: 'user', content: 'hi' }], stream: false })
    assert.equal(res.status, 404)
    assert.match(JSON.stringify(await res.json()), /no such chain/)
  } finally { await gateway.close(); await upstream.close() }
})

await check('a disabled chain is not advertised and not dispatchable', async () => {
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [{ name: 'Off', models: ['ofm-kilo/good-free'], strategy: 'fallback', enabled: false }])
  try {
    const rows = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).json()
    assert.ok(!rows.data.some((row: any) => row.id.includes('off')), 'a disabled chain was advertised')
    const res = await post(base, key, { model: 'ofm-chain/off', messages: [{ role: 'user', content: 'hi' }], stream: false })
    assert.equal(res.status, 404, `a disabled chain answered ${res.status}`)
  } finally { await gateway.close(); await upstream.close() }
})

await check('quota readings reorder the chain without spending a request', async () => {
  // The `smart` strategy scores from cached readings; a stale or absent reading
  // decides nothing, so the order stays as configured.
  const upstream = standIn()
  await upstream.listen()
  const { gateway, key, base } = await gatewayOver(upstream, [])
  try {
    const now = new Date().toISOString()
    const readings = new Map<string, any>([
      // The head is exhausted, so the chain should hand the caller the second.
      ['ofm-kilo/good-free', { status: 'ok', checkedAt: now, windows: [{ kind: 'weekly', remainingPercent: 0, resetsAt: now }] }],
      ['ofm-opencode/good-free', { status: 'ok', checkedAt: now, windows: [{ kind: 'weekly', remainingPercent: 90, resetsAt: now }] }],
    ])
    const { runChain } = await import('../dist/gateway/chain.js')
    const { resolveModel } = await import('../dist/gateway/dispatch.js')
    const { classifyFailure } = await import('../dist/gateway/classify.js')
    const models = buildLaneModels([
      { id: 'ofm-kilo', models: laneModels(`http://127.0.0.1:${upstream.port()}`, ['good-free']) },
      { id: 'ofm-opencode', models: laneModels(`http://127.0.0.1:${upstream.port()}`, ['good-free']) },
    ])
    const links = ['ofm-kilo/good-free', 'ofm-opencode/good-free'].map((address) => {
      const slash = address.indexOf('/')
      return resolveModel(models, address.slice(0, slash), address.slice(slash + 1))!
    })
    const attempted: string[] = []
    const outcome = await runChain({
      chain: { id: 'combo:smart', name: 'Smart', models: ['ofm-kilo/good-free', 'ofm-opencode/good-free'], strategy: 'smart', stickyLimit: 1 },
      links,
      readings,
      attempt: async (candidate: any) => {
        attempted.push(`${candidate.provider}/${candidate.model.id}`)
        return { response: new Response(GOOD_SSE, { status: 200 }), aliases: new Map(), scrub: false }
      },
      toResult: (body, answeredBy) => Promise.resolve({ status: 200, body: new TextEncoder().encode(''), headers: {}, answeredBy, tried: [] }),
    })
    assert.equal(outcome.status, 200)
    // The exhausted head is skipped, so the first attempt is the healthy link.
    assert.deepEqual(attempted, ['ofm-opencode/good-free'], `the order ignored the exhausted head: ${attempted.join(', ')}`)
    void classifyFailure
  } finally { await gateway.close(); await upstream.close() }
})

// The summary is written after the last check settles, not on a wall-clock
// timer: a fixed deadline printed "ALL CHECKS PASSED" while the async checks
// were still running, and a slow suite then looked like it had failed.
void (async () => {
  await new Promise(resolve => setImmediate(resolve))
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
})()
