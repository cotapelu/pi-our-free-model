/**
 * Anthropic Messages codec for the gateway: request translation and the named
 * event frames an Anthropic client reads.
 *
 * Pure by construction — no sockets, no timers, no filesystem. Both upstreams
 * answer on the OpenAI chat wire, so an Anthropic-shaped turn is *translated*
 * rather than natively served: the request is projected onto OpenAI messages and
 * the answer is projected back onto Anthropic's event vocabulary. What that
 * costs is the two things a projection cannot carry faithfully — `system` has to
 * move into the message list, and Anthropic's `input_json_delta` accumulation is
 * synthesized from the OpenAI `arguments` string — and what it buys is the
 * protocol Claude Code actually speaks.
 *
 * @module pi-extension/gateway/anthropic.js
 */

export interface AnthropicToolUse {
  id: string
  name: string
  input: unknown
}

export interface AnthropicRequest {
  model?: string
  system?: unknown
  messages?: any[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
  tools?: any[]
  tool_choice?: unknown
  thinking?: unknown
}

export interface OpenAiRequest {
  model: string
  system: string
  messages: any[]
  max_tokens?: number
  temperature?: number
  stream: boolean
  tools: any[]
  tool_choice?: unknown
}

const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (typeof block?.text === 'string') out += block.text
  }
  return out
}

function blocksOf(content: unknown): any[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part)).filter(Boolean)
}

function mediaOf(dataUrl: string): { mediaType: string; data: string } | undefined {
  const comma = String(dataUrl).indexOf(',')
  if (comma < 0) return undefined
  const head = String(dataUrl).slice(0, comma)
  const mediaType = /^data:([^;]+)/.exec(head)?.[1]
  if (mediaType === undefined || !IMAGE_MEDIA.has(mediaType)) return undefined
  return { mediaType, data: String(dataUrl).slice(comma + 1) }
}

function flattenSystem(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter((block) => typeof block?.text === 'string' && block.text !== '')
    .map((block) => block.text)
    .join('\n\n')
}

/**
 * Project one Anthropic request onto the OpenAI chat wire.
 *
 * `tool_result` becomes a `role:'tool'` message keyed by the call it answers,
 * `thinking` becomes nothing (both projectors drop reasoning on the way upstream,
 * and echoing account-bound ciphertext back would be a guaranteed refusal), and
 * `redacted_thinking` is dropped for the same reason.
 */
