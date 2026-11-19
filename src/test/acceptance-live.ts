/**
 * End-to-end acceptance check of the extension inside a real `pi`, against a
 * stand-in gateway on loopback.
 *
 * This is the executable form of runbook §5's acceptance half — the step that
 * was only ever done by hand. It proves the three things that make the
 * extension usable, without spending any upstream free quota (both lanes point
 * at loopback, so nothing leaves the machine and nothing meters an IP):
 *
 *   1. `pi --list-models` shows BOTH rosters the freshly fetched listing yields
 *      (`ofm-opencode` and `ofm-kilo`), not just the offline snapshot;
 *   2. a real turn on the Kilo lane is answered end to end;
 *   3. a real turn on the OpenCode lane is answered end to end — the half the
 *      by-hand smoke could not reach at a quota-walled egress, because the
 *      stand-in answers instead of refusing the request.
 *
 * The stand-in serves one free model per lane (`accept-opencode-free` and
 * `accept/vendor-free`), answers chat by lane so a misroute would read as the
 * wrong `answered-by-*` marker, and both lanes are redirected with the
 * documented `OFM_*` endpoint overrides.
 *
 * Usage: node pi-extension/test/acceptance-live.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { requirePi } from './preflight.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION = path.join(HERE, '..')
requirePi('acceptance-live')

/** OpenCode free id on the stand-in listing (a safe id, no `/` or `:`). */
const OPENECODE_ID = 'accept-opencode-free'
/** Kilo wire id on the stand-in listing; the gateway routes this spelling. */
const KILO_WIRE = 'accept/vendor-free'
/** What safeId(KILO_WIRE) becomes, i.e. the id pi selects. */
const KILO_SAFE = 'accept-vendor-free'
/** A generous per-invocation ceiling; a hang becomes a FAIL, not a stuck test. */
const CALL_TIMEOUT_MS = 90_000

const failures = []

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
    const url = req.url ?? ''
    // The OpenCode listing must be matched before the generic `/models` tail, or
    // the Kilo listing handler would swallow `/inference/v1/models`.
    if (url.includes('/inference/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: [{
          id: OPENECODE_ID,
          name: 'Accept OpenCode',
          api: { 'chat-completions': {} },
          capabilities: { reasoning: { effort: ['low', 'high'] } },
          modalities: { input: ['text'] },
          limit: { context: 131072, output: 32768 },
        }],
      }))
      return
    }
    // Kilo's listing lives at `<KILO_BASE>/models`; chat is `/chat/completions`.
    if (/\/models(?:\?|$)/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: [{
          id: KILO_WIRE,
          name: 'Accept Vendor',
          isFree: true,
          context_length: 200000,
          top_provider: { max_completion_tokens: 32000 },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['max_tokens', 'reasoning'],
        }],
      }))
      return
    }
    const parsed = body ? JSON.parse(body) : {}
    const who = parsed.model === KILO_WIRE ? 'kilo' : 'opencode'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'a', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: `answered-by-${who}` }, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

/** Run `pi` with the extension pointed at the stand-in; never blocks forever. */
function pi(args, dataDir, cwd) {
  return new Promise((resolve) => {
    const child = spawn('pi', ['-e', EXTENSION, ...args], {
      cwd,
      env: {
        ...process.env,
        OFM_OPENECODE_BASE: `http://127.0.0.1:${server.address().port}`,
        OFM_OPENECODE_CHAT_BASE: `http://127.0.0.1:${server.address().port}/inference/openai/v1`,
        OFM_KILO_BASE: `http://127.0.0.1:${server.address().port}/api/gateway`,
        OFM_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const guard = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ out, err, timedOut: true })
    }, CALL_TIMEOUT_MS)
    child.on('close', () => {
      clearTimeout(guard)
      resolve({ out, err, timedOut: false })
    })
  })
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ofm-accept-data-'))
  const cwd = mkdtempSync(path.join(tmpdir(), 'ofm-accept-cwd-'))
  const session = `ofm-accept-${Date.now().toString(36)}`

  // 1. Both rosters come from the live listing, visible to pi's model chooser.
  const listed = await pi(['--list-models'], dataDir, cwd)
  assert(!listed.timedOut && listed.out.includes('ofm-opencode') && listed.out.includes(OPENECODE_ID),
    'pi --list-models renders the ofm-opencode roster from the live listing', `out=${JSON.stringify(listed.out.slice(0, 300))} err=${JSON.stringify(listed.err.slice(0, 300))}`)
  assert(!listed.timedOut && listed.out.includes('ofm-kilo') && listed.out.includes(KILO_SAFE),
    'pi --list-models renders the ofm-kilo roster from the live listing', `out=${JSON.stringify(listed.out.slice(0, 300))}`)

  // 2. A real turn on the Kilo lane, answered end to end through pi.
  const kilo = await pi(['-nt', '-p', 'ping', '--model', `ofm-kilo/${KILO_SAFE}`, '--session-id', `${session}-k`], dataDir, cwd)
  assert(!kilo.timedOut && /answered-by-kilo/.test(kilo.out),
    'a real turn on the Kilo free lane is answered end to end', `out=${JSON.stringify(kilo.out.slice(0, 300))} err=${JSON.stringify(kilo.err.slice(0, 400))}`)

  // 3. A real turn on the OpenCode lane, answered through the fingerprint path.
  const opencode = await pi(['-nt', '-p', 'ping', '--model', `ofm-opencode/${OPENECODE_ID}`, '--session-id', `${session}-o`], dataDir, cwd)
  assert(!opencode.timedOut && /answered-by-opencode/.test(opencode.out),
    'a real turn on the OpenCode free lane is answered end to end', `out=${JSON.stringify(opencode.out.slice(0, 300))} err=${JSON.stringify(opencode.err.slice(0, 400))}`)

  server.close()
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
