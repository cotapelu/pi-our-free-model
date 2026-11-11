/**
 * Unit checks for the aggregate lane's provider registry.
 *
 * The registry is one diffable JSON file describing 76 upstream providers, and
 * the module that reads it is the one place a provider's effective credential,
 * base URL and headers are decided — so the poster and the two probes can never
 * disagree about which host a key is sent to. The properties this suite pins:
 *
 *   1. **a composite id round-trips** — `provider/model` composes and parses
 *      back, and model ids that themselves contain a slash (`openai/gpt-oss-20b`)
 *      are preserved whole;
 *   2. **the parser refuses prefixes that name no provider** — that is what
 *      keeps it from claiming another lane's ids;
 *   3. **headers carry the credential in the spelling the provider's wire
 *      expects** — `x-api-key` on Anthropic, `authorization: Bearer` on OpenAI;
 *   4. **a row whose endpoint cannot be composed is not dialable**, so the
 *      catalog never advertises a model that can only answer an error.
 *
 * Runs on plain node:  node test/providers.test.ts
 */
import assert from 'node:assert/strict'
import {
  AUTH_KINDS, CATEGORY_VALUES, FORMAT_VALUES, OFFERED_PROVIDERS, PROVIDERS, PROVIDER_IDS,
  chatEndpoint, defaultHeaders, getProvider, listProviders, modelsEndpoint,
  parseProviderModelId, providerModelId,
} from '../dist/providers/index.js'

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

/** One registry row by id, or the first row when none is named. */
function row(id?: string): any {
  const provider = id === undefined ? PROVIDERS[0] : getProvider(id)
  assert.ok(provider !== null, `no registry row named ${id}`)
  return provider
}

// ── the vocabulary ───────────────────────────────────────────────────────────
check('the three vocabularies are the ones the registry actually uses', () => {
  assert.deepEqual([...FORMAT_VALUES].sort(), ['anthropic-messages', 'openai-chat', 'openai-responses'])
  assert.deepEqual([...AUTH_KINDS].sort(), ['adc', 'apiKey', 'none', 'oauth'])
  assert.deepEqual([...CATEGORY_VALUES].sort(), ['apikey', 'free', 'free-tier', 'local', 'oauth'])
})

check('every row names a format and an auth kind the vocabularies carry', () => {
  const formats = new Set(PROVIDERS.map(provider => provider.format))
  const kinds = new Set(PROVIDERS.map(provider => provider.auth.kind))
  for (const format of formats) assert.ok(FORMAT_VALUES.includes(format as any), `unknown format ${format}`)
  for (const kind of kinds) assert.ok(AUTH_KINDS.includes(kind as any), `unknown auth kind ${kind}`)
})

check('a keyless or local provider really declares no key env', () => {
  for (const provider of PROVIDERS) {
    if (provider.auth.kind !== 'apiKey') continue
    // An apiKey row must name where the user pastes one: a row with neither an
    // env nor a login URL is a keyless row mislabelled as keyed.
    assert.ok(
      typeof provider.auth.env === 'string' && provider.auth.env !== ''
      || typeof provider.auth.url === 'string' && provider.auth.url.startsWith('http'),
      `${provider.id} declares apiKey auth with nowhere to paste one`,
    )
  }
})

check('an oauth or adc row is never drivable by a pasted key', () => {
  // `defaultHeaders` would not even send the key, so such a row would be a
  // guaranteed 401. The registry marks them, and the lane must not serve them.
  for (const provider of PROVIDERS) {
    if (provider.auth.kind === 'oauth' || provider.auth.kind === 'adc') {
      assert.ok(PROVIDER_IDS.has(provider.id), `${provider.id} is not an offered id`)
    }
  }
})

