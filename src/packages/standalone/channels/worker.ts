/**
 * The channel pack's host, inside the standalone's worker thread.
 *
 * One worker per service instance: the channel pack keeps module-level state
 * (its account pool, its credential cache), so two instances sharing a module
 * would share accounts — the one thing a multi-account standalone must never do.
 * This file is the whole kernel surface the pack sees: a `platform` with the
 * data dir, a `credentials` store, a `logger`, an `attachments` bridge, an `llm`
 * registry, and a `connection.fetch` router for its management RPC.
 *
 * The harness-to-OpenAI projection (`harnessBody`) is the part that is easy to
 * get wrong: a request arriving over `/v1/messages` carries harness messages and
 * flat tools, and handing those to an adapter that parses OpenAI bodies loses
 * the tools, `max_tokens` and temperature without any error at all.
 *
 * Ported from dsh's `packages/standalone/channels/worker.mjs`.
 *
 * @module pi-extension/packages/standalone/channels/worker.js
 */

import { parentPort, workerData } from 'node:worker_threads'
import { createCredentials } from './credentials.js'
import { attachments } from './images.js'
import { toChatMessages, toToolDefs } from '../../../messages.js'
import {
  apply, toGenerateOptions, toResponsesGenerateOptions, normalizeReasoningEffort,
  responsesReasoningEffort, normalizeMaxTokens, responsesMaxOutputTokens, markGatewayChannel,
  collectGatewayModels, collectGatewayEffortViews, toOpenAiModels,
} from './business.mjs'

const cleanups: Array<() => void | Promise<void>> = []
const adapters = new Map<string, any>()
const routes = new Map<string, any>()
const controllers = new Map<string, AbortController>()
let closed = false
const send = (message: unknown) => parentPort?.postMessage(message)
const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (message: unknown) => send({ type: 'log', level, message: String(message) })]))
const credentials = createCredentials(workerData.dataDir)
const ctx: any = {
  platform: { channelHome: workerData.dataDir }, credentials, logger, attachments,
  connection: { fetch: { register(route: any) { routes.set(route.path, route) } } },
  get(name: string) { return this[name] },
  provide(name: string, value: unknown) {
    if (Object.hasOwn(this, name)) throw new Error(`服务重复注册：${name}`)
    this[name] = value
  },
  effect(body: () => void | (() => void | Promise<void>)) {
    const cleanup = body()
    if (typeof cleanup === 'function') {
      if (closed) void cleanup()
      else cleanups.push(cleanup)
    }
    return cleanup
  },
  inject(names: string[], body: (ctx: any) => unknown) { if (names.every(name => this[name] !== undefined)) return body(this) },
  emit() { send({ type: 'changed' }) },
  llm: {
    registerAdapter(providers: string[], adapter: any) {
      for (const provider of providers) {
        if (adapters.has(provider)) throw new Error(`渠道重复注册：${provider}`)
        adapters.set(provider, adapter)
      }
    },
    listProviders() { return [...adapters.keys()].map(id => ({ id })) },
    async listModels(provider: string) { return await adapters.get(provider)?.listModels(provider) ?? [] },
    async resolveModel(provider: string, model: string, signal?: AbortSignal) {
      const adapter = adapters.get(provider)
      if (!adapter) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
      return adapter.resolveModel(provider, model, signal)
    },
    async resolveModelInfo(provider: string, model: string, signal?: AbortSignal) { return this.resolveModel(provider, model, signal) },
    async *stream(options: any) {
      const adapter = adapters.get(options.provider)
      if (!adapter) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
      const call = await adapter.prepareCall(options.provider, options.model, options.signal)
      yield* call.stream(options)
    },
  },
}

async function models() {
  const sources: Record<string, { ok: boolean; count: number }> = Object.fromEntries([...adapters.keys()].map(provider => [provider, { ok: false, count: 0 }]))
  const onError = (provider: string, error: any) => logger.warn(`${provider} 模型目录读取失败：${error.message}`)
  const groups = (await Promise.all([...adapters.keys()].map(provider => collectGatewayModels({
    listProviders: () => [{ id: provider }],
    listModels: (id: string) => ctx.llm.listModels(id),
  }, onError)))).flat()
  for (const { provider, models } of groups) sources[provider] = { ok: true, count: models.length }
  const infos = new Map<string, any>()
  const views = await collectGatewayEffortViews({
    async resolveModelInfo(provider: string, model: string) {
      const info = await ctx.llm.resolveModel(provider, model)
      infos.set(`${provider}/${model}`, info)
      return info
    },
  }, groups, onError)
  const rows = toOpenAiModels(groups, views).map((row: any) => ({
    ...row, channel: row.owned_by, vision: row.input?.includes('image') === true,
    context_window: row.context_window ?? infos.get(row.id)?.context?.contextWindow,
    max_tokens: row.max_tokens ?? infos.get(row.id)?.defaultMaxTokens,
  }))
  return { rows, sources }
}

