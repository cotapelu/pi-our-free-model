/**
 * The Gemini native endpoint: `POST /v1beta/models/{m}:generateContent` and its
 * stream variant, plus the error writer the route answers with.
 *
 * `gemini.ts` carries the route table and the frame encoders; this module is the
 * route handler itself — read the body, project it onto this provider's request
 * shape, drive one turn, and answer in Gemini's own envelope. A malformed body
 * is a 400 in *Gemini's* error shape, because that is what a Gemini client
 * parses.
 *
 * Ported from dsh's `src/gemini.js`.
 *
 * @module pi-extension/gateway/gemini-endpoint.js
 */

import crypto from 'node:crypto'
import { foldAnthropicOutcome, countTokens } from './anthropic-frames.js'
import { forwardFailureWire } from '../failure.js'
import { fromGeminiRequest } from './gemini.js'

const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = (message: string) => { throw Object.assign(new Error(message), { statusCode: 400 }) }
const upstreamError = (message: string) => { throw Object.assign(new Error(message), { statusCode: 502 }) }
const MAX_PENDING_BYTES = 1024 * 1024
const methods = ['generateContent', 'streamGenerateContent', 'countTokens']

function fields(value: any, allowed: any, label: any) {
  if (!object(value)) invalid(`${label} must be an object`)
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} contains unsupported fields`)
}

/** Keep /v1/models reserved for the existing OpenAI discovery contract. */
export function geminiRoute(path: any) {
  if (path === '/v1beta/models') return { method: 'list' }
  const match = /^\/(?:v1beta|v1)\/models\/(.+)$/.exec(path)
  if (!match) return null
  const at = match[1].lastIndexOf(':')
  const method = at < 0 ? 'get' : match[1].slice(at + 1)
  let model
  try { model = decodeURIComponent(at < 0 ? match[1] : match[1].slice(0, at)) }
  catch { invalid('model path is not valid percent encoding') }
  if (!model || /[\u0000-\u001f\u007f]/.test(model)) invalid('model path is invalid')
  return { method, model }
}

export function geminiError(res: any, code: any, message: any) {
  const table: Record<string, string> = {
    400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED',
    404: 'NOT_FOUND', 405: 'UNIMPLEMENTED', 413: 'RESOURCE_EXHAUSTED',
    429: 'RESOURCE_EXHAUSTED', 499: 'CANCELLED', 500: 'INTERNAL',
    502: 'UNAVAILABLE', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED',
  }
  const status = table[String(code)] ?? 'UNKNOWN'
  const payload = { error: { code, message: String(message), status } }
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.end(`data: ${JSON.stringify(payload)}\n\n`)
  } else {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(JSON.stringify(payload))
  }
}


function usageMetadata(usage: any = {}) {
  const prompt = usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0
  const cached = usage.cacheReadTokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
  const output = usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0
  const thoughts = usage.reasoningTokens ?? usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0
  const input = usage.inputTokens === undefined ? prompt : prompt + cached
  return {
    promptTokenCount: input, candidatesTokenCount: Math.max(0, output - thoughts),
    totalTokenCount: input + output, thoughtsTokenCount: thoughts, cachedContentTokenCount: cached,
  }
}

function functionPart(call: any, declared: any, truncated = false) {
  if (!declared.has(call.name)) upstreamError('model called a function that was not declared')
  let args
  try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : call.arguments ?? {} }
  catch {
    if (truncated) return null
    upstreamError('model returned invalid function arguments')
  }
  if (!object(args)) upstreamError('model returned non-object function arguments')
  return { functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args } }
}

function estimate(request: any) {
  return countTokens({
    messages: request.messages.map((row: any) => ({
      content: row.content.map((block: any) => block.type === 'tool-call'
        ? { type: 'tool_use', name: block.name, input: JSON.parse(block.arguments) }
        : block.type === 'reasoning' ? { type: 'thinking', thinking: block.text } : block),
    })),
    tools: request.tools.map((tool: any) => ({ ...tool, input_schema: tool.parameters })),
  }).input_tokens
}

/** Factory injects the gateway's bounded reader and existing response helpers. */
export function geminiEndpoint({ readBody, json, modelRows, route, url }: any) {
  return async (req: any, res: any, complete: any) => {
    // Provider errors can contain a URL. Redact every presented credential,
    // including its percent-encoded spelling, and never pass errors to logging.
    const secrets = [url.searchParams.get('key'), req.headers['x-goog-api-key'], req.headers['x-api-key'], req.headers.authorization?.replace(/^Bearer\s+/i, '')]
      .filter(value => typeof value === 'string' && value)
    const safeMessage = (value: any) => {
      let text = String(value ?? 'gateway request failed')
      for (const secret of secrets) for (const spelling of [secret, encodeURIComponent(secret)]) text = text.split(spelling).join('[redacted]')
      return text.slice(0, 1024)
    }
    try {
      if (route.method === 'list' || route.method === 'get') {
        if (req.method !== 'GET') { geminiError(res, 405, 'model discovery requires GET'); return }
        const rows = modelRows().map((row: any) => ({
          name: `models/${row.id}`, displayName: row.id,
          supportedGenerationMethods: methods,
          ...(row.context_window ? { inputTokenLimit: row.context_window } : {}),
        }))
        if (route.method === 'get') {
          const row = rows.find((row: any) => row.name === `models/${route.model}`)
          if (!row) { geminiError(res, 404, 'model not found'); return }
          json(res, 200, row)
        } else {
          const pageSize = url.searchParams.get('pageSize')
          const pageToken = url.searchParams.get('pageToken') ?? '0'
          if ((pageSize !== null && (!/^\d+$/.test(pageSize) || Number(pageSize) < 1)) || !/^\d+$/.test(pageToken)) invalid('invalid model pagination')
          const size = pageSize === null ? 50 : Math.min(1000, Number(pageSize))
          const start = Number(pageToken)
          if (!Number.isSafeInteger(start)) invalid('invalid model pagination')
          json(res, 200, { models: rows.slice(start, start + size), ...(start + size < rows.length ? { nextPageToken: String(start + size) } : {}) })
        }
        return
      }
      if (!methods.includes(route.method)) { geminiError(res, 404, 'unknown Gemini method'); return }
      if (req.method !== 'POST') { geminiError(res, 405, 'generation and token counting require POST'); return }
      const stream = route.method === 'streamGenerateContent'
      if (stream && url.searchParams.get('alt') !== 'sse') invalid('streamGenerateContent requires alt=sse')
      let body = await readBody(req)
      if (route.method === 'countTokens' && body.generateContentRequest !== undefined) {
        fields(body, ['generateContentRequest', 'model'], 'countTokens request')
        if (body.model !== undefined && body.model !== route.model && body.model !== `models/${route.model}`) invalid('body model conflicts with path model')
        body = body.generateContentRequest
      }
      const request = fromGeminiRequest(body, route.model)
      if (route.method === 'countTokens') {
        res.setHeader('x-ofm-token-count-estimated', 'true')
        json(res, 200, { totalTokens: estimate(request) })
        return
      }
      const identity = { modelVersion: route.model, responseId: `gemini-${crypto.randomBytes(12).toString('hex')}` }
      const response = (parts: any[], extra: any = {}, usage?: any) => ({
        candidates: [{ index: 0, content: { role: 'model', parts }, ...extra }], ...identity,
        ...(usage === undefined ? {} : { usageMetadata: usageMetadata(usage) }),
      })
      const declared = new Set(request.tools.map(tool => tool.name))
      const thoughts = body.generationConfig?.thinkingConfig?.includeThoughts !== false
      const folded: any = { text: '', thinking: '', toolCalls: [], truncated: false }
      const slots = new Map()
      const sentIds = new Set()
      const sentSignatures = new Map()
      const signature = (part: any) => crypto.createHash('sha256').update(JSON.stringify([part.functionCall.name, part.functionCall.args])).digest('hex')
      let pendingBytes = 0
      let usage
      let truncated = false
      let sawText = false
      let sawThought = false
      let chunkFailure
      let renderError: any
      if (stream) res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
        'access-control-allow-origin': '*', 'x-accel-buffering': 'no',
      })
      const send = (payload: any) => {
        if (res.destroyed || res.writableEnded) return
        if (res.writableLength > MAX_PENDING_BYTES) upstreamError('stream client is too slow')
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const flushCall = (key: any, call: any, allowIncomplete = false) => {
        if ((!slots.has(key) && slots.size >= 1024) || Buffer.byteLength(JSON.stringify(call)) > MAX_PENDING_BYTES) upstreamError('pending function calls exceed stream limit')
        const part = functionPart(call, declared, allowIncomplete || truncated)
        if (!part) return
        send(response([part]))
        sentIds.add(call.id || `slot:${key}`)
        const hash = signature(part)
        sentSignatures.set(hash, (sentSignatures.get(hash) ?? 0) + 1)
        const slot = slots.get(key)
        if (slot) pendingBytes -= Buffer.byteLength(slot.arguments)
        slots.set(key, { sent: true })
      }
      const result = await complete(request, (chunk: any) => {
        if (res.destroyed || renderError) return
        try {
          if (chunk.type === 'usage') usage = chunk.usage
          if (chunk.type === 'block-end' && chunk.block && !['text', 'reasoning', 'tool-call'].includes(chunk.block.type)) upstreamError('model returned an unsupported output block')
          if (!stream) { foldAnthropicOutcome(folded, chunk); return }
          switch (chunk.type) {
            case 'text-delta':
            case 'reasoning-delta':
              if (chunk.text) {
                if (chunk.type === 'text-delta') sawText = true
                else sawThought = true
              }
              if (chunk.text && (chunk.type === 'text-delta' || thoughts)) send(response([{ text: chunk.text, ...(chunk.type === 'reasoning-delta' ? { thought: true } : {}) }]))
              break
            case 'tool-call-delta': {
              const slot = slots.get(chunk.index) ?? { id: '', name: '', arguments: '' }
              if (slot.sent) break
              if (chunk.id) slot.id = chunk.id
              if (chunk.name) slot.name = chunk.name
              const delta = chunk.argumentsDelta ?? ''
              pendingBytes += Buffer.byteLength(delta)
              if (pendingBytes > MAX_PENDING_BYTES || (!slots.has(chunk.index) && slots.size >= 1024)) upstreamError('pending function calls exceed stream limit')
              slot.arguments += delta
              slots.set(chunk.index, slot)
              break
            }
            case 'block-end':
              if (chunk.block?.type === 'tool-call' && !slots.get(chunk.index)?.sent) {
                const slot = slots.get(chunk.index)
                const call = { ...slot, ...chunk.block, id: chunk.block.id || slot?.id, name: chunk.block.name || slot?.name }
                pendingBytes += Buffer.byteLength(call.arguments ?? '') - Buffer.byteLength(slot?.arguments ?? '')
                if (pendingBytes > MAX_PENDING_BYTES || (!slot && slots.size >= 1024)) upstreamError('pending function calls exceed stream limit')
                slots.set(chunk.index, call)
                // A max-token finish may follow a partial block-end. Hold the
                // broken call until that finish distinguishes truncation from
                // invalid JSON on an otherwise completed turn.
                flushCall(chunk.index, call, true)
              }
              break
            case 'usage': usage = chunk.usage; break
            case 'finish':
              truncated = chunk.reason?.kind === 'max-tokens'
              if (['error', 'aborted'].includes(chunk.reason?.kind)) chunkFailure = {
                error: chunk.reason.failure?.message ?? 'generation aborted',
                failure: chunk.reason.failure ?? { code: 'ABORTED' },
              }
              break
            default: break
          }
        } catch (error: any) {
          renderError = error
          // The shared wrapper releases the adapter iterator and returns a
          // failed outcome when the rendering callback throws.
          throw error
        }
      })
      if (res.destroyed) return
      if (renderError) throw renderError
      const failed = result?.error !== undefined ? result : chunkFailure ?? (folded.error !== undefined ? folded : undefined)
      if (failed) {
        const failure = forwardFailureWire(failed, false)
        if (!res.headersSent && failure.retryAfterMs !== undefined) res.setHeader('retry-after', String(Math.ceil(failure.retryAfterMs / 1000)))
        geminiError(res, failure.status, safeMessage(failure.error.message))
        return
      }
      truncated ||= result?.truncated === true || folded.truncated
      const finish = { finishReason: truncated ? 'MAX_TOKENS' : 'STOP' }
      if (stream) {
        if (!sawThought && thoughts && result?.thinking) send(response([{ text: result.thinking, thought: true }]))
        if (!sawText && result?.text) send(response([{ text: result.text }]))
        for (const [key, slot] of slots) {
          if (slot.sent) continue
          flushCall(key, slot)
        }
        // Some adapters only publish calls in their final outcome.
        for (const call of result?.toolCalls ?? []) {
          const part = functionPart(call, declared, truncated)
          if (!part) continue
          const hash = signature(part)
          const count = sentSignatures.get(hash) ?? 0
          if (count) sentSignatures.set(hash, count - 1)
          if (sentIds.has(call.id || `slot:${call.slot}`)) continue
          if (!call.id && call.slot === undefined && count) continue
          send(response([part]))
        }
        send(response([], finish, usage ?? result?.usage ?? {}))
        res.end()
      } else {
        const text = folded.text || result?.text || ''
        const thinking = folded.thinking || result?.thinking || ''
        const parts: any[] = [
          ...(thinking && thoughts ? [{ text: thinking, thought: true }] : []),
          ...(text ? [{ text }] : []),
        ]
        for (const call of folded.toolCalls.length ? folded.toolCalls : result?.toolCalls ?? []) {
          const part = functionPart(call, declared, truncated)
          if (part) parts.push(part)
        }
        json(res, 200, response(parts, finish, usage ?? result?.usage ?? folded.usage ?? {}))
      }
    } catch (error: any) {
      const code = Number.isInteger((error as any)?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500
      geminiError(res, code, safeMessage((error as any)?.message))
    }
  }
}
