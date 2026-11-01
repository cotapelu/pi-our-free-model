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

/** How long a stream may go without a `data:`-bearing chunk. 0 disables. */
const IDLE_MS = Number(process.env.OFM_STREAM_IDLE_MS ?? 300_000)

/** The DeepSeek v4 family leaks DSML control tokens into visible content. */
const DSML_OPENING = '<｜DSML｜'
const DSML_TAG = /<｜DSML｜[^>]*>/g

/**
 * Forward `inner`, renaming tool calls back from the fingerprint aliases.
 *
 * The request side renamed the caller's own `read` tool out of the gate slot;
 * the model answered under that alias, and the transcript, the tool registry and
 * the user all speak the original name. The `partial` message is the object pi
 * finalises, so both the event and its block are rewritten.
 */
export function restoreAliases(inner, aliases, { onEvent, scrubDsml = false } = {}) {
  const outer = createAssistantMessageEventStream()
  const scrubber = scrubDsml ? createDsmlScrubber() : null
  let lastText = null
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
          event.delta = scrubber.push(event.delta)
        }
        outer.push(translateError(event))
        onEvent?.(event)
      }
      // A held tail that never resolved into a markup opening is spare text; it
      // rides the last text block, the only one that can carry it.
      if (scrubber !== null && lastText !== null) {
        const tail = scrubber.flush()
        if (tail !== '') {
          lastText.delta = `${lastText.delta ?? ''}${tail}`
          const block = lastText.partial?.content?.[lastText.contentIndex]
          if (block?.type === 'text') block.text += tail
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

/**
 * Scrub `<｜DSML｜…>` from a text stream, holding a tail that could still grow
 * into an opening until the next delta resolves it (ported from src/stream.js).
 */
function createDsmlScrubber() {
  let held = ''
  return {
    push(delta) {
      let text = held + delta
      held = ''
      const cut = text.lastIndexOf('<')
      if (cut !== -1) {
        const tail = text.slice(cut)
        if (DSML_OPENING.startsWith(tail) || (tail.startsWith(DSML_OPENING) && !tail.includes('>'))) {
          held = tail
          text = text.slice(0, cut)
        }
      }
      return text.replace(DSML_TAG, '')
    },
    flush() {
      const out = held
      held = ''
      if (out === '' || DSML_OPENING.startsWith(out) || (out.startsWith(DSML_OPENING) && !out.includes('>'))) return ''
      return out.replace(DSML_TAG, '')
    },
  }
}

function errorMessageOf(error) {
  return {
    role: 'assistant',
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
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

export function friendlyMessage(message) {
  if (/FreeTierError/i.test(message)) {
    return 'upstream refused the free lane: the client fingerprint no longer matches (the gateway tightened its gate). Update this extension; the lane needs no key, so nothing on your side is wrong.'
  }
  if (/FreeUsageLimitError|429|usage limit|rate limit/i.test(message)) {
    return 'free quota for this egress is spent (429). The lane meters per session/IP; wait for the reset, change egress, or fall back to another lane/model.'
  }
  if (/RegionError|not available in your country/i.test(message) || (/region/i.test(message) && /403|forbidden/i.test(message))) {
    return 'upstream blocks this model for this egress region (403). Route the request through a proxy (NODE_USE_ENV_PROXY=1 with HTTPS_PROXY) and retry.'
  }
  if (/HTML error page/i.test(message) || /^\s*<(!doctype|html[\s>])/i.test(message)) {
    return 'the gateway\'s front proxy answered with an HTML error page — usually a WAF or a body-size limit in front of the gateway; if this hit a long conversation, its request size is the likely trigger.'
  }
  if (/Model is unavailable|ModelError/i.test(message)) {
    return 'the gateway no longer routes this model id on the free pool; pick another model.'
  }
  if (/INVALID_TOKEN|authentication_required/i.test(message)) {
    return 'the gateway refused the request\'s credentials — this lane is keyless, so this means the request carried a token it should not have; update the extension.'
  }
  if (/signature rejected|signature mismatch/i.test(message)) {
    return 'the gateway rejected the request signature — the request body was modified in transit; if a local proxy plugin is installed, disable it for this lane.'
  }
  return null
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
 * buffered and sniffed:
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
    // Not labelled SSE: buffer and let the body say what it is.
    const text = await response.text().catch(() => '')
    const shape = sniffBody(text)
    if (shape === 'sse') return sseResponse(text, response.status, response.headers)
    if (shape === 'json') return sseResponse(foldToSse(text), response.status, response.headers)
    if (shape === 'empty') throw new Error('the gateway answered 200 with an empty body; the request produced no stream')
    throw new Error(friendlyMessage(text) ?? `the gateway answered 200 with a non-stream body: ${text.slice(0, 200)}`)
  }
}

/** Re-wrap buffered body bytes as an SSE response, keeping status and headers. */
function sseResponse(text, status, headers) {
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
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
function foldToSse(text) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return `data: ${text.trim()}\n\ndata: [DONE]\n\n`
  }
  const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`
  const frames = []
  const choices = Array.isArray(document?.choices) ? document.choices : []
  for (const [index, choice] of choices.entries()) {
    const message = choice?.message ?? choice?.delta ?? {}
    const delta = {}
    if (index === 0 && message.role !== undefined) delta.role = message.role
    if (typeof message.content === 'string' && message.content !== '') delta.content = message.content
    if (message.reasoning_content !== undefined && message.reasoning_content !== null && message.reasoning_content !== '') delta.reasoning_content = message.reasoning_content
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      delta.tool_calls = message.tool_calls.map((call, position) => ({
        index: position,
        id: call?.id,
        type: 'function',
        function: { name: call?.function?.name ?? call?.name ?? '', arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? call?.arguments ?? {}) },
      }))
    }
    if (Object.keys(delta).length > 0 || index === 0) frames.push(frame({ id: document?.id, object: 'chat.completion.chunk', choices: [{ index, delta, finish_reason: null }] }))
    if (choice?.finish_reason !== undefined && choice?.finish_reason !== null) {
      frames.push(frame({ id: document?.id, object: 'chat.completion.chunk', choices: [{ index, delta: {}, finish_reason: choice.finish_reason }] }))
    }
  }
  if (document?.usage !== undefined && document.usage !== null) {
    frames.push(frame({ id: document?.id, object: 'chat.completion.chunk', choices: [], usage: document.usage }))
  }
  frames.push('data: [DONE]\n\n')
  return frames.join('')
}

/** Classify the beginning of a body by shape (ported from src/http.js). */
export function sniffBody(text) {
  const head = String(text ?? '').replace(/^﻿/, '').trimStart()
  if (head === '') return 'empty'
  if (head.startsWith(':') || /^(?:data|event|id|retry)[ \t]*:/m.test(head.slice(0, 64))) return 'sse'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'unknown'
}

/**
 * Idle watchdog for a response body: each chunk that carries a `data:` line
 * resets the deadline; keepalive comments do not, exactly as dsh's reader does —
 * otherwise a gateway that pings every 15s keeps a wedged, token-less turn alive
 * indefinitely. Disabled with OFM_STREAM_IDLE_MS=0.
 */
export function withIdleTimeout(body, ms = IDLE_MS) {
  if (!(ms > 0) || body === null || body === undefined) return body
  const reader = body.getReader()
  const decoder = new TextDecoder()
  // One deadline across the whole body: a chunk that only carries keepalive
  // comment lines does not move it, so a pinging-but-mute gateway still dies.
  let deadline = Date.now() + ms
  return new ReadableStream({
    async pull(controller) {
      let timer
      try {
        const row = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reader.cancel().catch(() => {})
              reject(new Error(`upstream stream went idle past ${ms}ms without a data frame; the turn was cut`))
            }, Math.max(0, deadline - Date.now()))
            timer.unref?.()
          }),
        ])
        if (row.done === true) {
          controller.close()
          return
        }
        if (decoder.decode(row.value, { stream: true }).includes('data:')) deadline = Date.now() + ms
        controller.enqueue(row.value)
      } catch (error) {
        controller.error(error)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })
}

/** The session seed for one turn: pi's session id when it has one. */
export function sessionSeedOf(options) {
  const id = options?.sessionId
  return typeof id === 'string' && id.trim() ? id.trim() : 'global'
}

/** Rotate the mapped upstream session after a spent session. */
export function rotateOnQuota(event, seed) {
  if (isQuotaExhausted(event)) rotateSession(seed)
}
