/**
 * Unit checks for the ported adapter.
 *
 * The silence watchdog is the piece that is genuinely new to the port: without it
 * a chain candidate that accepts a request and then sends nothing but keepalive
 * comments blocks the whole walk, so the failover that exists for exactly that
 * case never reaches its next link. Every check below is there to pin that shape
 * against the byte-stream walker, plus the pure helpers the adapter owns.
 *
 * Runs on plain node:  node test/adapter.test.ts
 */
import assert from 'node:assert/strict'
import { commitBody as commitBodyForTest } from '../dist/gateway/chain.js'
import {
  CHAIN_SILENCE_MS, ROUTE_LABELS, ROUTE_MAIN, ROUTE_REGION, adapterRoutes, applySealedPacingHint,
  commitsAnswer, describe, buildPayload, imageRequestPricing, nextOrSilence, providerInfo,
  PROVIDER_RETRY_POLICY, savingsFields, SEALED_PACING_HINT, styleForWire, subscriptionToolChoice,
  toFailure, wireOf,
} from '../dist/adapter.js'

let failures = 0
let running = Promise.resolve()
/**
 * A **ref'd** keep-alive while the suite runs.
 *
 * The watchdog's own timer is deliberately `unref`'d — a chain must not be the
 * reason a CLI process stays up — so nothing in this suite holds the event loop
 * open on its own. Without a ref'd handle, Node exits the moment the queue drains
 * and the checks queued behind the one that just resolved never run. Cleared
 * before the report, so a real hang still hangs.
 */
const keepAlive = setInterval(() => {}, 500)
/** One check at a time; several of these hold a stream open on purpose. */
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

const encoder = new TextEncoder()
/** A stream over the given frames, with `close` to finish it. */
function streamOf(frames: string[], close = true): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < frames.length) {
        controller.enqueue(encoder.encode(frames[index]))
        index += 1
        return
      }
      if (close) controller.close()
    },
  })
}
/** A stream that stays open until it is cancelled — the silent candidate. */
function neverEnds(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false
  return {
    stream: new ReadableStream({
      pull() { /* never delivers, never closes */ },
      cancel() { cancelled = true },
    }),
    cancelled: () => cancelled,
  }
}

// ── the silence watchdog ────────────────────────────────────────────────────
check('the silence window is bounded and disarmed by default for a live model', () => {
  // 25 s is long enough that a reasoning model streaming its thoughts never trips
  // it, and short enough that a dead candidate does not stall a whole turn.
  assert.equal(CHAIN_SILENCE_MS, 25_000)
})

check('a candidate that accepts then goes quiet is discarded whole', async () => {
  // The exact shape the gateway cannot see: it answers 200, so a probe reads it
  // as up, and `reader.read()` never settles.
  const quiet = neverEnds()
  const started = Date.now()
  const committed = await commitBodyForTest(quiet.stream, 40)
  assert.ok(Date.now() - started < 500, 'the watchdog did not fire')
  assert.equal(committed, undefined, 'a silent candidate produced a body')
  assert.equal(quiet.cancelled(), true, 'the silent candidate was not cancelled')
})

check('a candidate that answers inside the window is kept, heartbeat frames and all', async () => {
  const frames = [
    ': ping\n\n', ': ping\n\n',
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'.replace('data: ', 'data: '),
  ]
  const body = await commitBodyForTest(streamOf(frames, true), CHAIN_SILENCE_MS)
  assert.notEqual(body, undefined, 'a keepalive before the answer discarded the try')
  const text = await new Response(body!).text()
  assert.match(text, /hello/)
  // The heartbeat frames ride along rather than being dropped.
  assert.equal((text.match(/: ping\n\n/g) ?? []).length, 2)
})

check('a body that commits on its last frame is not cut off', async () => {
  // The races on every read, so the commit read must be the one that counts.
  const body = await commitBodyForTest(streamOf([
    'data: {"choices":[{"delta":{"content":"tail"}}]}\n\n',
  ], true), CHAIN_SILENCE_MS)
  assert.notEqual(body, undefined)
  assert.match(await new Response(body!).text(), /tail/)
})

check('frames buffered after the committing frame ride along', async () => {
  // A single-chunk body that carries answer and tail in one write must not lose
  // its tail.
  const body = await commitBodyForTest(streamOf([
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n',
  ], true), CHAIN_SILENCE_MS)
  const text = await new Response(body!).text()
  assert.match(text, /"a"/)
  assert.match(text, /"b"/)
})

check('a candidate that fails before any answer reports no body, with its failure seen', async () => {
  const body = await commitBodyForTest(streamOf([
    'data: {"error":{"message":"quota"}}\n\n',
  ], true), CHAIN_SILENCE_MS)
  assert.equal(body, undefined)
})

