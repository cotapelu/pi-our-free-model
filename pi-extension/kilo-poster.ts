/**
 * The Kilo lane's raw poster, with no `pi-ai` in its import graph.
 *
 * `kilo.ts` drives pi's completions API (the extension entry) and therefore
 * imports `@earendil-works/pi-ai/compat`; the service entries need only the
 * lane-level POST — one request, SSE frames handed to `onData`, refusals
 * classified the way the other lanes' are. Keeping that half here is what makes
 * `packages/standalone/` self-contained: the standalone service's module graph
 * must not reach the extension's provider SDK, or a staged copy of it would need
 * `node_modules` beside it.
 *
 * Ported from dsh's `src/kilo.js`.
 *
 * @module pi-extension/kilo-poster.js
 */

import { SNIFF_BYTES, sniffBody, readHead, readSse, replayStream, transportCause } from './transport.js'
import { KILO_BASE } from './catalog.js'
import { CODE, UpstreamError, classifyFailure, classifyStreamFailure } from './core/upstream.js'

/**
 * One Kilo turn as a raw SSE stream, the shape the service runtime's adapter
 * drives (`onData` per frame, no pi in the loop).
 *
 * `streamKilo` above is the extension's entry: it runs the turn through pi's
 * completions API because that is the contract `pi.registerProvider` speaks.
 * The service entries need the *lane-level* poster instead — one POST whose
 * frames are classified the same way the other lanes' are — so this is the
 * missing half of `src/kilo.js`, ported next to the lane it belongs to.
 *
 * A gateway that answers a stream request with one JSON document is folded into
 * a single payload for the reader, as the other lanes' posters do.
 *
 * Ported from dsh's `src/kilo.js`.
 *
 * @module pi-extension/kilo.js
 */


const TURN_TIMEOUT_MS = 300000

/** One listing round: `GET {base}/models`. Returns the parsed JSON document. */
export async function postKiloStreamed({ body, signal, onData, timeoutMs = TURN_TIMEOUT_MS }: {
  body: any
  signal?: AbortSignal
  onData: (payload: string) => void
  timeoutMs?: number
}): Promise<{ status: number }> {
  let response: Response
  try {
    response = await fetch(`${KILO_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': 'our-free-model' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || (error as Error)?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`model request failed: ${(error as Error)?.message ?? error}${transportCause(error)}`, CODE.transport)
  }

  // `Retry-After` is seconds on the wire and milliseconds in the classified
  // failure — the other lanes' posters convert before classifying, so does this.
  const retrySeconds = Number(response.headers.get('retry-after'))
  const setRetry = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.trunc(retrySeconds * 1000) : undefined
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw classifyKilo(response.status, text, setRetry)
  }
  if (response.body === null) throw new UpstreamError('model stream returned no body', CODE.empty)

  const head = await readHead(response.body, SNIFF_BYTES, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('model stream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head) as never, onData, signal, timeoutMs)
    return { status: response.status }
  }

  // A gateway that answered a stream request with one JSON document: fold the
  // whole answer into a single payload for the reader, as the other lanes do.
  let text = head.text
  if (!head.done) {
    try {
      while (true) {
        const row = await (head as any).reader.read()
        if (row.done) break
        if (row.value !== undefined) text += (head as any).decoder.decode(row.value, { stream: true })
      }
    } catch (error) {
      await (head as any).reader.cancel().catch(() => {})
      throw classifyStreamFailure(error, signal)
    }
  }
  text += (head as any).decoder.decode()
  let payload: any
  try { payload = JSON.parse(text) } catch {
    throw new UpstreamError(`unexpected non-stream response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload.error) throw classifyKilo(response.status, text, setRetry)
  onData(JSON.stringify(payload))
  return { status: response.status }
}

/**
 * Classify one of this gateway's refusals.
 *
 * The envelope names its class twice — `error.code` inside the error object and
 * `error_type` beside it — while the shared classifier reads `error.type`, so the
 * envelope is reshaped onto that vocabulary first. Two of this lane's own codes
 * deserve better than a bare status: a paid id requested keyless is the caller
 * picking a model this lane does not serve (a request defect, not a broken
 * credential store), and an explicit moderation block is the upstream's answer,
 * not a transport fault.
 */
function classifyKilo(status: number, text: string, retryAfterMs?: number): UpstreamError {
  let payload: any
  try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${status}` } } }
  const type = payload?.error_type ?? payload?.error?.code ?? payload?.error?.type
  const shaped = {
    error: {
      ...payload?.error,
      ...(type === undefined ? {} : { type: String(type) }),
    },
  }
  if (typeof type === 'string' && /PAID_MODEL_AUTH_REQUIRED/i.test(type)) {
    return new UpstreamError('this model is not on the free pool: it needs a Kilo account, so it is not served by this channel', CODE.client, { status })
  }
  const failure = classifyFailure(status, shaped, retryAfterMs)
  if (typeof failure.message === 'string' && /moderation|flagged|filtered/i.test(failure.message)) {
    return new UpstreamError(failure.message, CODE.client, { status })
  }
  return failure
}
