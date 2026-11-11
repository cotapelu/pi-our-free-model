/**
 * The gateway's HTTP server: routes, trust fence, CORS, and the stream reply.
 *
 * Kept thin on purpose — every decision about what a route means lives in
 * `dispatch.ts`, and every wire-protocol detail in `protocol.ts`. What is left
 * is the one thing that cannot live anywhere else: which request is allowed, and
 * how a live stream is written to a socket.
 *
 * @module pi-extension/gateway/server.js
 */

import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'
import { bindGatewayPort, rankLanAddresses, resolveLoopbackBind } from './loopback.js'
import { anthropicErrorBody, bearerOf, corsHeaders, keyMatches, openAiErrorBody, readBody, REQUEST_ID_HEADER } from './protocol.js'
import { deferStreamResponse, dispatchAnthropicChat, dispatchChainChat, dispatchChat, dispatchGeminiChat, dispatchResponsesChat, LaneModels, modelRows, Resolved, resolveModel } from './dispatch.js'
import { chainRowOf, type ChainRow } from './chain.js'
import { countTokensEstimate } from './anthropic.js'
import { geminiErrorBody, geminiRoute } from './gemini.js'
import { classifyFailure, forwardFailure } from './classify.js'
import type { QuotaReading } from './probe.js'
import { friendlyMessage } from '../transport.js'
import type { AnnouncementFeed } from '../feed.js'
import { acknowledge, readAck } from '../feed-ack.js'
import { sponsorView } from '../sponsor.js'
import { createPickStats, type PickStats } from '../picks.js'
import { createPushHub, type PushHub } from '../push.js'
import { CHAIN_PREFIX, CHAIN_PROVIDER } from '../chains.js'

export interface GatewaySettings {
  host: string
  port: number
  enabled: boolean
  key: string
}

export interface GatewayDependencies {
  settings: () => GatewaySettings
  models: () => LaneModels
  chains?: () => ChainRow[]
  /** The announcement feed, when this installation runs one. Optional so a
   * minimal gateway (and the test suites) does not need one. */
  feed?: () => AnnouncementFeed | undefined
  /** A push hub, for the `/v1/events` stream. Created when absent. */
  push?: () => PushHub
  /** The recommended-projects numbers. Created when absent. */
  picks?: () => PickStats
  /** Per-link quota readings, for the chains that score from them. */
  quota?: () => Map<string, QuotaReading>
  log?: (message: string) => void
  heartbeatMs?: number
}

export interface GatewayHandle {
  server: http.Server
  /** Closes every held-open stream. Called before the listener closes. */
  push?: PushHub
  port: number
  requestedPort: number
  fellBack: boolean
  host: string
  lanAddresses: () => string[]
  close: () => Promise<void>
}

interface Reply {
  status: number
  body: ReadableStream<Uint8Array> | Uint8Array
  headers: Record<string, string>
}

const COMPLETION_PATHS = new Set(['/v1/chat/completions', '/chat/completions'])
const MESSAGE_PATHS = new Set(['/v1/messages', '/messages'])
const COUNT_TOKEN_PATHS = new Set(['/v1/messages/count_tokens', '/messages/count_tokens'])
const RESPONSES_PATHS = new Set(['/v1/responses', '/responses'])