async function rpc(call: any, signal?: AbortSignal) {
  const route = routes.get('/api/channel-pack')
  if (!route) throw new Error('渠道管理接口未注册')
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ type: 'client-request', rpcId: 'standalone', method: 'channel-pack', payload: call }),
  }))
  const reply = await response.json()
  return reply.result
}

/**
 * Project the Anthropic/harness request shape onto the OpenAI body the channel
 * adapters parse. `/v1/messages` hands over harness messages and flat tools,
 * not an `openAi` body; without this the adapter rejects the turn for having no
 * messages and silently loses tools, max_tokens and temperature.
 */
function harnessBody(request: any) {
  const body: any = { messages: toChatMessages(Array.isArray(request.messages) ? request.messages : []) }
  if (Array.isArray(request.tools) && request.tools.length > 0) body.tools = toToolDefs(request.tools)
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.reasoningEffort === 'string' && request.reasoningEffort !== '') body.reasoning_effort = request.reasoningEffort
  return body
}

async function complete(request: any, id: string, signal: AbortSignal) {
  const slash = request.model.indexOf('/')
  const provider = request.model.slice(0, slash)
  const model = request.model.slice(slash + 1)
  // 禁用模型和供应商必须同时影响统一 API，不能只隐藏页面。
  if (!(await ctx.llm.listModels(provider)).some((row: any) => row.id === model)) throw Object.assign(new Error('模型不存在或已停用'), { statusCode: 404 })
  const body = { ...(request.responsesBody ?? request.openAi ?? harnessBody(request)), model: request.model }
  const resolved = await ctx.llm.resolveModel(provider, model, signal)
  const effort = normalizeReasoningEffort(request.responses ? responsesReasoningEffort(body) : body.reasoning_effort, resolved, provider, model,
    (notice: any) => logger.info(`${request.model}：思考档位 ${notice.requested} ${notice.applied ? `映射为 ${notice.applied}` : '使用模型默认'}`))
  const requested = request.responses ? responsesMaxOutputTokens(body) : body.max_completion_tokens ?? body.max_tokens
  const maxTokens = typeof requested === 'number' ? normalizeMaxTokens(requested, provider, model) : undefined
  const convert = request.responses ? toResponsesGenerateOptions : toGenerateOptions
  const options = await convert(body, signal, effort, maxTokens, { bridge: attachments }, (dropped: any) => logger.warn(`忽略无法表达的工具类型：${dropped.type}`))
  options.sessionId = `standalone:${String(body.user ?? body.conversation ?? 'shared')}`
  for await (const chunk of ctx.llm.stream(markGatewayChannel(options))) {
    if (signal.aborted) throw new Error('请求已取消')
    send({ type: 'chunk', id, chunk })
  }
}

parentPort?.on('message', async (message: any) => {
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return }
  if (message.type === 'close') {
    closed = true
    for (const controller of controllers.values()) controller.abort()
    credentials.dispose()
    for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch {} }
    send({ type: 'closed' })
    return
  }
  const { id, type } = message
  const controller = new AbortController()
  controllers.set(id, controller)
  try {
    if (closed) throw new Error('渠道已停止')
    if (type === 'models') send({ type: 'result', id, value: await models() })
    else if (type === 'rpc') send({ type: 'result', id, value: await rpc(message.call, controller.signal) })
    else if (type === 'complete') { await complete(message.request, id, controller.signal); send({ type: 'result', id }) }
    else throw new Error('未知渠道操作')
  } catch (error: any) {
    send({ type: 'error', id, message: error.message, statusCode: error.statusCode ?? error.status })
  } finally { controllers.delete(id) }
})

apply(ctx, { disableOpencode: true })
send({ type: 'ready', providers: [...adapters.keys()] })
