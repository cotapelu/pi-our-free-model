/**
 * The shared turn entry, plus the projection between OpenAI bodies and this
 * provider's own shapes.
 *
 * In DSH this was the file that made one adapter serve two listeners: the
 * OpenAI/Responses listener hands over a raw body, and the Anthropic listener
 * hands over messages it already projected — because re-spelling them as OpenAI
 * blocks and back would lose thinking blocks and block ordering. Both shapes end
 * at the same adapter call, so there is **exactly one place** that decides which
 * model runs.
 *
 * The port keeps that property: `createForwardCompletion` takes the *streaming*
 * interface as a parameter rather than importing one, so the pi extension and the
 * HTTP gateway drive the same reasoning path without either importing the other.
 *
 * Ported from dsh's `src/core/completion.js`.
 *
 * @module pi-extension/core/completion.js
 */

import { carryFailure } from '../failure.js'
import { ROUTE_MAIN, ROUTE_REGION } from '../adapter.js'

/** Harness usage as an OpenAI `usage` envelope. */
export function toOpenAiUsage(usage: any): any {
  if (usage === undefined || usage === null) return undefined
  return {
    prompt_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0),
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  }
}

/** The routes this lane publishes; the region one is opt-out per installation. */
export interface LaneMembership {
  [ROUTE_MAIN]?: string[]
  [ROUTE_REGION]?: string[]
}

/** Every model id a caller may address: the main route, plus the region route unless it is hidden. */
export function routableModelIds(snapshot: any): Set<string> {
  const membership: LaneMembership = snapshot.membership ?? {}
  const ids = new Set<string>(membership[ROUTE_MAIN] ?? [])
  if (snapshot.settings?.exposeRegionModels !== false) {
    for (const id of membership[ROUTE_REGION] ?? []) ids.add(id)
  }
  return ids
}

/** The `/v1/models` rows, with the effort menu a model actually declares. */
export function publicModelRows(snapshot: any, effortsFor: (model: any, requested: any, fallback: any) => any, defaultEffortFor: (model: any) => string): any[] {
  const membership = routableModelIds(snapshot)
  return (snapshot.catalog ?? [])
    .filter((entry: any) => membership.has(entry.id))
    .map((entry: any) => {
      const efforts = effortsFor(entry, undefined, snapshot.settings?.defaultMaxTokens)
      return {
        id: entry.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'our-free-model',
        ...entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow },
        ...efforts === undefined ? {} : {
          x_ofm_efforts: efforts.map((effort: any) => effort.id),
          x_ofm_effort_default: defaultEffortFor(entry),
        },
      }
    })
}

/** What one turn produced, folded from its chunks. */
export interface ForwardOutcome {
  text: string
  toolCalls: Array<{ slot: number; id: string; name: string; arguments: string }>
  usage: any
  truncated: boolean
  error?: string
  failure?: any
}

/** A streaming turn, as `createForwardCompletion` drives it. */
export type StreamFn = (options: any, entry: any, snapshot: any) => AsyncIterable<any>

/**
 * Freeze this request's model and config snapshot, so the two listeners share one
 * reasoning path.
 *
 * `signal` is a *lifetime* signal — a process stopping reason — and is combined
 * with the request's own rather than replacing it, so an aborted request still
 * aborts while the runtime still lives.
 */
export function createForwardCompletion({
  adapter,
  state,
  signal,
  onStopped,
  notFound,
}: {
  /** Anything with a `.stream(options, entry, snapshot)` method. */
  adapter: { stream: StreamFn }
  /** The current catalog + membership + settings, read per request. */
  state: () => any
  /** The runtime's lifetime signal; aborted means "stopped", not "this request". */
  signal?: AbortSignal
  onStopped?: () => Error & { statusCode: number }
  notFound?: (model: string) => Error & { statusCode: number }
}) {
  const stopped = () => onStopped?.() ?? Object.assign(new Error('model runtime is stopped'), { statusCode: 503 })
  const missing = (model: string) => notFound?.(model) ?? Object.assign(new Error(`model "${model}" not found`), { statusCode: 404 })

  return async (request: any, onChunk?: (chunk: any) => void): Promise<ForwardOutcome> => {
    if (signal?.aborted === true) throw stopped()
    const snapshot = state()
    const entry = snapshot.catalog.find((candidate: any) => candidate.id === request.model)
    if (entry === undefined || !routableModelIds(snapshot).has(entry.id)) {
      throw missing(request.model)
    }
    const openAi = request.openAi ?? {}
    const messages = Array.isArray(request.messages)
      ? request.messages
      : fromOpenAiMessages(openAi, request.responses === true, entry.id)
    const tools = Array.isArray(request.tools)
      ? request.tools
      : (openAi.tools ?? []).map(normalizeTool).filter(Boolean)
    const handler = typeof onChunk === 'function' ? onChunk : () => {}
    const outcome: ForwardOutcome = { text: '', toolCalls: [], usage: undefined, truncated: false }
    const options = {
      provider: ROUTE_MAIN,
      model: entry.id,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      ...pick(request, openAi, 'temperature'),
      ...pick(request, openAi, 'maxTokens', 'max_tokens'),
      ...pick(request, openAi, 'reasoningEffort', 'reasoning_effort'),
      ...request.toolChoice === undefined ? {} : { toolChoice: openAi.tool_choice ?? request.toolChoice },
      sessionId: `forward:${String(openAi.user ?? openAi.conversation ?? request.sessionId ?? 'shared')}`,
      // The lifetime signal never replaces the request's own: a stopped runtime
      // ends every request, but an aborted request must not be ignored.
      signal: request.signal !== undefined && signal !== undefined
        ? AbortSignal.any([request.signal, signal])
        : request.signal ?? signal,
    }
    for await (const chunk of adapter.stream(options, entry, snapshot)) {
      handler(chunk)
      foldForwardOutcome(outcome, chunk)
    }
    if (outcome.truncated === true) {
      // A truncated turn's last tool call is very likely a half-written one: the
      // arguments would not parse, and handing that to a caller that executes
      // tools would produce a failure nobody can read.
      outcome.toolCalls = outcome.toolCalls.filter(call => {
        try { JSON.parse(call.arguments === '' ? '{}' : call.arguments); return true } catch { return false }
      })
    }
    return outcome
  }
}

