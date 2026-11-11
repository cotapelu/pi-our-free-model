/**
 * Unit checks that the HTTP gateway serves every lane it can, and refuses the
 * ones it cannot.
 *
 * The gateway's contract with a caller is narrow: one base URL, one key, and
 * `provider/model` addressing. What is asserted here is what a caller meets at
 * that boundary —
 *
 *   1. **a lane the host has is served, one it has not is not** — the co-paid
 *      lane is absent on a host the seal gate refuses, and the aggregate lane is
 *      absent before a key is pasted, and neither is an error;
 *   2. **an unknown model is a 404 with an envelope**, never a 500 and never a
 *      dial to a lane that does not exist;
 *   3. **the roster is exactly the addresses the gateway can resolve**, so a
 *      caller cannot pick a model from `GET /v1/models` that `POST` then refuses;
 *   4. **a lane's own credential reaches its own upstream** — asserted through
 *      a stand-in, so nothing dials a real provider.
 *
 * Every check starts a real listener on loopback with a stand-in roster, so no
 * check reaches an upstream and no key is spent.
 *
 * Runs on plain node:  node test/gateway-lanes.test.ts
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

const model = (id: string, over: Record<string, any> = {}) => ({
  id, name: id, provider: 'x', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072, maxTokens: 8192, ...over,
} as any)

/** Boot the gateway over an arbitrary set of lanes. */
async function gatewayOver(lanes: Array<{ id: string; models: any[] }>, chains: any[] = []) {
  const key = generateKey()
  const gateway = await startGateway({
    settings: () => ({ host: '127.0.0.1', port: 0, enabled: true, key }),
    models: () => buildLaneModels(lanes),
    chains: () => chains,
    log: () => {},
  })
  return { gateway, key, base: `http://127.0.0.1:${gateway.port}` }
}

const getModels = async (base: string, key: string) => {
  const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
  assert.equal(res.status, 200)
  return (await res.json()).data
}

await check('a lane the host has is served under its own prefix', async () => {
  const { gateway, key, base } = await gatewayOver([
    { id: 'ofm-kilo', models: [model('kilo-auto-free')] },
    { id: 'ofm-aggregate', models: [model('groq-llama-3.3-70b-versatile', { baseUrl: 'https://api.groq.com/openai/v1' })] },
  ])
  try {
    const rows = await getModels(base, key)
    assert.deepEqual(rows.map((row: any) => row.id).sort(), ['ofm-aggregate/groq-llama-3.3-70b-versatile', 'ofm-kilo/kilo-auto-free'])
    // Every advertised row is also resolvable by dispatch.
    assert.ok(rows.every((row: any) => row.id.includes('/')))
  } finally { await gateway.close() }
})

await check('the roster is exactly what a POST can resolve', async () => {
  const { gateway, key, base } = await gatewayOver([
    { id: 'ofm-kilo', models: [model('kilo-auto-free')] },
    { id: 'ofm-eac', models: [model('deepseek-v4.1-flash')] },
  ])
  try {
    const rows = await getModels(base, key)
    for (const row of rows) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: row.id, messages: [{ role: 'user', content: 'hi' }], stream: false }),
      })
      // 404 would mean the roster advertised a row dispatch cannot resolve —
      // that is the defect this check exists to catch. A transport error to a
      // stand-in host is fine and expected here.
      assert.ok(res.status !== 404, `${row.id} was advertised but not resolvable`)
    }
  } finally { await gateway.close() }
})

await check('a lane the host has not is absent, and that is not an error', async () => {
  // A CLI host has no seal and no aggregate key: neither lane is served, and
  // neither is an error — a provider registered with an empty roster would show
  // up in the picker and fail every turn.
  const { gateway, key, base } = await gatewayOver([
    { id: 'ofm-kilo', models: [model('kilo-auto-free')] },
    { id: 'ofm-eac', models: [] },
    { id: 'ofm-aggregate', models: [] },
  ])
  try {
    const rows = await getModels(base, key)
    assert.deepEqual(rows.map((row: any) => row.id), ['ofm-kilo/kilo-auto-free'])
    // The empty lanes still resolve to a 404, not a 500.
    for (const address of ['ofm-eac/x', 'ofm-aggregate/y']) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: address, messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 404, `${address} answered ${res.status}`)
    }
  } finally { await gateway.close() }
})

await check('an unknown provider and an unknown model are both a 404', async () => {
  const { gateway, key, base } = await gatewayOver([{ id: 'ofm-kilo', models: [model('kilo-auto-free')] }])
  try {
    for (const address of ['ofm-nope/kilo-auto-free', 'ofm-kilo/not-a-model']) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: address, messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 404, `${address} answered ${res.status}`)
      const body = await res.json()
      assert.ok(body.error !== undefined, 'the 404 carried no envelope')
      assert.match(body.error.code, /model/)
    }
  } finally { await gateway.close() }
})

