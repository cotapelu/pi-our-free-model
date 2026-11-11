/**
 * Unit checks for the engine's live model catalog.
 *
 * The engine is a child process the plugin does not own, so its roster is read
 * over loopback and projected through the subscription adapter. What must not
 * pass by luck:
 *
 *   1. **a model the build does not offer stays out** — the channel pack is the
 *      one deliberate exception to the plugin's own code, and a channel this
 *      build refuses must not appear through the engine either;
 *   2. **a row without a usable id is skipped**, not crashed on and not served
 *      with an empty address;
 *   3. **the state only changes when the catalog actually did** — a refresh
 *      that answers the same roster must not fire `onChanged`, or the settings
 *      page re-renders on a timer forever;
 *   4. **combining runtimes keeps namespaces apart** — a model id the engine
 *      serves must not be swallowed by the legacy catch-all.
 *
 * The engine's HTTP surface is driven through its own `fetchImpl` seam, so
 * nothing spawns a child.
 *
 * Runs on plain node:  node test/magpie-models.test.ts
 */
import assert from 'node:assert/strict'
import { combineSubscriptionRuntimes, createMagpieModels } from '../dist/magpie-models.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

/** An engine whose gateway() answers a fixed URL + key, and whose state is fixed. */
function engine(over: { state?: string; url?: string; key?: string } = {}) {
  return {
    status: () => ({ state: over.state ?? 'ready', available: true, version: 'ofm-test', revision: 'testrev', error: null }),
    gateway: () => ({ url: over.url ?? 'http://127.0.0.1:1', key: over.key ?? 'sk-magpie-key-' + 'a'.repeat(64) }),
  }
}

/** A stand-in of the engine's `/v1/models`. */
function listing(rows: any[], over: { ok?: boolean; body?: string } = {}) {
  const seen: Array<{ url: string; auth?: string }> = []
  const fetchImpl = (async (url: any, init: any) => {
    seen.push({ url: String(url), auth: String(init?.headers?.authorization ?? '') })
    return {
      ok: over.ok ?? true,
      status: over.ok === false ? 503 : 200,
      async json() { return { data: rows } },
      async text() { return over.body ?? JSON.stringify({ data: rows }) },
    }
  }) as any
  return { fetchImpl, seen }
}

const row = (id: string, over: Record<string, any> = {}) => ({
  id,
  name: `Model ${id}`,
  context_window: 131072,
  max_output_tokens: 8192,
  ...over,
})

await check('a ready engine serves its live roster', async () => {
  const stand = listing([row('gpt-5', { reasoning: true }), row('llama-4', { vision: true })])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    const catalog = models.catalog()
    assert.equal(catalog.length, 2)
    assert.equal(catalog[0].id, 'subscription:magpie/gpt-5')
    assert.equal(catalog[0].reasoning, true)
    assert.equal(catalog[0].wire, 'chat')
  } finally { models.close() }
})

await check('the engine gateway key rides the Authorization header and nothing else', async () => {
  const stand = listing([row('gpt-5')])
  const models = createMagpieModels({ engine: engine({ url: 'http://127.0.0.1:8326' }), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    assert.deepEqual(stand.seen, [{ url: 'http://127.0.0.1:8326/v1/models', auth: 'Bearer sk-magpie-key-' + 'a'.repeat(64) }])
    // The key goes to the engine's own gateway and nowhere else.
    const catalog = JSON.stringify(models.catalog())
    assert.equal(catalog.includes('sk-magpie-key-'), false, 'the gateway key leaked into the catalog')
  } finally { models.close() }
})

await check('a channel this build refuses never appears through the engine', async () => {
  const stand = listing([row('gpt-5'), row('workbuddy-x'), row('HuaweiCloud-Y')])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    const ids = models.catalog().map((entry: any) => entry.id)
    assert.ok(ids.some((id: string) => id.includes('gpt-5')), 'the good model disappeared')
    assert.equal(ids.some((id: string) => /workbuddy/i.test(id)), false, 'a refused channel came through the engine')
    assert.equal(ids.some((id: string) => /huawei/i.test(id)), false, 'a refused channel came through the engine')
  } finally { models.close() }
})

await check('a row with no usable id is skipped, not served empty', async () => {
  const stand = listing([row('gpt-5'), row(''), row(null), { name: 'no id' }, row('ok-model')])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    assert.deepEqual(models.catalog().map((entry: any) => entry.id), ['subscription:magpie/gpt-5', 'subscription:magpie/ok-model'])
  } finally { models.close() }
})

await check('a duplicate id is served once', async () => {
  const stand = listing([row('gpt-5'), row('gpt-5'), row('gpt-5')])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    assert.equal(models.catalog().length, 1)
  } finally { models.close() }
})

await check('an id carrying CR/LF or NUL is skipped', async () => {
  // Such an id cannot be addressed on any wire and cannot be logged safely.
  const stand = listing([row('gpt-5'), row('bad\nid'), row('bad\rid'), row('bad\u0000id')])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    assert.deepEqual(models.catalog().map((entry: any) => entry.id), ['subscription:magpie/gpt-5'])
  } finally { models.close() }
})

