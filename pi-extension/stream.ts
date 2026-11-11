/**
 * Provider SSE -> harness `StreamChunk` projection for all three wire shapes the
 * free lane answers on.
 *
 * The harness contract is a flat indexed block protocol: every block is opened
 * with `block-start`, fed with deltas, and closed with `block-end` carrying the
 * assembled block. Block indices are allocated in arrival order.
 *
 * Ported from dsh's `src/stream.js`.
 *
 * @module pi-extension/stream.js
 */

import crypto from 'node:crypto'
import { classifyFailure } from './gateway/classify.js'
import { restoreToolName } from './upstream.js'
import { createDsmlScrubber } from './transport.js'

/** DeepSeek v4-family models occasionally leak internal DSML control markup. */
const DSML_OPENING = '<｜DSML｜'
const DSML_TAG = /<｜DSML｜[^>]*>/g

/** Mint a tool-call id for providers that stream arguments without one. */
function mintToolCallId(): string {
  return `call_${crypto.randomBytes(12).toString('hex')}`
}

// Arguments that never parse split into two kinds: a structurally incomplete
// value (unclosed string, unbalanced brackets) and a complete-but-invalid one.
function argumentsCutMidway(raw: string): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth -= 1
  }
  return inString || depth !== 0
}

/**
 * BlockSink accumulates streamed blocks and emits harness chunks.
 */
export class BlockSink {
  emit: (chunk: any) => void
  next: number
  onProgress: () => void
  open: Map<string, { index: number; kind: string; text: string; id?: string; name?: string; args?: string }>
  usage: any
  sawReasoning: boolean
  sawToolCall: boolean
  sawText: boolean
  reasoningText: string
  answerText: string
  answerLimit: number
  checkpointLimit: number
  checkpointTruncated: boolean
  brokenToolCall: boolean
  lastToolKey: string | undefined
  dsml: ReturnType<typeof createDsmlScrubber>

  constructor(
    yieldChunk: (chunk: any) => void,
    startIndex: number,
    checkpointLimit: number,
    onProgress?: () => void
  ) {
    this.emit = yieldChunk
    this.next = startIndex
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {}
    this.open = new Map()
    this.usage = undefined
    this.sawReasoning = false
    this.sawToolCall = false
    this.sawText = false
    this.reasoningText = ''
    this.answerText = ''
    this.answerLimit = checkpointLimit
    this.checkpointLimit = checkpointLimit
    this.checkpointTruncated = false
    this.brokenToolCall = false
    this.lastToolKey = undefined
    this.dsml = createDsmlScrubber()
  }

  toolKey(call: any): string {
    if (call.index !== undefined && call.index !== null) {
      this.lastToolKey = `c${call.index}`
      return this.lastToolKey
    }
    if (typeof call.id === 'string' && call.id !== '') {
      for (const [key, block] of this.open) {
        if (block.kind === 'tool-call' && block.id === call.id) { this.lastToolKey = key; return key }
      }
      this.lastToolKey = `cid:${call.id}`
      return this.lastToolKey
    }
    return this.lastToolKey ?? 'c0'
  }

  slot(key: string, kind: string): { index: number; kind: string; text: string; id?: string; name?: string; args?: string } {
    if (kind === 'tool-call') this.sawToolCall = true
    const existing = this.open.get(key)
    if (existing !== undefined) return existing
    const block = { index: this.next++, kind, text: '', args: '', id: kind === 'tool-call' ? mintToolCallId() : '', name: '' }
    this.open.set(key, block)
    this.emit({ type: 'block-start', index: block.index, blockType: kind === 'reasoning' ? 'reasoning' : kind === 'tool-call' ? 'tool-call' : 'text' })
    return block
  }

  text(key: string, delta: string | undefined): void {
    if (delta === undefined || delta === null || delta === '') return
    const scrubbed = this.dsml.push(delta)
    if (scrubbed === '') return
    this.sawText = true
    if (this.answerText.length < this.answerLimit) {
      this.answerText += this.answerText.length + scrubbed.length > this.answerLimit
        ? scrubbed.slice(0, this.answerLimit - this.answerText.length)
        : scrubbed
    }
    const block = this.slot(key, 'text')
    block.text += scrubbed
    this.emit({ type: 'text-delta', index: block.index, text: scrubbed })
  }

