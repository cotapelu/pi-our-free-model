/**
 * Unit checks for the lane transport guards — the half of `lane.js` that has no
 * dependency on pi's host packages, extracted into `transport.js` precisely so
 * it could be tested at all.
 *
 * Each guard answers a failure mode the gateways actually produce: a body that
 * lies about being a stream, a stream that pings and then goes mute, and a
 * model that leaks control markup into visible text.
 *
 * Usage: node pi-extension/test/transport.test.mjs
 */
import assert from 'node:assert/strict'
import { createDsmlScrubber, foldToSse, friendlyMessage, readHead, readRemainder, replayStream, sniffBody, SNIFF_BYTES, transportCause, withIdleTimeout } from '../dist/transport.js'

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failures += 1
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failures += 1
  }
}

/** A stream from byte chunks, with an optional keepalive comment first. */
function streamOf(chunks, { keepalive = false, delayMs = 0 } = {}) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      if (keepalive) {
        controller.enqueue(encoder.encode(': PING\n\n'))
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

const readAll = async (stream) => {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

check('sniffBody reads the body, not the content-type', () => {
  assert.equal(sniffBody(''), 'empty')
  assert.equal(sniffBody('   '), 'empty')
  assert.equal(sniffBody(': PING\n\ndata: {}'), 'sse', 'a keepalive comment is an SSE shape')
  assert.equal(sniffBody('data: {"a":1}\n\n'), 'sse')
  assert.equal(sniffBody('{"choices":[]}'), 'json')
  assert.equal(sniffBody('[1,2]'), 'json')
  assert.equal(sniffBody('<html><body>WAF</body></html>'), 'unknown')
  assert.equal(sniffBody('\uFEFFdata: {}'), 'sse', 'a BOM is not a shape')
})

check('foldToSse turns a complete document into delta frames the SDK can read', () => {
  const document = {
    id: 't',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong', reasoning_content: 'thinking', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 },
  }
  const frames = foldToSse(JSON.stringify(document)).split('\n\n').filter((frame) => frame !== '' && frame !== 'data: [DONE]')
  const parsed = frames.map((frame) => JSON.parse(frame.replace(/^data: /, '')))
  assert.ok(parsed.some((chunk) => chunk.choices[0].delta.content === 'pong'), 'the message became content deltas')
  assert.ok(parsed.some((chunk) => chunk.choices[0].delta.reasoning_content === 'thinking'), 'reasoning survives the fold')
  assert.ok(parsed.some((chunk) => chunk.choices[0].delta.tool_calls?.[0]?.function?.name === 'read'), 'tool calls survive the fold')
  assert.ok(parsed.some((chunk) => chunk.choices[0].finish_reason === 'tool_calls'), 'the finish reason survives')
  assert.ok(parsed.some((chunk) => chunk.usage?.total_tokens === 7), 'usage survives, so accounting still works')
  assert.match(foldToSse(JSON.stringify(document)), /data: \[DONE\]\n\n$/, 'the stream terminates with the SDK\'s DONE marker')
})

check('foldToSse passes an unparsable body through as one event', () => {
  const frames = foldToSse('not json').trim().split('\n\n')
  assert.equal(frames[0], 'data: not json')
  assert.equal(frames.at(-1), 'data: [DONE]')
})

check('foldToSse handles an empty answer without inventing content', () => {
  const frames = foldToSse(JSON.stringify({ id: 't', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }))
  const parsed = frames.split('\n\n').filter((frame) => frame !== '' && frame !== 'data: [DONE]').map((frame) => JSON.parse(frame.replace(/^data: /, '')))
  assert.ok(parsed.every((chunk) => chunk.choices[0]?.delta?.content === undefined || chunk.choices[0].delta.content === ''), 'no invented content')
  assert.ok(parsed.some((chunk) => chunk.choices[0]?.finish_reason === 'stop'))
})

check('the DSML scrubber removes markup and holds an ambiguous tail', () => {
  const scrubber = createDsmlScrubber()
  assert.equal(scrubber.push('hello <｜DSML｜ calls>\nworld'), 'hello \nworld')
  assert.equal(scrubber.flush(), '')
  // A tail that could still grow into an opening is held, not leaked; when the
  // next delta shows it never was one, the held character comes back as text.
  const held = createDsmlScrubber()
  assert.equal(held.push('answer: 2<'), 'answer: 2')
  assert.equal(held.push('+2'), '<+2', 'the held `<` was plain text after all')
  assert.equal(held.push(' tail<｜DSML'), ' tail')
  assert.equal(held.push('｜x>\n'), '\n')
  assert.equal(held.flush(), '')
  // A held tail that never resolves is dropped rather than leaked as markup.
  const dangling = createDsmlScrubber()
  dangling.push('end<｜DSML｜')
  assert.equal(dangling.flush(), '', 'an unresolved opening is dropped')
})

check('the idle watchdog passes a live stream through untouched', async () => {
  const body = streamOf(['data: {"a":1}\n\n', 'data: [DONE]\n\n'])
  const guarded = withIdleTimeout(body, 5_000)
  const text = await readAll(guarded)
  assert.match(text, /data: \{"a":1\}/)
  assert.match(text, /\[DONE\]/)
})

check('the watchdog returns the same stream when disabled', () => {
  const body = streamOf(['data: {}\n\n'])
  assert.equal(withIdleTimeout(body, 0), body, 'ms = 0 disables the watchdog')
  assert.equal(withIdleTimeout(null, 300), null, 'no body passes through')
})

check('the watchdog cuts a stream that pings and then goes mute', async () => {
  // One keepalive comment, then silence: the comment must not reset the clock.
  const body = streamOf([], { keepalive: true })
  const guarded = withIdleTimeout(body, 120)
  await assert.rejects(readAll(guarded), /went idle past 120ms/,
    'a wedged, token-less turn dies instead of holding the turn open')
})

check('the watchdog accepts a slow-but-alive stream', async () => {
  // Data frames arrive every 60ms for 5 of them, with a 150ms budget each.
  const body = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60))
        controller.enqueue(encoder.encode(`data: {"n":${index}}\n\n`))
      }
      controller.close()
    },
  })
  const text = await readAll(withIdleTimeout(body, 150))
  assert.equal((text.match(/data: /g) ?? []).length, 5, 'every frame arrived')
})

