/**
 * Unit checks for the plugin kernel — the half of the plugin platform that
 * decides what may be *loaded*, long before anything runs.
 *
 * The manifest parser is the load-bearing piece: it is the only thing standing
 * between a third-party file and a `fs.writeFileSync` into this data dir, so
 * most of these checks are refusals. Two are about the two places the grammar
 * is easy to get subtly wrong and hard to notice:
 *
 * - `safePluginPath` must reject a path that *escapes* the package directory,
 *   and must reject a path in a shape the installer never writes. One hole here
 *   and `installLocal` copies wherever it is pointed.
 * - `stripStringsAndComments` is what the API tripwires read, so a prose
 *   mention of `process` must not be a violation while a real call must be.
 *   A scanner that flags prose trains authors to disable it.
 *
 * `satisfiesApiVersion` is pinned range by range, because a caret comparison
 * that gets `^2.3.0` wrong installs an extension the host cannot run.
 *
 * Runs on plain node:  node test/plugins.test.ts
 */
import assert from 'node:assert/strict'
import {
  PLUGIN_API_VERSION, PLUGIN_CAPABILITIES, PAGE_ICONS, REGISTRY_FALLBACK,
  builtinDescriptors, manifestHasChannel, manifestHasEnhancement, manifestHasPage,
  parsePluginManifest, providerContributions, safePluginPath, satisfiesApiVersion,
  scanExtensionSource, scanPageAsset, scanPageHtml, scanPageScript, scanPageStyle,
  stripStringsAndComments, CHANNEL_PACK_CHANNELS, WORKBENCH_CLIENTS,
} from '../dist/plugins.js'