  reasoning(key: string, delta: string | undefined): void {
    if (delta === undefined || delta === null || delta === '') return
    this.sawReasoning = true
    const text = String(delta)
    const remaining = this.checkpointLimit - this.reasoningText.length
    if (text.length > remaining) this.checkpointTruncated = true
    this.reasoningText += text.slice(0, remaining)
    const block = this.slot(key, 'reasoning')
    block.text += delta
    this.emit({ type: 'reasoning-delta', index: block.index, text: delta })
  }

  toolStart(key: string, id: string | undefined, name: string | undefined): void {
    const block = this.slot(key, 'tool-call')
    const priorId = block.id
    const priorName = block.name
    if (id) block.id = id
    if (name) block.name = name
    if (typeof block.name === 'string' && block.name.trim() !== ''
      && (block.name !== priorName || block.id !== priorId)) this.onProgress()
  }

  toolArgs(key: string, delta: string | undefined): void {
    this.sawToolCall = true
    if (!delta) return
    const block = this.slot(key, 'tool-call')
    block.args += delta
    const name = typeof block.name === 'string' && block.name !== '' ? { name: block.name } : {}
    this.emit({ type: 'tool-call-delta', index: block.index, id: block.id ?? '', ...name, argumentsDelta: delta })
  }

  closeAll(): void {
    const spill = this.dsml.flush()
    let spilled = false
    for (const block of this.open.values()) {
      if (block.kind === 'text' && !spilled && spill !== '') {
        spilled = true
        block.text += spill
        this.emit({ type: 'text-delta', index: block.index, text: spill })
      }
      if (block.kind === 'text' && block.text !== '') this.emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      else if (block.kind === 'reasoning' && block.text !== '') this.emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
      else if (block.kind === 'tool-call') {
        try { JSON.parse(block.args === '' ? '{}' : block.args ?? "") } catch { this.brokenToolCall = argumentsCutMidway(block.args ?? "") }
        if (typeof block.name !== 'string' || block.name === '') this.brokenToolCall = true
        this.emit({
          type: 'block-end', index: block.index,
          block: { type: 'tool-call', id: block.id ?? '', name: block.name ?? '', arguments: block.args === '' ? '{}' : block.args },
        })
      }
    }
    this.open.clear()
  }
}

function number(value: any): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Turn one provider `usage` object into the harness's disjoint TokenUsage.
 */
export function mapUsage(usage: any): { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; totalTokens?: number } | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens)
  const completion = number(usage.completion_tokens ?? usage.output_tokens)
  const cached = number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) ?? 0
  const cacheWrite = number(usage.prompt_tokens_details?.cache_write_tokens)
  const reasoning = number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const out: any = {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: completion ?? 0,
  }
  if (cached > 0) out.cacheReadTokens = cached
  if (cacheWrite !== undefined && cacheWrite > 0) out.cacheWriteTokens = cacheWrite
  if (reasoning !== undefined && reasoning > 0) out.reasoningTokens = reasoning
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

/**
 * Drop input-side usage that cannot fit inside the advertised context window.
 */
export function sanitizeUsage(usage: any, contextWindow: number | undefined): any | undefined {
  if (!usage || typeof usage !== 'object') return usage
  const cw = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined
  if (!cw) return usage
  const input = number(usage.inputTokens) ?? 0
  const cacheRead = number(usage.cacheReadTokens) ?? 0
  const prompt = input + cacheRead
  const total = number(usage.totalTokens)
  const over =
    prompt > cw
    || (total !== undefined && total > cw)
  if (!over) return usage
  const output = number(usage.outputTokens) ?? 0
  const reasoning = number(usage.reasoningTokens)
  if (output <= 0 && (reasoning === undefined || reasoning <= 0)) return undefined
  const out: any = { inputTokens: 0, outputTokens: output }
  if (reasoning !== undefined && reasoning > 0) out.reasoningTokens = reasoning
  return out
}

const REASONING_FIELDS = ['reasoning', 'reasoning_content', 'reasoning_text', 'thinking']

function reasoningOf(delta: any): string | undefined {
  for (const field of REASONING_FIELDS) {
    const value = delta[field]
    if (typeof value === 'string' && value !== '') return value
  }
  if (Array.isArray(delta.reasoning_details)) {
    let text = ''
    for (const part of delta.reasoning_details) if (typeof part?.text === 'string') text += part.text
    if (text !== '') return text
  }
  return undefined
}

