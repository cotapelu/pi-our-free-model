/**
 * Offline integration check for the free lane's fingerprint and alias restore.
 *
 * A stand-in gateway mimics the upstream gate's checks — v2 User-Agent, the four
 * same-valued session headers, a canonical (descending) session id, the verbatim
 * `read`/`shell` declarations, no `tool_choice: 'none'`, the placeholder note —
 * then answers with a tool call addressed under the alias the fingerprint had to
 * create. If the alias is not restored on the way back, pi cannot match the call
 * to its own `read` tool and the run fails.
 *
 * Usage: node pi-extension/test/fingerprint-integration.mjs
 * Exits non-zero with a diagnosis on the first broken assumption.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const EXTENSION = path.join(HERE, '..')

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/
const TOOL_DESCRIPTIONS = {
  read: /^Read the contents of a file or directory\./,
  shell: /^Execute a shell command and return its output\./,
}

const seen = {}
let turns = 0
let failures = []

function assert(condition, label, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
    return true
  }
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  failures.push(label)
  return false
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const headers = req.headers
    seen.ua = headers['user-agent']
    seen.authorization = headers['authorization']
    seen.sessionHeaders = [
      headers['x-opencode-session'],
      headers['x-opencode-session-id'],
      headers['x-session-affinity'],
      headers['x-session-id'],
    ]
    seen.session = headers['x-opencode-session']
    seen.v1HeaderPresent = headers['x-opencode-request'] !== undefined
    seen.body = body ? JSON.parse(body) : {}

    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }

    turns += 1
    if (turns === 1) {
      // Answer with a call to the aliased copy of pi's `read` tool.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_ofm1', arguments: '{"path":"alpha.txt"}' } }] }))
      res.write(chunk({}, 'tool_calls'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    // Second turn: pi must have carried the tool result back under the alias.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const carried = (seen.body.messages ?? []).some((m) => m.role === 'tool' && /FAKE-FILE-CONTENT/.test(String(m.content)))
    res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: `TURN2 carried=${carried}` }, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

async function run() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port
      const base = `http://127.0.0.1:${port}`
      const workdir = path.join(HERE, '.fixture')
      const fs = await import('node:fs')
      fs.mkdirSync(workdir, { recursive: true })
      fs.writeFileSync(path.join(workdir, 'alpha.txt'), 'FAKE-FILE-CONTENT\n')

      const child = spawn('pi', [
        '-e', EXTENSION,
        '-p', 'Read alpha.txt with your read tool, then summarise what it says.',
        '--model', 'ofm-opencode/beam-free',
      ], {
        cwd: workdir,
        env: {
          ...process.env,
          OFM_OPENECODE_BASE: base,
          OFM_OPENECODE_CHAT_BASE: `${base}/inference/openai/v1`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('close', () => resolve({ out, err }))
    })
  })
}

const { out, err } = await run()
server.close()

// 1. Client fingerprint.
assert(seen.ua === 'opencode/latest/2.0.26/cli', 'User-Agent is the v2 client string', seen.ua)
assert(seen.authorization === 'Bearer public', 'Authorization carries the pooled public credential', seen.authorization)
const allSame = seen.sessionHeaders?.every((v) => typeof v === 'string' && v === seen.session && v !== '')
assert(allSame, 'four session headers present and equal', JSON.stringify(seen.sessionHeaders))
assert(!seen.v1HeaderPresent, 'v1-only x-opencode-request is not sent')
assert(SESSION_RE.test(seen.session ?? ''), 'session id shape is ses_ + 12 hex + 14 base62', seen.session)
assert(DESCENDING_RE.test((seen.session ?? '').slice(4, 16)), 'session id time half is descending-minted', seen.session)

// 2. Payload fingerprint.
const tools = seen.body?.tools ?? []
const names = tools.map((t) => t.function?.name ?? t.name)
const defOf = (name) => { const t = tools.find((x) => (x.function?.name ?? x.name) === name); return t?.function ?? t }
assert(names.includes('read') && TOOL_DESCRIPTIONS.read.test(defOf('read')?.description ?? ''), 'verbatim `read` tool declared')
assert(names.includes('shell') && TOOL_DESCRIPTIONS.shell.test(defOf('shell')?.description ?? ''), 'verbatim `shell` tool declared')
assert(!names.includes('read_ofm1') || names.filter((n) => n === 'read').length === 1, 'gate slot owned by the verbatim declaration')
assert(names.includes('read_ofm1'), "pi's own `read` renamed out of the gate slot", names.join(','))
assert(seen.body?.tool_choice !== 'none', 'tool_choice none is never emitted')
const system = (seen.body?.messages ?? []).find((m) => m.role === 'system')
assert(/<env>[\s\S]*Working directory:[\s\S]*Platform:/i.test(String(system?.content)), 'the lane-mandated <env> block rides the system message')
assert(/Do not call the `read` or `shell` tools/.test(String(system?.content)), 'placeholder note appended to the system message')

// 3. Alias restored on the way back, so pi could execute its own tool.
assert(/TURN2 carried=true/.test(out), 'pi executed the aliased tool call (alias restored, tool result carried)', JSON.stringify(out.slice(0, 200)))

if (err.trim()) console.log('--- stderr ---\n' + err.slice(0, 800))
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
