/**
 * One completion turn for the gateway: resolve the model to a lane, build the
 * upstream payload that lane's gate requires, call it through the shared
 * transport guards, and hand back either a rewritten SSE stream or one folded
 * document.
 *
 * The payload is built here rather than borrowed from pi-ai because a gateway
 * caller speaks plain OpenAI Chat Completions: its `messages` are already in the
 * wire's shape, so re-projecting them through pi-ai's message conversion would
 * only add a second, lossy translation. What the lanes *do* require — the
 * OpenCode v2 fingerprint, Kilo's `reasoning` object, the no-Authorization rule,
 * the body-shape sniff — is applied exactly as the pi providers apply it.
 *
 * @module pi-extension/gateway/dispatch.js
 */

import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { applyFingerprint, gatewayHeaders, sessionFor } from '../fingerprint.js'
import { KILO_BASE, OPENECODE_CHAT_BASE } from '../catalog.js'
import { PROVIDER_ID as KILO_ID, normalizeKiloPayload, roster } from '../kilo.js'
import { PROVIDER_ID as OPENECODE_ID } from '../opencode.js'
import { composeFetches, fetchWithoutHeader, sessionSeedOf, sseGuard } from '../lane.js'
import { friendlyMessage } from '../transport.js'
import { chatCompletionDocument, deferStreamResponse, foldSseAnswer, rewriteSseFrames, type FoldedAnswer } from './response-stream.js'
import {
  anthropicStopReason, contentBlockStart, contentBlockStopFrame, fromAnthropicRequest, inputJsonDeltaFrame,
  messageDeltaFrame, messageStartFrame, messageStopFrame, textDeltaFrame, thinkingDeltaFrame, toAnthropicMessage,
} from './anthropic.js'
import { fromGeminiRequest, geminiFrameStream, toGeminiResponse } from './gemini.js'
import { fromResponsesRequest, responsesFrameStream, toResponsesDocument } from './responses.js'
import { toMessagesResponse, tryOptimizations, type OptimizationKind } from './optimize.js'
import { runChain, type ChainRow } from './chain.js'
import type { QuotaReading } from './probe.js'
import { canRecover, canRecoverSilentStop, checkpointFits, continuationMessages, MIN_BUDGET, recoveryMessages, recoveryPolicy, type RecoveryPolicy, type TurnOutcome } from './recovery.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const DSML_FAMILY = /deepseek/i

export interface LaneModels {
  [KILO_ID]: Map<string, Model<Api>>
  [OPENECODE_ID]: Map<string, Model<Api>>
}

export function buildLaneModels(kilo: Model<Api>[], opencode: Model<Api>[]): LaneModels {
  return {
    [KILO_ID]: new Map(kilo.map((model) => [model.id, model])),
    [OPENECODE_ID]: new Map(opencode.map((model) => [model.id, model])),
  }
}

export interface Resolved {
  provider: string
  model: Model<Api>
}

export function resolveModel(models: LaneModels, provider: string, modelId: string): Resolved | undefined {
  const table = (models as unknown as Record<string, Map<string, Model<Api>> | undefined>)[provider]
  if (table === undefined) return undefined
  const model = table.get(modelId)
  if (model === undefined) return undefined
  return { provider, model }
}

export interface DispatchRequest {
  body: Record<string, any>
  requestId: string
  sessionId?: string
}