function feedChat(sink: BlockSink, payload: any, renameMap: Map<string, string>, onFinish: (usage: any, kind: string, token?: string) => void): void {
  if (payload.usage) onFinish(mapUsage(payload.usage), 'usage')
  for (const choice of payload.choices ?? []) {
    const delta = choice.delta ?? {}
    const reasoning = reasoningOf(delta)
    if (reasoning !== undefined) sink.reasoning('r', reasoning)
    if (typeof delta.content === 'string') sink.text('t', delta.content)
    for (const call of delta.tool_calls ?? []) {
      sink.sawToolCall = true
      const key = sink.toolKey(call)
      const name = call.function?.name
      if (typeof name === 'string' && name !== '') sink.toolStart(key, call.id ?? '', restoreToolName(name, renameMap))
      else if (call.id) sink.toolStart(key, call.id, '')
      if (call.function?.arguments) sink.toolArgs(key, call.function.arguments)
    }
    if (choice.finish_reason) onFinish(undefined, 'finish', choice.finish_reason)
  }
}

function feedClaude(sink: BlockSink, event: any, onFinish: (usage: any, kind: string, token?: string) => void, renameMap: Map<string, string>): void {
  if (event.type === 'content_block_start') {
    const block = event.content_block
    if (block?.type === 'tool_use') sink.toolStart(`b${event.index}`, block.id ?? '', restoreToolName(block.name ?? '', renameMap))
    return
  }
  if (event.type === 'content_block_delta') {
    const part = event.delta
    if (part?.type === 'text_delta') sink.text(`b${event.index}`, part.text)
    else if (part?.type === 'thinking_delta') sink.reasoning(`b${event.index}`, part.thinking)
    else if (part?.type === 'input_json_delta') sink.toolArgs(`b${event.index}`, part.partial_json)
    return
  }
  if (event.type === 'message_start') {
    const usage = event.message?.usage
    if (usage) {
      const mapped = mapUsage({
        prompt_tokens: number(usage.input_tokens),
        completion_tokens: number(usage.output_tokens),
        prompt_tokens_details: { cached_tokens: number(usage.cache_read_input_tokens), cache_write_tokens: number(usage.cache_creation_input_tokens) },
      })
      if (mapped) onFinish(mapped, 'usage')
    }
    return
  }
  if (event.type === 'message_delta') {
    const usage = event.usage
    if (usage && number(usage.output_tokens) !== undefined) {
      onFinish({ outputTokens: number(usage.output_tokens) }, 'usage')
    }
    const stop = event.delta?.stop_reason
    if (stop) onFinish(undefined, 'finish', stop)
    return
  }
  if (event.type === 'message_stop') onFinish(undefined, 'finish', undefined)
}

function feedResponses(sink: BlockSink, event: any, onFinish: (usage: any, kind: string, token?: string) => void, renameMap: Map<string, string>): void {
  switch (event.type) {
    case 'response.output_item.added': {
      const item = event.item
      if (item?.type === 'function_call') sink.toolStart(`i${event.output_index}`, item.call_id ?? item.id ?? '', restoreToolName(item.name ?? '', renameMap))
      return
    }
    case 'response.content_part.added':
      return
    case 'response.output_text.delta':
      sink.text(`t${event.output_index}`, event.delta)
      return
    case 'response.reasoning_summary_text.delta':
    case 'response.output_reasoning.text.delta':
      sink.reasoning(`r${event.item_id ?? 'r'}`, event.delta)
      return
    case 'response.function_call_arguments.delta':
      sink.toolArgs(`i${event.output_index}`, event.delta)
      return
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
    case 'response.done': {
      const response = event.response
      if (response?.usage) {
        const mapped = mapUsage({
          prompt_tokens: number(response.usage.input_tokens),
          completion_tokens: number(response.usage.output_tokens),
          prompt_tokens_details: { cached_tokens: number(response.usage.input_tokens_details?.cached_tokens) },
          completion_tokens_details: { reasoning_tokens: number(response.usage.output_tokens_details?.reasoning_tokens) },
        })
        if (mapped) onFinish(mapped, 'usage')
      }
      const status = response?.status ?? (event.type === 'response.failed' ? 'failed'
        : event.type === 'response.incomplete' ? 'incomplete'
          : event.type === 'response.completed' ? 'completed' : undefined)
      const incomplete = response?.incomplete_details?.reason
      onFinish(undefined, 'finish', incomplete === 'max_output_tokens' ? 'length' : status === 'completed' ? 'stop' : status)
      return
    }
    default: return
  }
}