/** One request field, read from the normalised request and then the raw body. */
function pick(request: any, openAi: any, normalised: string, raw = normalised): Record<string, any> {
  const value = Number.isFinite(request[normalised]) ? request[normalised]
    : typeof request[normalised] === 'string' ? request[normalised]
      : openAi[raw]
  return value === undefined ? {} : { [normalised]: value }
}

/** An OpenAI (or Responses) body, as this provider's own message vocabulary. */
export function fromOpenAiMessages(body: any, isResponses: boolean, modelId: string): any[] {
  const out: any[] = []
  const rows = isResponses
    ? normaliseResponsesInput(body?.input)
    : (Array.isArray(body?.messages) ? body.messages : [])
  for (const row of rows) {
    const role = row?.role ?? 'user'
    const content: any[] = []
    if (typeof row.content === 'string') {
      if (row.content !== '') content.push({ type: 'text', text: row.content })
    } else if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (typeof part === 'string') { if (part !== '') content.push({ type: 'text', text: part }); continue }
        const text = part?.text ?? part?.input_text ?? part?.output_text
        if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
        // An image arrives as a URL on this wire and travels as an attachment: the
        // provider resolves it (and drops it) without this layer reading bytes.
        const image = part?.image_url?.url ?? part?.image_url
        if (typeof image === 'string' && image !== '') {
          content.push({ type: 'image', attachment: { attachmentId: `url:${image.slice(0, 64)}`, mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: image } })
        }
      }
    }
    if (role === 'tool') {
      out.push({
        role: 'tool',
        content: [{ type: 'text', text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '') }],
        toolCallId: row.tool_call_id ?? '',
        source: { kind: 'tool', callId: row.tool_call_id ?? '' },
      })
      continue
    }
    if (role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        content.push({ type: 'tool-call', id: call.id ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' })
      }
    }
    if (content.length === 0) continue
    out.push({
      role: role === 'developer' ? 'developer' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
      content,
      ...(role === 'assistant' && typeof row.reasoning_content === 'string' ? { reasoning_content: row.reasoning_content } : {}),
      ...role === 'assistant' ? { source: { kind: 'model', provider: ROUTE_MAIN, model: String(modelId ?? '') } } : {},
    })
  }
  return out
}

/** Responses `input` items as the flat rows {@link fromOpenAiMessages} reads. */
function normaliseResponsesInput(input: any): any[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  return input.map((row: any) => {
    if (typeof row === 'string') return { role: 'user', content: row }
    if (row?.type === 'function_call') {
      return { role: 'assistant', content: [], tool_calls: [{ id: row.call_id, function: { name: row.name, arguments: row.arguments } }] }
    }
    if (row?.type === 'function_call_output') return { role: 'tool', content: String(row.output ?? ''), tool_call_id: row.call_id }
    return row
  })
}

/** One OpenAI tool declaration in this provider's own shape, or `null` when it has no name. */
function normalizeTool(tool: any): any {
  const name = tool?.name ?? tool?.function?.name
  if (typeof name !== 'string' || name.trim() === '') return null
  const parameters = tool?.parameters ?? tool?.function?.parameters ?? { type: 'object', properties: {} }
  return { name, description: String(tool?.description ?? tool?.function?.description ?? ''), parameters }
}

/** Fold one streamed chunk into the outcome the caller reads at the end. */
export function foldForwardOutcome(outcome: ForwardOutcome, chunk: any): ForwardOutcome {
  switch (chunk?.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) {
        call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }
        outcome.toolCalls.push(call)
      } else {
        call.arguments += chunk.argumentsDelta ?? ''
      }
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end': {
      if (chunk.block?.type !== 'tool-call') break
      // Match by slot first: the call's deltas were folded under this same block
      // index, and a relayed stream can carry its id late — matching by id alone
      // would miss the slot's entry and fold one call into two. The block-end
      // carries the assembled arguments, so a slot match adopts them; an id match
      // only fills identity fields.
      const bySlot = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (bySlot !== undefined) {
        if (typeof chunk.block.id === 'string' && chunk.block.id !== '') bySlot.id = chunk.block.id
        if (typeof chunk.block.name === 'string' && chunk.block.name !== '') bySlot.name = chunk.block.name
        if (typeof chunk.block.arguments === 'string') bySlot.arguments = chunk.block.arguments
        break
      }
      const byId = outcome.toolCalls.find(candidate => typeof candidate.id === 'string' && candidate.id !== ''
        && candidate.id === chunk.block.id)
      if (byId === undefined) {
        outcome.toolCalls.push({
          slot: chunk.index,
          id: typeof chunk.block.id === 'string' ? chunk.block.id : '',
          name: typeof chunk.block.name === 'string' ? chunk.block.name : '',
          arguments: typeof chunk.block.arguments === 'string' ? chunk.block.arguments : '',
        })
      }
      break
    }
    case 'usage': outcome.usage = toOpenAiUsage(chunk.usage); break
    case 'finish': {
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
        // The wire envelope, not the raw reason: a forwarded failure carries only
        // what the caller's own error type can represent.
        outcome.failure = carryFailure(chunk.reason.failure, chunk.reason.kind)
        outcome.error = outcome.failure.message
      }
      break
    }
    default: break
  }
  return outcome
}
