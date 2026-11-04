/**
 * Offline integration check for the prompt families, driven through a real `pi`
 * run against a stand-in gateway on loopback.
 *
 * The unit checks prove the texts; this one proves the wiring: that the level
 * the user selected is really appended to the system prompt the upstream sees,
 * and really is absent when both families are off. The system prompt is the one
 * part of a request that has no shape to sniff, so the check reads it off the
 * wire — the stand-in records the `messages` pi-ai built and looks for the
 * family's own marker lines.
 *
 * Usage: node pi-extension/test/prompt-saver-integration.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { requirePi } from './preflight.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION = path.join(HERE, '..')
requirePi('prompt-saver-integration')

const failures = []
function assert(condition: unknown, label: string, detail?: string) {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  failures.push(label)
}

/**
 * What the stand-in saw on the last chat request, as one text blob.
 *
 * The prompt families land in the `developer` message: pi folds its base system
 * prompt into a `developer` item, `before_agent_start`'s returned `systemPrompt`
 * is forced into that same leading position, and the lane's own `<env>` block
 * goes into a separate `system` message created by the fingerprint. So the check
 * searches the whole request rather than one role.
 */
const seen: { all: string; developer: string; system: string } = { all: '', developer: '', system: '' }

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {}
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const text = (message: any) => typeof message?.content === 'string' ? message.content : ''
    seen.system = text(messages.find((m: any) => m.role === 'system'))
    seen.developer = text(messages.find((m: any) => m.role === 'developer'))
    seen.all = messages.map(text).join('\n')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

/** One turn with the given saver switches; returns what the stand-in saw. */
function turn(caveman: string, ponytail: string) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ofm-prompt-saver-'))
  writeFileSync(path.join(dataDir, 'saver.json'), `${JSON.stringify({
    version: 1,
    saver: { rtk: false, caveman, ponytail },
  })}\n`, { mode: 0o600 })
  const cwd = mkdtempSync(path.join(tmpdir(), 'ofm-prompt-cwd-'))
  return new Promise<{ out: string; err: string }>((resolve) => {
    const child = spawn('pi', ['-e', EXTENSION, '-p', 'ping', '--model', 'ofm-opencode/beam-free'], {
      cwd,
      env: {
        ...process.env,
        OFM_OPENECODE_BASE: `http://127.0.0.1:${server.address().port}`,
        OFM_OPENECODE_CHAT_BASE: `http://127.0.0.1:${(server.address() as any).port}/inference/openai/v1`,
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

  // 1. Both off: nothing is appended, and the lane's own <env> block is still
  //    there — the fingerprint has to pass whatever the saver does.
  const off = await turn('off', 'off')
  assert(seen.all !== '', 'a turn reached the upstream', `err=${JSON.stringify(off.err.slice(0, 300))}`)
  assert(/<env>[\s\S]*Working directory:/.test(seen.system),
    'the lane-mandated <env> block rides the system prompt even with the saver off',
    JSON.stringify(seen.system.slice(0, 200)))
  assert(seen.developer.length > 0, 'the base system prompt reached the upstream as a developer message')
  assert(!/Respond tersely/.test(seen.all), 'no caveman prompt when the level is off')
  assert(!/lazy senior developer/.test(seen.all), 'no ponytail prompt when the level is off')

  // 2. caveman full: its own marker is on the wire, and pi's own base prompt
  //    survives beside it — the family is appended, not substituted.
  const caveman = await turn('full', 'off')
  assert(/Respond like terse caveman/.test(seen.all),
    'the caveman full prompt is appended to the system prompt',
    JSON.stringify(seen.developer.slice(-160)))
  assert(/Auto-Clarity: drop caveman/.test(seen.all),
    'the level carries its safety boundary to the wire')
  assert(!/lazy senior developer/.test(seen.all), 'ponytail stays off when only caveman is set')
  assert(seen.developer.length > 4000,
    'pi\'s own base prompt is still there — the append did not replace the prompt',
    `${seen.developer.length} bytes`)
  assert(/<env>[\s\S]*Working directory:/.test(seen.system), 'the <env> block is still there')

  // 3. ponytail lite: its own marker, and caveman stays absent.
  const ponytail = await turn('off', 'lite')
  assert(/You are a lazy senior developer/.test(seen.all),
    'the ponytail lite prompt is appended to the system prompt',
    JSON.stringify(seen.developer.slice(-160)))
  assert(!/Respond like terse caveman/.test(seen.all), 'caveman stays off when only ponytail is set')
  assert(/<env>[\s\S]*Working directory:/.test(seen.system), 'the <env> block survives the second family too')

  server.close()
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