let failures = 0
let running = Promise.resolve()
const check = (name: string, fn: () => void | Promise<void>) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${name}\n     ${error?.message ?? error}`) }
  })
}

/** A v2 manifest that passes every rule, so one rule can be broken at a time. */
function manifest(over: Record<string, any> = {}): Record<string, any> {
  return {
    schemaVersion: 2,
    id: 'demo-plugin',
    version: '1.0.0',
    kind: 'channel',
    name: 'Demo',
    main: 'main.mjs',
    files: ['main.mjs'],
    apiVersion: '^2',
    permissions: { network: ['https://api.example.com'], secrets: [], storage: false },
    ...over,
  }
}

// ── safePluginPath ───────────────────────────────────────────────────────────

check('a plain relative package path is accepted', () => {
  assert.equal(safePluginPath('main.mjs'), 'main.mjs')
  assert.equal(safePluginPath('ui/page.html'), 'ui/page.html')
  assert.equal(safePluginPath('assets/font.woff2'), 'assets/font.woff2')
})

check('a path that escapes the package is refused', () => {
  for (const value of ['../escape.mjs', 'ui/../../escape.mjs', '/etc/passwd', 'C:\\Windows\\x.mjs', 'a//b.mjs', './main.mjs', 'main', 'a\\b.mjs', 'x\0.mjs']) {
    assert.equal(safePluginPath(value), null, `"${value}" was accepted as a safe package path`)
  }
})

check('an extension outside the allowlist is refused', () => {
  for (const value of ['main.exe', 'main.sh', 'main.py', 'main.wasm', 'main.tar.gz']) {
    assert.equal(safePluginPath(value), null, `"${value}" was accepted`)
  }
  // The allowlist itself is short and explicit; growing it is a review decision.
  assert.equal(safePluginPath('main.mjs'), 'main.mjs')
  assert.equal(safePluginPath('data.json'), 'data.json')
})

// ── manifest normalization ───────────────────────────────────────────────────

check('a v2 channel manifest normalizes to the shape every consumer reads', () => {
  const parsed = parsePluginManifest(manifest({ models: ['demo-model'] }))
  assert.equal(parsed.schemaVersion, 2)
  assert.equal(parsed.type, 'channel')
  assert.equal(parsed.main, 'main.mjs')
  assert.deepEqual(parsed.models, ['demo-model'])
  assert.deepEqual(parsed.permissions.network, ['https://api.example.com'])
  assert.equal(parsed.apiVersion, '^2')
  assert.equal(parsed.apiCompatible, true)
  assert.equal(parsed.kinds[0], 'channel')
})

check('a network origin keeps its scheme, drops its trailing slash, and drops non-strings', () => {
  const parsed = parsePluginManifest(manifest({ permissions: { network: ['https://a.example.com/', 'http://127.0.0.1:8080', 42, '', 'ftp://x.example.com'] } }))
  // http is kept on purpose: a loopback proxy is http, and `prepareChat` allows
  // it. The trailing slash goes because `URL.origin` never carries one, and the
  // permission is compared against exactly that.
  assert.deepEqual(parsed.permissions.network, ['https://a.example.com', 'http://127.0.0.1:8080'])
})

check('a v1 manifest still loads, and its type becomes a kind', () => {
  const parsed = parsePluginManifest({
    schemaVersion: 1, id: 'legacy', version: '0.1.0', type: 'enhancement',
    main: 'main.mjs', files: ['main.mjs'], hooks: ['onRequest'],
  })
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.type, 'enhancement')
  assert.equal(parsed.apiVersion, '')
  assert.equal(parsed.apiCompatible, true)
  assert.equal(manifestHasEnhancement(parsed), true)
  assert.equal(manifestHasChannel(parsed), false)
})

check('a bad id, a bad version and a bad main are each a refusal with a reason', () => {
  assert.throws(() => parsePluginManifest(manifest({ id: 'Demo' })), /must match/)
  assert.throws(() => parsePluginManifest(manifest({ id: 'x' })), /must match/)
  assert.throws(() => parsePluginManifest(manifest({ version: '1.0' })), /is not semver/)
  assert.throws(() => parsePluginManifest(manifest({ main: 'main.js' })), /must be a relative \.mjs/)
  assert.throws(() => parsePluginManifest(manifest({ files: ['other.mjs'] })), /not in the files list/)
})

check('a page entry must be a declared relative .html file', () => {
  const pages = { contributes: { pages: [{ id: 'settings', title: 'Settings', entry: 'ui/settings.html' }] }, files: ['ui/settings.html'], kind: 'page', main: '' }
  const parsed = parsePluginManifest(manifest(Object.assign({}, pages, { id: 'paged' })))
  assert.equal(parsed.pages.length, 1)
  assert.equal(parsed.pages[0].entry, 'ui/settings.html')
  assert.equal(parsed.pages[0].icon, 'puzzle', 'an unnamed icon gets the documented default')
  assert.equal(manifestHasPage(parsed), true)
  assert.throws(() => parsePluginManifest(manifest({ contributes: { pages: [{ id: 'settings', entry: 'ui/missing.html' }] } })), /not in the manifest files list/)
  // A one-character page id is below the grammar's minimum, so the row is
  // dropped rather than mounted under an id the router cannot address.
  const short = parsePluginManifest(manifest({ contributes: { pages: [{ id: 'x', entry: 'p.html' }] }, files: ['p.html'], kind: 'page', main: '' }))
  assert.equal(short.pages.length, 0)
})

check('a page icon outside the console set falls back, never throws', () => {
  const parsed = parsePluginManifest(manifest({ contributes: { pages: [{ id: 'pp', entry: 'p.html', icon: 'not-an-icon' }] }, files: ['p.html'], kind: 'page', main: '' }))
  assert.equal(parsed.pages[0].icon, 'puzzle')
  assert.ok(PAGE_ICONS.has('puzzle'))
})

check('config fields are capped, typed and stripped of prototype keys', () => {
  const parsed = parsePluginManifest(manifest({
    config: [
      { key: 'token', type: 'password', label: 'Token', default: '' },
      { key: 'mode', type: 'select', options: ['a', 'b'], default: 'a' },
      { key: '__proto__', type: 'text' },
      { key: 'bogus', type: 'danger' },
    ],
  }))
  assert.deepEqual(parsed.config.map(field => field.key), ['token', 'mode', 'bogus'])
  assert.equal(parsed.config[2].type, 'text', 'an unknown type becomes text, never an error')
  assert.deepEqual(parsed.config[1].options, ['a', 'b'])
})

check('a secret key outside the grammar is dropped, not stored', () => {
  const parsed = parsePluginManifest(manifest({ permissions: { network: [], secrets: ['ok_key', 'bad key!', 'a'.repeat(65)] } }))
  assert.deepEqual(parsed.permissions.secrets, ['ok_key'])
})

check('unknown capabilities survive so the plugin mounts as pending', () => {
  const parsed = parsePluginManifest(manifest({ requires: ['teleport'] }))
  assert.deepEqual(parsed.requires, ['teleport'])
  assert.equal(PLUGIN_CAPABILITIES.has('teleport'), false, 'an unknown capability must not be silently provided')
})

// ── apiVersion ranges ────────────────────────────────────────────────────────

check('the compact apiVersion ranges resolve the way authors write them', () => {
  const host = PLUGIN_API_VERSION
  assert.equal(satisfiesApiVersion('^2', host), true)
  assert.equal(satisfiesApiVersion('^2.0.0', host), true)
  assert.equal(satisfiesApiVersion('^3', host), false)
  assert.equal(satisfiesApiVersion('~2.0', host), true)
  assert.equal(satisfiesApiVersion('~2.9', host), false)
  assert.equal(satisfiesApiVersion('2.x', host), true)
  assert.equal(satisfiesApiVersion('2.0.x', host), true)
  assert.equal(satisfiesApiVersion('2', host), true)
  assert.equal(satisfiesApiVersion('*', host), true)
  assert.equal(satisfiesApiVersion('', host), true, 'an absent range imposes nothing')
  assert.equal(satisfiesApiVersion('>=2 <3', host), true)
  assert.equal(satisfiesApiVersion('>=3', host), false)
  assert.equal(satisfiesApiVersion('nonsense', host), false)
})

check('a caret floor below the host still passes; one above it does not', () => {
  // `^2.5.0` against host 2.9.0: the minor is above the floor, so it passes.
  assert.equal(satisfiesApiVersion('^2.5.0', '2.9.0'), true)
  assert.equal(satisfiesApiVersion('^2.5.0', '2.4.0'), false)
  assert.equal(satisfiesApiVersion('^2.5.0', '3.0.0'), false)
})

// ── static scans ─────────────────────────────────────────────────────────────

check('a plain ofm:sdk plugin passes its scan', () => {
  const result = scanExtensionSource("import { sdk } from 'ofm:sdk'\nexport default defineChannel({\n  async prepareChat(request) { return { url: 'https://x.example.com/v1/chat' } },\n})\n")
  assert.equal(result.ok, true, result.violations.join('; '))
})

check('a node builtin import is refused by name, not by heuristic', () => {
  const result = scanExtensionSource("import { sdk } from 'ofm:sdk'\nimport fs from 'node:fs'\nexport default defineChannel({})\n")
  assert.equal(result.ok, false)
  assert.match(result.violations.join(' '), /node:fs/)
})

check('a forbidden API named in prose is not a violation', () => {
  // The tripwires run over the string-stripped text, so a comment saying
  // "never call process" is prose. A scanner that flags it trains authors to
  // distrust it, and then the real violations look like noise too.
  const result = scanExtensionSource("import { sdk } from 'ofm:sdk'\n// never call process.exit here; the host owns the process\nexport default defineChannel({ prepareChat: async () => ({}) })\n")
  assert.equal(result.ok, true, result.violations.join('; '))
})

check('a forbidden API actually called is a violation', () => {
  const result = scanExtensionSource("import { sdk } from 'ofm:sdk'\nconst who = process.env.USER\nexport default defineChannel({})\n")
  assert.equal(result.ok, false)
  assert.match(result.violations.join(' '), /forbidden API/)
})

check('a minified bundle is refused: it is not reviewable', () => {
  const line = `const a='${'x'.repeat(520)}'`
  const result = scanExtensionSource(`import {{ sdk }} from 'ofm:sdk'\n${line}\n${line}\n${line}\nexport default defineChannel({{}})\n`)
  assert.equal(result.ok, false)
  assert.match(result.violations.join(' '), /exceed 500 characters/)
})

check('an inline page script is refused; a declared one is not', () => {
  const inline = scanPageHtml('<!doctype html><html><body><script>window.ofm.config.get()</script></body></html>')
  assert.equal(inline.ok, false)
  assert.match(inline.violations.join(' '), /inline <script>/)
  const declared = scanPageHtml('<!doctype html><html><body><script type="module" src="./page.js"></script></body></html>')
  assert.equal(declared.ok, true, declared.violations.join('; '))
})

check('a page plugin has no direct network of its own', () => {
  for (const source of ["fetch('/api')", "new XMLHttpRequest()", "new WebSocket('wss://x')", "new EventSource('/s')", "navigator.sendBeacon('/b')", "localStorage.setItem('a','b')", "window.open('https://x')"]) {
    const result = scanPageScript(`window.ofm.ready.then(() => { ${source} })\n`)
    assert.equal(result.ok, false, `${source} was allowed in a page script`)
    assert.match(result.violations.join(' '), /forbidden API/)
  }
})

check('page CSS refuses @import and url() outside the package', () => {
  const imported = scanPageStyle(`@import url('https://evil.example.com/x.css');\nbody{color:red}`)
  assert.equal(imported.ok, false)
  const remote = scanPageStyle(`body{background:url('https://cdn.example.com/a.png')}`)
  assert.equal(remote.ok, false)
  const local = scanPageStyle(`body{background:url('./bg.png')}`)
  assert.equal(local.ok, true, local.violations.join('; '))
})

check('a page asset picks its scan by extension', () => {
  assert.equal(scanPageAsset({ path: 'p.html', text: '<p>x</p>' }).ok, true)
  assert.equal(scanPageAsset({ path: 'p.js', text: "fetch('/x')" }).ok, false)
  assert.equal(scanPageAsset({ path: 'p.css', text: 'body{color:red}' }).ok, true)
  // Binary and data assets are display-only: the declared path is the contract.
  assert.equal(scanPageAsset({ path: 'p.png', text: 'binary' }).ok, true)
  assert.equal(scanPageAsset({ path: 'p.json', text: '{}' }).ok, true)
})

check('stripStringsAndComments blanks strings but keeps their delimiters', () => {
  // The delimiters survive so a scanner reading the stripped text still sees
  // the token positions; the *body* is gone.
  const stripped = stripStringsAndComments(`const a = 'process' // process\n/* process */ const b = "process"`)
  assert.equal(stripped.includes('process'), false)
  assert.equal(stripped.includes("''"), true)
  assert.equal(stripped.includes('""'), true)
})