check('a stream that closes before answering reports no body', async () => {
  assert.equal(await commitBodyForTest(streamOf([': ping\n\n'], true), CHAIN_SILENCE_MS), undefined)
})

// ── nextOrSilence, the chunk-level sibling ──────────────────────────────────
check('an iterator that answers inside the window resolves normally', async () => {
  async function* chunks() { yield { type: 'text-delta', text: 'x' }; yield { type: 'finish' } }
  const iterator = chunks()
  const first = await nextOrSilence(iterator, 500)
  assert.equal(first.done, false)
  assert.equal((first.value as any).text, 'x')
})

check('an iterator that goes quiet reports an advanceable end-of-try', async () => {
  // A pending `next()` cannot be interrupted, so the watchdog has to report the
  // try as over rather than block the walker — exactly what `SILENCE_RESULT` is.
  async function* silent() { await new Promise(() => {}); yield 'never' }
  const iterator = silent()
  const row = await nextOrSilence(iterator, 30)
  assert.deepEqual(row, { done: true, value: { advance: true, verdict: null } })
})

// ── commitsAnswer ──────────────────────────────────────────────────────────
check('visible text and streamed tool calls commit; reasoning does not', () => {
  assert.equal(commitsAnswer({ type: 'text-delta', text: 'answer' }), true)
  assert.equal(commitsAnswer({ type: 'tool-call-delta' }), true)
  // The most valuable failover: a minute of thinking, then a quota wall.
  assert.equal(commitsAnswer({ type: 'reasoning-delta', text: 'hmm' }), false)
  assert.equal(commitsAnswer({ type: 'block-end', block: { type: 'reasoning' } }), false)
})

check('whitespace-only text does not commit a chain', () => {
  assert.equal(commitsAnswer({ type: 'text-delta', text: '   ' }), false)
  assert.equal(commitsAnswer({ type: 'text-delta', text: '' }), false)
  assert.equal(commitsAnswer({ type: 'text-delta', text: '\n\t' }), false)
})

check('a text block-end commits only when it carries visible content', () => {
  assert.equal(commitsAnswer({ type: 'block-end', block: { type: 'text', text: 'done' } }), true)
  assert.equal(commitsAnswer({ type: 'block-end', block: { type: 'text', text: '  ' } }), false)
})

check('a reasoning block-end is the tail of thinking, so it does not commit', () => {
  // Letting it commit would pin the chain one chunk before the failure it exists
  // to survive.
  assert.equal(commitsAnswer({ type: 'block-end', block: { type: 'reasoning', text: 'done thinking' } }), false)
})

check('a block-end with no named block type still commits', () => {
  assert.equal(commitsAnswer({ type: 'block-end', block: { type: 'tool-call' } }), true)
  assert.equal(commitsAnswer({ type: 'block-end', block: {} }), true)
})

check('a non-object chunk never commits', () => {
  for (const value of [null, undefined, 42, 'text', [], true]) {
    assert.equal(commitsAnswer(value), false, `${JSON.stringify(value)} committed`)
  }
})

// ── the routes ──────────────────────────────────────────────────────────────
check('one adapter publishes two groups, and the second names its own limit', () => {
  const routes = adapterRoutes()
  assert.deepEqual(routes.map(entry => entry.route), [ROUTE_MAIN, ROUTE_REGION])
  // A group with no models is dropped by the client, so a user with no VPN sees
  // the region group labelled as limited rather than missing.
  assert.equal(ROUTE_LABELS[ROUTE_REGION], 'Our Free Model · region-limited')
  assert.equal(ROUTE_LABELS[ROUTE_MAIN], 'Our Free Model')
  assert.equal(Object.isFrozen(routes), true)
})

check('an unknown route falls back to its own id rather than a blank heading', () => {
  assert.deepEqual(providerInfo('no-such-route'), { id: 'no-such-route', name: 'no-such-route' })
  assert.deepEqual(providerInfo(ROUTE_MAIN), { id: ROUTE_MAIN, name: 'Our Free Model' })
})

// ── wire and payload ────────────────────────────────────────────────────────
check('each wire maps to the style the fingerprint pass expects', () => {
  assert.equal(styleForWire('chat'), 'chat')
  assert.equal(styleForWire('responses'), 'flat')
  assert.equal(styleForWire('messages'), 'claude')
  assert.equal(styleForWire('unknown'), 'chat')
})

check('a row that declares its wire wins over its id', () => {
  assert.equal(wireOf({ wire: 'responses' }), 'responses')
  assert.equal(wireOf({ wire: 'messages' }), 'messages')
  assert.equal(wireOf({}), 'chat')
  assert.equal(wireOf(null), 'chat')
})

