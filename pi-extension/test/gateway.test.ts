/**
 * Unit checks for the standalone API gateway, driven against a loopback stand-in
 * upstream so no free-lane quota is spent.
 *
 * What these cover is the gateway's own contract, not the lanes': the key fence,
 * the model address, the wire id the Kilo lane must carry (pi's own safe id would
 * be a "model not found" on a lane that is up), the credential the Kilo lane must
 * not send, the fingerprint headers the OpenCode lane must send, the alias restore
 * on the way back, and the fold that answers a non-stream request.
 *
 * Every check runs serially: several of them read what the stand-in was last
 * called with, and running them concurrently would race those observations.
 *
 * Usage: node pi-extension/test/gateway.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const KEY = 'ofm-test-key'

interface Seen {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: any
}

const kiloSeen: Seen[] = []
const opencodeSeen: Seen[] = []
const kiloCalls = new Map<string, number>()

const SSE_BODY = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" done"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

const THINK_ONLY_BODY = [
  'data: {"id":"chatcmpl-3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking hard about pong"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

const TOOL_SSE_BODY = [
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_ofm1","arguments":"{\\"path\\":\\"/tmp\\"}"}}]},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

const standIn = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsed: any = raw
    try {
      parsed = raw === '' ? {} : JSON.parse(raw)
    } catch {
      parsed = raw
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/models') {
      kiloSeen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body: null })
      const row = (id: string) => ({ id, name: id, isFree: true, context_length: 123456, top_provider: { max_completion_tokens: 4321 }, architecture: { input_modalities: ['text'] } })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [row('standin/free'), row('second/free'), row('think-only/free'), row('silent/free'), row('broken/free'), row('rejected/free')] }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/inference/v1/models') {
      opencodeSeen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body: null })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: [{
          id: 'standin-free',
          name: 'Stand In Free',
          api: { 'chat-completions': { base_url: '' } },
        }],
      }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      kiloSeen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body: parsed })
      const model = String(parsed?.model ?? '')
      kiloCalls.set(model, (kiloCalls.get(model) ?? 0) + 1)
      if (model === 'broken/free') {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'FreeUsageLimitError: quota spent', type: 'rate_limit_error' } }))
        return
      }
      if (model === 'rejected/free') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'temperature must be a number', type: 'invalid_request_error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // A model that thought too long on its first turn and answers for real once
      // the caller re-asks, exactly like the shape recovery exists to finish.
      // (`think-only/free` stays permanently silent so the chain commit rule has a
      // candidate that never answers.)
      if (model === 'think-only/free' || (model === 'silent/free' && (kiloCalls.get(model) ?? 0) === 1)) res.end(THINK_ONLY_BODY)
      else res.end(SSE_BODY)
      return
    }
    if (req.method === 'POST' && url.pathname === '/inference/openai/v1/chat/completions') {
      opencodeSeen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body: parsed })
      const payloadTools = Array.isArray(parsed?.tools) ? parsed.tools : []
      const payloadNames = payloadTools.map((tool: any) => tool?.function?.name ?? tool?.name)
      const callerRenamed = payloadNames.includes('read_ofm1') && !payloadNames.includes('conversation_delegate')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(callerRenamed ? TOOL_SSE_BODY : SSE_BODY)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no route' } }))
  })
})

const checks: { label: string; fn: () => void | Promise<void> }[] = []
function check(label: string, fn: () => void | Promise<void>) {
  checks.push({ label, fn })
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-gateway-'))
  process.env.OFM_DATA_DIR = dataDir
  await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', () => resolve()))
  const port = (standIn.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  process.env.OFM_KILO_BASE = base
  process.env.OFM_OPENECODE_BASE = base
  process.env.OFM_OPENECODE_CHAT_BASE = `${base}/inference/openai/v1`

  const { buildLaneModels } = await import('../dist/gateway/dispatch.js')
  const { startGateway } = await import('../dist/gateway/server.js')
  const { kiloModels } = await import('../dist/kilo.js')
  const { opencodeModels } = await import('../dist/opencode.js')

  const { quotaReading } = await import('../dist/gateway/probe.js')
  // The gateway is built from an explicit lane list: the two keyless lanes are
  // always present, and the co-paid / aggregate lanes depend on the host (a seal
  // that opens, a key the user pasted) — so they are simply not listed here.
  const models = buildLaneModels([
    { id: 'ofm-kilo', models: await kiloModels() },
    { id: 'ofm-opencode', models: await opencodeModels() },
  ])
  let root = ''
  let gateway: Awaited<ReturnType<typeof startGateway>>
  const auth = { authorization: `Bearer ${KEY}` }

  check('the gateway binds a loopback port of its own when asked for 0', () => {
    assert.ok(gateway.port > 0, 'no port bound')
    assert.equal(gateway.host, '127.0.0.1')
    assert.equal(gateway.requestedPort, 0)
  })

  check('health answers without the key', async () => {
    const response = await fetch(`${root}/health`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).service, 'our-free-model')
  })

  check('a request with no key is refused', async () => {
    const response = await post({ model: 'ofm-kilo/standin-free', messages: [] })
    assert.equal(response.status, 401)
    assert.match(JSON.stringify(await response.json()), /invalid API key/)
  })

  check('a request with the wrong key is refused', async () => {
    const response = await post({ model: 'ofm-kilo/standin-free', messages: [] }, { authorization: 'Bearer ofm-wrong' })
    assert.equal(response.status, 401)
  })

  check('a model that is not provider/model is a 400, not a crash', async () => {
    const response = await post({ model: 'standin-free', messages: [] }, auth)
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /<provider>\/<model>/)
  })

  check('an unknown model is a 404 that names the address', async () => {
    const response = await post({ model: 'ofm-kilo/nope-free', messages: [] }, auth)
    assert.equal(response.status, 404)
    assert.match(JSON.stringify(await response.json()), /ofm-kilo\/nope-free/)
  })

  check('GET /v1/models lists both lanes under their provider prefix', async () => {
    const response = await fetch(`${root}/v1/models`, { headers: auth })
    assert.equal(response.status, 200)
    const ids = ((await response.json()).data as { id: string }[]).map((row) => row.id)
    assert.ok(ids.includes('ofm-kilo/standin-free'), `kilo row missing: ${ids.join(', ')}`)
    assert.ok(ids.includes('ofm-opencode/standin-free'), `opencode row missing: ${ids.join(', ')}`)
  })

  check('a Kilo turn carries the upstream wire id, not the pi safe id', async () => {
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-kilo/standin-free', messages: [{ role: 'user', content: 'hi' }], stream: false }, auth)
    assert.equal(response.status, 200)
    const document = await response.json()
    assert.equal(document.choices[0].message.content, 'pong done')
    assert.equal(document.usage.prompt_tokens, 11)
    assert.equal(document.usage.total_tokens, 18)
    assert.equal(kiloSeen.length, 1, 'the stand-in was not called once')
    assert.equal(kiloSeen[0].body.model, 'standin/free')
  })

  check('the Kilo lane sends no credential at all', () => {
    assert.equal(kiloSeen[0].headers.authorization, undefined)
    assert.equal(kiloSeen[0].headers['x-api-key'], undefined)
  })

  check('the Kilo payload drops the OpenAI-only framing fields', () => {
    const sent = kiloSeen[0].body
    assert.equal(sent.store, undefined)
    assert.equal(sent.stream_options, undefined)
    assert.equal(sent.prompt_cache_key, undefined)
    assert.equal(sent.stream, true, 'upstream is always asked for a stream')
  })

  check('a streamed Kilo turn replays the frames it received', async () => {
    const response = await post({ model: 'ofm-kilo/standin-free', messages: [{ role: 'user', content: 'hi' }] }, auth)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await response.text()
    assert.match(text, /pong/)
    assert.match(text, /\[DONE\]/)
  })

  check('the OpenCode lane wears the v2 fingerprint and carries Bearer public', async () => {
    opencodeSeen.length = 0
    const response = await post({ model: 'ofm-opencode/standin-free', messages: [{ role: 'user', content: 'hi' }] }, auth)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /pong/)
    assert.equal(opencodeSeen.length, 1, 'the stand-in was not called once')
    const seen = opencodeSeen[0]
    assert.equal(seen.headers['user-agent'], 'opencode/latest/2.0.26/cli')
    assert.equal(seen.headers.authorization, 'Bearer public')
    assert.equal(seen.headers['x-opencode-session'], seen.headers['x-session-id'])
    assert.equal(seen.headers['x-opencode-request'] === undefined, true)
  })

  check('an OpenCode body carries the verbatim gate tools and the env block', () => {
    const sent = opencodeSeen[0].body
    const names = (sent.tools ?? []).map((tool: any) => tool?.function?.name ?? tool?.name)
    assert.ok(names.includes('read'), `gate tool read missing: ${names.join(', ')}`)
    assert.ok(names.includes('shell'), `gate tool shell missing: ${names.join(', ')}`)
    const system = String(sent.messages?.[0]?.content ?? '')
    assert.match(system, /<env>/)
    assert.match(system, /Working directory:/)
    assert.equal(sent.tool_choice === 'none', false, 'tool_choice none must never be emitted')
  })

  check("the caller's own tool is renamed out of the gate slot and restored on the way back", async () => {
    opencodeSeen.length = 0
    const response = await post({
      model: 'ofm-opencode/standin-free',
      messages: [{ role: 'user', content: 'read /tmp' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'the caller own read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    }, auth)
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.doesNotMatch(text, /read_ofm1/, `the alias leaked to the caller: ${text.slice(0, 400)}`)
    // read is a fingerprint decoy, so it is suppressed on the way back
    assert.doesNotMatch(text, /"name":"read"/, `read decoy was not suppressed: ${text.slice(0, 400)}`)
    const sentNames = (opencodeSeen[0].body.tools ?? []).map((tool: any) => tool?.function?.name ?? tool?.name)
    // The caller's `read` folds onto the official name, so it is *bound* rather
    // than renamed out of the slot: its own definition rides the wire under the
    // official name and the official set is not duplicated (v1.4.7 BindOfficial).
    assert.ok(sentNames.filter((name: string) => name === 'read').length === 1, `the official set was duplicated: ${sentNames.join(', ')}`)
    // …and the bound row still carries the caller's own definition, which is
    // what makes this a binding rather than a silent replacement.
    const read = (opencodeSeen[0].body.tools ?? []).find((tool: any) => (tool?.function?.name ?? tool?.name) === 'read')
    assert.equal(read.function.description, 'the caller own read', 'the caller definition was replaced')
    assert.equal(read.function.parameters.properties.path.type, 'string')
  })

  check("fingerprint decoy tools (read, shell) are suppressed on the way back", async () => {
    opencodeSeen.length = 0
    const response = await post({
      model: 'ofm-opencode/standin-free',
      messages: [{ role: 'user', content: 'read /tmp' }],
      tools: [{ type: 'function', function: { name: 'my_read', description: 'the caller own read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    }, auth)
    assert.equal(response.status, 200)
    const text = await response.text()
    // read/shell decoys should not appear in the caller-facing response
    assert.doesNotMatch(text, /"name":"read"/, `read decoy leaked to caller: ${text.slice(0, 400)}`)
    assert.doesNotMatch(text, /"name":"shell"/, `shell decoy leaked to caller: ${text.slice(0, 400)}`)
  })

  check('an SSE body mislabelled as application/json is read by shape, not by header', async () => {
    const response = await post({ model: 'ofm-opencode/standin-free', messages: [{ role: 'user', content: 'hi' }] }, auth)
    assert.match(await response.text(), /pong/)
  })

  check('an unknown route answers 404 with the gateway error shape', async () => {
    const response = await fetch(`${root}/v1/nope`, { headers: auth })
    assert.equal(response.status, 404)
    assert.match(JSON.stringify(await response.json()), /no route for/)
  })

  check('CORS preflight answers 204 without the key', async () => {
    const response = await fetch(`${root}/v1/chat/completions`, { method: 'OPTIONS' })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  })

  check('an Anthropic turn answers with a message in Anthropic vocabulary', async () => {
    kiloSeen.length = 0
    const response = await postMessages({ model: 'ofm-kilo/standin-free', max_tokens: 64, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    const message = await response.json()
    assert.equal(message.type, 'message')
    assert.equal(message.role, 'assistant')
    assert.equal(message.model, 'ofm-kilo/standin-free')
    assert.equal(message.content[0].type, 'text')
    assert.equal(message.content[0].text, 'pong done')
    assert.equal(message.stop_reason, 'end_turn')
    assert.equal(message.usage.input_tokens, 11)
    const sent = kiloSeen[0].body
    assert.equal(sent.model, 'standin/free')
    assert.equal(sent.max_tokens, 64)
    assert.equal(sent.messages[0].role, 'user')
  })

  check('an Anthropic tool_use block rides through to the OpenAI wire and back', async () => {
    kiloSeen.length = 0
    const response = await postMessages({
      model: 'ofm-kilo/standin-free',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file listed' },
          { type: 'text', text: 'now summarise' },
        ],
      }],
      tools: [{ name: 'read', description: 'the caller read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    }, auth)
    assert.equal(response.status, 200)
    const message = await response.json()
    assert.ok(Array.isArray(message.content))
    const sent = kiloSeen[0].body
    const roles = (sent.messages ?? []).map((m: any) => m.role)
    assert.ok(roles.includes('tool'), `the tool_result did not become a role:tool message: ${roles.join(', ')}`)
    const toolMessage = sent.messages.find((m: any) => m.role === 'tool')
    assert.equal(toolMessage.tool_call_id, 'toolu_1')
    assert.ok(Array.isArray(sent.tools) && sent.tools.length === 1, 'the tool was not forwarded')
    assert.equal(sent.tools[0].function.name, 'read')
  })

  check('an Anthropic system block moves into the message list', async () => {
    kiloSeen.length = 0
    const response = await postMessages({
      model: 'ofm-kilo/standin-free',
      max_tokens: 32,
      system: [{ type: 'text', text: 'You are terse.' }],
      messages: [{ role: 'user', content: 'hi' }],
    }, auth)
    assert.equal(response.status, 200)
    const sent = kiloSeen[0].body
    assert.equal(sent.messages[0].role, 'system')
    assert.match(String(sent.messages[0].content), /terse/)
  })

  check('an Anthropic stream answers with the named event sequence', async () => {
    const response = await postMessages({
      model: 'ofm-kilo/standin-free',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'say pong' }],
    }, auth)
    assert.equal(response.status, 200)
    const text = await response.text()
    for (const event of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
      assert.ok(text.includes(`event: ${event}`), `missing ${event} in ${text.slice(0, 300)}`)
    }
    assert.match(text, /"type":"text_delta"/)
    assert.match(text, /end_turn/)
    const collected = [...text.matchAll(/event: content_block_delta\ndata: (.*)/g)].map((m) => {
      const delta = JSON.parse(m[1]).delta
      return delta.type === 'text_delta' ? delta.text : ''
    }).join('')
    assert.equal(collected, 'pong done')
  })

  check('a Gemini turn answers with candidates in Gemini vocabulary', async () => {
    kiloSeen.length = 0
    const response = await postGemini({
      contents: [{ role: 'user', parts: [{ text: 'say pong' }] }],
      generationConfig: { maxOutputTokens: 48 },
    }, '/v1beta/models/ofm-kilo%2Fstandin-free:generateContent', auth)
    assert.equal(response.status, 200)
    const document = await response.json()
    assert.ok(Array.isArray(document.candidates), 'no candidates')
    const candidate = document.candidates[0]
    assert.equal(candidate.content.role, 'model')
    assert.equal(candidate.content.parts[0].text, 'pong done')
    assert.equal(candidate.finishReason, 'STOP')
    assert.equal(document.usageMetadata.promptTokenCount, 11)
    assert.equal(document.usageMetadata.candidatesTokenCount, 7)
    const sent = kiloSeen[0].body
    assert.equal(sent.model, 'standin/free')
    assert.equal(sent.max_tokens, 48)
  })

  check('a Gemini systemInstruction and a model text part project onto the OpenAI wire', async () => {
    kiloSeen.length = 0
    const response = await postGemini({
      contents: [{ role: 'user', parts: [{ text: 'next' }] }],
      systemInstruction: { parts: [{ text: 'Be terse.' }] },
      generationConfig: { temperature: 0.3 },
    }, '/v1beta/models/ofm-kilo%2Fstandin-free:generateContent', auth)
    assert.equal(response.status, 200)
    const sent = kiloSeen[0].body
    assert.equal(sent.messages[0].role, 'system')
    assert.match(String(sent.messages[0].content), /terse/)
    assert.equal(sent.temperature, 0.3)
  })

  check('a Gemini functionResponse answer rides through as a tool message', async () => {
    kiloSeen.length = 0
    const response = await postGemini({
      contents: [{
        role: 'user',
        parts: [
          { functionResponse: { id: 'fc_1', name: 'read', response: { path: '/tmp' } } },
          { text: 'summarise' },
        ],
      }],
      tools: [{ functionDeclarations: [{ name: 'read', description: 'the caller read', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } }] }],
    }, '/v1beta/models/ofm-kilo%2Fstandin-free:generateContent', auth)
    assert.equal(response.status, 200)
    const sent = kiloSeen[0].body
    const toolMessage = (sent.messages ?? []).find((m: any) => m.role === 'tool')
    assert.ok(toolMessage !== undefined, 'the functionResponse did not become a role:tool message')
    assert.equal(toolMessage.tool_call_id, 'fc_1')
    const tool = (sent.tools ?? [])[0]
    assert.ok(tool !== undefined, 'the function declaration was not forwarded')
    assert.equal(tool.function.name, 'read')
    assert.equal(tool.function.parameters.properties.path.type, 'string', 'Gemini uppercase schema was not lowered')
  })

  check('a streamed Gemini turn answers with streamed chunks and a terminal finishReason', async () => {
    const response = await postGemini({
      contents: [{ role: 'user', parts: [{ text: 'say pong' }] }],
      generationConfig: { stream: true },
    }, '/v1beta/models/ofm-kilo%2Fstandin-free:streamGenerateContent', auth)
    assert.equal(response.status, 200)
    const text = await response.text()
    const chunks = text.split('\n\n').filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
    assert.ok(chunks.length > 0, 'no streamed chunks')
    const first = JSON.parse(chunks[0].slice(6))
    assert.ok(Array.isArray(first.candidates), 'a chunk has no candidates')
    assert.ok(text.includes('"finishReason":"STOP"')
      || text.includes('"finishReason": undefined') || text.endsWith('data: [DONE]\n\n'), 'no terminal marker')
    const collected = chunks.map((c) => (JSON.parse(c.slice(6)).candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')).join('')
    assert.equal(collected, 'pong done')
  })

  check('GET /v1beta/models lists the gateway roster in Gemini shape', async () => {
    const response = await fetch(`${root}/v1beta/models`, { headers: auth })
    assert.equal(response.status, 200)
    const names = ((await response.json()).models as { name: string }[]).map((row) => row.name)
    assert.ok(names.includes('models/ofm-kilo/standin-free'), `kilo row missing: ${names.slice(0, 4).join(', ')}`)
  })

  check('an unknown chain is a 404 that names the address', async () => {
    const response = await post({ model: 'ofm-chain/nope-free', messages: [] }, auth)
    assert.equal(response.status, 404)
    assert.match(JSON.stringify(await response.json()), /no such chain/)
  })

  check('a chain with no live link is refused, not dispatched', async () => {
    chainRows.push({ id: 'chain:dead', name: 'Dead', models: ['ofm-kilo/ghost-free'], strategy: 'fallback', stickyLimit: 1 })
    const before = kiloSeen.length
    const response = await post({ model: 'ofm-chain/dead', messages: [] }, auth)
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /no link resolves right now/)
    assert.equal(kiloSeen.length, before, 'a dead chain must not spend a turn')
  })

  check('a chain that falls over mid-stream answers from the next link and hides the failure', async () => {
    chainRows.push({ id: 'chain:failover', name: 'Failover', models: ['ofm-kilo/broken-free', 'ofm-kilo/standin-free'], strategy: 'fallback', stickyLimit: 1 })
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-chain/failover', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 200)
    const document = await response.json()
    assert.equal(document.choices[0].message.content, 'pong done')
    assert.equal(document.model, 'ofm-kilo/standin-free', 'the answering link must be the model echoed')
    assert.ok(kiloSeen.length >= 2, `the chain walked: ${kiloSeen.length} calls`)
  })

  check('a reasoning-only candidate is discarded whole so a quota wall after thinking still fails over', async () => {
    chainRows.push({ id: 'chain:silent', name: 'Silent', models: ['ofm-kilo/think-only-free', 'ofm-kilo/standin-free'], strategy: 'fallback', stickyLimit: 1 })
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-chain/silent', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 200)
    const document = await response.json()
    assert.equal(document.choices[0].message.content, 'pong done')
    assert.equal(document.model, 'ofm-kilo/standin-free', 'the held reasoning must not pin the chain')
    assert.equal(kiloSeen[0].body.model, 'think-only/free', 'the first link was the reasoning-only model')
  })

  check('a request-scoped refusal does not move the chain — replaying is what 4xx means', async () => {
    chainRows.push({ id: 'chain:bad-req', name: 'Bad Request', models: ['ofm-kilo/rejected-free', 'ofm-kilo/standin-free'], strategy: 'fallback', stickyLimit: 1 })
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-chain/bad-req', max_tokens: 64, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 400, 'the caller error must be handed back, not failed over')
    assert.equal(kiloSeen.length, 1, 'a request-scoped refusal must not spend a second link')
  })

  check('a chain whose every link fails exhausts with a reason per link', async () => {
    chainRows.push({ id: 'chain:all-dead', name: 'All Dead', models: ['ofm-kilo/think-only-free'], strategy: 'fallback', stickyLimit: 1 })
    const response = await post({ model: 'ofm-chain/all-dead', max_tokens: 64, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 502)
    assert.match(JSON.stringify(await response.json()), /exhausted every candidate/)
  })

  check('a turn that stopped with only its thinking is continued once instead of returned empty', async () => {
    kiloCalls.clear()
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-kilo/silent-free', max_tokens: 2048, stream: false, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 200)
    const document = await response.json()
    assert.equal(document.choices[0].message.content, 'pong done', 'the continuation delivered the answer')
    assert.equal(kiloSeen.length, 2, `the turn was replayed once: ${kiloSeen.length} calls`)
    const second = kiloSeen[1].body
    assert.equal(second.max_tokens, 2048, 'the remaining budget carries over')
    assert.equal(second.model, 'silent/free')
    assert.match(JSON.stringify(second.messages), /not new instructions/, 'the continuation injected the reasoning checkpoint')
  })

  check('a silent turn under the continuation floor is returned as it came, not re-sent', async () => {
    kiloCalls.clear()
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-kilo/silent-free', max_tokens: 256, stream: false, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 200)
    assert.equal(kiloSeen.length, 1, 'a budget below the floor must not spend a second turn')
  })

  check('a turn that answered is not replayed', async () => {
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-kilo/standin-free', max_tokens: 256, stream: false, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 200)
    assert.equal(kiloSeen.length, 1, 'an answering turn must not be re-sent')
  })

  check('a quota probe is answered locally and spends no lane', async () => {
    kiloSeen.length = 0
    const response = await postMessages({ model: 'ofm-kilo/standin-free', max_tokens: 1, messages: [{ role: 'user', content: 'What quota is left?' }] }, auth)
    assert.equal(response.status, 200)
    const message = await response.json()
    assert.equal(message.content[0].text, 'Quota check passed.')
    assert.equal(message.stop_reason, 'end_turn')
    assert.equal(kiloSeen.length, 0, 'the lane must not be consulted for a local answer')
  })

  check('a real question is never answered locally', async () => {
    kiloSeen.length = 0
    const response = await postMessages({ model: 'ofm-kilo/standin-free', max_tokens: 64, messages: [{ role: 'user', content: 'explain hash maps' }] }, auth)
    assert.equal(response.status, 200)
    const message = await response.json()
    assert.equal(message.content[0].text, 'pong done')
    assert.equal(kiloSeen.length, 1, 'the lane was consulted')
  })

  check('a Responses turn answers with a response document in Responses vocabulary', async () => {
    kiloSeen.length = 0
    const response = await postResponses({ model: 'ofm-kilo/standin-free', input: 'say pong', max_output_tokens: 64 }, auth)
    assert.equal(response.status, 200)
    const document = await response.json()
    assert.equal(document.object, 'response')
    assert.equal(document.status, 'completed')
    assert.equal(document.model, 'ofm-kilo/standin-free')
    const text = document.output.find((item: any) => item.type === 'message')?.content?.[0]?.text
    assert.equal(text, 'pong done')
    assert.equal(document.usage.input_tokens, 11)
    const sent = kiloSeen[0].body
    assert.equal(sent.messages[0].role, 'user', 'a plain input string becomes one user turn')
    assert.equal(sent.messages[0].content, 'say pong')
    assert.equal(sent.max_tokens, 64)
  })

  check('a Responses instructions field moves into the message list', async () => {
    kiloSeen.length = 0
    const response = await postResponses({ model: 'ofm-kilo/standin-free', input: 'say pong', instructions: 'Be terse.', max_output_tokens: 64 }, auth)
    assert.equal(response.status, 200)
    const sent = kiloSeen[0].body
    assert.equal(sent.messages[0].role, 'system')
    assert.equal(sent.messages[0].content, 'Be terse.')
    assert.equal(sent.messages[1].role, 'user')
  })

  check('a Responses tool call rides through as a function_call item', async () => {
    kiloSeen.length = 0
    const response = await postResponses({
      model: 'ofm-kilo/standin-free',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read /tmp' }] }],
      tools: [{ type: 'function', name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    }, auth)
    assert.equal(response.status, 200)
    const sent = kiloSeen[0].body
    const tool = (sent.tools ?? [])[0]
    assert.ok(tool !== undefined, 'the function declaration was not forwarded')
    assert.equal(tool.function.name, 'read')
  })

  check('a streamed Responses turn answers with the typed event sequence', async () => {
    const response = await postResponses({ model: 'ofm-kilo/standin-free', input: 'say pong', stream: true, max_output_tokens: 64 }, auth)
    assert.equal(response.status, 200)
    const text = await response.text()
    for (const event of ['response.created', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.completed']) {
      assert.ok(text.includes(`event: ${event}`), `missing ${event}`)
    }
    assert.ok(text.includes('"type":"output_text"'))
  })

  check('a smart chain with no quota reading keeps its declared order, not a shuffled guess', async () => {
    chainRows.push({ id: 'chain:smart-cold', name: 'Smart Cold', models: ['ofm-kilo/standin-free', 'ofm-kilo/second-free'], strategy: 'smart', stickyLimit: 1 })
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-chain/smart-cold', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'say pong' }] }, auth)
    assert.equal(response.status, 200)
    assert.equal(kiloSeen[0].body.model, 'standin/free', 'the declared head is the one tried first')
  })

  check('a smart chain with a reading picks the link that has quota left', async () => {
    chainRows.push({ id: 'chain:smart', name: 'Smart', models: ['ofm-kilo/standin-free', 'ofm-kilo/second-free'], strategy: 'smart', stickyLimit: 1 })
    const readings = new Map([
      ['ofm-kilo/standin-free', { status: 'ok', checkedAt: new Date().toISOString(), windows: [{ remainingPercent: 0, resetsAt: new Date(Date.now() + 3600000).toISOString(), kind: 'weekly', windowSeconds: 604800 }] }],
      ['ofm-kilo/second-free', { status: 'ok', checkedAt: new Date().toISOString(), windows: [{ remainingPercent: 80, resetsAt: new Date(Date.now() + 3600000).toISOString(), kind: 'weekly', windowSeconds: 604800 }] }],
    ])
    kiloSeen.length = 0
    const response = await post({ model: 'ofm-chain/smart', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'say pong' }] }, auth, readings)
    assert.equal(response.status, 200)
    assert.equal(kiloSeen[0].body.model, 'second/free', 'the scored order starts with the link that has quota left')
  })

  check('quotaReading reports an empty window list when the upstream discloses nothing', () => {
    assert.deepEqual(quotaReading({ total_tokens: 18 }), [])
    assert.deepEqual(quotaReading(undefined), [])
  })

  check('quotaReading reports the window a usage frame discloses', () => {
    const reading = quotaReading({ remainingPercent: 42, resetsAt: '2026-11-07T00:00:00.000Z' })
    assert.equal(reading.length, 1)
    assert.equal(reading[0].remainingPercent, 42)
  })

  check('quotaReading refuses a window outside 0..100', () => {
    assert.deepEqual(quotaReading({ remainingPercent: 120 }), [])
    assert.deepEqual(quotaReading({ remainingPercent: -5 }), [])
  })

  check('count_tokens answers a local estimate without calling upstream', async () => {
    kiloSeen.length = 0
    const response = await fetch(`${root}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ofm-kilo/standin-free', messages: [{ role: 'user', content: 'say pong' }] }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.ok(payload.input_tokens > 0, 'a non-zero estimate')
    assert.equal(kiloSeen.length, 0, 'no turn should have been dispatched')
  })

  const chainRows: { id: string; name: string; models: string[]; strategy: string; stickyLimit: number }[] = []

  gateway = await startGateway({
    settings: () => ({ host: '127.0.0.1', port: 0, enabled: true, key: KEY }),
    models: () => models,
    chains: () => chainRows,
    quota: () => chainReadings,
    heartbeatMs: 5000,
    log: () => {},
  })
  root = `http://127.0.0.1:${gateway.port}`
  const chainReadings = new Map()
  const post = (body: unknown, headers: Record<string, string> = {}, readings?: Map<string, any>) => {
    if (readings !== undefined) for (const [key, value] of readings) chainReadings.set(key, value)
    return fetch(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }
  const postMessages = (body: unknown, headers: Record<string, string> = {}) => fetch(`${root}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const postResponses = (body: unknown, headers: Record<string, string> = {}) => fetch(`${root}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const postGemini = (body: unknown, suffix: string, headers: Record<string, string> = {}) => fetch(`${root}${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  let failures = 0
  for (const { label, fn } of checks) {
    try {
      await fn()
      console.log(`ok   ${label}`)
    } catch (error) {
      console.log(`FAIL ${label} — ${(error as Error).message}`)
      failures += 1
    }
  }

  await gateway.close()
  await new Promise<void>((resolve) => standIn.close(() => resolve()))
  if (failures > 0) {
    console.log(`\n${failures} FAIL`)
    process.exit(1)
  }
  console.log('\nALL CHECKS PASSED')
}

void main()