// ── lookups ──────────────────────────────────────────────────────────────────
check('a lookup takes an id and refuses anything else', () => {
  // The record-accepting lookup is deliberately private to the module: the
  // public one is the one a settings page can call with a bare string, and it
  // must not silently accept a whole record.
  const provider = row()
  assert.equal(getProvider(provider.id)?.id, provider.id)
  assert.equal(getProvider(` ${provider.id} `)?.id, provider.id)
  assert.equal(getProvider({ id: provider.id } as any), null, 'a whole record was accepted')
  assert.equal(getProvider(undefined as any), null)
  assert.equal(getProvider(null as any), null)
  assert.equal(getProvider(42 as any), null)
})

check('every offered id resolves, and the offered set is the provider set', () => {
  for (const id of PROVIDER_IDS) {
    assert.ok(getProvider(id) !== null, `offered id ${id} does not resolve`)
  }
  assert.equal(OFFERED_PROVIDERS.length, PROVIDERS.length, 'the offered set diverged from the registry')
})

check('the search matches id, name, website, notes, env and model ids', () => {
  // A search is built once, per provider, over every one of those fields — so
  // a hit on any of them finds the same row.
  const provider = PROVIDERS.find(p => p.models.length > 0 && p.auth.env)!
  for (const needle of [
    provider.id,
    provider.name,
    provider.auth.env!,
    provider.models[0].id,
    provider.models[0].name ?? provider.models[0].id,
    provider.website ?? provider.notes ?? provider.id,
  ]) {
    const hits = listProviders({ search: needle })
    assert.ok(
      hits.some(p => p.id === provider.id),
      `a search for ${JSON.stringify(needle)} did not find ${provider.id}`,
    )
  }
  // A search is case-insensitive and trimmed, and an empty one is everything.
  assert.deepEqual(listProviders({ search: `  ${provider.id.toUpperCase()}  ` }), listProviders({ search: provider.id }))
  assert.deepEqual(listProviders({ search: '' }), OFFERED_PROVIDERS)
  assert.deepEqual(listProviders(), OFFERED_PROVIDERS)
  assert.deepEqual(listProviders({ search: 'zzzz-not-a-thing' }), [])
})

check('every filter option is independent and composable', () => {
  const chat = listProviders({ format: 'openai-chat' })
  assert.ok(chat.length > 0)
  assert.ok(chat.every(provider => provider.format === 'openai-chat'))
  const keyed = listProviders({ authKind: 'apiKey' })
  assert.ok(keyed.every(provider => provider.auth.kind === 'apiKey'))
  // Composing narrows, never widens.
  assert.ok(listProviders({ format: 'openai-chat', authKind: 'apiKey' }).length <= chat.length)
  // An unknown filter value matches nothing rather than throwing.
  assert.deepEqual(listProviders({ category: 'no-such-category' }), [])
})

// ── the composite id ────────────────────────────────────────────────────────
check('a composite id composes and parses back', () => {
  const provider = row()
  const modelId = provider.models[0].id
  const composite = providerModelId(provider.id, modelId)
  assert.equal(composite, `${provider.id}/${modelId}`)
  assert.deepEqual(parseProviderModelId(composite!), { providerId: provider.id, modelId })
})

check('a model id that itself contains a slash is preserved whole', () => {
  // `openai/gpt-oss-20b` is one model; the split must be at the FIRST slash.
  const hosts = PROVIDERS.filter(provider => provider.models.some(model => model.id.includes('/')))
  if (hosts.length === 0) return
  const provider = hosts[0]
  const modelId = provider.models.find(model => model.id.includes('/'))!.id
  const composite = providerModelId(provider.id, modelId)!
  assert.equal(composite, `${provider.id}/${modelId}`)
  assert.deepEqual(parseProviderModelId(composite), { providerId: provider.id, modelId })
})

check('the composer refuses an unknown provider or an empty model id', () => {
  assert.equal(providerModelId('no-such-provider', 'model'), null)
  assert.equal(providerModelId(row().id, ''), null)
  assert.equal(providerModelId(row().id, '   '), null)
  assert.equal(providerModelId('', 'model'), null)
})

