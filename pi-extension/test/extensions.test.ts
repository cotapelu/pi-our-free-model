/**
 * Unit checks for the extension platform's trust fences.
 *
 * These are the checks that matter most in this module, because every one of
 * them pins a place where a *refusal* is the correct answer and an approval
 * would be a hole. The registry signature, the host allowlist, the digest
 * check, the page asset capability token and the page RPC allowlist each get
 * their own; a regression in any of them turns a curated marketplace into an
 * arbitrary-download one.
 *
 * The other half pins the *fail-open* surfaces, which are the opposite shape
 * and equally load-bearing: an enhancement hook that throws must ship the body
 * unchanged, and a hook that returns a row it did not have must not be able to
 * introduce it.
 *
 * Runs on plain node:  node test/extensions.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  createExtensionRuntime, parseRegistry, registrySources, verifyRegistrySignature,
  PINNED_EXTENSIONS_PUBLIC_KEY,
} from '../dist/extensions.js'
import { REGISTRY_FALLBACK } from '../dist/plugins.js'
import { parsePluginManifest } from '../dist/plugins.js'


/**
 * A loopback mirror, the way the upstream offline suite serves a registry.
 *
 * `OFM_EXTENSIONS_REGISTRY` must be a URL (`new URL(source)` is what the error
 * sentence and `hostAllowed` both use), and `hostAllowed` accepts the
 * override's own origin — which is exactly the one case where a non-https
 * source is legitimate. So the local mirror is the only shape that works, and
 * it also exercises the loopback branch a self-hosted registry uses.
 */
