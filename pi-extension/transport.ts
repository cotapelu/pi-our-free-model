/**
 * The dependency-free half of the lane transport: body-shape sniffing and
 * folding, the idle watchdog, the DSML scrubber, and the error copy.
 *
 * Extracted from `lane.js` so it can be tested without pi's host packages —
 * these are the guards the gateways force on us, and every one of them had a
 * bug report behind it in the plugin this port follows (issue #6 for the
 * mislabelled/non-stream body, #460 for the mute-but-pinging stream, and the
 * DSML leak observed on DeepSeek v4). None of them may depend on a provider.
 *
 * @module pi-extension/transport.js
 */

/** DeepSeek v4 sometimes leaks DSML control markup into visible text. */
const DSML_OPENING = '<｜DSML｜'
const DSML_TAG = /<｜DSML｜[^>]*>/g

/** Scrub `<｜DSML｜…>` from a text stream, holding a tail that could still grow. */
export function createDsmlScrubber() {
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

/** Classify the beginning of a body by shape (ported from src/http.js). */
export function sniffBody(text) {
  const head = String(text ?? '').replace(/^﻿/, '').trimStart()
  if (head === '') return 'empty'
  if (head.startsWith(':') || /^(?:data|event|id|retry)[ \t]*:/m.test(head.slice(0, 64))) return 'sse'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'unknown'
}

/**
 * Fold one complete Chat-Completion document into the SSE frame sequence the
 * OpenAI SDK can read: the SDK reads `choices[].delta` frames, and a gateway
 * that answers a *stream* request with the whole document carries
 * `choices[].message`, which the decoder drops as "no SSE lines".
 */
export function foldToSse(text) {
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
    const delta: any = {}
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

/** How many bytes to look at before deciding what the body is (ported from src/http.js). */
export const SNIFF_BYTES = 4096

/** The abort error shape a cancelled read is rejected with. */
function abortError() {
  return Object.assign(new Error('the request was aborted'), { name: 'AbortError' })
}

/**
 * Read only the head of a body — enough to know its shape — without consuming
 * the rest, so a live stream is never buffered to its end before the first
 * token (dsh issue #6). Stops as soon as the head says it is SSE; otherwise the
 * caller finishes the small remainder with `readRemainder`. One deadline spans
 * the whole head and the caller's abort is honoured, so a connection that
 * accepts the request but never sends a byte cannot hang the turn here, before
 * any watchdog exists.
 *
 * Returns the reader that follows the head, the chunks already read, and the
 * decoded head text — the pieces `replayStream` stitches back into one stream.
 */
export async function readHead(stream, limit = SNIFF_BYTES, { signal, timeoutMs = 30000 }: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let size = 0
  let text = ''
  let done = false
  const deadline = Date.now() + timeoutMs
  try {
    while (size < limit) {
      if (signal?.aborted === true) throw abortError()
      let timer
      let onAbort
      const halted = new Promise((_, reject) => {
        onAbort = () => reject(abortError())
        signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => reject(new Error(`the gateway sent no bytes before its head deadline (${timeoutMs}ms)`)), Math.max(0, deadline - Date.now()))
        timer.unref?.()
      })
      let row
      try {
        row = await Promise.race([reader.read(), halted])
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      if (row.done === true) { done = true; break }
      if (row.value !== undefined) {
        chunks.push(row.value)
        size += row.value.byteLength ?? 0
        text += decoder.decode(row.value, { stream: true })
      }
      if (sniffBody(text) === 'sse') break
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return { reader, chunks, done, text, decoder }
}

/**
 * Stitch a head that was already read back onto the reader that follows it, as
 * one byte stream: the buffered head bytes first, then the still-live reader.
 * This is what keeps a mislabelled-SSE turn streaming — only the head spent
 * deciding the shape is replayed; every later byte flows as it arrives.
 */
export function replayStream(head) {
  const cancelled = { value: false }
  return new ReadableStream({
    start(controller) {
      try {
        for (const chunk of head.chunks) {
          if (cancelled.value) return
          controller.enqueue(chunk)
        }
        if (head.done) controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    async pull(controller) {
      if (head.done) { controller.close(); return }
      try {
        const row = await head.reader.read()
        if (row.done) { controller.close(); return }
        if (row.value !== undefined) controller.enqueue(row.value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      cancelled.value = true
      if (!head.done) head.reader.cancel(reason).catch(() => {})
    },
  })
}

/** Finish a body that turned out not to be a stream, continuing the head decoder so a character split over the boundary still decodes. */
export async function readRemainder(head) {
  let text = head.text
  try {
    while (head.done !== true) {
      const row = await head.reader.read()
      if (row.done === true) break
      if (row.value !== undefined) text += head.decoder.decode(row.value, { stream: true })
    }
  } catch (error) {
    await head.reader.cancel().catch(() => {})
    throw error
  }
  return text + head.decoder.decode()
}

/**
 * Idle watchdog for a response body.
 *
 * One deadline spans the whole body, and only a chunk that carries a `data:`
 * line moves it: a gateway that sends keepalive comment lines every few seconds
 * must not keep a wedged, token-less turn alive (dsh issue #460). Returns the
 * same stream when the watchdog is off, so the caller can pass it straight
 * through.
 */
export function withIdleTimeout(body, ms) {
  if (!(ms > 0) || body === null || body === undefined) return body
  const reader = body.getReader()
  const decoder = new TextDecoder()
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

/**
 * The two lanes' failure vocabulary, in words the user can act on. The
 * gateways name their refusals inside the body and pi's error formatting
 * stringifies that body into `errorMessage`; a bare `HTTP 403` tells nobody
 * anything.
 */
export function friendlyMessage(message) {
  if (/FreeTierError/i.test(message)) {
    return 'upstream refused the free lane: the client fingerprint no longer matches (the gateway tightened its gate). Update this extension; the lane needs no key, so nothing on your side is wrong.'
  }
  if (/FreeUsageLimitError|429|usage limit|rate limit/i.test(message)) {
    // The upstream's own discriminator stays in the text on purpose: pi-ai reads
    // `FreeUsageLimitError` as a non-retryable account limit, and rewriting it
    // into a bare "429" would put quota walls into the retryable set — the same
    // turn, paid three times, arriving later.
    return 'free quota for this egress is spent (429 FreeUsageLimitError). The lane meters per session/IP; wait for the reset, change egress, or fall back to another lane/model.'
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

/**
 * The socket-level fact behind a transport failure, walked off the error's
 * `cause` chain (ported from src/http.js).
 *
 * Node's fetch collapses every DNS, TCP and TLS refusal into `TypeError: fetch
 * failed`; the reason a user could act on — the ENOTFOUND, the ECONNRESET, the
 * certificate alert — lives one or two `cause` links deeper. Walk at most three
 * links, deduplicate, and append so a bare "fetch failed" reads "fetch failed —
 * getaddrinfo ENOTFOUND opencode.ai". Returns '' when the chain names nothing.
 */
export function transportCause(error) {
  const parts = []
  let node = error
  for (let depth = 0; depth < 3 && node?.cause !== undefined; depth += 1) {
    node = node.cause
    if (node === null || typeof node !== 'object') break
    const code = typeof node.code === 'string' && node.code !== '' ? node.code : ''
    const line = typeof node.message === 'string' ? node.message.split('\n')[0].trim() : ''
    if (line === '' && code === '') continue
    const fact = line === '' || line.includes(code) ? (line === '' ? code : line) : `${line} (${code})`
    if (!parts.includes(fact)) parts.push(fact)
  }
  return parts.length > 0 ? ` — ${parts.join('; ')}` : ''
}
