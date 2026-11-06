/**
 * Gemini `generateContent` codec for the gateway.
 *
 * Pure, like the Anthropic codec: request in, an OpenAI chat request out; an
 * OpenAI answer in, Gemini's `candidates`/`usageMetadata` shape out. The one
 * detail worth stating is the token split — Gemini reports
 * `promptTokenCount`/`candidatesTokenCount`, where OpenAI reports
 * `prompt_tokens`/`completion_tokens`, and the reasoning count Gemini carries in
 * `thoughtsTokenCount` has to be folded into `candidatesTokenCount` because that
 * is where Gemini counts it, not into a bucket of its own.
 *
 * @module pi-extension/gateway/gemini.js
 */

export interface GeminiRoute {
  method: 'list' | 'get' | string
  model: string
}

const GEMINI_METHODS = ['generateContent', 'streamGenerateContent', 'countTokens']
const CONTROL = /[\u0000-\u001f\u007f\\]/

function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 })
}

/** `GET /v1beta/models` lists; `/v1|v1beta/models/{model}:{method}` acts. */
export function geminiRoute(path: string): GeminiRoute | undefined {
  if (path === '/v1beta/models') return { method: 'list', model: '' }
  const match = /^\/(?:v1beta|v1)\/models\/(.+)$/.exec(path)
  if (match === null) return undefined
  const rest = match[1]
  const at = rest.lastIndexOf(':')
  const method = at < 0 ? 'get' : rest.slice(at + 1)
  if (at >= 0 && !GEMINI_METHODS.includes(method)) invalid(`unsupported Gemini method "${method}"`)
  let model: string
  try {
    model = decodeURIComponent(at < 0 ? rest : rest.slice(0, at))
  } catch {
    invalid('model path is not valid percent encoding')
  }
  if (model === '' || CONTROL.test(model)) invalid('model path is invalid')
  return { method, model }
}

export interface GeminiRequest {
  model?: string
  contents?: any[]
  systemInstruction?: unknown
  tools?: any[]
  toolConfig?: unknown
  generationConfig?: Record<string, any>
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

function imageUrl(source: any): string | undefined {
  if (source === null || typeof source !== 'object') return undefined
  if (source.inlineData !== undefined) {
    const data = source.inlineData
    if (typeof data?.data !== 'string' || data.data === '') return undefined
    const media = typeof data.mimeType === 'string' ? data.mimeType : 'image/png'
    return `data:${media};base64,${data.data}`
  }
  if (source.fileData !== undefined) {
    if (typeof source.fileData?.fileUri !== 'string') return undefined
    const parsed = new URL(source.fileData.fileUri)
    if (!['http:', 'https:'].includes(parsed.protocol)) invalid('fileData requires an HTTP(S) image URI')
    return parsed.href
  }
  return undefined
}

/** Gemini's uppercase Schema types are the OpenAI wire's lowercase ones. */
function lowerCaseSchema(value: any): any {
  if (Array.isArray(value)) return value.map(lowerCaseSchema)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, any> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'type' && typeof child === 'string') out[key] = child.toLowerCase()
    else if (key === 'enum' && Array.isArray(child)) {
      const kept = child.filter((member) => member !== '')
      if (kept.length > 0) out[key] = kept
    } else out[key] = lowerCaseSchema(child)
  }
  return out
}

/**
 * Project one Gemini request onto the OpenAI chat wire.
 *
 * `thought` marks reasoning on a model text part and is carried as
 * `reasoning_content` — the one OpenAI field the upstreams read it back from —
 * `functionResponse` becomes a `role:'tool'` answer keyed by the call it answers,
 * and `systemInstruction` moves into the message list exactly as the Anthropic
 * codec moves `system`.
 */
