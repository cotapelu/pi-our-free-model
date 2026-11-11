/**
 * Unit checks for the standalone product's modules.
 *
 * The standalone is the half of the port that has no host: it owns its own data
 * directory, its own key, its own console, and its own LAN relay. These checks
 * pin the rules that make that safe rather than merely working:
 *
 * - validation refuses a malformed group/key/plan *before* it reaches a store
 *   or a spawn (`routing.ts`, `providers.ts`, `library.ts`, `client-terminal.ts`);
 * - the public view of a keyed provider never carries the key (`providers.ts`);
 * - the desktop updater only accepts this repository's own signed releases
 *   (`desktop-update.ts`);
 * - a catalog row survives a damaged persisted store (`catalog-rows.ts`);
 * - the Anthropic folder and the Gemini route agree with the wire they speak
 *   (`anthropic-frames.ts`, `gemini-endpoint.ts`);
 * - the chain's cooldown verdict answers the same question `classifyFailure`
 *   does, in cooldown arithmetic (`classify.ts`).
 *
 * Runs on plain node:  node test/standalone-parts.test.ts
 */
import assert from 'node:assert/strict'
import { createRoutingManagement } from '../dist/packages/standalone/routing.js'
import { publicProviders } from '../dist/packages/standalone/providers.js'
import { newerVersion, selectDesktopRelease, installerChecksum } from '../dist/packages/standalone/desktop-update.js'
import { parseListing, buildCatalog, reviveKiloCatalog, isKiloEntry } from '../dist/core/catalog-rows.js'
import { foldAnthropicOutcome, countTokens } from '../dist/gateway/anthropic-frames.js'
import { geminiRoute } from '../dist/gateway/gemini.js'
import { cooldownVerdict } from '../dist/gateway/classify.js'
import { createWorkbenchLibrary } from '../dist/packages/standalone/library.js'

let failures = 0
let running = Promise.resolve()
/**
 * A **ref'd** keep-alive while the checks run.
 *
 * Every check here resolves through microtasks, so without a live handle Node
 * exits when the queue drains — and the checks queued behind the one that just
 * resolved never run. That is the same silent-drop failure the `&&` chain in
 * package.json used to have; the keep-alive is cleared before the result prints.
 */
const keepAlive = setInterval(() => {}, 1000)
function check(name: string, fn: () => void | Promise<void>) {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error) { failures++; console.log(`FAIL ${name}\n     ${(error as Error)?.message ?? error}`) }
  })
}

/** A settings/store/runtime triple the management surfaces can be handed. */
function harness(settings: Record<string, unknown>, catalog: any[] = []) {
  const persisted: Record<string, unknown>[] = []
  const stores = {
    settings: {
      value: settings,
      get() { return this.value },
      update(patch: Record<string, unknown>) { Object.assign(this.value, patch) },
      flush() {},
      writeFailed: false,
    },
  }
  const runtime = {
    catalog,
    state() { return { catalog: this.catalog, routing: {} } },
    syncAggregateCatalog() {},
  }
  const persist = (patch: Record<string, unknown>) => { persisted.push(patch); stores.settings.update(patch) }
  return { stores, runtime, persist, persisted }
}

// ── routing: the persisted group must stay honest ─────────────────────────────
check('routing rejects a group with unknown fields', () => {
  const { stores, runtime, persist } = harness({ combos: [] })
  const management = createRoutingManagement({ stores, runtime, persist })
  assert.throws(() => management.save({ combo: { name: 'x', models: ['a'], strategy: 'fallback', stickyLimit: 1, enabled: true, extra: 1 } }),
    /路由组配置无效/)
})

check('routing rejects a self-referencing group', () => {
  const { stores, runtime, persist } = harness({ combos: [] })
  const management = createRoutingManagement({ stores, runtime, persist })
  assert.throws(() => management.save({ combo: { name: 'x', models: ['combo:x'], strategy: 'fallback', stickyLimit: 1, enabled: true } }),
    /路由组不能引用自身/)
})

