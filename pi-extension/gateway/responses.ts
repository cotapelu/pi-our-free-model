/**
 * OpenAI Responses codec for the gateway: the request shape a Responses client
 * sends, the events it reads while a turn streams, and the document it reads at
 * the end.
 *
 * Pure by construction, like the Anthropic and Gemini codecs: the request is
 * projected onto the OpenAI chat wire the lanes speak, and the answer is
 * projected back onto Responses vocabulary. What the projection cannot carry
 * faithfully is the request's `instructions` — a Responses client puts the system
 * prompt in its own field rather than in `input`, so it moves into the message
 * list exactly as Anthropic's `system` does — and the stream's typed events,
 * which are synthesized from chat deltas because that is the only shape the
 * upstreams produce.
 *
 * The one detail worth stating: an answer that stops mid-way (`incomplete`,
 * `max_output_tokens`) is reported with that status rather than `completed`,
 * because a client that counts output tokens needs to know the turn was cut and
 * not merely finished.
 *
 * Ported from dsh's `src/forward.js` Responses route and `src/anthropic.js`.
 *
 * @module pi-extension/gateway/responses.js
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface ResponsesRequest {
  model?: string
  input?: unknown
  instructions?: string
  max_output_tokens?: number
  temperature?: number
  stream?: boolean
  tools?: any[]
  tool_choice?: unknown
  reasoning?: { effort?: string; [key: string]: unknown }
}

export interface ChatRequest {
  model: string
  system: string
  messages: any[]
  max_tokens?: number
  temperature?: number
  stream: boolean
  tools: any[]
  tool_choice?: unknown
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (typeof block?.text === 'string') out += block.text
    else if (typeof block === 'string') out += block
  }
  return out
}

function blocksOf(content: unknown): any[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'input_text', text: content }]
  if (!Array.isArray(content)) return []
  return content
    .map((part) => (typeof part === 'string' ? { type: 'input_text', text: part } : part))
    .map((part) => {
      if (part?.type === 'output_text' || part?.type === 'text') return { type: 'input_text', text: part.text ?? '' }
      return part
    })
    .filter(Boolean)
}

function imageUrlOf(source: any): string | undefined {
  if (source === null || typeof source !== 'object') return undefined
  const url = typeof source.image_url === 'string' ? source.image_url : (typeof source.url === 'string' ? source.url : undefined)
  return url
}

/**
 * Project one Responses request onto the OpenAI chat wire.
 *
 * `instructions` moves into a leading system message, a `function_call_output`
 * becomes a `role:'tool'` answer keyed by its `call_id`, and the reasoning effort
 * rides `reasoning_effort` so the lane's own translation applies to it. An
 * `input` that is a plain string becomes one user turn.
 */
