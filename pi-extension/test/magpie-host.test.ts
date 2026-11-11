/**
 * Unit checks for the engine host's route guards.
 *
 * The engine is not shipped (its 68MB binary is not this package's to give
 * away), so what these checks pin is the half that would govern a *running*
 * engine — and it is the half that decides what an attacker reaches first:
 *
 * - `localPath` refuses double-encoded traversal, protocol-relative paths, a
 *   browser-supplied `?k=` (authentication belongs to the owner, never a query
 *   string a page can set) and the prefix hint;
 * - the internal caller key is refused (409) on any mutation that names it —
 *   including under Go's case-insensitive field names — and filtered out of
 *   every listing the browser can read;
 * - the engine's own update endpoints are refused outright, and a framed
 *   response (a page that embeds this API in an iframe) is refused too;
 * - `rewriteHTML` mounts the engine under this console's prefix without letting
 *   the engine's page fetch a path outside it.
 *
 * Runs on plain node:  node test/magpie-host.test.ts
 */
import assert from 'node:assert/strict'
import {
  localPath, validatePrefix, routePath, callerKeysRoute, callerKeysMutation,
  callerKeysListing, protectInternalKey, publicKeyListing, rewriteHTML, forbiddenFrame, protectUpdate,
  MAGPIE_UI_PREFIX,
} from '../dist/magpie-engine.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 1000)
function check(name: string, fn: () => void | Promise<void>) {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error) { failures++; console.log(`FAIL ${name}\n     ${(error as Error)?.message ?? error}`) }
  })
}

check('localPath refuses a traversal, in every encoding it can arrive in', () => {
  for (const bad of ['/api/../etc/passwd', '//evil.com/x', '/a/..%2f..%2fb', '/x%00', '/x#frag']) {
    assert.throws(() => localPath(bad), /Invalid engine path/, `${bad} was accepted`)
  }
  // The prefix hint and a browser-supplied key never survive into the engine.
  assert.equal(localPath('/api/models?k=sk-should-not-travel'), '/api/models')
  assert.equal(localPath(`/api/models?${'__ofm_ui_prefix'}=/api/x`), '/api/models')
  assert.equal(localPath('/api/models?page=2'), '/api/models?page=2')
})

check('validatePrefix only accepts this console\'s own mount', () => {
  // The engine's own route is the mount; the console's path is the *prefix*.
  assert.equal(validatePrefix('/api/our-free-model/engine/ui/'), '/api/our-free-model/engine/ui/')
  assert.throws(() => validatePrefix('/api/management/engine/ui/'), /Invalid engine UI prefix/,
    'the console path is a prefix, not the engine route')
  assert.throws(() => validatePrefix('/other/place/'), /Invalid engine UI prefix/)
  assert.throws(() => validatePrefix('/api/our-free-model/engine/ui/x'), /Invalid engine UI prefix/)
})

check('the caller-keys route is recognized, and a mutation is any non-read', () => {
  assert.equal(callerKeysRoute('/api/caller-keys'), true)
  assert.equal(callerKeysRoute('/api/caller-keys/abc'), true)
  assert.equal(callerKeysRoute('/api/models'), false)
  assert.equal(callerKeysMutation('POST', '/api/caller-keys'), true)
  assert.equal(callerKeysMutation('GET', '/api/caller-keys'), false)
  assert.equal(callerKeysListing('GET', '/api/caller-keys'), true)
  assert.equal(callerKeysListing('GET', '/api/models'), false)
})

check('the internal key cannot be renamed by a case variant', () => {
  // The body names the key in a `key` field, and Go's JSON decoder accepts
  // case-insensitive field names — so the guard compares them lowercased.
  for (const body of [
    JSON.stringify({ key: 'our-free-model-engine', secret: 'sk-new' }),
    JSON.stringify({ KEY: 'our-free-model-engine', secret: 'sk-new' }),
  ]) {
    assert.throws(() => protectInternalKey(Buffer.from(body)),
      (error: any) => error.statusCode === 409, body)
  }
  // A body that names a caller key is accepted.
  protectInternalKey(Buffer.from(JSON.stringify({ key: 'someone-else', secret: 'sk-ok' })))
})

check('a listing the browser reads never carries the internal key', () => {
  const listing = Buffer.from(JSON.stringify({
    keys: [
      { id: 'caller-key', secret: 'sk-caller' },
      { id: 'our-free-model-engine', secret: 'sk-internal-must-not-leak' },
    ],
  }))
  const shown = JSON.parse(publicKeyListing(listing).toString('utf8'))
  assert.deepEqual(shown.keys.map((row: any) => row.id), ['caller-key'])
  assert.ok(!publicKeyListing(listing).toString().includes('sk-internal'))
})

check('the engine\'s own update endpoints are refused outright', () => {
  assert.throws(() => protectUpdate('POST', '/api/update'), /Engine/, 'an update POST was allowed')
  assert.throws(() => protectUpdate('POST', '/api/update/check'), /Engine/)
  protectUpdate('GET', '/api/update', )
  protectUpdate('GET', '/api/models')
})

check('a framed response is refused, and a plain one is not', () => {
  assert.equal(forbiddenFrame({ 'sec-fetch-dest': 'iframe' }, '/api/models'), true)
  assert.equal(forbiddenFrame({ origin: 'null' }, '/api/models'), true)
  assert.equal(forbiddenFrame({ 'sec-fetch-site': 'cross-site' }, '/api/models'), true)
  // A same-site document navigation is not a frame.
  assert.equal(forbiddenFrame({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' }, '/api/models'), false)
  // An ordinary http origin (a page that simply embeds a link) is not refused.
  assert.equal(forbiddenFrame({ origin: 'http://evil.example' }, '/api/models'), false)
  // A non-API path is the engine's own UI, not a framed API call.
  assert.equal(forbiddenFrame({ 'sec-fetch-dest': 'iframe' }, '/'), false)
})

check('rewriteHTML mounts the page under this console\'s prefix', () => {
  const html = '<html><head><title>engine</title></head><body><div id="app"></div></body></html>'
  const rewritten = rewriteHTML(html, '/', '/api/our-free-model/engine/ui/')
  assert.ok(rewritten.includes('<base href="/api/our-free-model/engine/ui/">'), 'the page got no base for its own assets')
  // The appearance bridge is injected only on the engine's own index: a deep
  // route's layout belongs to the page it is on, not to this console's chrome.
  assert.ok(rewritten.includes('ofm-engine-appearance'), 'the appearance style was not injected')
  const deep = rewriteHTML(html, '/api/models', '/api/our-free-model/engine/ui/')
  assert.ok(!deep.includes('ofm-engine-appearance'), 'a deep route gained the index chrome')
  assert.ok(deep.includes('<base href="/api/our-free-model/engine/ui/">'))
  // A plugin page keeps its own relative root and gets no injected code: it runs
  // under a CSP that cannot execute inline script.
  const plugin = rewriteHTML('<html><head></head><body><script src="/a.js"></script></body></html>', '/_magpie/plugin/abc/page', '/x/')
  assert.ok(!plugin.includes('<base'), 'a plugin page gained a base tag')
})

check('routePath decodes once, and a path with a query keeps it', () => {
  assert.equal(routePath('/api/models%2Flist'), '/api/models/list')
  assert.equal(routePath('/api/models?page=2'), '/api/models')
})

Promise.allSettled([running]).then(() => {
  clearInterval(keepAlive)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
  if (failures > 0) process.exitCode = 1
})