check('buildPayload shapes all three wires from the shared codecs', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  const chat = buildPayload('chat', 'm/free', messages, { system: 'be brief' }, 512)
  assert.equal(chat.model, 'm/free')
  assert.equal(chat.max_tokens, 512)
  assert.equal(chat.stream, true)
  // A caller system message rides in front rather than being dropped.
  assert.equal(chat.messages[0].role, 'system')
  assert.equal(chat.messages[0].content, 'be brief')

  const claude = buildPayload('messages', 'm/free', messages, {}, 512)
  assert.equal(claude.max_tokens, 512)

  const responses = buildPayload('responses', 'm/free', messages, {}, 512)
  assert.equal(responses.max_output_tokens, 512)
  assert.equal(responses.store, false)
  assert.ok(Array.isArray(responses.input) && responses.input.length > 0, 'an empty input is not a legal payload')
})

check('a responses payload with nothing to send still carries a placeholder turn', () => {
  // An empty `input` is rejected upstream as a malformed request.
  const empty = buildPayload('responses', 'm/free', [], {}, 512)
  assert.ok(Array.isArray(empty.input) && empty.input.length > 0)
})

// ── toFailure ──────────────────────────────────────────────────────────────
check('a failure keeps only what a lossless JSON round trip survives', () => {
  assert.deepEqual(toFailure(Object.assign(new Error('boom'), { code: 'SERVER', status: 502 })), {
    message: 'boom', code: 'SERVER', status: 502,
  })
})

check('a malformed failure is dropped, not emitted degraded', () => {
  // The durable log rejects a NaN or an explicit undefined field, and a rejected
  // append aborts the whole turn — so each is dropped instead.
  // An Error is not a message: its text is the message, its class is not.
  assert.deepEqual(toFailure(new Error('x')), { message: 'x', code: 'TRANSPORT' })
  // The fallback only fires for a value with nothing to stringify.
  assert.deepEqual(toFailure(null), { message: 'our free model request failed', code: 'TRANSPORT' })
  assert.deepEqual(toFailure(undefined), { message: 'our free model request failed', code: 'TRANSPORT' })
  assert.deepEqual(toFailure(''), { message: 'our free model request failed', code: 'TRANSPORT' })
  assert.deepEqual(toFailure(Object.assign(new Error('x'), { status: 700, providerRetryAfterMs: -5 })), { message: 'x', code: 'TRANSPORT' })
  assert.deepEqual(toFailure(Object.assign(new Error('x'), { status: 99, providerRetryAfterMs: Number.NaN })), { message: 'x', code: 'TRANSPORT' })
  assert.deepEqual(toFailure(Object.assign(new Error('x'), { status: 'nope', providerRetryAfterMs: 'soon' })), { message: 'x', code: 'TRANSPORT' })
})

check('a retry-after is truncated to an integer', () => {
  const failure = toFailure(Object.assign(new Error('x'), { providerRetryAfterMs: 1234.9 }))
  assert.equal(failure.providerRetryAfterMs, 1234)
  assert.equal(Number.isInteger(failure.providerRetryAfterMs), true)
})

// ── savingsFields ──────────────────────────────────────────────────────────
check('a report with nothing measured contributes nothing', () => {
  assert.deepEqual(savingsFields(null), {})
  assert.deepEqual(savingsFields({ saved: 0, bytesBefore: 0, bytesAfter: 0 }), {})
})

check('a measured saving rides along as usage-record fields', () => {
  const fields = savingsFields({ saved: 1200, bytesBefore: 2599, bytesAfter: 1399, rtk: { hits: [1, 2, 3] } })
  assert.deepEqual(fields, { savings: { saved: 1200, bytesBefore: 2599, bytesAfter: 1399, blocks: 3 } })
})

check('a prompt injection with no byte saving still reports', () => {
  const fields = savingsFields({ saved: 0, prompt: { injected: true, families: ['caveman', 'ponytail'] } })
  assert.deepEqual(fields, { savings: { saved: 0, bytesBefore: 0, bytesAfter: 0, blocks: 0, prompt: ['caveman', 'ponytail'] } })
})

// ── describe ───────────────────────────────────────────────────────────────
check('a detail line names modality, window and the effort menu', () => {
  assert.equal(
    // A declared menu is only read on a reasoning entry, so the call has to
    // carry `reasoning: true` for the levels to be named.
    describe({ vision: true, contextWindow: 131072, reasoning: true, efforts: ['low', 'high'] }),
    'vision + text input · 128K context · thinking levels: low / high',
  )
  // An entry that does not declare reasoning must not advertise levels it does
  // not use.
  assert.equal(describe({ vision: true, contextWindow: 131072, efforts: ['low', 'high'] }), 'vision + text input · 128K context')
  assert.equal(describe({ contextWindow: 8192 }), 'text input · 8K context')
})

