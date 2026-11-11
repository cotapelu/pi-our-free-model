/**
 * Unit checks for the co-paid lane's pi-provider surface.
 *
 * The lane's whole security model is *where it does not exist*: a host the seal
 * gate refuses gets no roster entry, no request, and no ciphertext work. So the
 * properties this suite pins are the absence ones:
 *
 *   1. **a host with no lane registers no provider** — `eacProvider` returns
 *      `null`, so `pi --list-models` on a CLI never shows a lane that would fail
 *      every turn with `LANE_LOCKED`;
 *   2. **a listing failure is not an empty roster** — a transient 5xx must not
 *      make a desktop user lose their EAC models for the rest of the process;
 *   3. **the credential is opened per call and dropped with it** — a seal that
 *      closes between registration and the turn fails the turn, it does not
 *      dial an endpoint the host has no key for;
 *   4. **a listing row's own id becomes wire-safe**, because `/` and `:` are
 *      pi's provider separator.
 *
 * Every check drives the lane through its own `lane.fetch` seam, so nothing
 * reaches a gateway and no credential is spent.
 *
 * Runs on plain node:  node test/eac-lane.test.ts
 */
import assert from 'node:assert/strict'
import * as eac from '../dist/eac.js'
import { eacAvailable, eacModels, eacProvider, safeId, sealedCredential } from '../dist/eac-lane.js'

let failures = 0
const check = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

async function withSeam<T>(fn: (url: string, init: any) => any, body: () => Promise<T>): Promise<T> {
  eac.lane.fetch = fn
  try { return await body() } finally { eac.lane.fetch = null }
}

function reply(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() },
    }),
    async text() { return body },
    async json() { return JSON.parse(body) },
  }
}

await check('a host the gate refuses has no lane at all', async () => {
  // A plain CLI process: no bundled node, no kernel-declared profile.
  assert.equal(eacAvailable(), false)
  assert.equal(eacAvailable('cli'), false)
  assert.equal(sealedCredential(), null)
  assert.equal(sealedCredential('cli'), null)
})

await check('a recognised host opens the seal', async () => {
  assert.equal(eacAvailable('web'), true)
  const credential = sealedCredential('web')!
  assert.ok(credential !== null)
  assert.ok(credential.base.startsWith('https://'))
})

await check('a host with no lane registers no provider', async () => {
  // The absence is the feature: a provider registered with an empty roster
  // would show up in `pi --list-models` and fail every turn with LANE_LOCKED.
  assert.equal(eacProvider({ models: [], profileName: 'cli' }), null)
  assert.equal(eacProvider({ models: [], }), null)
})

await check('a host with a lane registers one', async () => {
  const provider = eacProvider({ models: [], profileName: 'web' })
  assert.ok(provider !== null)
  assert.equal(provider!.name, 'Our Free Model · EAC (co-paid)')
  assert.equal(provider!.api, 'ofm-free-api')
  // The base comes from the seal, so the gateway can move without a code change.
  assert.ok(String(provider!.baseUrl).startsWith('https://'))
  assert.equal(typeof provider!.refreshModels, 'function')
  assert.equal(typeof provider!.streamSimple, 'function')
})

await check('a recognised host with no reachable gateway gets no roster', async () => {
  // A listing failure is not an empty roster *and* not a stale one: the lane is
  // dark for this process until the next refresh.
  await withSeam(() => Promise.reject(new Error('ENOTFOUND gateway.example')), async () => {
    assert.deepEqual(await eacModels({ profileName: 'web' }), [])
  })
})

await check('a refused credential is not an empty roster but a dark lane', async () => {
  await withSeam(() => Promise.resolve(reply(403, JSON.stringify({ error: { message: 'authorization required' } }), { 'content-type': 'application/json' })), async () => {
    assert.deepEqual(await eacModels({ profileName: 'web' }), [])
  })
})

await check('a listing row becomes a pi model with a wire-safe id', async () => {
  await withSeam(() => Promise.resolve(reply(200, JSON.stringify({
    data: [
      { id: 'deepseek/v4.1:flash', name: 'DeepSeek V4.1 Flash', context_window: 1048576, max_output_tokens: 131072 },
      { id: 'plain-free-model', context_window: 131072, max_output_tokens: 32768 },
    ],
  }), { 'content-type': 'application/json' })), async () => {
    const models = await eacModels({ profileName: 'web' })
    assert.equal(models.length, 2)
    // `/` and `:` are pi's provider separator, so the upstream's own spelling
    // cannot ride the registered id.
    assert.equal(models[0].id, 'deepseek-v4.1-flash')
    assert.ok(!models[0].id.includes('/'), 'the id kept a slash')
    assert.ok(!models[0].id.includes(':'), 'the id kept a colon')
    assert.equal(models[0].name, 'DeepSeek V4.1 Flash')
    assert.equal(models[0].contextWindow, 1048576)
    assert.equal(models[0].maxTokens, 131072)
    // A row naming no name falls back to its id.
    assert.equal(models[1].name, 'plain-free-model')
  })
})

await check('a listing row with a non-positive window falls back, never zero', async () => {
  await withSeam(() => Promise.resolve(reply(200, JSON.stringify({
    data: [{ id: 'm', context_window: 0, max_output_tokens: -1 }, { id: 'n', context_window: 'big', max_output_tokens: {} }],
  }), { 'content-type': 'application/json' })), async () => {
    const models = await eacModels({ profileName: 'web' })
    assert.ok(models.every(model => model.contextWindow > 0), 'a row carried a zero window')
    assert.ok(models.every(model => model.maxTokens > 0), 'a row carried a zero ceiling')
  })
})

await check('a listing that answers an empty data array yields no roster', async () => {
  await withSeam(() => Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })), async () => {
    assert.deepEqual(await eacModels({ profileName: 'web' }), [])
  })
})

await check('a listing whose shape is not a listing yields no roster', async () => {
  for (const body of ['{"data":"not an array"}', '{"models":[]}', '[]', 'not json']) {
    await withSeam(() => Promise.resolve(reply(200, body, { 'content-type': 'application/json' })), async () => {
      assert.deepEqual(await eacModels({ profileName: 'web' }), [], `${body} produced a roster`)
    })
  }
})

await check('a caller abort is honoured, not dialed', async () => {
  const controller = new AbortController()
  await withSeam(() => { controller.abort(); return Promise.resolve(reply(200, '{"data":[]}', { 'content-type': 'application/json' })) }, async () => {
    await eacModels({ profileName: 'web', signal: controller.signal })
  })
})

await check('safeId keeps only what pi can address', async () => {
  assert.equal(safeId('deepseek/v4.1:flash'), 'deepseek-v4.1-flash')
  assert.equal(safeId('a/b:c/d'), 'a-b-c-d')
  assert.equal(safeId('plain'), 'plain')
  assert.equal(safeId(''), '')
})

await check('a refresh through the registered provider is the same code path', async () => {
  const provider = eacProvider({ models: [], profileName: 'web' })!
  await withSeam(() => Promise.resolve(reply(200, JSON.stringify({ data: [{ id: 'm' }] }), { 'content-type': 'application/json' })), async () => {
    const refreshed = await provider.refreshModels({})
    assert.equal(refreshed.length, 1)
    assert.equal(refreshed[0].id, 'm')
  })
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 300)
