/**
 * End-to-end check of a fallback chain, driven through a real `pi` run against
 * a stand-in gateway on loopback.
 *
 * Two behaviours, because pi refuses to retry the failure that matters most on
 * these lanes:
 *
 *   1. a *retryable* failure (HTTP 503) on the first link — pi retries, the
 *      chain advances, the second link answers;
 *   2. a *quota* failure (429 FreeUsageLimitError) — pi treats it as non-retryable
 *      by design, so the turn ends; the chain remembers the wall and the next
 *      user turn in the same session starts at the link after it.
 *
 * The stand-in serves two free models on the Kilo lane: `vendor/alpha` (which
 * fails) and `vendor/beta` (which answers), so the chain under test is
 * `ofm-kilo/vendor-alpha → ofm-kilo/vendor-beta`.
 *
 * Usage: node pi-extension/test/chain-integration.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION = path.join(HERE, '..')

const failures = []
/** `alpha`'s answer per phase: `503`, `429`, or `ok`. */
let phase = '503'

function assert(condition, label, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  failures.push(label)
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: [
          {
            id: 'vendor/alpha',
            name: 'Alpha',
            isFree: true,
            context_length: 262144,
            top_provider: { max_completion_tokens: 65536 },
            architecture: { input_modalities: ['text'] },
            supported_parameters: ['max_tokens', 'tools', 'reasoning', 'include_reasoning'],
          },
          {
            id: 'vendor/beta',
            name: 'Beta',
            isFree: true,
            context_length: 262144,
            top_provider: { max_completion_tokens: 65536 },
            architecture: { input_modalities: ['text'] },
            supported_parameters: ['max_tokens', 'tools', 'reasoning', 'include_reasoning'],
          },
        ],
      }))
      return
    }
    const parsed = body ? JSON.parse(body) : {}
    if (parsed.model === 'vendor/alpha' && phase !== 'ok') {
      res.writeHead(phase === '429' ? 429 : 503, { 'content-type': 'application/json' })
      res.end(phase === '429'
        ? JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } })
        : JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'overloaded' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const who = parsed.model === 'vendor/alpha' ? 'alpha' : 'beta'
    res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: `answered-by-${who}` }, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

function pi(prompt, { phase: nextPhase, dataDir, sessionId, cwd }) {
  return new Promise((resolve) => {
    phase = nextPhase
    // One exact session id for every phase: pi creates it once and resumes it
    // for the later turns, and a fresh id per test run keeps runs independent.
    const child = spawn('pi', ['-e', EXTENSION, '-p', prompt, '--model', 'ofm-chain/test', '--session-id', sessionId], {
      cwd,
      env: {
        ...process.env,
        OFM_KILO_BASE: `http://127.0.0.1:${server.address().port}/api/gateway`,
        OFM_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', () => resolve({ out, err }))
  })
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ofm-chain-'))
  mkdirSync(dataDir, { recursive: true })
  // pi stores its sessions under the working directory, so the run gets its own.
  const cwd = mkdtempSync(path.join(tmpdir(), 'ofm-chain-cwd-'))
  const sessionId = `chain-it-${Date.now().toString(36)}`
  writeFileSync(path.join(dataDir, 'chains.json'), `${JSON.stringify({
    chains: [{ id: 'chain:test', name: 'Test', models: ['ofm-kilo/vendor-alpha', 'ofm-kilo/vendor-beta'] }],
  })}\n`, { mode: 0o600 })

  // 1. One chain link, first refusal is retryable: pi retries, the chain advances.
  const retried = await pi('ping one', { phase: '503', dataDir, sessionId, cwd })
  assert(/answered-by-beta/.test(retried.out), 'a retryable failure on link 1 fails over to link 2 within the turn', `out=${JSON.stringify(retried.out.slice(0, 200))} err=${JSON.stringify(retried.err.slice(0, 400))}`)

  // 2. Quota wall on link 1: pi will not retry it, so the turn ends with the
  //    lane's own message and the *next* user turn starts past the wall.
  const walled = await pi('ping two', { phase: '429', dataDir, sessionId, cwd })
  assert(/free quota for this egress is spent/.test(walled.out + walled.err), 'the quota wall is reported in the lane\'s own words', JSON.stringify((walled.out + walled.err).slice(0, 300)))
  const after = await pi('ping three', { phase: '429', dataDir, sessionId, cwd })
  assert(/answered-by-beta/.test(after.out), 'the next user turn starts past the failed link', `out=${JSON.stringify(after.out.slice(0, 200))} err=${JSON.stringify(after.err.slice(0, 400))}`)

  server.close()
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