await check('an engine that is not ready contributes nothing', async () => {
  // No request is made either: a stopped engine must not be dialed.
  const stand = listing([row('gpt-5')])
  const models = createMagpieModels({ engine: engine({ state: 'stopped' }), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    assert.deepEqual(models.catalog(), [])
    assert.deepEqual(stand.seen, [], 'a stopped engine was dialled')
  } finally { models.close() }
})

await check('a failed listing keeps the roster it already had', async () => {
  // A transient 5xx must not empty a working catalog.
  let ok = true
  const seen: any[] = []
  const fetchImpl = (async (url: any, init: any) => {
    seen.push(String(url))
    return {
      ok,
      status: ok ? 200 : 503,
      async json() { return { data: [row('gpt-5')] } },
      async text() { return ok ? JSON.stringify({ data: [row('gpt-5')] }) : 'nope' },
    }
  }) as any
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl })
  try {
    await models.refresh()
    assert.equal(models.catalog().length, 1)
    ok = false
    await models.refresh()
    assert.equal(models.catalog().length, 1, 'a failed listing emptied the catalog')
    ok = true
    await models.refresh()
    assert.equal(models.catalog().length, 1)
  } finally { models.close() }
})

await check('a malformed listing payload is refused, not crashed on', async () => {
  for (const rows of [{ data: 'not an array' }, {}, 'not an object'] as any[]) {
    const stand = listing(rows)
    const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
    try {
      await models.refresh()
      assert.deepEqual(models.catalog(), [], `${JSON.stringify(rows)} produced a roster`)
    } finally { models.close() }
  }
})

await check('onChanged fires only when the catalog actually changed', async () => {
  // A refresh that answers the same roster re-rendering the settings page is a
  // timer burning CPU forever.
  let changes = 0
  const stand = listing([row('gpt-5')])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, onChanged: () => { changes += 1 }, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    assert.equal(changes, 1, 'the first roster did not fire onChanged')
    await models.refresh()
    assert.equal(changes, 1, 'an identical refresh fired onChanged again')
    // A changed roster does.
    const next = listing([row('gpt-5'), row('gpt-6')])
    const models2 = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: next.fetchImpl })
    await models2.refresh()
    await models2.refresh()
    models2.close()
  } finally { models.close() }
})

await check('a capacity the engine did not name stays absent', async () => {
  // The projection carries `undefined`, not a default, so a picker can tell a
  // model that declared its window from one that did not.
  const stand = listing([row('gpt-5', { context_window: undefined, max_output_tokens: undefined })])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    const catalog = models.catalog()
    assert.equal(catalog[0].contextWindow, undefined)
    assert.equal(catalog[0].maxOutput, undefined)
  } finally { models.close() }
})

await check('the effort list only carries plain slugs', async () => {
  const stand = listing([row('gpt-5', { reasoning: true, reasoning_levels: ['low', 'high', 'Bad Level', 'x'.repeat(40), 7] })])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    assert.deepEqual(models.catalog()[0].efforts, ['low', 'high'])
  } finally { models.close() }
})

await check('a model with no reasoning_levels carries no efforts at all', async () => {
  const stand = listing([row('gpt-5')])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  try {
    await models.refresh()
    assert.equal(models.catalog()[0].efforts, undefined)
  } finally { models.close() }
})

await check('close stops the refresh timer and empties the catalog', async () => {
  const stand = listing([row('gpt-5')])
  const models = createMagpieModels({ engine: engine(), stats: {}, logger: {}, fetchImpl: stand.fetchImpl })
  await models.refresh()
  models.close()
  assert.deepEqual(models.catalog(), [])
})

await check('combining runtimes dispatches by namespace, not by order', async () => {
  // A specific namespace takes priority over the legacy subscription catch-all.
  const engineRuntime = {
    handles: (id: string) => id.startsWith('subscription:magpie/'),
    catalog: () => [{ id: 'subscription:magpie/gpt-5', name: 'GPT-5', wire: 'chat' }],
    complete: async () => ({ text: 'engine' }),
  }
  const legacyRuntime = {
    handles: (id: string) => id.startsWith('subscription:'),
    catalog: () => [{ id: 'subscription:other/model', name: 'Other', wire: 'chat' }],
    complete: async () => ({ text: 'legacy' }),
  }
  const combined = combineSubscriptionRuntimes(engineRuntime, legacyRuntime)
  assert.deepEqual(combined.catalog().map((row: any) => row.id), ['subscription:magpie/gpt-5', 'subscription:other/model'])
  assert.deepEqual(await combined.complete({ model: 'subscription:magpie/gpt-5' }), { text: 'engine' })
  assert.deepEqual(await combined.complete({ model: 'subscription:other/model' }), { text: 'legacy' })
})

await check('combining an empty set answers nothing, not a crash', async () => {
  const combined = combineSubscriptionRuntimes()
  assert.deepEqual(combined.catalog(), [])
  assert.deepEqual(combined.routingQuota(), {})
  assert.throws(() => combined.complete({ model: 'x' }), /not found/)
})

await check('a runtime with no handles never swallows a request', async () => {
  const silent = { handles: undefined, catalog: () => [{ id: 'subscription:ghost/x' }], complete: async () => ({ text: 'ghost' }) }
  const useful = { handles: (id: string) => id.startsWith('subscription:useful/'), catalog: () => [{ id: 'subscription:useful/x' }], complete: async () => ({ text: 'useful' }) }
  const combined = combineSubscriptionRuntimes(silent as any, useful)
  assert.deepEqual(await combined.complete({ model: 'subscription:useful/x' }), { text: 'useful' })
  assert.throws(() => combined.complete({ model: 'subscription:ghost/x' }), /not found/)
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 400)
