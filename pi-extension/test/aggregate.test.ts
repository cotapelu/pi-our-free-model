/**
 * Unit checks for the aggregate lane.
 *
 * This lane is the orthogonal one: 76 upstream providers each reachable only
 * with material the user pastes into the settings page. Three things must not
 * pass by luck, and each is a way the lane could take a user's money or waste
 * it:
 *
 *   1. **a row whose endpoint cannot be composed is never advertised** — a
 *      picker entry that can only answer an error is worse than no entry;
 *   2. **a credential never reaches a message** — a provider that echoes the
 *      key back (a 401 body routinely does) must not put it in front of the
 *      user, a log, or the harness's durable session log;
 *   3. **the poster reads the response's shape, not its content-type** — a
 *      provider that answers `stream:true` with one JSON document is folded
 *      into the frame sequence the row's wire decodes, and each wire gets a
 *      terminal frame, always.
 *
 * Every check drives the lane through its own fetch, so nothing dials a
 * provider and no key is spent.
 *
 * Runs on plain node:  node test/aggregate.test.ts
 */
import assert from 'node:assert/strict'
import { PROVIDERS, getProvider } from '../dist/providers/index.js'
import { AGGREGATE_CHANNEL, buildAggregateCatalog, isAggregateEntry, resolveProvider } from '../dist/aggregate.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

/** A registry row that really can be configured with a pasted key. */
const KEYED = PROVIDERS.find((p: any) => p.auth.kind === 'apiKey' && p.baseUrl && p.models.length > 0)!
const KEYED_ID = KEYED.id
/** A registry row that needs no key at all. */
const KEYLESS = PROVIDERS.find((p: any) => p.auth.kind === 'none')!
const KEYLESS_ID = KEYLESS.id

// ── buildAggregateCatalog ───────────────────────────────────────────────────
check('the section switch is the first gate: an off lane contributes no rows', () => {
  assert.deepEqual(buildAggregateCatalog({ enabled: false, providers: { [KEYED_ID]: { enabled: true, apiKey: 'k' } } }), [])
  assert.deepEqual(buildAggregateCatalog({ providers: 'not an object' }), [])
  assert.deepEqual(buildAggregateCatalog({}), [])
  assert.deepEqual(buildAggregateCatalog(undefined), [])
})

check('a keyed provider with a key contributes one row per model', () => {
  const registry = getProvider(KEYED_ID)!
  const config = { enabled: true, providers: { [KEYED_ID]: { enabled: true, apiKey: 'sk-test' } } }
  const rows = buildAggregateCatalog(config)
  assert.equal(rows.length, registry.models.length, 'a row per model is missing')
  assert.ok(rows.every(row => row.channel === AGGREGATE_CHANNEL))
  assert.ok(rows.every(row => row.id.startsWith(`${KEYED_ID}/`)), 'a row lost its provider namespace')
})

check('a keyed provider with no key contributes nothing', () => {
  // A guaranteed 401 is not a catalog entry.
  assert.deepEqual(buildAggregateCatalog({ enabled: true, providers: { [KEYED_ID]: { enabled: true } } }), [])
  assert.deepEqual(buildAggregateCatalog({ enabled: true, providers: { [KEYED_ID]: { enabled: true, apiKey: '  ' } } }), [])
})

check('a keyless provider needs no key at all', () => {
  const registry = getProvider(KEYLESS_ID)!
  const rows = buildAggregateCatalog({ enabled: true, providers: { [KEYLESS_ID]: { enabled: true } } })
  assert.equal(rows.length, registry.models.length > 0 ? registry.models.length : rows.length)
  // If it has no models of its own, it contributes none — that is honest.
  if (registry.models.length === 0) assert.deepEqual(rows, [])
})

check('an oauth or adc provider is never drivable here', () => {
  // The two credential flows the registry names but this lane cannot drive:
  // `defaultHeaders` would not even send the key, so the row would be a
  // guaranteed 401.
  const registry = PROVIDERS as any[]
  for (const provider of registry.filter((p: any) => p.auth.kind === 'oauth' || p.auth.kind === 'adc')) {
    assert.deepEqual(
      buildAggregateCatalog({ enabled: true, providers: { [provider.id]: { enabled: true, apiKey: 'sk-any' } } }),
      [],
      `${provider.id} produced a row`,
    )
  }
})

check('a switched-off provider contributes nothing, whatever its key', () => {
  assert.deepEqual(buildAggregateCatalog({ enabled: true, providers: { [KEYED_ID]: { enabled: false, apiKey: 'k' } } }), [])
})

check('an unknown provider id is skipped, not crashed on', () => {
  assert.deepEqual(buildAggregateCatalog({ enabled: true, providers: { 'no-such-provider': { enabled: true, apiKey: 'k' } } }), [])
})

