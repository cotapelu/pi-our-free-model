/**
 * Response-side stream plumbing for the gateway: the deferred header commit, the
 * SSE frame rewriter that puts the caller's own tool names back, and the
 * accumulator that folds a live stream into one non-stream document.
 *
 * Both upstreams are OpenAI-shaped, so a streamed turn is passed through with two
 * fixes: the fingerprint renamed the caller's tools out of the gate slots on the
 * request, so every `tool_calls[].function.name` rides the alias on the way back
 * and must be restored here; and DeepSeek v4 leaks `<｜DSML｜…>` control markup
 * into visible text, which is scrubbed from the same frame.
 *
 * @module pi-extension/gateway/response-stream.js
 */

import { createDsmlScrubber } from '../transport.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Hold stream metadata until content arrives or the first heartbeat is due.
 *
 * A gateway that answers a stream request must not commit `200 text/event-stream`
 * before it knows the turn will produce output: a refusal that arrives before any
 * frame would otherwise be a 200 the client parses as an empty stream instead of
 * the error it is. Writes are buffered until the first real frame (or a 64 KB
 * backlog, or the heartbeat deadline), then flushed verbatim.
 */
export function deferStreamResponse(res: any, heartbeatMs: number) {
  let pending = true
  let head: any[] | undefined
  let writes: any[][] = []
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const commit = () => {
    if (!pending || res.destroyed) return
    pending = false
    clear()
    if (head) res.writeHead(...head)
    for (const row of writes) res.write(...row)
    writes = []
  }
  const response = new Proxy(res, {
    get(target, key) {
      if (key === 'writeHead') return (...args: any[]) => {
        if (!pending) return target.writeHead(...args)
        head = args
        if (args[0] >= 400) {
          writes = []
          bytes = 0
        }
        if (timer === undefined && heartbeatMs > 0) {
          timer = setTimeout(commit, heartbeatMs)
          timer.unref?.()
        }
        return response
      }
      if (key === 'flushHeaders') return () => {
        if (!pending) target.flushHeaders()
      }
      if (key === 'write') return (...args: any[]) => {
        if (!pending) return target.write(...args)
        const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined
        writes.push(args)
        bytes += Buffer.byteLength(args[0] ?? '')
        if (callback) queueMicrotask(callback)
        if (bytes >= 64 * 1024) commit()
        return true
      }
      if (key === 'end') return (...args: any[]) => {
        commit()
        return target.end(...args)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  res.once('finish', clear)
  res.once('close', clear)
  return { response, commit, dispose: clear }
}

/**
 * Rewrite one SSE body: restore the caller's tool names, scrub DSML markup.
 *
 * A frame that does not parse is forwarded byte-for-byte rather than dropped —
 * a malformed frame is a bug the client should see, not something to hide.
 */
export function rewriteSseFrames(body: ReadableStream<Uint8Array>, aliases: Map<string, string>, scrub: boolean): ReadableStream<Uint8Array> {
  if (aliases.size === 0 && !scrub) return body
  const scrubber = scrub ? createDsmlScrubber() : null
  const reader = body.getReader()
  return new ReadableStream({
    async pull(controller) {
      const row = await reader.read()
      if (row.done === true) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(rewriteChunk(decoder.decode(row.value, { stream: true }), aliases, scrubber)))
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function rewriteChunk(text: string, aliases: Map<string, string>, scrubber: ReturnType<typeof createDsmlScrubber> | null): string {
  const frames = text.split('\n\n')
  const tail = frames.pop() ?? ''
  let out = frames.map((frame) => rewriteFrame(frame, aliases, scrubber)).join('\n\n')
  if (frames.length > 0) out += '\n\n'
  return out + tail
}

function rewriteFrame(frame: string, aliases: Map<string, string>, scrubber: ReturnType<typeof createDsmlScrubber> | null): string {
  const lines = frame.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    if (colon < 0 || line.slice(0, colon) !== 'data') continue
    const payload = line.slice(colon + 1).replace(/^ /, '')
    if (payload.trim() === '[DONE]') continue
    let parsed: any
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    let changed = false
    for (const choice of parsed?.choices ?? []) {
      for (const call of choice?.delta?.tool_calls ?? []) {
        const name = call?.function?.name
        if (typeof name === 'string' && aliases.has(name)) {
          call.function.name = aliases.get(name)
          changed = true
        }
      }
      if (scrubber !== null) {
        for (const field of ['content', 'reasoning_content', 'reasoning']) {
          if (typeof choice?.delta?.[field] === 'string') {
            choice.delta[field] = scrubber.push(choice.delta[field])
            changed = true
          }
        }
      }
    }
    if (changed) lines[index] = `data: ${JSON.stringify(parsed)}`
  }
  return lines.join('\n')
}

/** The merged answer one non-streamed turn produces. */
export interface FoldedAnswer {
  content: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
  finishReason: string | null
  usage: Record<string, any> | undefined
}

/** Fold a complete SSE body into the one Chat-Completion document it describes. */
export function foldSseAnswer(body: ReadableStream<Uint8Array>): Promise<FoldedAnswer> {
  const reader = body.getReader()
  const answer: FoldedAnswer = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: undefined }
  const byIndex = new Map<number, { id: string; name: string; arguments: string }>()
  return (async () => {
    let buffer = ''
    for (;;) {
      const row = await reader.read()
      if (row.done === true) break
      buffer += decoder.decode(row.value, { stream: true })
      let at = buffer.indexOf('\n\n')
      while (at !== -1) {
        foldFrame(buffer.slice(0, at), answer, byIndex)
        buffer = buffer.slice(at + 2)
        at = buffer.indexOf('\n\n')
      }
    }
    answer.toolCalls = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
    return answer
  })()
}

function foldFrame(frame: string, answer: FoldedAnswer, byIndex: Map<number, { id: string; name: string; arguments: string }>) {
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    if (colon < 0 || line.slice(0, colon) !== 'data') continue
    const payload = line.slice(colon + 1).replace(/^ /, '')
    if (payload.trim() === '' || payload.trim() === '[DONE]') continue
    let parsed: any
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (parsed?.usage !== undefined && parsed.usage !== null) answer.usage = parsed.usage
    for (const choice of parsed?.choices ?? []) {
      const delta = choice?.delta ?? {}
      if (typeof delta.content === 'string') answer.content += delta.content
      if (typeof delta.reasoning_content === 'string') answer.reasoning += delta.reasoning_content
      for (const call of delta.tool_calls ?? []) {
        const index = Number(call.index ?? 0)
        let slot = byIndex.get(index)
        if (slot === undefined) {
          slot = { id: '', name: '', arguments: '' }
          byIndex.set(index, slot)
        }
        if (typeof call?.id === 'string' && call.id !== '') slot.id = call.id
        if (typeof call?.function?.name === 'string' && call.function.name !== '') slot.name += call.function.name
        if (typeof call?.function?.arguments === 'string') slot.arguments += call.function.arguments
      }
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) answer.finishReason = String(choice.finish_reason)
    }
  }
}

/** The non-stream Chat-Completion document the folded answer is wrapped in. */
export function chatCompletionDocument(id: string, model: string, created: number, answer: FoldedAnswer) {
  const message: Record<string, any> = { role: 'assistant', content: answer.content }
  if (answer.reasoning !== '') message.reasoning_content = answer.reasoning
  if (answer.toolCalls.length > 0) {
    message.tool_calls = answer.toolCalls.map((call, index) => ({
      index,
      id: call.id || `call_${index}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    }))
  }
  const usage = answer.usage ?? {}
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: answer.finishReason ?? 'stop' }],
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  }
}