check('friendlyMessage keeps the quota wall out of the retryable set', () => {
  const message = friendlyMessage('429 {"error":{"type":"FreeUsageLimitError"}}')
  assert.match(message, /FreeUsageLimitError/, 'the upstream discriminator survives, so pi-ai still classifies it as an account limit')
  assert.match(message, /free quota for this egress is spent/)
})

check('friendlyMessage names the fingerprint refusal, the region, and the WAF', () => {
  assert.match(friendlyMessage('403 FreeTierError') ?? '', /client fingerprint no longer matches/)
  assert.match(friendlyMessage('403 RegionError') ?? '', /egress region/)
  assert.match(friendlyMessage('<!doctype html><html>') ?? '', /HTML error page/)
  assert.match(friendlyMessage('{"error":{"message":"Model is unavailable"}}') ?? '', /no longer routes this model/)
  assert.equal(friendlyMessage('a perfectly ordinary 500'), null, 'unknown failures are left to pi')
})

check('transportCause walks the cause chain for the reason a fetch failed', () => {
  const withCode = (message, code) => Object.assign(new Error(message), { code })
  assert.equal(transportCause(new Error('fetch failed')), '', 'nothing to append when the chain names no cause')
  const refused = new Error('fetch failed', { cause: withCode('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED') })
  assert.equal(transportCause(refused), ' — connect ECONNREFUSED 127.0.0.1:443', 'the socket line rides the message when it already names the code')
  const named = new Error('fetch failed', { cause: withCode('connect failed', 'ECONNREFUSED') })
  assert.equal(transportCause(named), ' — connect failed (ECONNREFUSED)', 'the code is parenthesised when the line omits it')
  const dns = new Error('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND opencode.ai', { cause: withCode('getaddrinfo ENOTFOUND opencode.ai', 'ENOTFOUND') }) })
  assert.equal(transportCause(dns), ' — getaddrinfo ENOTFOUND opencode.ai', 'a two-link chain is walked and deduplicated to one fact')
})

await (async () => {
  await checkAsync('readHead decides on SSE from the head alone, without waiting for the stream to close', async () => {
    // The source delivers one SSE head and then holds the connection open: a
    // reader that buffered the whole body would wait for a close that never
    // comes. readHead must return as soon as the shape is known (issue #6).
    const encoder = new TextEncoder()
    const head1 = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
    let ctrl
    const stream = new ReadableStream({ start(controller) { ctrl = controller; controller.enqueue(encoder.encode(head1)) } })
    const started = Date.now()
    const head = await readHead(stream, SNIFF_BYTES, { timeoutMs: 4000 })
    assert.equal(sniffBody(head.text), 'sse', 'the head is recognised as SSE')
    assert.equal(head.done, false, 'the body is still open — only the head was spent')
    assert.ok(Date.now() - started < 2000, 'readHead did not wait for the never-coming close')
    // replayStream stitches the head back on and keeps the live reader going.
    const replayed = replayStream(head)
    const reader = replayed.getReader()
    const first = await reader.read()
    assert.equal(new TextDecoder().decode(first.value), head1, 'the head bytes come back first, unchanged')
    ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"tail"}}]}\n\n'))
    const second = await reader.read()
    assert.ok(new TextDecoder().decode(second.value).includes('tail'), 'bytes pushed after the head flow through the same reader')
    ctrl.close()
    const end = await reader.read()
    assert.equal(end.done, true, 'the reader ends when the source ends')
  })

  await checkAsync('readRemainder finishes a non-stream body the head split across the boundary', async () => {
    const document = JSON.stringify({ id: 't', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })
    const mid = Math.floor(document.length / 2)
    const head = await readHead(streamOf([document.slice(0, mid), document.slice(mid)]), SNIFF_BYTES, { timeoutMs: 4000 })
    const text = head.done ? head.text : await readRemainder(head)
    assert.equal(text, document, 'the whole document reassembles, the decoder continuing across the split')
    assert.equal(sniffBody(text), 'json', 'a non-stream body is reported as json, not mistaken for a stream')
  })
})()

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