/** Map a provider finish token onto the harness finish reason. */
export function finishReason(token: string | undefined): { kind: string } {
  if (token === 'tool_calls' || token === 'tool_use' || token === 'function_call') return { kind: 'tool-calls' }
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * Output tokens that can honestly be divided by the measured window.
 */
export function windowTokens(usage: any, sawReasoning: boolean): number {
  const output = number(usage?.outputTokens) ?? 0
  if (sawReasoning) return output
  return Math.max(0, output - (number(usage?.reasoningTokens) ?? 0))
}

function carriesDelta(payload: any, wire: string): boolean {
  if (wire === 'chat') return (payload.choices ?? []).some((choice: any) => {
    const delta = choice.delta ?? {}
    return (typeof delta.content === 'string' && delta.content !== '')
      || reasoningOf(delta) !== undefined
      || (delta.tool_calls ?? []).length > 0
  })
  if (wire === 'responses') return (typeof payload.delta === 'string' && payload.delta !== '') || payload.type === 'response.output_item.added'
  return payload.type === 'content_block_delta' || payload.type === 'content_block_start'
}

/**
 * Read one streamed response, yielding harness chunks as they are produced.
 */
export async function * readStream(
  lines: AsyncIterable<string>,
  wire: 'chat' | 'messages' | 'responses',
  renameMap: Map<string, string>,
  now: () => number = () => Date.now(),
  options: { startIndex?: number; checkpointLimit?: number; onState?: (snapshot: any) => void; onProgress?: () => void } = {}
): AsyncGenerator<any> {
  const outbox: any[] = []
  const startIndex = Number.isSafeInteger(options?.startIndex) && options.startIndex !== undefined && options.startIndex >= 0 ? options.startIndex : 0
  const checkpointLimit = Number.isSafeInteger(options?.checkpointLimit) && options.checkpointLimit !== undefined && options.checkpointLimit >= 0 ? options.checkpointLimit : 131072
  const sink = new BlockSink((chunk: any) => outbox.push(chunk), startIndex, checkpointLimit, options?.onProgress)
  const state: any = {
    usage: undefined, finish: undefined, sawFinish: false, sawUsage: false,
    sawToolCall: false, firstDeltaAt: undefined, sawReasoning: false, sawText: false,
    brokenToolCall: false,
  }

  const snapshot = () => ({
    ...state,
    nextIndex: sink.next,
    reasoningText: sink.reasoningText,
    answerText: sink.answerText,
    checkpointTruncated: sink.checkpointTruncated,
    usage: state.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  })

  const publishState = () => {
    if (typeof options?.onState === 'function') options.onState(snapshot())
  }

  const onFinish = (usage: any, kind: string, token?: string) => {
    if (kind === 'usage' && usage !== undefined) {
      state.sawUsage = true
      const carried = state.usage
      state.usage = carried !== undefined && usage.inputTokens === undefined
        ? { ...carried, ...usage, totalTokens: Math.max(0, (carried.totalTokens ?? 0) - (carried.outputTokens ?? 0)) + (usage.outputTokens ?? 0) }
        : usage
    }
    if (kind !== 'finish') return
    state.sawFinish = true
    if (token !== undefined) state.finish = token
  }

  try {
    for await (const raw of lines) {
      if (typeof raw !== 'string') continue
      const text = raw.trim()
      if (!text.startsWith('{')) continue
      let payload: any
      try { payload = JSON.parse(text) } catch { continue }
      if ((payload.type === 'response.failed' || payload.response?.status === 'failed') && payload.response?.error) {
        throw classifyFailure({ status: undefined, body: { error: payload.response.error } })
      }
      if (payload.type === 'error' || payload.error) {
        const failure = payload.error ?? payload
        const classified: any = classifyFailure({ status: undefined, body: payload })
        if (typeof failure.message !== 'string') classified.message = 'upstream error'
        throw Object.assign(classified, { upstream: payload })
      }
      if (state.firstDeltaAt === undefined && carriesDelta(payload, wire)) state.firstDeltaAt = now()
      if (wire === 'chat') feedChat(sink, payload, renameMap, onFinish)
      else if (wire === 'messages') feedClaude(sink, payload, onFinish, renameMap)
      else feedResponses(sink, payload, onFinish, renameMap)
      if (sink.sawReasoning) state.sawReasoning = true
      if (sink.sawText) state.sawText = true
      if (sink.brokenToolCall) state.brokenToolCall = true
      if (sink.sawToolCall) state.sawToolCall = true
      publishState()
      while (outbox.length > 0) yield outbox.shift()
    }

    sink.closeAll()
    if (sink.brokenToolCall) state.brokenToolCall = true
    publishState()
    while (outbox.length > 0) yield outbox.shift()
    return snapshot()
  } catch (error) {
    publishState()
    throw error
  }
}