check('a regexp literal containing a quote is not a string start', () => {
  // `/['"]/` — the quote inside a character class must not open a string, or
  // everything after it is blanked and the scan reads nothing at all.
  const stripped = stripStringsAndComments(`const re = /['"]/g\nconst b = process`)
  assert.equal(stripped.includes('process'), true, 'the token after the regexp was swallowed')
})

// ── built-in descriptors and the bundled shelf ───────────────────────────────

check('the bundled registry parses and the shelf is not empty', () => {
  assert.equal(REGISTRY_FALLBACK.schemaVersion, 1)
  assert.ok(REGISTRY_FALLBACK.plugins.length > 0, 'an empty shelf turns the plugin center into a blank page')
  const ids = REGISTRY_FALLBACK.plugins.map((entry: any) => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'the bundled shelf lists an id twice')
})

check('every bundled shelf entry survives the manifest parser', () => {
  // The snapshot is a build artifact; if a schema change makes one row invalid
  // the marketplace silently loses a card, which is the failure mode this pins.
  for (const entry of REGISTRY_FALLBACK.plugins) {
    const parsed = parsePluginManifest(entry)
    assert.ok(parsed.id !== '', 'a bundled entry has no usable id')
    assert.ok(parsed.main !== '' || parsed.pages.length > 0, `${parsed.id} has neither code nor page`)
  }
})