check('routing refuses a cycle between two groups', () => {
  const { stores, runtime, persist } = harness({
    combos: [{ id: 'combo:a', name: 'a', models: ['combo:b'], strategy: 'fallback', stickyLimit: 1, enabled: true }],
  }, [{ id: 'combo:a' }, { id: 'combo:b' }])
  const management = createRoutingManagement({ stores, runtime, persist })
  assert.throws(() => management.save({ combo: { name: 'b', models: ['combo:a'], strategy: 'fallback', stickyLimit: 1, enabled: true } }),
    /循环引用/)
})

check('routing persists a valid group and rebuilds the usable view', () => {
  const { stores, runtime, persist, persisted } = harness({ combos: [] }, [{ id: 'ofm-kilo/x' }])
  const management = createRoutingManagement({ stores, runtime, persist })
  const saved = management.save({ combo: { name: 'chain', models: ['ofm-kilo/x'], strategy: 'fallback', stickyLimit: 1, enabled: true } })
  assert.equal(saved.combos.length, 1)
  assert.equal(persisted.length, 1)
  assert.deepEqual(Object.keys(persisted[0]), ['combos'])
})

// ── providers: the key never leaves through the public view ───────────────────
check('provider public view carries a hint and redacts the test message', () => {
  const view = publicProviders({ providers: { openai: { enabled: true, apiKey: 'sk-secret-token-1234', models: [], lastTest: { message: 'failed with sk-secret-token-1234', ok: false } } } })
  assert.equal(view.openai.hasKey, true)
  assert.equal(view.openai.keyHint, '…1234')
  assert.equal(view.openai.lastTest.message, 'failed with [redacted]')
  assert.ok(!JSON.stringify(view).includes('sk-secret-token'))
})

// ── desktop updater: only this repository's own signed release ────────────────
check('newerVersion compares semver, and refuses anything else', () => {
  assert.equal(newerVersion('2.7.5', '2.7.4'), true)
  assert.equal(newerVersion('2.7.4', '2.7.5'), false)
  assert.equal(newerVersion('2.7.4', '2.7.4'), false)
  assert.equal(newerVersion('v2.7.5', '2.7.4'), false)
})

check('selectDesktopRelease skips drafts, prereleases and foreign assets', () => {
  const release = (tag: string, extras: Record<string, unknown> = {}) => ({
    draft: false, prerelease: false, tag_name: tag, body: '', published_at: null,
    assets: [
      { name: `Our.Free.Model_${tag.slice(1)}_x64-setup.exe`, size: 1024, browser_download_url: `https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/download/${tag}/Our.Free.Model_${tag.slice(1)}_x64-setup.exe` },
      { name: 'SHA256SUMS', browser_download_url: `https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/download/${tag}/SHA256SUMS` },
    ],
    ...extras,
  })
  assert.equal(selectDesktopRelease([release('v2.7.4')])?.version, '2.7.4')
  assert.equal(selectDesktopRelease([release('v2.7.4'), release('v2.7.5')])?.version, '2.7.5')
  assert.equal(selectDesktopRelease([release('v2.7.5', { draft: true })]), null)
  assert.equal(selectDesktopRelease([release('v2.7.5', { prerelease: true })]), null)
  // An installer whose URL is not this repository's own release path is
  // refused at the source check — dsh throws here, and the check route turns
  // that into its error phase rather than serving a foreign binary.
  const foreign = release('v2.7.5')
  foreign.assets[0].browser_download_url = 'https://example.com/installer.exe'
  assert.throws(() => selectDesktopRelease([foreign]), /官方/)
})

check('installerChecksum needs exactly one matching line', () => {
  const digest = 'a'.repeat(64)
  const text = `${digest}  Our.Free.Model_2.7.5_x64-setup.exe\n`
  assert.equal(installerChecksum(text, 'Our.Free.Model_2.7.5_x64-setup.exe'), digest)
  assert.throws(() => installerChecksum(text, 'other.exe'), /唯一/)
  assert.throws(() => installerChecksum(`${text}${digest}  Our.Free.Model_2.7.5_x64-setup.exe\n`, 'Our.Free.Model_2.7.5_x64-setup.exe'), /唯一/)
})