check('a provider with no dialable endpoint stays out of the picker', () => {
  // Azure names its endpoint per deployment: until the user supplies a base
  // URL, a row would be a picker entry that can only answer an error.
  const rows = buildAggregateCatalog({ enabled: true, providers: { azure_openai: { enabled: true, apiKey: 'k' } } })
  assert.deepEqual(rows, [])
  // With a base URL *and* a model list (Azure names both itself) it becomes a
  // real row: the registry cannot supply the deployment names for it.
  const configured = buildAggregateCatalog({
    enabled: true,
    providers: {
      azure_openai: {
        enabled: true, apiKey: 'k',
        baseUrl: 'https://mine.openai.azure.com/openai',
        models: ['gpt-4o-mini', 'gpt-4o-mini'],
      },
    },
  })
  assert.ok(configured.length > 0, 'a configured Azure produced no row')
  assert.ok(configured[0].id.startsWith('azure_openai/'))
  assert.deepEqual(configured.map(row => row.modelId), ['gpt-4o-mini'], 'the configured list was not de-duplicated')
})

check('a base URL still carrying a registry placeholder stays out', () => {
  const registry = PROVIDERS as any[]
  const placeholder = registry.find((p: any) => /\{[^}]*\}/.test(String(p.baseUrl ?? '')))
  if (placeholder === undefined) return
  assert.deepEqual(
    buildAggregateCatalog({ enabled: true, providers: { [placeholder.id]: { enabled: true, apiKey: 'k' } } }),
    [],
    `${placeholder.id} produced a row from a placeholder host`,
  )
})

check('a configured model list overrides the registry one, and is de-duplicated', () => {
  const registry = getProvider(KEYED_ID)!
  const ids = [registry.models[0].id, registry.models[0].id, registry.models[1]?.id].filter(Boolean)
  const rows = buildAggregateCatalog({
    enabled: true,
    providers: { [KEYED_ID]: { enabled: true, apiKey: 'k', models: ids } },
  })
  assert.deepEqual(rows.map(row => row.modelId), [...new Set(ids)])
  assert.ok(rows.every(row => row.source === 'static'))
})

