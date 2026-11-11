/**
 * Unit checks for the deployment self-check.
 *
 * The step that earns its keep is the **unsigned** one: a gateway that answers an
 * unsigned turn has its trust fence off, and every other step in this file would
 * pass clean while the lane is open to anyone. So the assertion is that an
 * unsigned turn is refused, not that the signed ones work.
 *
 * The other property worth pinning is that a stream which stops **before `[DONE]`**
 * is a failure: a relay that drops mid-frame looks fine on a listing and drops
 * every real turn.
 *
 * Runs on plain node:  node test/worker-verify.test.ts
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyDeployment } from '../dist/worker/verify.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-verify-'))
const SECRET = 'a'.repeat(40)

/** A gateway stand-in with a signed-request fence, shaped like the real one. */
function gateway(over: {
  models?: string[]
  signedListing?: number
  signedTurn?: number
  turnBody?: string
  unsignedListing?: number
} = {}) {
  const seen: Array<{ url: string; auth: boolean }> = []
  const server = http.createServer((req, res) => {
    const signed = (req.headers['x-ofm-signature'] ?? '') !== ''
    seen.push({ url: req.url ?? '', auth: signed })
    const reply = (status: number, contentType: string, body: string) => {
      res.writeHead(status, { 'content-type': contentType })
      res.end(body)
    }
    if (req.url?.endsWith('/models')) {
      // An unsigned listing is refused whatever the other answers are: this is
      // the fence, and it is the step that must never regress.
      if (!signed) return reply(over.unsignedListing ?? 401, 'application/json', '{"error":{"message":"nope"}}')
      return reply(over.signedListing ?? 200, 'application/json', JSON.stringify({ data: (over.models ?? ['model/one']).map(id => ({ id })) }))
    }
    if (req.url?.endsWith('/chat/completions')) {
      if (!signed) return reply(401, 'application/json', '{"error":{"message":"nope"}}')
      if ((over.signedTurn ?? 200) !== 200) return reply(over.signedTurn!, 'application/json', '{"error":{"message":"relay"}}')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')
      if (over.turnBody !== undefined) res.end(over.turnBody)
      else res.end('data: [DONE]\n\n')
      return
    }
    reply(404, 'application/json', '{"error":{"message":"not found"}}')
  })
  return { server, seen }
}

/** A private file carrying the lane's signing secret. */
function privateFile(dir: string, over: Record<string, unknown> = {}): string {
  const file = path.join(dir, 'private.json')
  fs.writeFileSync(file, JSON.stringify({ signingSecret: SECRET, ...over }))
  return file
}

check('a healthy gateway verifies, and every step is reported', async () => {
  const dir = tempDir()
  const stub = gateway()
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  const port = (stub.server.address() as any).port
  const lines: string[] = []
  const failures = await verifyDeployment(`http://127.0.0.1:${port}/v1`, privateFile(dir), { out: line => lines.push(line) })
  assert.equal(failures, 0)
  assert.equal(lines.filter(line => line.startsWith('ok  ')).length, 3, `steps: ${lines.join(' | ')}`)
  assert.match(lines.join('\n'), /signed listing round/)
  assert.match(lines.join('\n'), /signed streaming turn/)
  assert.match(lines.join('\n'), /unsigned request refused/)
  assert.match(lines.join('\n'), /3 models|1 models/)
  stub.server.closeAllConnections?.()
  await new Promise<void>(resolve => stub.server.close(() => resolve()))
})

check('an unsigned turn is refused, and a gateway that answers one FAILS', async () => {
  // The fence, not the convenience: every other step would pass clean while the
  // lane is open to anyone.
  const dir = tempDir()
  const stub = gateway({ unsignedListing: 200 })
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  const port = (stub.server.address() as any).port
  const lines: string[] = []
  const failures = await verifyDeployment(`http://127.0.0.1:${port}/v1`, privateFile(dir), { out: line => lines.push(line) })
  assert.equal(failures, 1)
  assert.match(lines.join('\n'), /FAIL unsigned request refused/)
  assert.match(lines.join('\n'), /expected 401, got HTTP 200/)
  stub.server.closeAllConnections?.()
  await new Promise<void>(resolve => stub.server.close(() => resolve()))
})

