/**
 * Shared plumbing for the two keyless lanes: response-side alias restoration,
 * upstream error translation, and the transport guards both lanes need because
 * they speak to gateways that are not strict OpenAI servers:
 *
 *   - the body's shape decides how it is read, not `Content-Type` — these
 *     gateways are observed answering 200 with a JSON content-type over a full
 *     SSE frame stream, *and* answering a stream request with one JSON document,
 *     which the OpenAI SDK silently drops as "no SSE lines" and hands back as an
 *     empty turn (the dsh plugin learned this the hard way: issue #6);
 *   - a stream that sends keepalive comments and then nothing must die on a
 *     deadline instead of holding the turn open (dsh: issue #460);
 *   - DeepSeek v4 sometimes leaks `<｜DSML｜…>` control markup into visible text.
 *
 * @module pi-extension/lane.js
 */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat'
import { rotateSession } from './fingerprint.js'
import { createDsmlScrubber, foldToSse, friendlyMessage, readHead, readRemainder, replayStream, sniffBody, SNIFF_BYTES, transportCause, withIdleTimeout } from './transport.js'

/** How long a stream may go without a `data:`-bearing chunk. 0 disables. */
const IDLE_MS = Number(process.env.OFM_STREAM_IDLE_MS ?? 300_000)

/**
 * Forward `inner`, renaming tool calls back from the fingerprint aliases.
 *
 * The request side renamed the caller's own `read` tool out of the gate slot;
 * the model answered under that alias, and the transcript, the tool registry and
 * the user all speak the original name. The `partial` message is the object pi
 * finalises, so both the event and its block are rewritten.
 */
export function restoreAliases(inner: any, aliases: any, { onEvent, scrubDsml = false }: { onEvent?: (event: any) => void; scrubDsml?: boolean } = {}) {
  const outer = createAssistantMessageEventStream()
  const scrubber = scrubDsml ? createDsmlScrubber() : null
  let lastText = null
  // The provider appends every delta to the message's text block as it goes,
  // and it can be ahead of this wrapper (the SDK pushes without waiting for us),
  // so the block is written from this accumulator rather than by editing out a
  // suffix: `block.text = cleanSoFar` is right however much the SDK has appended.
  let cleanSoFar = ''
  ;(async () => {
    try {
      for await (const event of inner) {
        if (aliases && aliases.size > 0 && typeof event?.type === 'string' && event.type.startsWith('toolcall')) {
          const block = event.partial?.content?.[event.contentIndex]
          if (block && aliases.has(block.name)) block.name = aliases.get(block.name)
          if (event.toolCall?.name && aliases.has(event.toolCall.name)) event.toolCall.name = aliases.get(event.toolCall.name)
        }
        if (scrubber !== null && event?.type === 'text_delta' && typeof event.delta === 'string') {
          lastText = event
          const raw = event.delta
          const scrubbed = scrubber.push(raw)
          cleanSoFar += scrubbed
          event.delta = scrubbed
          const block = event.partial?.content?.[event.contentIndex]
          if (block?.type === 'text') block.text = cleanSoFar
        }
        outer.push(translateError(event))
        onEvent?.(event)
      }
      // A held tail that never resolved into a markup opening is spare text; it
      // rides the last text block, the only one that can carry it.
      if (scrubber !== null && lastText !== null) {
        const tail = scrubber.flush()
        if (tail !== '') {
          cleanSoFar += tail
          lastText.delta = `${lastText.delta ?? ''}${tail}`
          const block = lastText.partial?.content?.[lastText.contentIndex]
          if (block?.type === 'text') block.text = cleanSoFar
        }
      }
      outer.end()
    } catch (error) {
      outer.push({ type: 'error', reason: 'error', error: errorMessageOf(error) })
      outer.end()
    }
  })()
  return outer
}


function errorMessageOf(error: unknown): any {
  return {
    role: 'assistant',
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error',
    // A transport failure reads "fetch failed" with no reason; walk the cause
    // chain so the socket fact (ENOTFOUND, ECONNRESET, TLS) reaches the user.
    errorMessage: `${error instanceof Error ? error.message : String(error)}${transportCause(error)}`,
    timestamp: Date.now(),
  }
}

/**
 * Translate the free lanes' own failure vocabulary into something actionable.
 * The gateways name their refusals inside the body, and pi's error formatting
 * already stringified that body into `errorMessage`; a bare `HTTP 403` tells the
 * user nothing.
 */
export function translateError(event) {
  if (event?.type !== 'error') return event
  const message = String(event.error?.errorMessage ?? '')
  const rewritten = friendlyMessage(message)
  if (rewritten !== null && event.error) event.error.errorMessage = rewritten
  return event
}


/** True when the stream ended on the free lane's quota error. */
export function isQuotaExhausted(event) {
  return event?.type === 'error' && /FreeUsageLimitError|429|usage limit/i.test(String(event.error?.errorMessage ?? ''))
}

