/**
 * Offline integration check for the Kilo lane's request shape.
 *
 * A stand-in gateway records every request: Kilo's free pool answers only a
 * credential-less request, its rows declare OpenRouter's `reasoning` object
 * rather than OpenAI's `reasoning_effort` (with `{enabled:false}` as the off
 * rung), and it takes `max_tokens` rather than `max_completion_tokens`. The
 * provider must therefore strip Authorization, translate the reasoning field,
 * and keep the wire model id (`vendor/name:free`) that pi's `provider/model`
 * addressing cannot carry.
 *
 * A third round turns the stand-in into the failure mode the dsh plugin learned
 * to survive: a 200 answered with `content-type: application/json` over one
 * complete JSON document for a stream request. The OpenAI SDK drops such a body
 * as "no SSE lines", so the lane's transport guard must fold it into an SSE
 * frame for the turn to complete at all.
 *
 * Usage: node pi-extension/test/kilo-integration.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTENSION = path.join(HERE, '..')

/** Every non-listing request, in arrival order: `{ headers, body }`. */
const requests = []
const failures = []
let mode = 'sse'

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
        data: [{
          id: 'reflection/beam-free',
          name: 'Beam Free',
          isFree: true,
          context_length: 1048576,
          top_provider: { max_completion_tokens: 131072 },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['max_tokens', 'tools', 'reasoning', 'include_reasoning'],
        }],
      }))
      return
    }
    requests.push({ headers: req.headers, body: body ? JSON.parse(body) : {} })
    if (mode === 'json-body') {
      // One complete document, labelled JSON: the guard must fold it to SSE.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 't',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'folded' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

function run(thinking, nextMode) {
  return new Promise((resolve) => {
    mode = nextMode ?? 'sse'
    const child = spawn('pi', ['-e', EXTENSION, '-p', 'ping', '--model', 'ofm-kilo/reflection-beam-free', '--thinking', thinking], {
      env: { ...process.env, OFM_KILO_BASE: `http://127.0.0.1:${server.address().port}/api/gateway` },
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
  const high = await run('high')
  const off = await run('off')
  const folded = await run('high', 'json-body')
  server.close()

  const highRequest = requests[0]
  const offRequest = requests[1]

  assert(highRequest?.headers?.authorization === undefined, 'no Authorization header on the wire (the free pool refuses any token)', highRequest?.headers?.authorization)
  assert(highRequest?.body?.model === 'reflection/beam-free', 'wire model id keeps the upstream `vendor/name` form', highRequest?.body?.model)
  assert(highRequest?.body?.store === undefined, '`store` not sent (in no listing row)')
  assert(highRequest?.body?.max_tokens !== undefined && highRequest?.body?.max_completion_tokens === undefined, 'max_tokens, not max_completion_tokens')
  assert(highRequest?.body?.reasoning_effort === undefined, 'OpenAI reasoning_effort renamed off the wire')
  assert(highRequest?.body?.reasoning?.effort === 'high', 'gateway-shaped reasoning { effort } sent', JSON.stringify(highRequest?.body?.reasoning))
  assert(highRequest?.body?.include_reasoning === true, 'include_reasoning sent with the reasoning request')
  assert(highRequest?.body?.stream_options === undefined, 'stream framing fields the gateway has no row for are dropped')
  assert(typeof highRequest?.headers?.['user-agent'] === 'string' && highRequest.headers['user-agent'] !== '', 'a User-Agent is still present')

  assert(offRequest?.body?.reasoning_effort === undefined, 'off is not OpenAI reasoning_effort')
  assert(offRequest?.body?.reasoning?.enabled === false, 'off rides the gateway\'s reasoning { enabled: false }', JSON.stringify(offRequest?.body?.reasoning))
  assert(offRequest?.body?.include_reasoning === undefined, 'include_reasoning is not sent with thinking off')

  assert(/pong/.test(high.out), 'the high turn completed', JSON.stringify(high.out.slice(0, 200)))
  assert(/folded/.test(folded.out), 'a 200 JSON document answering a stream request is folded and answered', JSON.stringify(folded.out.slice(0, 300)))
  if (folded.err.trim()) console.log('--- stderr ---\n' + folded.err.slice(0, 600))

  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