export function fromAnthropicRequest(body: AnthropicRequest): OpenAiRequest {
  const system = flattenSystem(body.system)
  const out: OpenAiRequest = { model: String(body.model ?? ''), system, messages: [], stream: body.stream === true, tools: [] }
  if (system !== '') out.messages.push({ role: 'system', content: system })
  if (Number.isFinite(Number(body.max_tokens))) out.max_tokens = Number(body.max_tokens)
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) out.temperature = body.temperature

  for (const rawMessage of Array.isArray(body.messages) ? body.messages : []) {
    const role = rawMessage?.role === 'assistant' ? 'assistant' : 'user'
    const blocks = blocksOf(rawMessage?.content)
    const toolUses = blocks.filter((block) => block?.type === 'tool_use') as AnthropicToolUse[]
    const toolResults = blocks.filter((block) => block?.type === 'tool_result')
    if (role === 'assistant') {
      const text = blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('')
      const entry: Record<string, any> = { role: 'assistant', content: text === '' ? null : text }
      if (toolUses.length > 0) {
        entry.tool_calls = toolUses.map((block, index) => ({
          id: String(block.id ?? `call_${index}`),
          type: 'function',
          function: { name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
        }))
      }
      out.messages.push(entry)
      continue
    }

    for (const block of toolResults) {
      const text = textOf(block.content)
      out.messages.push({ role: 'tool', tool_call_id: String(block.tool_use_id ?? ''), content: text === '' ? '(no output)' : text })
    }
    const parts: any[] = []
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push({ type: 'text', text: block.text })
      else if (block?.type === 'image') {
        const source = block.source ?? {}
        const url = source.type === 'url' ? source.url : source.type === 'base64' && typeof source.data === 'string'
          ? `data:${typeof source.media_type === 'string' ? source.media_type : 'image/png'};base64,${source.data}`
          : undefined
        if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
      }
    }
    if (parts.length > 0) {
      out.messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
    }
  }

  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (typeof tool?.name !== 'string' || tool.name === '') continue
    const parameters = tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object', properties: {} }
    out.tools.push({ type: 'function', function: { name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', parameters } })
  }
  return out
}

const STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

export function anthropicStopReason(finish: string | null): string {
  if (finish === null) return 'end_turn'
  return STOP_REASON[finish] ?? 'end_turn'
}

let messageCounter = 0

function nextMessageId(): string {
  messageCounter += 1
  const stamp = Date.now().toString(36)
  const tail = messageCounter.toString(36).padStart(3, '0')
  return `msg_${stamp}${tail}`
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** The non-streaming message one folded OpenAI answer becomes. */
export function toAnthropicMessage(document: any, model: string, includeReasoning: boolean) {
  const choice = document?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const content: any[] = []
  if (includeReasoning && typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' })
  }
  if (typeof message.content === 'string' && message.content !== '') content.push({ type: 'text', text: message.content })
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    let input: unknown = {}
    try {
      input = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: String(call?.id ?? `call_${index}`), name: String(call?.function?.name ?? ''), input })
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  const usage = document?.usage ?? {}
  return {
    id: nextMessageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(choice.finish_reason ?? null),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? Math.max(1, estimateTokens(String(document?.choices?.[0]?.message?.content ?? ''))),
    },
  }
}

/** One `event: <name>\ndata: <json>\n\n` frame. */
export function anthropicFrame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** The opening frame every Anthropic stream sends before any content. */
export function messageStartFrame(message: any): string {
  return anthropicFrame('message_start', { type: 'message_start', message })
}

export function contentBlockStart(index: number, block: any): string {
  return anthropicFrame('content_block_start', { type: 'content_block_start', index, content_block: block })
}

export function textDeltaFrame(index: number, text: string): string {
  return anthropicFrame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
}

export function inputJsonDeltaFrame(index: number, partial: string): string {
  return anthropicFrame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } })
}

export function thinkingDeltaFrame(index: number, thinking: string): string {
  return anthropicFrame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })
}

export function contentBlockStopFrame(index: number): string {
  return anthropicFrame('content_block_stop', { type: 'content_block_stop', index })
}

export function messageDeltaFrame(stopReason: string, outputTokens: number): string {
  return anthropicFrame('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })
}

export function messageStopFrame(): string {
  return anthropicFrame('message_stop', { type: 'message_stop' })
}

export function anthropicErrorFrame(message: string, type = 'api_error'): string {
  return anthropicFrame('error', { type: 'error', error: { type, message } })
}

/**
 * A local `count_tokens` estimate: one token per four characters, a flat cost per
 * image because a base64 payload carries no dimensions to price, and framing
 * overhead so an empty body still answers non-zero (a client that divides by the
 * count must not see 0).
 */
export function countTokensEstimate(body: AnthropicRequest): number {
  const CHARS_PER_TOKEN = 4
  const IMAGE_TOKENS = 1024
  const TOOL_FRAME_TOKENS = 8
  const BASE_TOKENS = 16
  let total = BASE_TOKENS + estimateTokens(flattenSystem(body.system) ?? '')
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const block of blocksOf(message?.content)) {
      if (block?.type === 'tool_use') total += TOOL_FRAME_TOKENS + estimateTokens(JSON.stringify(block.input ?? {}))
      else if (block?.type === 'tool_result') total += estimateTokens(textOf(block.content))
      else if (block?.type === 'image') total += IMAGE_TOKENS
      else if (typeof block?.text === 'string') total += estimateTokens(block.text)
    }
  }
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    total += TOOL_FRAME_TOKENS + estimateTokens(JSON.stringify(tool ?? {}))
  }
  return total
}