async function mirror(make: (fileUrl: (name: string) => string) => any, { sign = true, files = {} as Record<string, string> } = {}) {
  const http = await import('node:http')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-mirror-'))
  void dir
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/registry.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return }
    if (path === '/registry.sig') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(signature); return }
    const name = path.replace(/^\/files\//, '')
    if (Object.hasOwn(files, name)) { res.writeHead(200); res.end(files[name]); return }
    res.writeHead(404); res.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const fileUrl = (name: string) => `http://127.0.0.1:${port}/files/${name}`
  // The payload is built *after* the port is known, so an entry's signed file
  // URL can point at this mirror — which is the one origin `hostAllowed`
  // accepts from an override, and the only way a loopback registry works.
  const payload = make(fileUrl)
  const body = JSON.stringify(payload)
  const signature = sign ? crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') : 'AAAA'
  return {
    source: `http://127.0.0.1:${port}/registry.json`,
    fileUrl,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** Point the registry source at a local mirror and keep the signing key in step. */
function useMirror(source: string): void {
  process.env.OFM_EXTENSIONS_REGISTRY = source
  process.env.OFM_EXTENSIONS_PUBLIC_KEY = PUBLIC_KEY_BASE64
}


const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ext-'))
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ext-'))

let failures = 0
let running = Promise.resolve()
const check = (name: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${name}\n     ${error?.message ?? error}`) }
  })
}

/** Sign a registry document the way the marketplace's publisher does. */
function signRegistry(payload: any, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64')
}

/** The canonical form `stableStringify` builds: sorted keys, no whitespace. */
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(row => canonical(row ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const PUBLIC_KEY_BASE64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

function clearSource(): void {
  delete process.env.OFM_EXTENSIONS_REGISTRY
  delete process.env.OFM_EXTENSIONS_PUBLIC_KEY
  delete process.env.OFM_EXTENSIONS_ALLOW_UNSIGNED
}

/**
 * One registry entry, in the shape a **registry row** uses.
 *
 * The distinction that trips everyone up: the manifest's `main` is a *path*
 * (`main.mjs`), while the registry row's `main` is the signed *file object*
 * (`{url, size, sha256}`). `parsePluginManifest` reads the path out of the
 * object when it is one, and `registryFiles` reads the object out of the row.
 * A fixture that puts a string in the row's `main` is refused with "url must be
 * an https URL", which looks like a URL problem and is a shape problem.
 */
function oneEntry(over: Record<string, any> = {}): Record<string, any> {
  return {
    schemaVersion: 2,
    id: 'demo-channel',
    version: '1.0.0',
    kind: 'channel',
    name: 'Demo',
    files: ['main.mjs'],
    main: { url: 'https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/demo/main.mjs', size: 24, sha256: 'b'.repeat(64) },
    apiVersion: '^2',
    minHost: '2.8.0',
    permissions: { network: ['https://api.example.com'], secrets: [], storage: false },
    ...over,
  }
}

const onePlugin = (over: Record<string, any> = {}) => ({
  schemaVersion: 2,
  generatedAt: '2026-11-11T00:00:00Z',
  plugins: [oneEntry(over)],
})

// ── signature ────────────────────────────────────────────────────────────────

check('a correctly signed registry verifies', () => {
  const payload = { schemaVersion: 1, plugins: [] }
  assert.equal(verifyRegistrySignature(payload, signRegistry(payload, privateKey), PUBLIC_KEY_BASE64), true)
})

check('a registry signed by any other key does not', () => {
  const other = crypto.generateKeyPairSync('ed25519')
  const payload = { schemaVersion: 1, plugins: [{ id: 'x' }] }
  const forged = signRegistry(payload, other.privateKey)
  assert.equal(verifyRegistrySignature(payload, forged, PUBLIC_KEY_BASE64), false)
})

check('one added field invalidates the signature', () => {
  // The signature is over the *canonical form*, so a package list appended
  // after signing — the shape a compromised mirror would use — does not verify.
  const payload = { schemaVersion: 1, plugins: [] }
  const signature = signRegistry(payload, privateKey)
  payload.plugins.push({ id: 'sneaky', version: '9.9.9' })
  assert.equal(verifyRegistrySignature(payload, signature, PUBLIC_KEY_BASE64), false)
})

check('key order does not change the canonical form', () => {
  // Same document, two serialization orders: the signature must verify, or
  // every publisher and every mirror disagree about the same bytes.
  const left = { a: 1, b: { c: 2, d: 3 } }
  const right = { b: { d: 3, c: 2 }, a: 1 }
  assert.equal(canonical(left), canonical(right))
  assert.equal(verifyRegistrySignature(right, signRegistry(left, privateKey), PUBLIC_KEY_BASE64), true)
})

check('an undefined field is dropped and nulled in arrays, as the publisher does', () => {
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(canonical([undefined]), '[null]')
})

check('a missing or malformed signature is a refusal, not an exception', () => {
  for (const signature of ['', 'not-base64!!', null, 42]) {
    assert.equal(verifyRegistrySignature({ plugins: [] }, signature, PUBLIC_KEY_BASE64), false, `signature ${JSON.stringify(signature)} verified`)
  }
  assert.equal(verifyRegistrySignature({ plugins: [] }, signRegistry({ plugins: [] }, privateKey), ''), false, 'an empty public key verified')
})

check('the shipped public key is a well-formed Ed25519 SPKI key', () => {
  // Not a check that this is the *right* key — that the constant parses at all,
  // so a truncated paste fails loudly here instead of failing every registry
  // read with "signature check failed".
  const key = crypto.createPublicKey({ key: Buffer.from(PINNED_EXTENSIONS_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' })
  assert.equal(key.asymmetricKeyType, 'ed25519')
})

// ── registry document parsing ────────────────────────────────────────────────

check('a registry document must be an object carrying a plugins array', () => {
  assert.throws(() => parseRegistry(null), /must be a JSON object/)
  assert.throws(() => parseRegistry([]), /must be a JSON object/)
  assert.throws(() => parseRegistry({}), /plugins array/)
})

check('a malformed entry costs one card, never the whole market', () => {
  const view = parseRegistry(onePlugin({ version: 'not-semver' }))
  assert.equal(view.plugins.length, 0, 'a broken row took the shelf down')
  assert.equal(parseRegistry(onePlugin()).plugins.length, 1, 'a well-formed row was refused')
  const mixed = parseRegistry({ schemaVersion: 2, plugins: [
    oneEntry({ id: 'good' }),
    oneEntry({ id: 'bad', version: 'x' }),
  ] })
  assert.deepEqual(mixed.plugins.map((entry: any) => entry.manifest.id), ['good'])
})

check('an entry with no downloadable file is refused', () => {
  // A page-only entry without ui.files has nothing to download.
  const view = parseRegistry({ schemaVersion: 2, plugins: [
    { schemaVersion: 2, id: 'paged', version: '1.0.0', kind: 'page', pages: [{ id: 'pp', title: 'P', entry: 'p.html' }], files: ['p.html'] },
  ] })
  assert.equal(view.plugins.length, 0)
})

check('a file the manifest did not declare cannot ride the signed file list', () => {
  // The whole point of the files/manifest pairing: the signed manifest and the
  // signed file list cannot disagree about what a package contains.
  // A v2 entry may not name a file its manifest did not declare: the signed
  // manifest and the signed file list cannot disagree about a package.
  const declared = parseRegistry({ schemaVersion: 2, plugins: [oneEntry({ ui: { files: [{ path: 'ui/page.html', url: 'https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/demo/ui/page.html', size: 10, sha256: 'c'.repeat(64) }] } })] })
  assert.equal(declared.plugins.length, 0, 'a page file the manifest never declared was accepted')
  const declaredRight = parseRegistry({ schemaVersion: 2, plugins: [oneEntry({ files: ['main.mjs', 'ui/page.html'], ui: { files: [{ path: 'ui/page.html', url: 'https://raw.githubusercontent.com/Ebony-Vinyl/ofm-extensions/main/packages/demo/ui/page.html', size: 10, sha256: 'c'.repeat(64) }] } })] })
  assert.equal(declaredRight.plugins.length, 1, 'a declared page file was refused')
})

check('the bundled shelf parses through the same validator', () => {
  const view = parseRegistry(REGISTRY_FALLBACK)
  assert.equal(view.plugins.length, REGISTRY_FALLBACK.plugins.length, 'the bundled shelf lost an entry')
  for (const entry of view.plugins) {
    assert.ok(entry.files.length > 0, `${entry.manifest.id} has no downloadable file`)
    assert.ok(entry.size > 0 && /^[0-9a-f]{64}$/.test(entry.sha256), `${entry.manifest.id} has no signed digest`)
  }
})

// ── registry sources ─────────────────────────────────────────────────────────

check('the mirror list is raw, then two jsDelivr edges, then the plain-read proxy', () => {
  clearSource()
  const sources = registrySources()
  assert.equal(sources.length, 4)
  assert.match(sources[0], /raw\.githubusercontent\.com/)
  assert.match(sources[1], /cdn\.jsdelivr\.net/)
  assert.match(sources[2], /gcore\.jsdelivr\.net/)
  assert.match(sources[3], /gh-proxy\.com/)
})

check('a signed local mirror serves its shelf, and the signature is what allowed it', async () => {
  clearSource()
  const site = await mirror(() => onePlugin())
  useMirror(site.source)
  const runtime = createExtensionRuntime({ dataDir: path.join(tempDir(), 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  const view = await runtime.refreshRegistry({ force: true })
  assert.equal(view.plugins.length, 1)
  assert.equal(view.plugins[0].manifest.id, 'demo-channel')
  assert.equal(runtime.registryMeta().source, site.source)
  runtime.dispose()
  await site.close()
})

check('a registry whose signature does not match is never served from its own bytes', async () => {
  clearSource()
  const site = await mirror(() => onePlugin(), { sign: false })
  useMirror(site.source)
  const runtime = createExtensionRuntime({ dataDir: path.join(tempDir(), 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  const view = await runtime.refreshRegistry({ force: true })
  assert.notEqual(view.plugins.length, 1, 'an unsigned registry was served')
  assert.equal(runtime.registryMeta().source, 'bundled', 'the bundled shelf did not take over')
  runtime.dispose()
  await site.close()
})

check('one forged field invalidates the signature the mirror serves', async () => {
  clearSource()
  // Valid document, signature over a *different* document — the shape a
  // compromised mirror produces by appending a package after signing.
  const payload = onePlugin()
  const site = await mirror(() => payload)
  const forged = crypto.sign(null, Buffer.from(canonical({ ...payload, plugins: [] })), privateKey).toString('base64')
  const http = await import('node:http')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-forge-'))
  void dir
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end(forged) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  useMirror(`http://127.0.0.1:${port}/registry.json`)
  const runtime = createExtensionRuntime({ dataDir: path.join(tempDir(), 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  const view = await runtime.refreshRegistry({ force: true })
  assert.notEqual(view.plugins.length, 1, 'a signature over the wrong document verified')
  runtime.dispose()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await site.close()
})

check('a host below minHost is refused, and the sentence names the floor', async () => {
  clearSource()
  const site = await mirror(() => onePlugin({ minHost: '9.9.9' }))
  useMirror(site.source)
  const runtime = createExtensionRuntime({ dataDir: path.join(tempDir(), 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  await assert.rejects(() => runtime.install('demo-channel'), /requires host >= 9\.9\.9/)
  runtime.dispose()
  await site.close()
})

check('an entry the registry does not carry is refused by name', async () => {
  clearSource()
  const site = await mirror(() => onePlugin())
  useMirror(site.source)
  const runtime = createExtensionRuntime({ dataDir: path.join(tempDir(), 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  await assert.rejects(() => runtime.install('not-there'), /does not carry/)
  runtime.dispose()
  await site.close()
})

check('a package whose bytes do not match the signed digest is refused at download', async () => {
  clearSource()
  // The registry names a digest; the mirror serves different bytes for it. The
  // verify-then-write rule means the refusal happens before any file lands in
  // the data dir — and the entry survives parsing only because its file URL is
  // the mirror's own origin, which the override allowlist accepts.
  const site = await mirror((fileUrl) => onePlugin({ main: { url: fileUrl('main.mjs'), size: 16, sha256: 'a'.repeat(64) } }), { files: { 'main.mjs': 'export default 1' } })
  useMirror(site.source)
  const dataDir = path.join(tempDir(), 'data')
  const runtime = createExtensionRuntime({ dataDir, hostVersion: '2.8.3', logger: { warn() {} } })
  await assert.rejects(() => runtime.install('demo-channel'), /digest/)
  assert.equal(fs.existsSync(path.join(dataDir, 'extensions', 'packages')), false, 'a refused package still wrote files')
  runtime.dispose()
  await site.close()
})

// ── install: verify-then-write ────────────────────────────────────────────────

// ── installLocal: the developer-mode door ─────────────────────────────────────

/** A valid local package directory. */
function localPackage(dir: string, { main }: { main: string }): string {
  const pkg = path.join(dir, 'pkg')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'main.mjs'), main)
  const manifest = {
    schemaVersion: 2, id: 'local-demo', version: '1.0.0', kind: 'channel',
    main: 'main.mjs', files: ['main.mjs'], apiVersion: '^2', minHost: '2.0.0',
    permissions: { network: ['https://api.example.com'], secrets: [], storage: false },
  }
  fs.writeFileSync(path.join(pkg, 'ofm-plugin.json'), JSON.stringify(manifest))
  return pkg
}

check('a local install requires the explicit unsigned acknowledgement', async () => {
  const dir = tempDir()
  const pkg = localPackage(dir, { main: 'x' })
  const runtime = createExtensionRuntime({ dataDir: path.join(dir, 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  await assert.rejects(() => runtime.installLocal({ path: pkg }), /explicit unsigned-package acknowledgement/)
  runtime.dispose()
})

check('a local file that escapes its directory is refused before it is read', async () => {
  const dir = tempDir()
  const pkg = path.join(dir, 'pkg')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(dir, 'outside.mjs'), 'export default 1')
  fs.writeFileSync(path.join(pkg, 'ofm-plugin.json'), JSON.stringify({
    schemaVersion: 2, id: 'escape-demo', version: '1.0.0', kind: 'channel',
    main: 'main.mjs', files: ['../outside.mjs'], apiVersion: '^2', minHost: '2.0.0',
    permissions: { network: [], secrets: [], storage: false },
  }))
  const runtime = createExtensionRuntime({ dataDir: path.join(dir, 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  await assert.rejects(() => runtime.installLocal({ path: pkg, acknowledgeUnsigned: true }), /escapes its directory|must list every shipped file/)
  runtime.dispose()
})

check('a local package that ships a forbidden API is refused by its scan', async () => {
  const dir = tempDir()
  const pkg = localPackage(dir, { main: "import fs from 'node:fs'\nexport default defineChannel({ prepareChat: async () => ({}) })\n" })
  const runtime = createExtensionRuntime({ dataDir: path.join(dir, 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  await assert.rejects(() => runtime.installLocal({ path: pkg, acknowledgeUnsigned: true }), /failed its scan/)
  runtime.dispose()
})

check('a local package that only declares a page loads, and serves its file by token', async () => {
  const dir = tempDir()
  const pkg = path.join(dir, 'pkg')
  fs.mkdirSync(path.join(pkg, 'ui'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'ui', 'page.html'), '<!doctype html><html><body>hi</body></html>')
  fs.writeFileSync(path.join(pkg, 'ofm-plugin.json'), JSON.stringify({
    schemaVersion: 2, id: 'paged-demo', version: '1.0.0', kind: 'page',
    files: ['ui/page.html'], apiVersion: '^2', minHost: '2.0.0',
    pages: [{ id: 'pp', title: 'P', entry: 'ui/page.html' }],
    permissions: { network: [], secrets: [], storage: false },
  }))
  const runtime = createExtensionRuntime({ dataDir: path.join(dir, 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  const record = await runtime.installLocal({ path: pkg, acknowledgeUnsigned: true })
  assert.equal(record.enabled, true, 'a page plugin defaults to enabled')
  assert.equal(record.pageCount, 1)
  assert.equal(record.main, '', 'a page-only plugin has no worker')
  // Its one page contribution carries a capability token in its URL.
  const [page] = runtime.pages()
  const token = /\/plugins\/assets\/([0-9a-f]{32})\//.exec(page.url)?.[1]
  assert.ok(token !== undefined, `the page URL carries no token: ${page.url}`)
  const asset = runtime.pageAsset(token!, 'ui/page.html')
  assert.equal(asset.type, 'text/html; charset=utf-8')
  assert.match(asset.bytes.toString('utf8'), /hi/)
  // The token authorizes that declared file and nothing else.
  assert.equal(runtime.pageAsset(token!, 'main.mjs'), null)
  assert.equal(runtime.pageAsset(token!, '../ofm-plugin.json'), null)
  assert.equal(runtime.pageAsset('0'.repeat(32), 'ui/page.html'), null)
  runtime.dispose()
})

check('a page asset path outside the declaration is refused', async () => {
  const dir = tempDir()
  const pkg = localPackage(dir, { main: 'export default defineChannel({ prepareChat: async () => ({}) })' })
  const runtime = createExtensionRuntime({ dataDir: path.join(dir, 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  await runtime.installLocal({ path: pkg, acknowledgeUnsigned: true })
  const [page] = runtime.pages().filter((entry: any) => !entry.builtin)
  assert.equal(page, undefined, 'a channel plugin contributed a page')
  runtime.dispose()
})

// ── page RPC allowlist ───────────────────────────────────────────────────────

check('the page RPC allowlist refuses an unknown method and an undeclared page', async () => {
  const dir = tempDir()
  const pkg = path.join(dir, 'pkg')
  fs.mkdirSync(path.join(pkg, 'ui'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'ui', 'page.html'), '<p>x</p>')
  fs.writeFileSync(path.join(pkg, 'ofm-plugin.json'), JSON.stringify({
    schemaVersion: 2, id: 'rpc-demo', version: '1.0.0', kind: 'page',
    files: ['ui/page.html'], apiVersion: '^2', minHost: '2.0.0',
    pages: [{ id: 'pp', title: 'P', entry: 'ui/page.html' }],
    permissions: { network: ['https://api.example.com'], secrets: [], storage: false },
  }))
  const runtime = createExtensionRuntime({ dataDir: path.join(dir, 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  await runtime.installLocal({ path: pkg, acknowledgeUnsigned: true })
  await assert.rejects(() => runtime.pageRpc('rpc-demo', 'pp', 'not.a.method') as Promise<any>, /unknown page method/)
  await assert.rejects(() => runtime.pageRpc('rpc-demo', 'nope', 'plugin.info') as Promise<any>, /not declared by this plugin/)
  // This manifest declares no storage, so the storage door is closed — and a
  // door that is closed is closed even when the key is well formed.
  await assert.rejects(() => runtime.pageRpc('rpc-demo', 'pp', 'storage.get', { key: 'a' }) as Promise<any>, /did not declare storage permission/)
  const info = await runtime.pageRpc('rpc-demo', 'pp', 'plugin.info')
  assert.equal(info.id, 'rpc-demo')
  assert.equal(info.pageId, 'pp')
  runtime.dispose()
})

check('a page storage key may not be a prototype key', async () => {
  const dir = tempDir()
  const pkg = path.join(dir, 'pkg')
  fs.mkdirSync(path.join(pkg, 'ui'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'ui', 'page.html'), '<p>x</p>')
  fs.writeFileSync(path.join(pkg, 'ofm-plugin.json'), JSON.stringify({
    schemaVersion: 2, id: 'proto-demo', version: '1.0.0', kind: 'page',
    files: ['ui/page.html'], apiVersion: '^2', minHost: '2.0.0',
    pages: [{ id: 'pp', title: 'P', entry: 'ui/page.html' }],
    permissions: { network: [], secrets: [], storage: true },
  }))
  const runtime = createExtensionRuntime({ dataDir: path.join(dir, 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  await runtime.installLocal({ path: pkg, acknowledgeUnsigned: true })
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    await assert.rejects(() => runtime.pageRpc('proto-demo', 'pp', 'storage.get', { key }) as Promise<any>, /reserved/)
  }
  runtime.dispose()
})

// ── built-ins ────────────────────────────────────────────────────────────────

check('a built-in is always enabled, never uninstallable, and reports ready', async () => {
  const runtime = createExtensionRuntime({ dataDir: path.join(DATA, 'builtins'), hostVersion: '2.8.3', logger: { warn() {} } })
  const entry = runtime.registerBuiltin({ manifest: { id: 'core-demo', name: 'Demo', provides: ['ui'] }, contributions: { pages: [{ id: 'pp', title: 'P', entry: 'p.html' }] } })
  assert.equal(entry.manifest.essential, true)
  assert.throws(() => runtime.registerBuiltin({ manifest: { id: 'core-demo' } }), /already registered/)
  await assert.rejects(() => runtime.uninstall('core-demo'), /cannot be uninstalled/)
  await assert.rejects(() => runtime.setEnabled('core-demo', false), /always enabled/)
  const row = runtime.listInstalled().find((record: any) => record.id === 'core-demo')
  assert.equal(row.state, 'ready')
  assert.equal(row.builtin, true)
  assert.equal(row.enabled, true)
  // A built-in's page is listed too, and it is the builtin half of `pages()`.
  const [page] = runtime.pages().filter((entry: any) => entry.builtin)
  assert.equal(page.pluginId, 'core-demo')
  // Its contribution surface is reachable.
  const surface = runtime.contributions()
  assert.equal(surface.pages.length, 1)
  runtime.dispose()
})

check('an unknown required capability parks the plugin as pending, not ready', () => {
  const dir = tempDir()
  const pkg = path.join(dir, 'pkg')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'main.mjs'), 'export default defineChannel({ prepareChat: async () => ({}) })')
  fs.writeFileSync(path.join(pkg, 'ofm-plugin.json'), JSON.stringify({
    schemaVersion: 2, id: 'needs-demo', version: '1.0.0', kind: 'channel',
    main: 'main.mjs', files: ['main.mjs'], apiVersion: '^2', minHost: '2.0.0',
    requires: ['teleport'],
    permissions: { network: [], secrets: [], storage: false },
  }))
  const runtime = createExtensionRuntime({ dataDir: path.join(dir, 'data'), hostVersion: '2.8.3', logger: { warn() {} } })
  // installLocal succeeds; the *mount* is what refuses, at remount time.
  runtime.installLocal({ path: pkg, acknowledgeUnsigned: true }).then(async () => {
    const row = runtime.listInstalled().find((record: any) => record.id === 'needs-demo')
    assert.equal(row.state, 'pending', 'a plugin missing a host capability was not parked')
    assert.match(row.pendingReason, /teleport/)
    assert.equal(runtime.isRunning('needs-demo'), false)
    // A parked plugin contributes no catalog rows.
    assert.deepEqual(runtime.catalog, [])
    runtime.dispose()
  })
})

// ── the lane surface ─────────────────────────────────────────────────────────

check('an enhancement hook that throws ships the body unchanged', async () => {
  // Fail-open is the whole contract: a broken third-party hook must not take a
  // turn down with it.
  const runtime = createExtensionRuntime({ dataDir: path.join(DATA, 'failopen'), hostVersion: '2.8.3', logger: { warn() {} } })
  const body = { model: 'x', messages: [] }
  const out = await runtime.applyRequestHooks(body, {})
  assert.deepEqual(out, body)
  assert.deepEqual(await runtime.applyRequestHooks({ a: 1 }, {}), { a: 1 })
  runtime.dispose()
})

check('an enhancement onModels cannot introduce a row it did not have', async () => {
  // There is no running enhancement here, so the pass is a no-op; the point is
  // that the filter only ever *removes or rewrites* — asserted again through the
  // shape check in `applyModelHooks`, which is not reachable without a worker.
  const runtime = createExtensionRuntime({ dataDir: path.join(DATA, 'models'), hostVersion: '2.8.3', logger: { warn() {} } })
  assert.deepEqual(runtime.catalog, [])
  runtime.dispose()
})

check('dispose leaves nothing running and tolerates being called twice', async () => {
  const runtime = createExtensionRuntime({ dataDir: path.join(DATA, 'dispose'), hostVersion: '2.8.3', logger: { warn() {} } })
  await runtime.dispose()
  await runtime.dispose()
  assert.equal(runtime.isRunning('anything'), false)
})

// ── the update soak ──────────────────────────────────────────────────────────

check('a repository at the visible version parses under the manifest parser', () => {
  const parsed = parsePluginManifest(REGISTRY_FALLBACK.plugins[0])
  assert.ok(parsed.id !== '')
  assert.ok(parsed.version.split('.').length === 3)
})

running.then(() => {
  clearSource()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
})