check('every built-in descriptor parses and declares what it provides', () => {
  const descriptors = builtinDescriptors()
  assert.ok(descriptors.length >= 5)
  for (const descriptor of descriptors) {
    // `registerBuiltin` injects the host version after spreading the
    // descriptor's manifest, so a descriptor need not carry its own version.
    const parsed = parsePluginManifest({ schemaVersion: 2, kind: 'bundle', apiVersion: '^2', version: PLUGIN_API_VERSION, ...descriptor.manifest, essential: true }, { source: 'builtin' })
    assert.equal(parsed.essential, true, `${parsed.id} is not marked essential`)
    assert.equal(parsed.builtin, true, `${parsed.id} is not marked builtin`)
    assert.ok(parsed.provides.length > 0, `${parsed.id} provides nothing`)
  }
})

check('the provider registry projection stays a projection', () => {
  const rows = providerContributions()
  assert.ok(Array.isArray(rows) && rows.length > 0, 'the provider shelf is empty')
  for (const row of rows) {
    assert.equal(typeof row.modelCount, 'number')
    assert.equal(typeof row.id, 'string')
    assert.ok(!('models' in row), 'the projection leaked the full model rows')
  }
})

check('the channel-pack and workbench tables are the ones the console indexes', () => {
  assert.equal(CHANNEL_PACK_CHANNELS.length, 10)
  assert.equal(new Set(CHANNEL_PACK_CHANNELS.map(row => row.id)).size, 10)
  assert.equal(WORKBENCH_CLIENTS.length, 6)
  for (const client of WORKBENCH_CLIENTS) {
    assert.ok(['cli', 'desktop'].includes(client.kind), `${client.id} names an unknown kind`)
  }
})

running.then(() => {
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
})