check('a stream that stops before [DONE] is a failure, not a pass', async () => {
  // A relay dropping mid-frame looks fine on a listing and drops every real turn.
  const dir = tempDir()
  const stub = gateway({ turnBody: 'data: {"choices":[{"delta":{"content":"par"}}]}\n\n' })
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  const port = (stub.server.address() as any).port
  const lines: string[] = []
  const failures = await verifyDeployment(`http://127.0.0.1:${port}/v1`, privateFile(dir), { out: line => lines.push(line) })
  assert.equal(failures, 1)
  assert.match(lines.join('\n'), /FAIL signed streaming turn/)
  assert.match(lines.join('\n'), /without \[DONE\]/)
  stub.server.closeAllConnections?.()
  await new Promise<void>(resolve => stub.server.close(() => resolve()))
})

check('a listing that carries no model ids is a failure, and skips the turn', async () => {
  const dir = tempDir()
  const stub = gateway({ models: [] })
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  const port = (stub.server.address() as any).port
  const lines: string[] = []
  const failures = await verifyDeployment(`http://127.0.0.1:${port}/v1`, privateFile(dir), { out: line => lines.push(line) })
  assert.equal(failures, 1)
  assert.match(lines.join('\n'), /listing carried no model ids/)
  // No id means nothing to send a turn for, so that step is skipped rather than
  // sent with an empty model.
  assert.equal(lines.filter(line => line.includes('streaming turn')).length, 0)
  stub.server.closeAllConnections?.()
  await new Promise<void>(resolve => stub.server.close(() => resolve()))
})

check('a refused listing is a failure that names the status', async () => {
  const dir = tempDir()
  const stub = gateway({ signedListing: 503 })
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  const port = (stub.server.address() as any).port
  const lines: string[] = []
  const failures = await verifyDeployment(`http://127.0.0.1:${port}/v1`, privateFile(dir), { out: line => lines.push(line) })
  assert.equal(failures, 1)
  assert.match(lines.join('\n'), /HTTP 503/)
  stub.server.closeAllConnections?.()
  await new Promise<void>(resolve => stub.server.close(() => resolve()))
})

check('a base that is not https-or-loopback is refused before any request', async () => {
  const dir = tempDir()
  const lines: string[] = []
  const errors: string[] = []
  const failures = await verifyDeployment('http://evil.example/v1', privateFile(dir), {
    out: line => lines.push(line), err: line => errors.push(line),
  })
  assert.equal(failures, 1)
  assert.match(errors.join('\n'), /usage:/)
  // Nothing was dialled: the refusal is about the address, not about the gateway.
  assert.equal(lines.length, 0)
})

check('a loopback http base is allowed, so a drill verifies the same files', async () => {
  const dir = tempDir()
  const stub = gateway()
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  const port = (stub.server.address() as any).port
  const lines: string[] = []
  const failures = await verifyDeployment(`http://127.0.0.1:${port}/v1`, privateFile(dir), { out: line => lines.push(line) })
  assert.equal(failures, 0, 'a loopback drill was refused')
  stub.server.closeAllConnections?.()
  await new Promise<void>(resolve => stub.server.close(() => resolve()))
})

check('a private file with no signingSecret is refused before any request', async () => {
  const dir = tempDir()
  const errors: string[] = []
  const failures = await verifyDeployment('https://gateway.example/v1', privateFile(dir, { signingSecret: 'too-short' }), {
    out: () => {}, err: line => errors.push(line),
  })
  assert.equal(failures, 1)
  assert.match(errors.join('\n'), /signingSecret/)
})

check('an unreadable private file is a clean refusal, not a crash', async () => {
  const errors: string[] = []
  const failures = await verifyDeployment('https://gateway.example/v1', path.join(tempDir(), 'missing.json'), {
    out: () => {}, err: line => errors.push(line),
  })
  assert.equal(failures, 1)
  assert.match(errors.join('\n'), /could not be read/)
})

check('the signed requests carry a signature the gateway can recompute', async () => {
  // Not a mock: the real signing code, against a gateway that recomputes it the
  // way the lane core does. A signature shape that drifted would surface here.
  const dir = tempDir()
  const stub = gateway()
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  const port = (stub.server.address() as any).port
  const lines: string[] = []
  await verifyDeployment(`http://127.0.0.1:${port}/v1`, privateFile(dir), { out: line => lines.push(line) })
  assert.equal(stub.seen.length, 3, 'the three steps did not dial once each')
  assert.equal(stub.seen[0].url, '/v1/models')
  assert.equal(stub.seen[1].url, '/v1/chat/completions')
  // Every signed step is signed; the last one is deliberately not.
  assert.deepEqual(stub.seen.map(row => row.auth), [true, true, false])
  stub.server.closeAllConnections?.()
  await new Promise<void>(resolve => stub.server.close(() => resolve()))
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