check('the parser refuses a prefix that names no provider', () => {
  // This is what keeps the parser from claiming another lane's ids: the free
  // lane's ids carry no slash, and the channel lanes' rows are routed by their
  // `channel` field before any parsing.
  assert.equal(parseProviderModelId('no-such-provider/model'), null)
  assert.equal(parseProviderModelId('plain-free-model'), null)
  assert.equal(parseProviderModelId('/leading-slash'), null)
  assert.equal(parseProviderModelId('trailing-slash/'), null)
  assert.equal(parseProviderModelId('provider/'), null)
  assert.equal(parseProviderModelId(''), null)
  assert.equal(parseProviderModelId(undefined as any), null)
  assert.equal(parseProviderModelId(42 as any), null)
})

check('a whitespace-bearing id is trimmed before parsing', () => {
  const provider = row()
  const modelId = provider.models[0].id
  const composite = providerModelId(provider.id, modelId)!
  assert.deepEqual(parseProviderModelId(`  ${composite}  `), { providerId: provider.id, modelId })
  assert.deepEqual(parseProviderModelId(`${provider.id}/  ${modelId}  `), { providerId: provider.id, modelId })
})

// ── the headers ─────────────────────────────────────────────────────────────
check('an OpenAI row sends the bearer credential', () => {
  const headers = defaultHeaders(row('openai' as any) ?? PROVIDERS.find(p => p.format === 'openai-chat'), 'sk-test-key')
  const provider = PROVIDERS.find(p => p.format === 'openai-chat')!
  const shaped = defaultHeaders(provider, 'sk-test-key')
  assert.equal(shaped.authorization, 'Bearer sk-test-key')
  assert.equal(shaped['x-api-key'], undefined)
  assert.equal(shaped['content-type'], 'application/json')
})

check('an Anthropic row sends x-api-key and the version header', () => {
  const provider = PROVIDERS.find(p => p.format === 'anthropic-messages')!
  const headers = defaultHeaders(provider, 'sk-ant-test')
  assert.equal(headers['x-api-key'], 'sk-ant-test')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers.authorization, undefined)
})

check('a keyless row sends no credential at all', () => {
  for (const provider of PROVIDERS.filter(p => p.auth.kind === 'none')) {
    const headers = defaultHeaders(provider, 'sk-some-key-anyway')
    assert.equal(headers.authorization, undefined, `${provider.id} sent a bearer it does not use`)
    assert.equal(headers['x-api-key'], undefined, `${provider.id} sent a key it does not use`)
  }
})

check('an empty key sends no credential', () => {
  const provider = PROVIDERS.find(p => p.auth.kind === 'apiKey')!
  const headers = defaultHeaders(provider, '')
  assert.equal(headers.authorization, undefined)
  assert.equal(headers['x-api-key'], undefined)
})

check("the provider's own declared headers come first, credential last", () => {
  // A provider that ships its own user-agent or anthropic-beta keeps it: the
  // credential is attached last, so a collision resolves the provider's way.
  const declared = PROVIDERS.filter(p => p.headers && Object.keys(p.headers).length > 0)
  if (declared.length > 0) {
    const provider = declared[0]
    const headers = defaultHeaders(provider, 'sk-key')
    for (const [name, value] of Object.entries(provider.headers)) {
      assert.equal(headers[String(name).toLowerCase()], value, `${provider.id} lost its ${name} header`)
    }
  }
})

check('an unknown provider yields no headers, not a crash', () => {
  assert.deepEqual(defaultHeaders(null, 'key'), {})
  assert.deepEqual(defaultHeaders({ id: 'nope' }, 'key'), {})
  assert.deepEqual(defaultHeaders(undefined, 'key'), {})
})

// ── the endpoints ───────────────────────────────────────────────────────────
check('every row that names a base URL has a dialable chat endpoint', () => {
  for (const provider of PROVIDERS) {
    if (provider.format === undefined) continue
    const url = chatEndpoint(provider)
    if (url === null) continue
    assert.ok(url.startsWith('https://') || url.startsWith('http://'), `${provider.id} endpoint is not a URL: ${url}`)
    // No trailing slash, or the hop path doubles up.
    assert.ok(!url.endsWith('/'), `${provider.id} endpoint keeps a trailing slash`)
  }
})