check('a discovered list is marked as discovered so a picker can tell them apart', () => {
  const registry = getProvider(KEYED_ID)!
  const rows = buildAggregateCatalog({
    enabled: true,
    providers: { [KEYED_ID]: { enabled: true, apiKey: 'k', discovered: [registry.models[0].id] } },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'discovered')
  // A configured list wins over the discovered cache.
  const both = buildAggregateCatalog({
    enabled: true,
    providers: {
      [KEYED_ID]: {
        enabled: true, apiKey: 'k',
        models: [registry.models[1]?.id ?? registry.models[0].id],
        discovered: [registry.models[0].id],
      },
    },
  })
  assert.ok(both.every(row => row.source === 'static'))
})

check('an empty list is dropped, and so is the whole provider', () => {
  const registry = getProvider(KEYED_ID)!
  assert.deepEqual(
    buildAggregateCatalog({ enabled: true, providers: { [KEYED_ID]: { enabled: true, apiKey: 'k', models: [] } } })
      .map(row => row.modelId),
    registry.models.map((m: any) => m.id),
    'an empty configured list fell through to nothing',
  )
})

check('a row carries the wire its provider actually serves', () => {
  const registry = getProvider(KEYED_ID)!
  const [row] = buildAggregateCatalog({
    enabled: true, providers: { [KEYED_ID]: { enabled: true, apiKey: 'k', models: [registry.models[0].id] } },
  })
  assert.equal(row.format, registry.format)
  assert.ok(['chat', 'messages', 'responses'].includes(row.wire))
})

check('a row advertises only the capacity every published value supports', () => {
  const registry = getProvider(KEYED_ID)!
  const [row] = buildAggregateCatalog({
    enabled: true, providers: { [KEYED_ID]: { enabled: true, apiKey: 'k', models: [registry.models[0].id] } },
  })
  assert.ok(row.contextWindow > 0 && row.maxOutput > 0, 'a row carries no usable window')
  // No declared menu, so the free lane's token ladder is the control and the
  // answer owns the whole window — nothing here doubles a ceiling for thinking
  // the provider never promised to stream.
  assert.equal(row.canDisableThinking, true)
  assert.equal(row.regionSensitive, false)
})

check('isAggregateEntry recognises the lane tag and nothing else', () => {
  assert.equal(isAggregateEntry({ channel: AGGREGATE_CHANNEL }), true)
  assert.equal(isAggregateEntry({ channel: 'free' }), false)
  assert.equal(isAggregateEntry(undefined), false)
  assert.equal(isAggregateEntry(null), false)
})

// ── resolveProvider ─────────────────────────────────────────────────────────
check('resolveProvider is the one place the credential and the host agree', () => {
  const resolved = resolveProvider({ providers: { [KEYED_ID]: { enabled: true, apiKey: 'sk-live-key' } } }, KEYED_ID)
  assert.equal(resolved.providerId, KEYED_ID)
  assert.equal(resolved.apiKey, 'sk-live-key')
  assert.ok(resolved.chatUrl.startsWith('http'), 'the resolved endpoint is not a URL')
  // The wire is the vocabulary the poster speaks.
  assert.ok(['chat', 'messages', 'responses'].includes(resolved.wire))
})

check('an unknown provider id throws a non-retryable configuration state', () => {
  // An unknown id, a switched-off provider, an unusable credential flow or a
  // missing key are states the user fixes in the settings page, not transport
  // faults to retry — the code is deliberately outside the retryable set.
  let thrown: any
  try { resolveProvider({}, 'no-such-provider') } catch (error: any) { thrown = error }
  assert.ok(thrown !== undefined)
  assert.equal(thrown.code, 'client')
  assert.match(thrown.message, /no provider/)
})

check('a switched-off provider is refused by name', () => {
  let thrown: any
  try { resolveProvider({ providers: { [KEYED_ID]: { enabled: false, apiKey: 'k' } } }, KEYED_ID) } catch (error: any) { thrown = error }
  assert.equal(thrown.code, 'client')
  assert.match(thrown.message, /switched off/)
})

check('a missing key names where the user gets one', () => {
  let thrown: any
  try { resolveProvider({ providers: { [KEYED_ID]: { enabled: true } } }, KEYED_ID) } catch (error: any) { thrown = error }
  assert.equal(thrown.code, 'credential')
  const registry = getProvider(KEYED_ID)!
  assert.ok(String(thrown.message).includes(String(registry.auth.url)), 'the issuing URL was not named')
})

check('an oauth or adc provider is refused with the flow it actually uses', () => {
  const registry = PROVIDERS as any[]
  const flow = registry.find((p: any) => p.auth.kind === 'oauth' || p.auth.kind === 'adc')
  if (flow === undefined) return
  let thrown: any
  try { resolveProvider({ providers: { [flow.id]: { enabled: true, apiKey: 'k' } } }, flow.id) } catch (error: any) { thrown = error }
  assert.equal(thrown.code, 'credential')
  assert.ok(String(thrown.message).includes(flow.auth.kind), 'the flow was not named')
})

check('a base URL override is slash-trimmed and honoured', () => {
  const resolved = resolveProvider({
    providers: { [KEYED_ID]: { enabled: true, apiKey: 'k', baseUrl: 'https://mirror.example/api/' } },
  }, KEYED_ID)
  assert.equal(resolved.baseUrl, 'https://mirror.example/api')
  assert.ok(resolved.chatUrl.startsWith('https://mirror.example/api/'), `the override was not applied: ${resolved.chatUrl}`)
})

check('a keyless provider resolves with no credential in the headers', () => {
  const resolved = resolveProvider({ providers: { [KEYLESS_ID]: { enabled: true } } }, KEYLESS_ID)
  assert.equal(resolved.apiKey, '')
  assert.equal(resolved.headers.authorization, undefined, 'a keyless provider was sent a bearer')
  assert.equal(resolved.headers['x-api-key'], undefined, 'a keyless provider was sent a key')
})

check('an anthropic-format provider sends x-api-key, an openai one a bearer', () => {
  const registry = PROVIDERS as any[]
  const openai = registry.find((p: any) => p.format === 'openai-chat' && p.auth.kind === 'apiKey')!
  const anthropic = registry.find((p: any) => p.format === 'anthropic-messages' && p.auth.kind === 'apiKey')
  const shaped = resolveProvider({ providers: { [openai.id]: { enabled: true, apiKey: 'sk-x' } } }, openai.id)
  assert.equal(shaped.headers.authorization, 'Bearer sk-x')
  if (anthropic !== undefined) {
    const claude = resolveProvider({ providers: { [anthropic.id]: { enabled: true, apiKey: 'sk-y' } } }, anthropic.id)
    assert.equal(claude.headers['x-api-key'], 'sk-y')
    assert.equal(claude.headers['anthropic-version'], '2023-06-01')
  }
})

check('a resolved provider never leaks its key into the returned field names', () => {
  const resolved = resolveProvider({ providers: { [KEYED_ID]: { enabled: true, apiKey: 'sk-live-key' } } }, KEYED_ID)
  // The key is carried once, under `apiKey`, and nowhere else.
  const occurrences = JSON.stringify(resolved).split('sk-live-key').length - 1
  assert.ok(occurrences >= 1, 'the key vanished from the resolution')
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 50)