export function fromGeminiRequest(body: GeminiRequest, model: string): OpenAiRequest {
  const out: OpenAiRequest = { model, system: '', messages: [], stream: false, tools: [] }
  const gen = body.generationConfig ?? {}
  if (Number.isFinite(Number(gen.maxOutputTokens))) out.max_tokens = Number(gen.maxOutputTokens)
  if (typeof gen.temperature === 'number' && Number.isFinite(gen.temperature)) out.temperature = gen.temperature
  if (Array.isArray(gen.stopSequences) && gen.stopSequences.length > 0) (out as any).stop = gen.stopSequences

  const instruction = body.systemInstruction as any
  const systemParts = Array.isArray(instruction?.parts) ? instruction.parts : []
  const systemText = systemParts.map((part: any) => String(part?.text ?? '')).filter((text: string) => text !== '').join('\n\n')
  if (systemText !== '') {
    out.system = systemText
    out.messages.push({ role: 'system', content: systemText })
  }

  const pending: { id: string; name: string }[] = []
  for (const row of Array.isArray(body.contents) ? body.contents : []) {
    const role = row?.role === 'model' ? 'assistant' : 'user'
    const parts = Array.isArray(row?.parts) ? row.parts : []
    const content: any[] = []
    const toolCalls: any[] = []
    for (const part of parts) {
      if (typeof part?.text === 'string') {
        content.push({ __kind: part.thought === true && role === 'assistant' ? 'reasoning_content' : 'text', text: part.text })
        continue
      }
      if (part?.inlineData !== undefined || part?.fileData !== undefined) {
        const url = imageUrl(part)
        if (url !== undefined) content.push({ __kind: 'image', image_url: { url } })
        continue
      }
      if (part?.functionCall !== undefined) {
        const call = part.functionCall
        const id = typeof call?.id === 'string' && call.id !== '' ? call.id : `gemini_call_${toolCalls.length}`
        pending.push({ id, name: String(call?.name ?? '') })
        toolCalls.push({ id, type: 'function', function: { name: String(call?.name ?? ''), arguments: JSON.stringify(call?.args ?? {}) } })
        continue
      }
      if (part?.functionResponse !== undefined) {
        const response = part.functionResponse ?? {}
        const at = pending.findIndex((call) => call.name === String(response.name ?? ''))
        const [matched] = at >= 0 ? pending.splice(at, 1) : []
        const callId = typeof response.id === 'string' && response.id !== ''
          ? response.id
          : (matched?.id ?? `gemini_call_${response.name ?? ''}`)
        const text = typeof response.response === 'object' && response.response !== null ? JSON.stringify(response.response) : String(response.response ?? '')
        out.messages.push({ role: 'tool', tool_call_id: callId, content: text === '' ? '(no output)' : text })
      }
    }
    if (role === 'assistant') {
      const entry: Record<string, any> = { role: 'assistant', content: null }
      const plain = content
        .filter((part) => part.__kind === 'text')
        .map((part) => ({ type: 'text', text: part.text }))
      const reasoning = content.filter((part) => part.__kind === 'reasoning_content').map((part) => part.text).join('')
      if (plain.length === 1) entry.content = plain[0].text
      else if (plain.length > 1) entry.content = plain
      if (reasoning !== '') entry.reasoning_content = reasoning
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      if (entry.content !== null || toolCalls.length > 0) out.messages.push(entry)
      continue
    }
    if (content.length === 0) continue
    const wireParts: any[] = []
    for (const part of content) {
      if (part.__kind === 'text') wireParts.push({ type: 'text', text: part.text })
      else if (part.__kind === 'image') wireParts.push(part)
    }
    if (wireParts.length === 1 && wireParts[0].type === 'text') out.messages.push({ role: 'user', content: wireParts[0].text })
    else if (wireParts.length > 0) out.messages.push({ role: 'user', content: wireParts })
  }

  for (const group of Array.isArray(body.tools) ? body.tools : []) {
    for (const tool of Array.isArray(group?.functionDeclarations) ? group.functionDeclarations : []) {
      if (typeof tool?.name !== 'string' || tool.name === '') continue
      const parameters = tool.parametersJsonSchema !== undefined ? tool.parametersJsonSchema : lowerCaseSchema(tool.parameters ?? { type: 'object', properties: {} })
      out.tools.push({ type: 'function', function: { name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', parameters } })
    }
  }
  const config = (body.toolConfig as any)?.functionCallingConfig
  if (config !== undefined) {
    const allowed = Array.isArray(config.allowedFunctionNames) ? config.allowedFunctionNames : []
    if (allowed.length === 1) out.tool_choice = { type: 'function', function: { name: allowed[0] } }
    else if (config.mode === 'ANY' || config.mode === 'auto') out.tool_choice = 'auto'
    else if (config.mode === 'NONE') out.tool_choice = 'none'
  }
  return out
}

const GEMINI_FINISH: Record<string, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP',
  content_filter: 'SAFETY',
}

export function geminiFinishReason(finish: string | null): string {
  if (finish === null) return 'STOP'
  return GEMINI_FINISH[finish] ?? 'STOP'
}

/** The non-streaming `generateContent` response one folded answer becomes. */
export function toGeminiResponse(document: any, model: string) {
  const choice = document?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const parts: any[] = []
  if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
    parts.push({ text: message.reasoning_content, thought: true })
  }
  if (typeof message.content === 'string' && message.content !== '') parts.push({ text: message.content })
  for (const call of message.tool_calls ?? []) {
    let args: unknown = {}
    try {
      args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}
    } catch {
      args = {}
    }
    parts.push({ functionCall: { id: String(call?.id ?? ''), name: String(call?.function?.name ?? ''), args } })
  }
  if (parts.length === 0) parts.push({ text: '' })
  const usage = document?.usage ?? {}
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: geminiFinishReason(choice.finish_reason ?? null), index: 0 }],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens ?? 0,
      candidatesTokenCount: usage.completion_tokens ?? 0,
      totalTokenCount: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    },
    modelVersion: model,
  }
}