export function fromResponsesRequest(body: ResponsesRequest): ChatRequest {
  const out: ChatRequest = { model: String(body.model ?? ''), system: '', messages: [], stream: body.stream === true, tools: [] }
  const instructions = typeof body.instructions === 'string' ? body.instructions : ''
  if (instructions !== '') {
    out.system = instructions
    out.messages.push({ role: 'system', content: instructions })
  }
  if (Number.isFinite(Number(body.max_output_tokens))) out.max_tokens = Number(body.max_output_tokens)
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) out.temperature = body.temperature

  const input = body.input
  const items = Array.isArray(input) ? input : (typeof input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }] : [])
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue
    const role = raw.type === 'function_call_output' ? 'tool' : (raw.role === 'assistant' || raw.role === 'developer' ? 'assistant' : 'user')
    if (raw.type === 'function_call_output') {
      out.messages.push({ role: 'tool', tool_call_id: String(raw.call_id ?? raw.id ?? ''), content: textOf(raw.output ?? raw.content ?? '') || '(no output)' })
      continue
    }
    if (raw.type === 'function_call') {
      out.messages.push({
        role: 'assistant',
        content: textOf(raw.arguments ?? '') === '' ? null : textOf(raw.arguments ?? ''),
        tool_calls: [{ id: String(raw.call_id ?? raw.id ?? ''), type: 'function', function: { name: String(raw.name ?? ''), arguments: JSON.stringify(raw.arguments ?? {}) } }],
      })
      continue
    }
    const blocks = blocksOf(raw.content)
    const parts: any[] = []
    for (const block of blocks) {
      if (block?.type === 'input_image' || block?.type === 'image') {
        const url = imageUrlOf(block)
        if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
      } else if (typeof block?.text === 'string' && block.text !== '') {
        parts.push({ type: 'text', text: block.text })
      } else if (typeof block?.image_url === 'string') {
        parts.push({ type: 'image_url', image_url: { url: block.image_url } })
      }
    }
    if (role === 'assistant') {
      const entry: Record<string, any> = { role: 'assistant', content: null }
      const plain = parts.filter((part) => part.type === 'text')
      if (plain.length === 1) entry.content = plain[0].text
      else if (plain.length > 1) entry.content = plain
      if (entry.content !== null) out.messages.push(entry)
      continue
    }
    if (parts.length === 1 && parts[0].type === 'text') out.messages.push({ role: 'user', content: parts[0].text })
    else if (parts.length > 0) out.messages.push({ role: 'user', content: parts })
  }

  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (typeof tool?.name !== 'string' || tool.name === '') continue
    const parameters = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} }
    out.tools.push({ type: 'function', function: { name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', parameters } })
  }
  const choice = body.tool_choice
  if (choice !== undefined) out.tool_choice = choice
  if (body.reasoning?.effort !== undefined) (out as any).reasoning_effort = body.reasoning.effort
  return out
}

/** The streamed event a Responses client reads, in its own spelling. */
export function responsesEvent(type: string, data: Record<string, any> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

export function responseCreated(id: string, model: string): string {
  return responsesEvent('response.created', {
    response: { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [] },
  })
}

export function outputItemAdded(id: string, index: number, block: any): string {
  return responsesEvent('response.output_item.added', { output_index: index, item: { ...block, id, status: 'in_progress' } })
}

export function contentPartAdded(index: number, partIndex: number, part: any): string {
  return responsesEvent('response.content_part.added', { item_id: '', output_index: index, content_index: partIndex, part })
}

export function outputTextDelta(index: number, partIndex: number, text: string): string {
  return responsesEvent('response.output_text.delta', { item_id: '', output_index: index, content_index: partIndex, delta: text })
}

export function outputTextDone(index: number, partIndex: number, text: string): string {
  return responsesEvent('response.output_text.done', { item_id: '', output_index: index, content_index: partIndex, text })
}

export function contentPartDone(index: number, partIndex: number, part: any): string {
  return responsesEvent('response.content_part.done', { item_id: '', output_index: index, content_index: partIndex, part })
}

export function outputItemDone(id: string, index: number, block: any): string {
  return responsesEvent('response.output_item.done', { output_index: index, item: { ...block, id, status: 'completed' } })
}

export function responseCompleted(document: any): string {
  return responsesEvent('response.completed', { response: { ...document, status: document?.status ?? 'completed' } })
}

export function responseFailed(id: string, message: string): string {
  return responsesEvent('response.failed', { response: { id, object: 'response', status: 'failed', error: { message, code: 'server_error' } } })
}

/** The non-streaming `response` document one folded answer becomes. */
export function toResponsesDocument(document: any, id: string, model: string) {
  const choice = document?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const output: any[] = []
  if (typeof message.content === 'string' && message.content !== '') {
    output.push({ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.content, annotations: [] }] })
  }
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    let args: unknown = {}
    try {
      args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}
    } catch {
      args = {}
    }
    output.push({ id: `fc_${index}`, type: 'function_call', status: 'completed', call_id: String(call?.id ?? `call_${index}`), name: String(call?.function?.name ?? ''), arguments: JSON.stringify(args) })
  }
  const usage = document?.usage ?? {}
  const incomplete = choice.finish_reason === 'length'
  return {
    id: `resp_${id}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: incomplete ? 'incomplete' : 'completed',
    output,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
    },
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  }
}

/**
 * The frame sequence one OpenAI SSE body projects onto.
 *
 * A text delta opens a content part on its first occurrence, a tool call opens
 * its own output item, and the answer ends with one `response.completed` carrying
 * the whole document — Responses clients read the events for the stream and the
 * document for the numbers.
 */
export function responsesFrameStream(source: ReadableStream<Uint8Array>, model: string, id: string): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let contentIndex = -1
  let toolIndex = -1
  let accumulated = ''
  let reasoning = ''
  const toolBlocks: { index: number; id: string; name: string; args: string }[] = []
  let finishReason: string | null = null
  let usage: any = {}
  return new ReadableStream({
    async start(out) {
      const emit = (frame: string) => out.enqueue(encoder.encode(frame))
      emit(responseCreated(id, model))
      let buffer = ''
      const openText = () => {
        if (contentIndex >= 0) return contentIndex
        contentIndex = 0
        emit(outputItemAdded(`msg_${id}`, contentIndex, { type: 'message', role: 'assistant', content: [] }))
        emit(contentPartAdded(contentIndex, 0, { type: 'output_text', text: '', annotations: [] }))
        return contentIndex
      }
      for (;;) {
        const row = await reader.read()
        if (row.done === true) break
        buffer += decoder.decode(row.value, { stream: true })
        let at = buffer.indexOf('\n\n')
        while (at !== -1) {
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          at = buffer.indexOf('\n\n')
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
            if (parsed?.usage !== undefined && parsed.usage !== null) usage = parsed.usage
            for (const choice of parsed?.choices ?? []) {
              const delta = choice?.delta ?? {}
              if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finishReason = String(choice.finish_reason)
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') reasoning += delta.reasoning_content
              if (typeof delta.content === 'string' && delta.content !== '') {
                openText()
                accumulated += delta.content
                emit(outputTextDelta(contentIndex, 0, delta.content))
              }
              for (const call of delta.tool_calls ?? []) {
                toolIndex += 1
                const block = { index: toolIndex, id: String(call?.id ?? `call_${toolIndex}`), name: String(call?.function?.name ?? ''), args: typeof call?.function?.arguments === 'string' ? call.function.arguments : '' }
                toolBlocks.push(block)
                emit(outputItemAdded(block.id, block.index, { type: 'function_call', name: block.name, arguments: '', call_id: block.id }))
              }
            }
          }
        }
      }
      if (contentIndex >= 0) {
        emit(outputTextDone(contentIndex, 0, accumulated))
        emit(contentPartDone(contentIndex, 0, { type: 'output_text', text: accumulated, annotations: [] }))
        emit(outputItemDone(`msg_${id}`, contentIndex, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: accumulated, annotations: [] }] }))
      }
      for (const block of toolBlocks) {
        emit(outputItemDone(block.id, block.index, { type: 'function_call', name: block.name, arguments: block.args, call_id: block.id }))
      }
      const document = toResponsesDocument({
        choices: [{ message: { content: accumulated, reasoning_content: reasoning, tool_calls: toolBlocks.map((block) => ({ id: block.id, function: { name: block.name, arguments: block.args } })) }, finish_reason: finishReason }],
        usage,
      }, id, model)
      emit(responseCompleted(document))
      out.close()
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