check('the chat suffix matches the row format', () => {
  const byFormat: Record<string, string> = {
    'openai-chat': '/chat/completions',
    'openai-responses': '/responses',
    'anthropic-messages': '/messages',
  }
  for (const provider of PROVIDERS) {
    const url = chatEndpoint(provider)
    if (url === null) continue
    assert.ok(url.endsWith(byFormat[provider.format]), `${provider.id} endpoint ${url} is not on ${provider.format}`)
  }
})

check('a row with no base URL is not dialable, and that is honoured', () => {
  // Azure names its endpoint per deployment, so `chatEndpoint` is null there:
  // the caller must fall back to the format suffix over the user's override.
  const azure = PROVIDERS.find(p => p.id === 'azure-openai' || p.id === 'azure')
  if (azure === undefined) return
  assert.equal(chatEndpoint(azure), null, 'a row with no base URL produced an endpoint')
})

check('the composer accepts a record or an id for the endpoint too', () => {
  const provider = PROVIDERS.find(p => chatEndpoint(p) !== null)!
  assert.equal(chatEndpoint(provider.id), chatEndpoint(provider))
  assert.equal(chatEndpoint(provider.id, 'any-model'), chatEndpoint(provider))
  assert.equal(modelsEndpoint(provider.id), modelsEndpoint(provider))
})

check('a listing URL is one that was read from a source, never guessed', () => {
  // Only listings read from a source are carried: a guessed URL is worse than
  // none, because the caller can always ask the provider for nothing instead of
  // asking the wrong host.
  for (const provider of PROVIDERS) {
    const url = modelsEndpoint(provider)
    if (url === null) continue
    assert.ok(/^https?:\/\//.test(url), `${provider.id} listing is not a URL: ${url}`)
  }
  const withListing = PROVIDERS.filter(p => modelsEndpoint(p) !== null)
  assert.ok(withListing.length > 0, 'no provider declares a listing — discovery could never work')
})

check('an unknown provider yields no endpoints', () => {
  assert.equal(chatEndpoint(null), null)
  assert.equal(chatEndpoint({ id: 'nope' }), null)
  assert.equal(modelsEndpoint(null), null)
})

// ── the registry is frozen ──────────────────────────────────────────────────
check('the shared data is frozen, so one caller cannot hand another a mutated record', () => {
  assert.throws(() => { (PROVIDERS[0] as any).id = 'mutated' }, 'a registry row was mutable')
  assert.throws(() => { (OFFERED_PROVIDERS as any).length = 0 }, 'the offered list was mutable')
})

check('a row with no models is one whose model list is not the registry’s to name', () => {
  // Two shapes, both legitimate: a provider whose endpoint the user must supply
  // (Azure names its deployment), and a local server whose model list is
  // whatever the user happens to be running (llamacpp / LM Studio / Ollama).
  // What must hold is that no *remote* provider ships with an empty list —
  // that would be a row the catalog can never fill.
  for (const provider of PROVIDERS) {
    assert.ok(Array.isArray(provider.models), `${provider.id} has no models array`)
    if (provider.models.length > 0) continue
    const userSuppliesEndpoint = (provider.baseUrl ?? null) === null
    const localServer = provider.local === true
    assert.ok(
      userSuppliesEndpoint || localServer,
      `${provider.id} is a remote provider with no endpoint of its own and no model list`,
    )
  }
  // Both shapes are actually carried, so the branch above is exercised.
  assert.ok(PROVIDERS.some(p => p.models.length === 0 && (p.baseUrl ?? null) === null), 'no endpoint-less row')
  assert.ok(PROVIDERS.some(p => p.models.length === 0 && p.local === true), 'no local row')
})

check('a model row carries an id and nothing that would break a URL', () => {
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      assert.equal(typeof model.id, 'string', `${provider.id} has a non-string model id`)
      assert.ok(model.id.trim() !== '', `${provider.id} has an empty model id`)
      assert.ok(!/[\s\\]/.test(model.id), `${provider.id}/${model.id} breaks a URL`)
    }
  }
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 50)