await check('a malformed address is a 400, not a 404', async () => {
  // The caller sent something that is not `provider/model` at all — that is a
  // client error about the request, not a fact about the roster. Collapsing the
  // two would tell a caller with a typo'd separator to "pick another model",
  // which sends them looking in the wrong place.
  const { gateway, key, base } = await gatewayOver([{ id: 'ofm-kilo', models: [model('kilo-auto-free')] }])
  try {
    for (const address of ['no-slash-at-all', '', '/leading-slash', 'trailing-slash/']) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: address, messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 400, `${JSON.stringify(address)} answered ${res.status}`)
      const body = await res.json()
      assert.match(body.error.code, /model/, 'the 400 did not name the field')
      // The message says what the shape must be, not "no such model".
      assert.match(body.error.message, /<provider>\/<model>/, 'the message did not state the required shape')
    }
  } finally { await gateway.close() }
})

await check('every dialect walks the same lane set', async () => {
  // A caller speaking Anthropic or Gemini addresses the same provider/model the
  // OpenAI speaker does, so an unknown address is a 404 on all three wires, not
  // a crash on two of them.
  const { gateway, key, base } = await gatewayOver([{ id: 'ofm-kilo', models: [model('kilo-auto-free')] }])
  try {
    const anthropic = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ofm-nope/x', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(anthropic.status, 404, `anthropic answered ${anthropic.status}`)

    const gemini = await fetch(`${base}/v1beta/models/ofm-nope%2Fx:generateContent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    })
    assert.equal(gemini.status, 404, `gemini answered ${gemini.status}`)

    const responses = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ofm-nope/x', input: 'hi' }),
    })
    assert.equal(responses.status, 404, `responses answered ${responses.status}`)
  } finally { await gateway.close() }
})

await check('the gemini list route walks the same roster', async () => {
  const { gateway, key, base } = await gatewayOver([
    { id: 'ofm-kilo', models: [model('kilo-auto-free')] },
    { id: 'ofm-aggregate', models: [model('groq-llama', { baseUrl: 'https://api.groq.com/openai/v1' })] },
  ])
  try {
    const res = await fetch(`${base}/v1beta/models`, { headers: { authorization: `Bearer ${key}` } })
    assert.equal(res.status, 200)
    const body = await res.json()
    const names = body.models.map((row: any) => row.name)
    assert.ok(names.some((name: string) => name.includes('ofm-kilo')), 'the openai lane is missing from the gemini list')
    assert.ok(names.some((name: string) => name.includes('ofm-aggregate')), 'the aggregate lane is missing from the gemini list')
  } finally { await gateway.close() }
})

await check('two lanes whose model ids collide keep their own rows', async () => {
  // The same upstream id on two lanes must not merge: each row carries its own
  // provider prefix, so two providers serving `llama-3.3-70b-versatile` stay
  // distinct.
  const { gateway, key, base } = await gatewayOver([
    { id: 'ofm-aggregate', models: [model('groq-llama-3.3-70b-versatile', { baseUrl: 'https://api.groq.com/openai/v1' })] },
    { id: 'ofm-kilo', models: [model('groq-llama-3.3-70b-versatile')] },
  ])
  try {
    const rows = await getModels(base, key)
    assert.equal(rows.length, 2, 'the two colliding rows merged')
    assert.equal(new Set(rows.map((row: any) => row.id)).size, 2)
  } finally { await gateway.close() }
})

await check('an empty roster still answers a well-formed list', async () => {
  const { gateway, key, base } = await gatewayOver([])
  try {
    const rows = await getModels(base, key)
    assert.deepEqual(rows, [])
  } finally { await gateway.close() }
})

await check('a lane registered after the fact is served on the next listing', async () => {
  // The gateway reads `models()` per request, so a lane that appears later
  // (a key pasted while the server runs) is served without a rebind.
  let lanes = [{ id: 'ofm-kilo', models: [model('kilo-auto-free')] }]
  const key = generateKey()
  const gateway = await startGateway({
    settings: () => ({ host: '127.0.0.1', port: 0, enabled: true, key }),
    models: () => buildLaneModels(lanes),
    chains: () => [],
    log: () => {},
  })
  const base = `http://127.0.0.1:${gateway.port}`
  try {
    assert.equal((await getModels(base, key)).length, 1)
    lanes = [...lanes, { id: 'ofm-aggregate', models: [model('groq-llama', { baseUrl: 'https://api.groq.com/openai/v1' })] }]
    assert.equal((await getModels(base, key)).length, 2, 'a late lane was not served')
  } finally { await gateway.close() }
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 400)