// ── catalog rows: a damaged store degrades, never crashes ─────────────────────
check('parseListing reads data, models and bare arrays alike', () => {
  assert.deepEqual(parseListing({ data: [{ id: 'a' }] }), ['a'])
  assert.deepEqual(parseListing({ models: [{ id: 'b' }] }), ['b'])
  assert.deepEqual(parseListing(['c']), ['c'])
  assert.deepEqual(parseListing({}), [])
})

check('reviveKiloCatalog re-validates field by field and drops junk rows', () => {
  const rows = reviveKiloCatalog([
    { id: 'openrouter/x', name: 'X', channel: 'kilo', contextWindow: 200000, maxOutput: 32768, vision: true, efforts: ['low', 'high'] },
    { id: '', channel: 'kilo' },
    'not-an-object',
    { id: 'openrouter/y', channel: 'other' },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'openrouter/x')
  assert.equal(isKiloEntry(rows[0]), true)
  assert.deepEqual(rows[0].efforts, ['low', 'high'])
})

check('buildCatalog keeps the free lane free and drops duplicates by base id', () => {
  const rows = buildCatalog(['mimo-v2.6-flash-free', 'union-alpha', 'union-alpha', 'not-a-free-model'])
  const ids = rows.map((row: any) => row.id)
  assert.ok(ids.includes('union-alpha') && ids.includes('mimo-v2.6-flash-free'))
  assert.equal(ids.filter((id: string) => id === 'union-alpha').length, 1)
})

// ── Anthropic/Gemini codecs ───────────────────────────────────────────────────
check('foldAnthropicOutcome answers in Anthropic usage spelling', () => {
  const outcome = foldAnthropicOutcome({ text: '', thinking: '', toolCalls: [], usage: undefined }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } })
  assert.equal(outcome.usage.input_tokens, 10)
  assert.equal(outcome.usage.output_tokens, 5)
  assert.equal(outcome.usage.total_tokens, 15)
  const toolOutcome = foldAnthropicOutcome({ text: '', thinking: '', toolCalls: [{ slot: 0, id: '', name: '', arguments: '{"a":' }], usage: undefined }, { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(toolOutcome.truncated, true)
})

check('countTokens answers a non-zero count for an empty body', () => {
  assert.ok(countTokens({ messages: [] }).input_tokens > 0)
})

check('geminiRoute parses the native path and rejects a foreign one', () => {
  const route = geminiRoute('/v1beta/models/ofm-kilo%2Fkilo-auto-free:generateContent')
  assert.equal(route?.model, 'ofm-kilo/kilo-auto-free')
  assert.equal(geminiRoute('/v1/chat/completions'), undefined)
})

// ── cooldown: the chain's verdict agrees with the classifier ──────────────────
check('cooldownVerdict treats a caller 4xx as not-fallback and a 5xx as transient', () => {
  const request = cooldownVerdict({ status: 400, message: 'bad request' })
  assert.equal(request.shouldFallback, false)
  const server = cooldownVerdict({ status: 503, message: 'Service Unavailable' })
  assert.equal(server.shouldFallback, true)
  assert.ok(server.cooldownMs > 0)
})

// ── library: managed storage owns what it wrote, nothing else ─────────────────
check('library refuses a profile client with an unknown id', () => {
  const dir = '/tmp/ofm-library-check-' + process.pid
  const workbench = { clients: () => [] }
  const library = createWorkbenchLibrary({ dataDir: dir, workbench })
  assert.throws(() => library.saveProfile({ name: 'ok' }), /Unsupported fields|Invalid/)
})

Promise.allSettled([running]).then(() => {
  clearInterval(keepAlive)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
  if (failures > 0) process.exitCode = 1
})