function responseId(): string {
  return `gemini-${Math.random().toString(36).slice(2, 12)}`
}

/** The SSE frame one streamed Gemini chunk rides in. */
export function geminiStreamFrame(candidate: any, usage: any, model: string): string {
  return `data: ${JSON.stringify({ candidates: [candidate], usageMetadata: usage, modelVersion: model })}\n\n`
}

/**
 * The streaming frame sequence one OpenAI SSE body projects onto.
 *
 * A `text` delta opens a candidate on its first occurrence and every delta rides
 * as one streamed chunk, because Gemini's client re-assembles by concatenation.
 */
export function geminiFrameStream(source: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  let finishReason: string | null = null
  let usage: any = {}
  return new ReadableStream({
    async start(out) {
      let buffer = ''
      const emit = (frame: string) => out.enqueue(new TextEncoder().encode(frame))
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
            if (parsed?.usage !== undefined && parsed.usage !== null) {
              usage = {
                promptTokenCount: parsed.usage.prompt_tokens ?? 0,
                candidatesTokenCount: parsed.usage.completion_tokens ?? 0,
                totalTokenCount: parsed.usage.total_tokens ?? 0,
              }
            }
            for (const choice of parsed?.choices ?? []) {
              const delta = choice?.delta ?? {}
              if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finishReason = String(choice.finish_reason)
              if (typeof delta.content === 'string' && delta.content !== '') {
                emit(geminiStreamFrame({ content: { role: 'model', parts: [{ text: delta.content }] }, finishReason: undefined, index: 0 }, usage, model))
              }
              for (const call of delta.tool_calls ?? []) {
                const functionCall = { id: String(call?.id ?? ''), name: String(call?.function?.name ?? ''), args: safeArgs(call?.function?.arguments) }
                emit(geminiStreamFrame({ content: { role: 'model', parts: [{ functionCall }] }, finishReason: undefined, index: 0 }, usage, model))
              }
            }
          }
        }
      }
      emit(geminiStreamFrame({ content: { role: 'model', parts: [] }, finishReason: geminiFinishReason(finishReason), index: 0 }, usage, model))
      out.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      out.close()
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function safeArgs(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Google's error envelope: a status string, not a number. */
export function geminiErrorBody(code: number, message: string) {
  const status: Record<number, string> = {
    400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND',
    405: 'UNIMPLEMENTED', 413: 'RESOURCE_EXHAUSTED', 429: 'RESOURCE_EXHAUSTED', 499: 'CANCELLED',
    500: 'INTERNAL', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED',
  }
  return { error: { code, message: String(message), status: status[code] ?? 'UNKNOWN' } }
}