export interface DispatchResult {
  status: number
  body: ReadableStream<Uint8Array> | Uint8Array
  headers: Record<string, string>
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

export interface UpstreamCall {
  response: Response
  scrub: boolean
  aliases: Map<string, string>
}

/**
 * One upstream turn, wearing its lane's own guards.
 *
 * Extracted because a chain needs it once per candidate and each dialect needs
 * it once, and the transport error surface has to stay identical in all three
 * cases: a refused turn is a status the caller sees, never a stack.
 */
export async function performUpstream(resolved: Resolved, payload: Record<string, any>, sessionId: string | undefined, aliases: Map<string, string>): Promise<UpstreamCall> {
  const isKilo = resolved.provider === KILO_ID
  const seed = sessionSeedOf({ sessionId })
  const headers = isKilo
    ? { 'content-type': 'application/json', accept: 'text/event-stream' }
    : gatewayHeaders({ session: sessionFor(seed), stream: true })
  const doFetch = upstreamFetch(isKilo)
  let response: Response
  try {
    response = await doFetch(upstreamUrl(resolved), { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error' })
  } catch (error) {
    const message = `${error instanceof Error ? error.message : String(error)}`
    throw httpError(502, friendlyMessage(message) ?? `upstream request failed: ${message}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const detail = text === '' ? `HTTP ${response.status}` : text.slice(0, 400)
    throw httpError(response.status, friendlyMessage(`${response.status} ${detail}`) ?? detail)
  }
  return { response, scrub: DSML_FAMILY.test(String(resolved.model.id)), aliases }
}

/**
 * The upstream payload one lane accepts, plus what the response side needs.
 *
 * Returned separately from the request because the OpenCode lane's fingerprint
 * renames the caller's tools, and the response must know those renames to undo
 * them.
 */
function buildUpstream(resolved: Resolved, body: Record<string, any>, aliases: Map<string, string>) {
  const isKilo = resolved.provider === KILO_ID
  const wireId = isKilo ? roster.wireId(resolved.model.id) : resolved.model.id
  const payload: Record<string, any> = {
    model: wireId,
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: true,
  }
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  if (maxTokens !== undefined) payload.max_tokens = maxTokens
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) payload.temperature = body.temperature
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) payload.top_p = body.top_p
  if (Array.isArray(body.stop) && body.stop.length > 0) payload.stop = body.stop
  if (Array.isArray(body.tools) && body.tools.length > 0) payload.tools = body.tools
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice
  if (body.reasoning_effort !== undefined) payload.reasoning_effort = body.reasoning_effort

  if (isKilo) {
    normalizeKiloPayload(payload, resolved.model)
  } else {
    applyFingerprint(payload, { aliases })
  }
  return { payload, isKilo }
}

function upstreamUrl(resolved: Resolved): string {
  if (resolved.provider === KILO_ID) return `${KILO_BASE}/chat/completions`
  const base = String(resolved.model.baseUrl ?? OPENECODE_CHAT_BASE).replace(/\/+$/, '')
  return `${base}/chat/completions`
}

function upstreamFetch(isKilo: boolean) {
  return composeFetches(
    fetch,
    isKilo ? fetchWithoutHeader('authorization') : () => (input: any, init?: any) => {
      void input
      return fetch(input, init)
    },
    sseGuard,
  )
}

export async function dispatchChat(models: LaneModels, resolved: Resolved, request: DispatchRequest): Promise<DispatchResult> {
  const body = request.body
  const stream = body.stream !== false
  const aliases = new Map<string, string>()
  const { payload } = buildUpstream(resolved, body, aliases)
  const call = await performUpstream(resolved, payload, request.sessionId, aliases)
  if (call.response.body === null) throw httpError(502, 'the gateway answered 200 with no body')

  const rewritten = rewriteSseFrames(call.response.body, call.aliases, call.scrub)
  if (stream) {
    return {
      status: 200,
      body: rewritten,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
    }
  }
  const folded = await foldSseAnswer(rewritten)
  const recovered = await recoverTurn(models, resolved, request, body, folded)
  const answer = recovered ?? folded
  const document = chatCompletionDocument(`chatcmpl-${request.requestId}`, String(body.model ?? resolved.model.id), Math.floor(Date.now() / 1000), answer)
  const text = JSON.stringify(document)
  return {
    status: 200,
    body: new TextEncoder().encode(text),
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(new TextEncoder().encode(text).byteLength) },
  }
}

function outcomeOf(folded: FoldedAnswer): TurnOutcome {
  return {
    sawFinish: folded.finishReason !== null,
    sawReasoning: folded.reasoning !== '',
    sawText: folded.content.trim() !== '',
    sawToolCall: folded.toolCalls.length > 0,
    checkpointTruncated: false,
    reasoningText: folded.reasoning,
    answerText: folded.content,
    finish: folded.finishReason ?? undefined,
    usage: folded.usage,
  }
}

const DEFAULT_POLICY: RecoveryPolicy = recoveryPolicy()

/**
 * Finish a turn that ended with only its thinking, or that was cut mid-answer.
 *
 * Returns the continued answer, or `undefined` when the turn needs no
 * continuation. The continuation is dispatched once: a second interruption is a
 * fault, not a third attempt, and the caller gets the honest ending.
 */
async function recoverTurn(models: LaneModels, resolved: Resolved, request: DispatchRequest, body: Record<string, any>, first: FoldedAnswer): Promise<FoldedAnswer | undefined> {
  const outcome = outcomeOf(first)
  const policy = DEFAULT_POLICY
  const elapsed = 0
  const interrupted = canRecover(outcome, policy, elapsed)
  const silenceStopped = canRecoverSilentStop(outcome, policy, elapsed) && ['stop', 'end_turn', 'stop_sequence'].includes(String(first.finishReason ?? ''))
  const cut = interrupted || silenceStopped
  const answerCut = !cut && first.finishReason === 'length' && first.content.trim() !== '' && first.toolCalls.length === 0
  if (!cut && !answerCut) return undefined

  const budget = Number(body.max_tokens ?? body.max_completion_tokens ?? resolved.model.maxTokens ?? policy.maxOutputTokens)
  const used = Number(first.usage?.completion_tokens ?? 0)
  const remaining = Math.max(0, budget - used)
  const continuationBudget = Math.min(remaining, policy.maxOutputTokens)
  if (continuationBudget < MIN_BUDGET) return undefined

  const messages = Array.isArray(body.messages) ? body.messages : []
  const continued = answerCut
    ? continuationMessages(messages, first.content)
    : recoveryMessages(messages, first.reasoning)
  if (!checkpointFits({ messages: continued }, resolved.model, answerCut ? first.content : first.reasoning, continuationBudget)) return undefined

  const aliases = new Map<string, string>()
  const { payload } = buildUpstream(resolved, { ...body, messages: continued, max_tokens: continuationBudget, max_completion_tokens: undefined }, aliases)
  const call = await performUpstream(resolved, payload, request.sessionId, aliases)
  if (call.response.body === null) return undefined
  const rewritten = rewriteSseFrames(call.response.body, call.aliases, call.scrub)
  const second = await foldSseAnswer(rewritten)
  void models
  return {
    content: answerCut ? `${first.content}${second.content}` : second.content,
    reasoning: answerCut ? first.reasoning : `${first.reasoning}${second.reasoning}`,
    toolCalls: second.toolCalls.length > 0 ? second.toolCalls : first.toolCalls,
    finishReason: second.finishReason ?? first.finishReason,
    usage: {
      prompt_tokens: Number(first.usage?.prompt_tokens ?? 0) + Number(second.usage?.prompt_tokens ?? 0),
      completion_tokens: used + Number(second.usage?.completion_tokens ?? 0),
    },
  }
}

/**
 * One chain turn on the OpenAI wire.
 *
 * The walk is inside this single response, which is the part a gateway owns and
 * `pi` owns for the extension: each link is tried, held, and discarded whole
 * when it produces no answer, and the document the caller finally reads names
 * the link that actually answered rather than the chain.
 */
export async function dispatchChainChat(models: LaneModels, chain: ChainRow, links: Resolved[], request: DispatchRequest, readings?: Map<string, QuotaReading>): Promise<DispatchResult> {
  const body = request.body
  const stream = body.stream !== false
  const outcome = await runChain({
    chain,
    links,
    readings,
    attempt: async (candidate): Promise<UpstreamCall> => {
      const aliases = new Map<string, string>()
      const { payload } = buildUpstream(candidate, body, aliases)
      return performUpstream(candidate, payload, request.sessionId, aliases)
    },
    toResult: (stream_: ReadableStream<Uint8Array>, answeredBy: string) => ({
      status: 200,
      body: stream_,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
      answeredBy,
      tried: [],
    }),
    fold: async (stream_: ReadableStream<Uint8Array>) => {
      const folded = await foldSseAnswer(stream_)
      return new TextEncoder().encode(JSON.stringify(folded))
    },
  })
  if (outcome.status !== 200) return { status: outcome.status, body: outcome.body, headers: outcome.headers }
  if (stream) return { status: 200, body: outcome.body as ReadableStream<Uint8Array>, headers: outcome.headers }
  const folded = JSON.parse(decoder.decode(outcome.body as Uint8Array)) as FoldedAnswer
  const document = chatCompletionDocument(`chatcmpl-${request.requestId}`, outcome.answeredBy, Math.floor(Date.now() / 1000), folded)
  const text = JSON.stringify(document)
  return {
    status: 200,
    body: new TextEncoder().encode(text),
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(new TextEncoder().encode(text).byteLength) },
  }
}

/**
 * One Anthropic-shaped turn, answered in Anthropic's own event vocabulary.
 *
 * The request is projected onto the OpenAI chat wire, the lane guards are applied
 * exactly as the OpenAI route applies them, and the answer is projected back:
 * SSE deltas become `content_block_*` frames and one folded document becomes one
 * `message`. Anthropic's `input_json_delta` accumulation is synthesized from the
 * OpenAI `arguments` string because that is the only shape the upstream speaks.
 */
/**
 * Whether a request is one of the five local answers, and which one.
 *
 * The lane is not consulted and nothing is streamed: the answer is generated
 * here, so a quota probe from an agent costs no free-lane quota at all. Every
 * detector is conservative, and a request that does not match exactly falls
 * through to the real lane unchanged.
 */
/** One Responses-shaped turn, answered in OpenAI's Responses vocabulary. */
export async function dispatchResponsesChat(models: LaneModels, resolved: Resolved, request: DispatchRequest): Promise<DispatchResult> {
  const projected = fromResponsesRequest(request.body as never)
  const stream = projected.stream
  const aliases = new Map<string, string>()
  const { payload } = buildUpstream(resolved, projected as unknown as Record<string, any>, aliases)
  const call = await performUpstream(resolved, payload, request.sessionId, aliases)
  if (call.response.body === null) throw httpError(502, 'the gateway answered 200 with no body')
  const rewritten = rewriteSseFrames(call.response.body, call.aliases, call.scrub)
  const id = request.requestId
  const model = String(request.body.model ?? resolved.model.id)
  if (stream) {
    return { status: 200, body: responsesFrameStream(rewritten, model, id), headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } }
  }
  const folded = await foldSseAnswer(rewritten)
  const document = chatCompletionDocument(`resp_${id}`, model, Math.floor(Date.now() / 1000), folded)
  const text = JSON.stringify(toResponsesDocument(document, id, model))
  return { status: 200, body: new TextEncoder().encode(text), headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(new TextEncoder().encode(text).byteLength) } }
}

export function localAnswerFor(body: Record<string, any>, addressed: string): { text: string } | undefined {
  if (process.env.OFM_LOCAL_OPTIMIZE === 'off') return undefined
  const result = tryOptimizations(body, { enabled: true, model: addressed })
  if (result === null) return undefined
  return { text: JSON.stringify(toMessagesResponse(result, { model: addressed })) }
}

export async function dispatchAnthropicChat(models: LaneModels, resolved: Resolved, request: DispatchRequest): Promise<DispatchResult> {
  const local = localAnswerFor(request.body, String(request.body.model ?? resolved.model.id))
  if (local !== undefined) {
    return {
      status: 200,
      body: new TextEncoder().encode(local.text),
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(new TextEncoder().encode(local.text).byteLength) },
    }
  }
  const projected = fromAnthropicRequest(request.body as never)
  const stream = projected.stream
  const aliases = new Map<string, string>()
  const { payload } = buildUpstream(resolved, projected as unknown as Record<string, any>, aliases)
  const call = await performUpstream(resolved, payload, request.sessionId, aliases)
  if (call.response.body === null) throw httpError(502, 'the gateway answered 200 with no body')
  const rewritten = rewriteSseFrames(call.response.body, call.aliases, call.scrub)
  const includeReasoning = (request.body as { include_thinking?: boolean })?.include_thinking !== false
  if (stream) {
    const frames = anthropicFrameStream(rewritten, String(request.body.model ?? resolved.model.id), includeReasoning)
    return {
      status: 200,
      body: frames,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
    }
  }
  const folded = await foldSseAnswer(rewritten)
  const document = chatCompletionDocument(`chatcmpl-${request.requestId}`, String(request.body.model ?? resolved.model.id), Math.floor(Date.now() / 1000), folded)
  const message = toAnthropicMessage(document, String(request.body.model ?? resolved.model.id), includeReasoning)
  const text = JSON.stringify(message)
  return {
    status: 200,
    body: new TextEncoder().encode(text),
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(new TextEncoder().encode(text).byteLength) },
  }
}

/**
 * One Gemini-shaped turn: `fromGeminiRequest` projects the body onto the OpenAI
 * chat wire, the same lane guards run, and the answer is projected back onto
 * Gemini's `candidates`/`usageMetadata` — including the streamed frame form.
 */
export async function dispatchGeminiChat(models: LaneModels, resolved: Resolved, request: DispatchRequest): Promise<DispatchResult> {
  const body = request.body as { contents?: unknown; generationConfig?: Record<string, any> }
  const stream = body.generationConfig?.stream === true
  const projected = fromGeminiRequest(request.body as never, resolved.model.id)
  const aliases = new Map<string, string>()
  const { payload } = buildUpstream(resolved, projected as unknown as Record<string, any>, aliases)
  const call = await performUpstream(resolved, payload, request.sessionId, aliases)
  if (call.response.body === null) throw httpError(502, 'the gateway answered 200 with no body')
  const rewritten = rewriteSseFrames(call.response.body, call.aliases, call.scrub)
  const model = String(request.body.model ?? resolved.model.id)
  if (stream) {
    return {
      status: 200,
      body: geminiFrameStream(rewritten, model),
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
    }
  }
  const folded = await foldSseAnswer(rewritten)
  const document = chatCompletionDocument(`gemini-${request.requestId}`, model, Math.floor(Date.now() / 1000), folded)
  const text = JSON.stringify(toGeminiResponse(document, model))
  return {
    status: 200,
    body: new TextEncoder().encode(text),
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(new TextEncoder().encode(text).byteLength) },
  }
}

/**
 * The Anthropic frame sequence one OpenAI SSE stream projects onto.
 *
 * Block bookkeeping mirrors the wire: an index is opened on its first delta,
 * reasoning and text never share an index (that is what keeps Anthropic's own
 * client from merging a thinking block into the answer), and a tool call's
 * `arguments` string rides one `input_json_delta` because the wire has no other
 * place for partial JSON.
 */
function anthropicFrameStream(source: ReadableStream<Uint8Array>, model: string, includeReasoning: boolean): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const opened = new Map<string, number>()
  const nextIndex = { value: 0 }
  let reasoningIndex = -1
  let textIndex = -1
  let finishReason: string | null = null
  let outputTokens = 0
  return new ReadableStream({
    async start(controllerOut) {
      const emit = (frame: string) => controllerOut.enqueue(encoder.encode(frame))
      emit(messageStartFrame({ id: `msg_${Math.random().toString(36).slice(2, 12)}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }))
      let buffer = ''
      const openFor = (key: string, block: any) => {
        const existing = opened.get(key)
        if (existing !== undefined) return existing
        const index = nextIndex.value
        nextIndex.value += 1
        opened.set(key, index)
        emit(contentBlockStart(index, block))
        return index
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
            if (parsed?.usage?.completion_tokens !== undefined) outputTokens = Number(parsed.usage.completion_tokens)
            for (const choice of parsed?.choices ?? []) {
              const delta = choice?.delta ?? {}
              if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finishReason = String(choice.finish_reason)
              if (includeReasoning) {
                const reasoning = typeof delta.reasoning_content === 'string' && delta.reasoning_content !== ''
                  ? delta.reasoning_content
                  : (typeof delta.reasoning === 'string' && delta.reasoning !== '' ? delta.reasoning : '')
                if (reasoning !== '') {
                  if (reasoningIndex < 0) reasoningIndex = openFor('reasoning', { type: 'thinking', thinking: '' })
                  emit(thinkingDeltaFrame(reasoningIndex, reasoning))
                }
              }
              if (typeof delta.content === 'string' && delta.content !== '') {
                if (textIndex < 0) textIndex = openFor('text', { type: 'text', text: '' })
                emit(textDeltaFrame(textIndex, delta.content))
              }
              for (const call of delta.tool_calls ?? []) {
                const key = `tool:${call.index ?? 0}`
                const block = { type: 'tool_use', id: String(call?.id ?? ''), name: String(call?.function?.name ?? ''), input: {} }
                const index = openFor(key, block)
                const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
                if (args !== '') emit(inputJsonDeltaFrame(index, args))
              }
            }
          }
        }
      }
      for (const index of [...opened.values()].sort((a, b) => a - b)) emit(contentBlockStopFrame(index))
      emit(messageDeltaFrame(anthropicStopReason(finishReason), outputTokens))
      emit(messageStopFrame())
      controllerOut.close()
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/** Rows for `GET /v1/models`, in the spelling every client's discovery expects. */
export function modelRows(models: LaneModels) {
  const rows: Record<string, any>[] = []
  for (const [provider, table] of Object.entries(models)) {
    for (const model of (table as Map<string, Model<Api>>).values()) {
      rows.push({ id: `${provider}/${model.id}`, object: 'model', created: 0, owned_by: provider })
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id))
}

export { deferStreamResponse }