/**
 * Compose fetch wrappers around a base fetch, innermost last:
 * `composeFetches(base, a, b)` runs `a` around `b` around `base`. Each wrapper
 * has the shape `next => (input, init)` and returns the innermost `fetch` when
 * no wrapper is given.
 */
export function composeFetches(base = fetch, ...wrappers) {
  const list = wrappers.filter((wrap) => typeof wrap === 'function').reverse()
  let next = typeof base === 'function' ? base : fetch
  for (const wrap of list) next = wrap(next)
  return next
}

/**
 * Fetch wrapper that removes a header the lane must not send.
 *
 * Kilo's free pool answers only when the request carries no credential: a
 * placeholder token is a `401 INVALID_TOKEN` there, so the SDK's Authorization
 * header is dropped on the way out and everything else is left untouched.
 */
export function fetchWithoutHeader(header, baseFetch = fetch) {
  const name = header.toLowerCase()
  return (next) => (input, init) => {
    if (typeof input === 'string') {
      const headers = new Headers(init?.headers)
      headers.delete(name)
      return next(input, { ...init, headers })
    }
    const headers = new Headers(input.headers)
    headers.delete(name)
    return next(new Request(input, { headers }))
  }
}

/**
 * Transport guard: read the body by shape, never by `Content-Type`.
 *
 * A response that is not already SSE (and is not an error — those carry the
 * gateway's own envelope and must reach the SDK's error path verbatim) is
 * sniffed by head, not buffered:
 *   - SSE frames with a wrong content-type are re-wrapped unchanged, so the
 *     turn survives the gateway's mislabelling;
 *   - one JSON document answering a stream request is folded into a single SSE
 *     event, which is what the SDK can parse;
 *   - markup or an empty body becomes a typed error instead of a silent empty
 *     turn.
 */
export function sseGuard(next) {
  return async (input, init) => {
    const response = await next(input, init)
    if (!response.ok || response.body === null) return response
    const guarded = (stream) => {
      const body = withIdleTimeout(stream, IDLE_MS)
      return body === stream ? response : new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    const type = String(response.headers.get('content-type') ?? '').toLowerCase()
    if (type.includes('text/event-stream')) return guarded(response.body)
    // Not labelled SSE: sniff only a head, so a live SSE stream is not buffered
    // to its end before the first token (issue #6). The head bytes are replayed
    // in front of the still-live reader; a non-stream body is finished and read.
    const head = await readHead(response.body, SNIFF_BYTES, { signal: init?.signal, timeoutMs: IDLE_MS })
    const shape = sniffBody(head.text)
    if (shape === 'sse') return sseResponse(replayStream(head), response.status, response.headers)
    const text = head.done ? head.text : await readRemainder(head)
    if (shape === 'json') return sseResponse(foldToSse(text), response.status, response.headers)
    if (shape === 'empty') throw new Error('the gateway answered 200 with an empty body; the request produced no stream')
    throw new Error(friendlyMessage(text) ?? `the gateway answered 200 with a non-stream body: ${text.slice(0, 200)}`)
  }
}

/**
 * Re-wrap a body as an SSE response, keeping status and headers: a whole text
 * (the JSON fold) is emitted as one chunk, a `ReadableStream` (the replayed
 * mislabelled SSE) is passed through so its later bytes keep streaming.
 */
function sseResponse(source, status, headers) {
  const stream = typeof source === 'string'
    ? new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source))
        controller.close()
      },
    })
    : source
  const next = new Headers(headers)
  next.set('content-type', 'text/event-stream')
  next.delete('content-length')
  return new Response(withIdleTimeout(stream, IDLE_MS), { status, headers: next })
}

/**
 * Fold one complete Chat-Completion document into the SSE frame sequence the
 * OpenAI SDK can read.
 *
 * A gateway that answers a *stream* request with the whole document at once is
 * not speaking the dialect the SDK's decoder expects: it reads `choices[].delta`
 * frames, and the document carries `choices[].message`. Re-emitting it as
 * role/content/finish/usage chunks keeps the turn — and its usage accounting —
 * instead of silently dropping the body as "no SSE lines".
 */

/** Classify the beginning of a body by shape (ported from src/http.js). */

/**
 * Idle watchdog for a response body: each chunk that carries a `data:` line
 * resets the deadline; keepalive comments do not, exactly as dsh's reader does —
 * otherwise a gateway that pings every 15s keeps a wedged, token-less turn alive
 * indefinitely. Disabled with OFM_STREAM_IDLE_MS=0.
 */

/** The session seed for one turn: pi's session id when it has one. */
export function sessionSeedOf(options) {
  const id = options?.sessionId
  return typeof id === 'string' && id.trim() ? id.trim() : 'global'
}

/** Rotate the mapped upstream session after a spent session. */
export function rotateOnQuota(event, seed) {
  if (isQuotaExhausted(event)) rotateSession(seed)
}
