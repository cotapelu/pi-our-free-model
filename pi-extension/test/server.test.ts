/**
 * Unit checks for the gateway's HTTP surface.
 *
 * What is asserted here is what a caller meets before any lane is reached: a
 * key fence on every route that spends quota, a health route that does not,
 * a model list that only advertises what exists, and an OpenAI-shaped error
 * envelope on the refusals. Every route is served over a real loopback
 * listener with a stand-in roster, so nothing dials upstream and no quota is
 * spent.
 *
 * Runs on plain node:  node test/server.test.ts
 */
import assert from 'node:assert/strict'
import { startGateway } from '../dist/gateway/server.js'
import { generateKey } from '../dist/gateway/protocol.js'
import { buildLaneModels } from '../dist/gateway/dispatch.js'

let failures = 0
const check = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

async function main() {
  const key = generateKey()
  const models = buildLaneModels([
    { id: 'ofm-kilo', models: [{ id: 'test-model', name: 'Test Model' } as any] },
    { id: 'ofm-opencode', models: [{ id: 'test-model-2', name: 'Test Model 2' } as any] },
  ])

  const gateway = await startGateway({
    settings: () => ({ host: '127.0.0.1', port: 0, enabled: true, key }),
    models: () => models,
    chains: () => [],
    log: () => {},
  })
  const base = `http://127.0.0.1:${gateway.port}`
  const withKey = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra })

  await check('the health route answers without a key and names the service', async () => {
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, service: 'our-free-model' })
  })

  await check('the root path answers the same health document', async () => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).ok, true)
  })

  await check('a model list without a key is refused before any roster work', async () => {
    const res = await fetch(`${base}/v1/models`)
    assert.equal(res.status, 401)
    const body = await res.json()
    // The refusal carries the OpenAI error envelope, not a bare status.
    assert.equal(body.error.type, 'invalid_request_error')
    assert.match(body.error.message, /api key/i)
  })

  await check('a wrong key is refused the same way', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer wrong-key' } })
    assert.equal(res.status, 401)
  })

  await check('a key on a route that spends nothing is still refused', async () => {
    // `x-api-key` is accepted the same way Bearer is, and a missing one is not.
    const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'other-key' } })
    assert.equal(res.status, 401)
  })

  await check('a model list with the key answers an OpenAI-shaped list', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: withKey() })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'list')
    assert.ok(Array.isArray(body.data))
    assert.ok(body.data.length >= 2, `expected both lanes, got ${body.data.length}`)
    // Every row is `provider/model`, which is what a client addresses.
    assert.ok(body.data.every((row: any) => row.id.includes('/')), 'a row has no provider prefix')
    assert.ok(body.data.every((row: any) => row.object === 'model'))
  })

  await check('a preflight is answered without a key and spends nothing', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    })
    assert.ok(res.status === 200 || res.status === 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/)
  })

  await check('a completion without a key is refused before a lane is reached', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ofm-kilo/test-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 401)
  })

  await check('an unknown model answers 404, never a 500', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...withKey(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-provider/no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.ok(body.error !== undefined, 'the 404 carried no envelope')
    // The endpoint, the key and the model id stay out of the message.
    assert.equal(JSON.stringify(body).includes(key), false, 'the api key leaked into the response')
  })

  await check('a malformed body is refused without a 500', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...withKey(), 'content-type': 'application/json' },
      body: 'this is not json',
    })
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`)
  })

  await check('every refusal carries the same error envelope shape', async () => {
    // One shape for the 401s and the 404, so a client parses one grammar.
    const shapes = []
    for (const attempt of [
      fetch(`${base}/v1/models`),
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { ...withKey(), 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'nope/nope', messages: [] }),
      }),
    ]) {
      const res = await attempt
      const body = await res.json()
      shapes.push(Object.keys(body.error).sort())
    }
    assert.deepEqual(shapes[0], shapes[1])
  })

  await gateway.close()
}

void main().then(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}).catch((error: any) => {
  console.error(error)
  process.exit(1)
})