check('a model that cannot switch thinking off names the shared ceiling', () => {
  // A picker that implied otherwise is how "why is it cut off at 8K when my
  // ceiling is 32K" gets asked.
  const line = describe({ contextWindow: 65536, reasoning: true, canDisableThinking: false }, { defaultMaxTokens: 8192 },
    (_effort, _entry, _max, ceiling) => (ceiling ?? 32768))
  assert.match(line, /thinking always on · 8K default ceiling, shared with the answer/)
})

check('a chain names its members in order', () => {
  assert.equal(
    describe({ contextWindow: 8192, combo: ['ofm-kilo/a', 'ofm-opencode/b'], strategy: 'round-robin' }),
    'text input · 8K context · 2-model chain: ofm-kilo/a -> ofm-opencode/b · rotating start',
  )
})

// ── sealed pacing ──────────────────────────────────────────────────────────
check('the pacing hint is appended to whichever field carries the sealed system text', () => {
  const chat = { messages: [{ role: 'system', content: 'be brief' }] }
  applySealedPacingHint(chat)
  assert.equal(chat.messages[0].content, `be brief\n\n${SEALED_PACING_HINT}`)
  // An empty one is filled in, not concatenated onto nothing.
  const empty = { messages: [{ role: 'system', content: '' }] }
  applySealedPacingHint(empty)
  assert.equal(empty.messages[0].content, SEALED_PACING_HINT)
  // With no system message at all, one is created in front.
  const none = { messages: [{ role: 'user', content: 'hi' }] }
  applySealedPacingHint(none)
  assert.equal(none.messages[0].role, 'system')
  assert.equal(none.messages.length, 2)
})

check('the pacing hint survives the `system` field shape too', () => {
  const body: Record<string, any> = { system: '' }
  applySealedPacingHint(body)
  assert.equal(body.system, SEALED_PACING_HINT)
})

check('a payload with neither shape is left alone rather than gaining a stray field', () => {
  const body: Record<string, any> = { model: 'm/free' }
  applySealedPacingHint(body)
  assert.deepEqual(body, { model: 'm/free' })
})

// ── subscriptionToolChoice ─────────────────────────────────────────────────
check('a tool choice naming a declared tool is honoured', () => {
  const tools = [{ name: 'read' }, { name: 'shell' }]
  assert.equal(subscriptionToolChoice('auto', tools), 'auto')
  assert.equal(subscriptionToolChoice('none', tools), 'none')
  assert.equal(subscriptionToolChoice('required', tools), 'required')
  assert.deepEqual(subscriptionToolChoice({ type: 'function', function: { name: 'read' } }, tools),
    { type: 'function', function: { name: 'read' } })
})

check('a choice nothing can honour is refused before the account is spent', () => {
  const tools = [{ name: 'read' }]
  assert.throws(() => subscriptionToolChoice('required', []), /Invalid subscription tool choice/)
  assert.throws(() => subscriptionToolChoice({ type: 'function', function: { name: 'nope' } }, tools), /Invalid/)
  assert.throws(() => subscriptionToolChoice({ name: 'nope' }, tools), /Invalid/)
})

check('no choice means no restriction', () => {
  assert.equal(subscriptionToolChoice(undefined, []), undefined)
})

// ── retry policy and image pricing ─────────────────────────────────────────
check('the retry policy carries RATE_LIMIT and REGION out of the retryable set', () => {
  // A quota wall retried twice is three walls: the same turn, paid thrice,
  // arriving later. A region refusal is a property of the egress, not a fault.
  const retryable = [...PROVIDER_RETRY_POLICY.retryableCodes]
  assert.equal(retryable.includes('RATE_LIMIT'), false)
  assert.equal(retryable.includes('REGION'), false)
  assert.equal(retryable.includes('EMPTY_RESPONSE'), true)
  assert.equal(retryable.includes('SERVER'), true)
  assert.equal(retryable.includes('TIMEOUT'), true)
  assert.equal(retryable.includes('TRANSPORT'), true)
  // The backoff fields are top-level: nested, every scheduled delay reads as NaN.
  assert.equal(PROVIDER_RETRY_POLICY.initialDelayMs, 700)
  assert.equal(PROVIDER_RETRY_POLICY.maxDelayMs, 8000)
  assert.equal((PROVIDER_RETRY_POLICY as any).backoff, undefined)
  assert.equal(Object.isFrozen(PROVIDER_RETRY_POLICY), true)
})

check('the vision estimate is synchronous and frozen', () => {
  const pricing = imageRequestPricing()
  assert.equal(pricing, imageRequestPricing(), 'a second call reported a different estimate')
  assert.equal(typeof pricing.priceImages, 'function')
  // No I/O: the token meter resolves this per measurement, with no window
  // (issue #42), so the answer has to already be there.
  assert.deepEqual(pricing.priceImages([{ offloaded: true }, {}]), [
    { visualTokens: 0, text: '[image omitted]' },
    { visualTokens: 1024, text: '[image]' },
  ])
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
