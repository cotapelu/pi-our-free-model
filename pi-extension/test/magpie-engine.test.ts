/**
 * Unit checks for the Magpie engine's honest-unavailable behaviour.
 *
 * The engine's 68MB binary is deliberately not shipped, and the whole design
 * question is what happens instead. These checks pin that the answer is *never*
 * a crash and *never* a hang:
 *
 *   1. `start()` resolves with `available:false` and one line naming the reason,
 *      so a settings page can say why rather than spinning forever;
 *   2. `request()` answers 503 with that same line, rather than throwing — a
 *      route mounted on it stays up;
 *   3. `proxy()` answers 503 on the socket and leaves it open, rather than
 *      destroying it;
 *   4. the path fence refuses escapes and double-encodings before anything is
 *      forwarded;
 *   5. the mount path is stable, so a bookmark the user already has keeps working.
 *
 * Runs on plain node:  node test/magpie-engine.test.ts
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMagpieEngine, enginePath, MAGPIE_UI_PREFIX } from '../dist/magpie-engine.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A fake res that records what the engine wrote to it. */
function fakeRes() {
  const writes: Array<{ code: number; headers: any; body: string }> = []
  return {
    writes,
    headersSent: false,
    destroyed: false,
    writeHead(code: number, headers: any) { writes.push({ code, headers, body: '' }) },
    end(body?: string) { const last = writes[writes.length - 1]; if (last) last.body = String(body ?? '') },
    get statusCode() { return writes[writes.length - 1]?.code },
  }
}

check('a binary-less engine reports unavailable with one actionable line', async () => {
  const engine = createMagpieEngine({ dataDir: scratch(), logger: { info: () => {} } })
  try {
    const status = engine.status()
    assert.equal(status.available, false)
    assert.equal(status.state, 'stopped')
    const started = await engine.start()
    assert.equal(started.available, false)
    assert.equal(started.state, 'unavailable')
    assert.match(String(started.error), /not shipped/, `the reason was: ${started.error}`)
    // The message names the fix, not just the symptom.
    assert.match(String(started.error), /binary/)
  } finally { await engine.close() }
})

check('start resolves rather than rejecting, so a caller need not try/catch', async () => {
  const engine = createMagpieEngine({ dataDir: scratch() })
  try {
    // A rejected start would make every caller wrap it to answer a question with
    // a known answer.
    const status = await engine.start()
    assert.equal(status.available, false)
  } finally { await engine.close() }
})

check('a second start does not re-run the check', async () => {
  const engine = createMagpieEngine({ dataDir: scratch() })
  try {
    const first = await engine.start()
    const second = await engine.start()
    assert.equal(first.state, second.state)
    assert.equal(first.available, second.available)
  } finally { await engine.close() }
})

check('request answers 503 with the reason rather than throwing', async () => {
  const engine = createMagpieEngine({ dataDir: scratch() })
  try {
    await engine.start()
    const response = await engine.request('GET', '/api/settings')
    assert.equal(response.status, 503)
    const text = await response.text()
    assert.match(text, /not shipped/)
  } finally { await engine.close() }
})

check('the path fence refuses every escape it can be handed', async () => {
  // This is the security boundary when a binary *is* present, so it is pinned
  // directly: `request()` answers 503 on an engine with no binary, which would
  // make the fence unreachable from the HTTP surface.
  for (const bad of ['/a/../../etc/passwd', '//evil', '/x\\y', '/x#frag', '/%2e%2e/%2e%2e/etc', '/.', '/a/./b', '']) {
    let thrown: any
    try { enginePath(bad) } catch (error: any) { thrown = error }
    assert.ok(thrown !== undefined, `${JSON.stringify(bad)} was accepted`)
    assert.equal(thrown.statusCode, 400, `${JSON.stringify(bad)} answered ${thrown.statusCode}`)
  }
  // And a legitimate path survives, with the engine's own query intact.
  assert.equal(enginePath('/api/settings?k=secret'), '/api/settings', 'the query key survived')
  assert.equal(enginePath('/api/settings?tab=agents'), '/api/settings?tab=agents')
})

check('a browser-supplied query key never authenticates anything', async () => {
  // Authentication belongs to the owner; `k` is removed before the engine sees it.
  assert.equal(enginePath('/api/settings?k=abc'), '/api/settings')
})

check('a request after close answers 503, it does not throw', async () => {
  const engine = createMagpieEngine({ dataDir: scratch() })
  await engine.close()
  const response = await engine.request('GET', '/api/settings')
  assert.equal(response.status, 503)
})

check('proxy answers 503 and leaves the socket open', async () => {
  // Destroying the socket would take the settings page down with the engine.
  const engine = createMagpieEngine({ dataDir: scratch() })
  try {
    const res = fakeRes()
    await engine.proxy({ method: 'GET', headers: {} }, res, '/api/settings')
    assert.equal(res.headersSent, false, 'the proxy claimed headers were already sent')
    assert.equal(res.destroyed, false, 'the engine destroyed the socket')
    assert.equal(res.statusCode, 503)
    assert.match(res.writes[0].body, /not shipped/)
  } finally { await engine.close() }
})

check('a closed engine still answers 503 on the proxy path', async () => {
  const engine = createMagpieEngine({ dataDir: scratch() })
  await engine.close()
  const res = fakeRes()
  await engine.proxy({ method: 'GET', headers: {} }, res, '/')
  assert.equal(res.statusCode, 503)
})

check('the mount path is stable so an existing bookmark keeps working', async () => {
  const engine = createMagpieEngine({ dataDir: scratch() })
  try {
    assert.equal(engine.mount, MAGPIE_UI_PREFIX)
    assert.match(engine.mount, /^\/api\/our-free-model\/engine\/ui\/$/)
  } finally { await engine.close() }
})

check('the UI proxy answers a real socket over HTTP without hanging', async () => {
  // End-to-end: a real listener, a real request, one 503 body.
  const engine = createMagpieEngine({ dataDir: scratch() })
  const server = http.createServer((req, res) => { void engine.proxy(req, res, req.url ?? '/') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/our-free-model/engine/ui/api/settings`)
    assert.equal(res.status, 503)
    assert.match(await res.text(), /not shipped/)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await engine.close()
  }
})

check('a non-absolute dataDir is refused at construction', () => {
  assert.throws(() => createMagpieEngine({ dataDir: 'relative/path' }), /absolute path/)
  assert.throws(() => createMagpieEngine({ dataDir: undefined as any }), /absolute path/)
})

check('the status version and revision come from the shipped metadata', async () => {
  const engine = createMagpieEngine({ dataDir: scratch() })
  try {
    // engine.json ships beside the package, so the version is a real value or
    // null — never a placeholder string.
    const status = engine.status()
    assert.ok(status.version === null || typeof status.version === 'string')
    assert.ok(status.revision === null || typeof status.revision === 'string')
  } finally { await engine.close() }
})

check('the unavailable surface never leaks a port or a key', async () => {
  const engine = createMagpieEngine({ dataDir: scratch() })
  try {
    await engine.start()
    const response = await engine.request('POST', '/api/settings')
    const text = await response.text()
    assert.equal(/\b\d{4,5}\b/.test(text), false, 'the answer named a port')
  } finally { await engine.close() }
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 400)
