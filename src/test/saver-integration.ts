/**
 * Offline integration check for the token saver, driven through a real `pi` run
 * against a stand-in gateway on loopback.
 *
 * The unit checks prove the filters; this one proves the wiring: that a tool
 * result which pi executed *really* is compacted on the wire when the user
 * switched the saver on, and really is untouched when it is off. A turn's tool
 * result is the only part of a request the saver may rewrite, so the check reads
 * a file whose content is a real `ls -la` listing through pi's own read tool and
 * reads what the stand-in was asked to send upstream on the next turn.
 *
 * Usage: node pi-extension/test/saver-integration.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { requirePi } from './preflight.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION = path.join(HERE, '..')
requirePi('saver-integration')

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
 * The listing the fixture file holds.
 *
 * `pi`'s read tool returns file content verbatim (truncateHead adds no line
 * numbers), so these rows arrive as the tool result and the `ls` filter is the
 * one that must fire. Thirty file rows put the blob well past the 500-byte floor.
 */
const LISTING = [
  'total 92',
  'drwxr-xr-x  2 dev dev 4096 Jan  1 10:00 .',
  'drwxr-xr-x 18 dev dev 4096 Jan  1 09:00 ..',
  ...Array.from({ length: 30 }, (_, i) => `-rw-r--r--  1 dev dev ${String(1200 + i * 7).padStart(8)} Jan  1 10:0${i % 10} module-${i}.ts`),
].join('\n')

/**
 * Every *chat* request the stand-in saw, in arrival order.
 *
 * The listing rounds are filtered out: they arrive as bodiless GETs on
 * `/models`, and counting them would shift the turn indices under the tool
 * result this check reads.
 */
const chatRequests: Array<{ body: any }> = []

/**
 * Whether the *next* chat request of the current run should be answered with
 * a tool call.
 *
 * Per-run, not a global counter: the stand-in serves several runs, and a
 * counter would send the second run's first request down the text branch.
 */
let wantToolCall = false

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {}
    if (Array.isArray(parsed.messages)) chatRequests.push({ body: parsed })
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    const turn = chatRequests.length
    if (wantToolCall) {
      wantToolCall = false
      // Ask pi to read the fixture; pi executes it with its own read tool, which
      // the fingerprint has to alias out of the gate slot.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish?: string) =>
        `data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_ofm1', arguments: '{"path":"listing.txt"}' } }] }))
      res.write(chunk({}, 'tool_calls'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: `TURN${turn} ok` }, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

/** Run one turn with the saver in the given state; returns the tool result text. */
function prompt(dataDir: string, cwd: string) {
  const from = chatRequests.length
  // The first chat request of this run is answered with a tool call, so pi
  // executes a real tool and the second one carries its result.
  wantToolCall = true
  return new Promise<{ out: string; err: string; tool: string }>((resolve) => {
    const child = spawn('pi', [
      '-e', EXTENSION,
      '-p', 'Read listing.txt with your read tool, then say how many files it lists.',
      '--model', 'ofm-opencode/beam-free',
    ], {
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
    child.on('close', () => {
      // This run's second chat request is the one whose history carries the result.
      const messages = chatRequests[from + 1]?.body?.messages ?? []
      const tool = messages.find((m: any) => m.role === 'tool')
      resolve({ out, err, tool: typeof tool?.content === 'string' ? tool.content : '' })
    })
  })
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const on = mkdtempSync(path.join(tmpdir(), 'ofm-saver-on-'))
  writeFileSync(path.join(on, 'saver.json'), `${JSON.stringify({ version: 1, saver: { rtk: true } })}\n`, { mode: 0o600 })
  const off = mkdtempSync(path.join(tmpdir(), 'ofm-saver-off-'))
  writeFileSync(path.join(off, 'saver.json'), `${JSON.stringify({ version: 1, saver: { rtk: false } })}\n`, { mode: 0o600 })

  /** The fixture every run reads: the same file, so only the switch differs. */
  const fixture = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ofm-saver-cwd-'))
    writeFileSync(path.join(dir, 'listing.txt'), `${LISTING}\n`)
    return dir
  }

  // 1. Saver ON: the tool result that reaches the upstream is compacted.
  const compacted = await prompt(on, fixture())
  assert(compacted.tool !== '', 'a turn with a tool result reached the upstream',
    `out=${JSON.stringify(compacted.out.slice(0, 200))} err=${JSON.stringify(compacted.err.slice(0, 400))}`)
  assert(/Summary: 30 files/.test(compacted.tool),
    'the ls filter fired: the counts lead the result',
    JSON.stringify(compacted.tool.slice(0, 160)))
  assert(/^module-0\.ts\s+1\.2K$/m.test(compacted.tool),
    'a file row carries its size, not its permission block',
    JSON.stringify(compacted.tool.slice(0, 160)))
  assert(!/drwxr-xr-x/.test(compacted.tool),
    'the permission columns are gone — the result was rewritten, not passed through',
    JSON.stringify(compacted.tool.slice(0, 160)))
  assert(compacted.tool.length < LISTING.length,
    'the compacted result is smaller than the listing it came from',
    `${compacted.tool.length} bytes of a ${LISTING.length}-byte listing`)

  // 2. Saver OFF: the same turn ships the listing as the tool returned it.
  const raw = await prompt(off, fixture())
  assert(raw.tool !== '', 'the off run also reached the upstream',
    `out=${JSON.stringify(raw.out.slice(0, 200))} err=${JSON.stringify(raw.err.slice(0, 400))}`)
  assert(/drwxr-xr-x/.test(raw.tool),
    'with the saver off the raw listing rides the wire',
    JSON.stringify(raw.tool.slice(0, 160)))
  assert(!/Summary:/.test(raw.tool), 'and no compaction marker appears', JSON.stringify(raw.tool.slice(0, 160)))
  assert(raw.tool.length >= LISTING.length - 8,
    'the off result is the full listing, not a window of it',
    `${raw.tool.length} bytes`)

  server.close()
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