export async function startGateway(deps: GatewayDependencies): Promise<GatewayHandle> {
  const log = deps.log ?? (() => {})
  const heartbeatMs = deps.heartbeatMs ?? 15_000
  const settings = deps.settings()
  // One hub per gateway, kept open across requests. Created here rather than per
  // route so a reload has a single thing to close, and so the interval is shared.
  const hub = deps.push?.() ?? createPushHub({ logger: log })
  // The star counts are one network read per repo, cached and refreshed behind
  // the route, so a hot console does not hammer GitHub.
  const picks = deps.picks?.() ?? createPickStats({ log })

  const server = http.createServer((req, res) => {
    let dialect: 'openai' | 'anthropic' | 'google' | 'gemini' = 'openai'
    void handle(req, res, (next) => { dialect = next }).catch((error) => {
      const status = Number((error as { statusCode?: number })?.statusCode)
      const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
      const message = String((error as Error)?.message ?? error)
      if (!res.headersSent) {
        // A route that already shaped its refusal exactly (a 400 on the Anthropic
        // wire says what Anthropic clients parse) keeps that shape; an unshaped
        // one is classified and rendered in the dialect's own envelope.
        const attached = (error as { body?: unknown })?.body
        if (attached !== undefined) {
          json(res, code, attached)
          return
        }
        const verdict = classifyFailure({ status: code, message })
        const shaped = forwardFailure(dialect, verdict, message)
        json(res, shaped.statusCode, shaped.body)
      } else {
        res.end()
      }
    })
  })
  server.on('error', (error: Error) => log(`gateway listener error: ${error.message}`))

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, setDialect: (dialect: 'openai' | 'anthropic' | 'google' | 'gemini') => void) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const requestId = crypto.randomBytes(16).toString('hex')
    res.setHeader(REQUEST_ID_HEADER, requestId)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }
    const current = deps.settings()
    if (!current.enabled) {
      json(res, 503, openAiErrorBody('the gateway is switched off', 'service_unavailable', 'ofm_disabled'))
      return
    }
    if (path === '/' || path === '/health') {
      json(res, 200, { ok: true, service: 'our-free-model' })
      return
    }
    if (bearerOf(req as never) === '' || !keyMatches(bearerOf(req as never), current.key)) {
      json(res, 401, openAiErrorBody('missing or invalid API key', 'invalid_request_error', 'ofm_unauthorized'))
      return
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      const rows = [...modelRows(deps.models())]
      for (const chain of deps.chains?.() ?? []) {
        if (chain.enabled === false) continue
        rows.push({ id: `${CHAIN_PROVIDER}/${chain.id.slice(CHAIN_PREFIX.length)}`, object: 'model', created: 0, owned_by: CHAIN_PROVIDER })
      }
      json(res, 200, { object: 'list', data: rows })
      return
    }
    // Announcements are behind the same key fence as every other route: the
    // feed names what this machine has been told, and an unauthenticated read
    // is a free inventory of it.
    if (req.method === 'GET' && path === '/v1/announcements') {
      const feed = deps.feed?.()
      if (feed === undefined) {
        json(res, 404, openAiErrorBody('no feed on this installation', 'not_found_error', 'ofm_not_found'))
        return
      }
      json(res, 200, feed.view({ ackedIds: readAck() }))
      return
    }
    if (req.method === 'POST' && path === '/v1/announcements/ack') {
      const feed = deps.feed?.()
      if (feed === undefined) {
        json(res, 404, openAiErrorBody('no feed on this installation', 'not_found_error', 'ofm_not_found'))
        return
      }
      const body = (await readBody(req as never)) as { ids?: unknown; all?: unknown }
      const wanted = body.all === true ? feed.view({ ackedIds: readAck() }).items.map((item: any) => item.id)
        : Array.isArray(body.ids) ? body.ids.map(String) : []
      // Only ids this installation actually serves can be acknowledged, so a
      // caller cannot write an arbitrary string into the user's ack file.
      const served = new Set(feed.view({ ackedIds: readAck() }).items.map((item: any) => item.id))
      const accepted = wanted.filter(id => served.has(id))
      acknowledge(accepted)
      json(res, 200, { ok: true, acked: readAck().size, acknowledged: accepted })
      return
    }
    if (req.method === 'GET' && path === '/v1/picks') {
      const stats = deps.picks?.() ?? createPickStats()
      json(res, 200, await stats.view())
      return
    }
    // The push stream. It is behind the same key fence as everything else —
    // an unauthenticated read would hand out what this machine has been told —
    // and it holds the response open, so it is matched before the routes that
    // reply in one shot.
    if (req.method === 'GET' && path === '/v1/sponsor') {
      // The copy is data, so it is an ordinary JSON response: any surface (a
      // browser console, an agent's own renderer, curl) reads the same thing.
      // The internal `invite` code is not carried — it belongs to the UI that
      // offers a copy button, not to a transport response.
      json(res, 200, sponsorView())
      return
    }
    if (req.method === 'GET' && path === '/v1/events') {
      // The hello snapshot is what makes the hub stateless: whatever a client
      // would have missed arrives with the connection, not on a later poll.
      const feed = deps.feed?.()
      const hello = feed === undefined ? undefined : feed.view({ ackedIds: readAck() })
      hub.attach(req, res, hello)
      return
    }
    if (req.method === 'POST' && COMPLETION_PATHS.has(path)) {
      const body = await readBody(req as never)
      const result = await routeCompletion(body, requestId, url)
      sendReply(res, result)
      return
    }
    if (req.method === 'POST' && COUNT_TOKEN_PATHS.has(path)) {
      const encoded = JSON.stringify({ input_tokens: countTokensEstimate((await readBody(req as never)) as never) })
      res.writeHead(200, { ...corsHeaders(), 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(encoded)
      return
    }
    if (req.method === 'POST' && MESSAGE_PATHS.has(path)) {
      setDialect('anthropic')
      const body = await readBody(req as never)
      const result = await routeAnthropic(body, requestId)
      sendReply(res, result)
      return
    }
    if (req.method === 'POST' && RESPONSES_PATHS.has(path)) {
      const body = await readBody(req as never)
      const result = await routeResolved(body, requestId, dispatchResponsesChat)
      sendReply(res, result)
      return
    }
    const gemini = geminiRoute(path)
    if (gemini !== undefined && req.method === 'POST' && gemini.method !== 'list' && gemini.method !== 'get') {
      setDialect('gemini')
      const body = await readBody(req as never)
      const result = await routeGemini(body, requestId, gemini)
      sendReply(res, result)
      return
    }
    if (gemini?.method === 'list' && req.method === 'GET') {
      const rows = modelRows(deps.models()).map((row) => ({
        name: `models/${row.id}`,
        displayName: row.id,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      }))
      json(res, 200, { models: rows })
      return
    }
    json(res, 404, openAiErrorBody(`no route for ${req.method} ${path}`, 'not_found_error', 'ofm_not_found'))
  }

  function chainLinks(chain: ChainRow): Resolved[] {
    const out: Resolved[] = []
    for (const address of chain.models) {
      const slash = address.indexOf('/')
      if (slash <= 0) continue
      const found = resolveModel(deps.models(), address.slice(0, slash), address.slice(slash + 1))
      if (found !== undefined) out.push(found as Resolved)
    }
    return out
  }

  async function routeCompletion(body: Record<string, any>, requestId: string, url: URL): Promise<Reply> {
    const addressed = String(body.model ?? '')
    const slash = addressed.indexOf('/')
    const provider = slash > 0 ? addressed.slice(0, slash) : ''
    const modelId = slash > 0 ? addressed.slice(slash + 1) : ''
    if (provider === '' || modelId === '') {
      throw Object.assign(new Error(`model must be "<provider>/<model>", got "${addressed}"`), { statusCode: 400, body: openAiErrorBody(`model must be "<provider>/<model>", got "${addressed}"`, 'invalid_request_error', 'ofm_bad_model') })
    }
    const sessionId = url.searchParams.get('session') ?? undefined
    if (provider === CHAIN_PROVIDER) {
      const chain = chainRowOf(deps.chains?.() ?? [], `${CHAIN_PREFIX}${modelId}`)
      if (chain === undefined) {
        throw Object.assign(new Error(`no such chain on this gateway: ${addressed}`), { statusCode: 404, body: openAiErrorBody(`no such chain on this gateway: ${addressed}`, 'invalid_request_error', 'ofm_unknown_chain') })
      }
      const links = chainLinks(chain)
      if (links.length === 0) {
        throw Object.assign(new Error(`no link resolves right now: ${chain.models.join(', ')}`), { statusCode: 400, body: openAiErrorBody(`no link resolves right now: ${chain.models.join(', ')}`, 'invalid_request_error', 'ofm_dead_chain') })
      }
      return dispatchChainChat(deps.models(), chain, links, { body: { ...body, model: addressed }, requestId, sessionId }, deps.quota?.() ?? new Map())
    }
    const resolved = resolveModel(deps.models(), provider, modelId)
    if (resolved === undefined) {
      throw Object.assign(new Error(`no such model on this gateway: ${addressed}`), { statusCode: 404, body: openAiErrorBody(`no such model on this gateway: ${addressed}`, 'invalid_request_error', 'ofm_unknown_model') })
    }
    return dispatchChat(deps.models(), resolved as Resolved, { body, requestId, sessionId })
  }

  /** Resolve one `provider/model` address, then hand it to the named dispatcher. */
  async function routeResolved(body: Record<string, any>, requestId: string, dispatch: (models: LaneModels, resolved: Resolved, request: { body: Record<string, any>; requestId: string; sessionId?: string }) => Promise<Reply>): Promise<Reply> {
    const addressed = String(body.model ?? '')
    const slash = addressed.indexOf('/')
    const provider = slash > 0 ? addressed.slice(0, slash) : ''
    const modelId = slash > 0 ? addressed.slice(slash + 1) : ''
    if (provider === '' || modelId === '') {
      throw Object.assign(new Error(`model must be "<provider>/<model>", got "${addressed}"`), { statusCode: 400, body: openAiErrorBody(`model must be "<provider>/<model>", got "${addressed}"`, 'invalid_request_error', 'ofm_bad_model') })
    }
    const resolved = resolveModel(deps.models(), provider, modelId)
    if (resolved === undefined) {
      throw Object.assign(new Error(`no such model on this gateway: ${addressed}`), { statusCode: 404, body: openAiErrorBody(`no such model on this gateway: ${addressed}`, 'invalid_request_error', 'ofm_unknown_model') })
    }
    return dispatch(deps.models(), resolved as Resolved, { body, requestId })
  }

  async function routeAnthropic(body: Record<string, any>, requestId: string): Promise<Reply> {
    const addressed = String(body.model ?? '')
    const slash = addressed.indexOf('/')
    const provider = slash > 0 ? addressed.slice(0, slash) : ''
    const modelId = slash > 0 ? addressed.slice(slash + 1) : ''
    if (provider === '' || modelId === '') {
      throw Object.assign(new Error(`model must be "<provider>/<model>", got "${addressed}"`), { statusCode: 400, body: anthropicErrorBody(`model must be "<provider>/<model>", got "${addressed}"`, 'invalid_request_error') })
    }
    const resolved = resolveModel(deps.models(), provider, modelId)
    if (resolved === undefined) {
      throw Object.assign(new Error(`no such model on this gateway: ${addressed}`), { statusCode: 404, body: anthropicErrorBody(`no such model on this gateway: ${addressed}`, 'not_found_error') })
    }
    return dispatchAnthropicChat(deps.models(), resolved as Resolved, { body, requestId })
  }

  async function routeGemini(body: Record<string, any>, requestId: string, route: { method: string; model: string }): Promise<Reply> {
    if (route.method === 'countTokens') {
      const encoded = JSON.stringify({ totalTokens: Math.ceil(String(JSON.stringify(body ?? {})).length / 4) })
      return { status: 200, body: new TextEncoder().encode(encoded), headers: { 'content-type': 'application/json' } }
    }
    const contents = (body as { contents?: unknown }).contents
    if (!Array.isArray(contents) || contents.length === 0) {
      throw Object.assign(new Error('contents must be a non-empty array'), { statusCode: 400, body: geminiErrorBody(400, 'contents must be a non-empty array') })
    }
    const addressed = String(route.model || (body as { model?: string }).model || '')
    const slash = addressed.indexOf('/')
    const provider = slash > 0 ? addressed.slice(0, slash) : ''
    const modelId = slash > 0 ? addressed.slice(slash + 1) : ''
    if (provider === '' || modelId === '') {
      throw Object.assign(new Error(`model must be "<provider>/<model>", got "${addressed}"`), { statusCode: 400, body: geminiErrorBody(400, `model must be "<provider>/<model>", got "${addressed}"`) })
    }
    const resolved = resolveModel(deps.models(), provider, modelId)
    if (resolved === undefined) {
      throw Object.assign(new Error(`no such model on this gateway: ${addressed}`), { statusCode: 404, body: geminiErrorBody(404, `no such model on this gateway: ${addressed}`) })
    }
    return dispatchGeminiChat(deps.models(), resolved as Resolved, { body: { ...body, model: `${provider}/${modelId}` }, requestId })
  }

  /** A buffered reply goes out at once; a live stream is written as it arrives. */
  function sendReply(res: http.ServerResponse, result: Reply) {
    if (result.body instanceof Uint8Array) {
      res.writeHead(result.status, { ...corsHeaders(), ...result.headers })
      res.end(result.body)
      return
    }
    const deferred = deferStreamResponse(res, heartbeatMs)
    void (async () => {
      deferred.response.writeHead(result.status, { ...corsHeaders(), ...result.headers })
      const reader = (result.body as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const row = await reader.read()
        if (row.done === true) break
        deferred.response.write(row.value)
      }
      deferred.response.end()
    })().catch((error) => {
      deferred.dispose()
      if (!res.headersSent) {
        json(res, 500, openAiErrorBody(String((error as Error)?.message ?? error), 'server_error', 'ofm_stream_failed'))
      } else {
        res.end()
      }
    })
  }

  const bindAddress = await resolveLoopbackBind(settings.host)
  const bound = await bindGatewayPort(server, {
    address: bindAddress,
    port: settings.port,
    log: (message) => log(`bind: ${message}`),
  })
  if (bound.fellBack) log(`port ${bound.requested} is taken; listening on ${bound.port} instead`)

  return {
    server,
    push: hub,
    port: bound.port,
    requestedPort: bound.requested,
    fellBack: bound.fellBack,
    host: settings.host || '127.0.0.1',
    lanAddresses: () => rankLanAddresses(os.networkInterfaces()),
    close: () =>
      new Promise((resolve) => {
        // Close every held-open stream first, so a dispose cannot leave a
        // half-open response behind for the next process to inherit the port.
        hub.dispose()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown) {
  const text = JSON.stringify(payload)
  res.writeHead(status, { ...corsHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(text)) })
  res.end(text)
}

export { friendlyMessage }
