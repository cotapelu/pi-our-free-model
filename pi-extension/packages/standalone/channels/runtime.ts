/**
 * One worker thread per service instance, speaking a small request/response
 * protocol to the channel pack inside it.
 *
 * The worker boundary is *why* this file exists rather than a plain import: the
 * channel pack keeps module-level singletons (its account pool, its credential
 * cache), so two service instances in one process would share accounts across
 * data directories. A thread per instance keeps them apart without a process
 * per instance.
 *
 * The protocol is deliberately narrow — `models`, `rpc`, `complete`, `cancel`,
 * `close` — because every message crosses a structured-clone boundary and a
 * wider surface would start smuggling non-cloneable state. A `changed` notice
 * from the pack (a login, a credential write) schedules one debounced refresh
 * rather than a refresh per write: a burst of account edits is one listing
 * round, not twenty.
 *
 * Ported from dsh's `packages/standalone/channels/runtime.mjs`.
 *
 * @module pi-extension/packages/standalone/channels/runtime.js
 */

import { Worker } from 'node:worker_threads'
import { foldForwardOutcome } from '../../../core/completion.js'
import { recordTurn, recordUsage } from '../../../gateway/store.js'

export interface ChannelRuntimeOptions {
  dataDir: string
  logger?: any
  stats?: any
}

/** 一实例一 Worker，避免原渠道业务的模块单例串目录、串账号。 */
export async function createChannelRuntime({ dataDir, logger = console, stats }: ChannelRuntimeOptions) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: { dataDir },
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
  })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; onChunk?: (chunk: unknown) => void }>()
  let sequence = 0
  let closed = false
  let closing: Promise<void> | undefined
  let rows: any[] = []
  let providers: string[] = []
  let refreshing: Promise<any> | undefined
  let refreshTimer: NodeJS.Timeout | undefined
  let finishClose: (() => void) | undefined
  let failed: unknown
  let readyResolve!: () => void
  let readyReject!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const rejectAll = (error: unknown) => {
    failed = error
    readyReject(error)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  worker.on('error', rejectAll)
  worker.on('exit', (code: number) => {
    if (!closed) rejectAll(new Error(`渠道进程已退出（${code}）`))
    finishClose?.()
  })
  worker.on('message', (message: any) => {
    if (message.type === 'ready') { providers = message.providers; readyResolve(); return }
    if (message.type === 'log') { logger[message.level]?.(message.message); return }
    if (message.type === 'closed') { finishClose?.(); return }
    if (message.type === 'changed') {
      if (closed) return
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => { void refresh().catch(error => logger.warn?.(`渠道目录刷新失败：${error.message}`)) }, 200)
      refreshTimer.unref?.()
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.type === 'chunk') {
      try { entry.onChunk?.(message.chunk) } catch (error) { entry.reject(error); worker.postMessage({ type: 'cancel', id: message.id }) }
    } else if (message.type === 'error') entry.reject(Object.assign(new Error(message.message), { statusCode: message.statusCode }))
    else entry.resolve(message.value)
  })
  function call(type: string, payload: Record<string, unknown> = {}, signal?: AbortSignal, onChunk?: (chunk: unknown) => void, timeoutMs = 120000) {
    if (closed || failed) return Promise.reject(failed ?? new Error('渠道已停止'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('请求已取消'))
    const id = ++sequence
    return new Promise<unknown>((resolve, reject) => {
      const finish = (fn: (value: unknown) => void) => (value: unknown) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); fn(value) }
      const abort = () => {
        worker.postMessage({ type: 'cancel', id })
        entry.reject(signal?.reason ?? new Error('渠道请求超时或已取消'))
      }
      const timer = setTimeout(abort, timeoutMs)
      timer.unref?.()
      const entry = { resolve: finish(resolve), reject: finish(reject), onChunk }
      pending.set(id, entry)
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ type, id, ...payload })
    })
  }
  function refresh({ report = false }: { report?: boolean } = {}) {
    if (!refreshing) {
      refreshing = call('models').then(value => { rows = (value as any).rows; return value }).finally(() => { refreshing = undefined })
    }
    return report ? refreshing : refreshing.then(value => (value as any).rows)
  }
  const runtime: any = {
    get providers() { return providers },
    state() { return { state: failed ? 'failed' : 'ready', error: failed ? (failed as Error).message : '' } },
    publicModelRows: () => rows,
    refresh,
    handles: (model: string) => providers.some(provider => model.startsWith(`${provider}/`)),
    async rpc(body: any, signal?: AbortSignal) {
      if (typeof body?.method !== 'string' || !Object.hasOwn(body, 'payload')) throw Object.assign(new Error('渠道请求缺少 method 或 payload'), { statusCode: 400 })
      return call('rpc', { call: { method: body.method, payload: body.payload } }, signal, undefined, 10 * 60000)
    },
    async complete(request: any, onChunk?: (chunk: unknown) => void) {
      const outcome: any = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
      const started = Date.now()
      let first = 0
      let ok = false
      try {
        const { signal, ...wire } = request
        await call('complete', { request: wire }, signal, chunk => {
          if (!first) first = Date.now()
          foldForwardOutcome(outcome, chunk)
          onChunk?.(chunk)
        }, 30 * 60000)
        ok = outcome.error === undefined
        return outcome
      } finally {
        if (!closed && stats) {
          const usage = outcome.usage
          recordUsage(stats, {
            model: request.model, at: Date.now(), input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0,
            reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
            ok, origin: 'forward', ttftMs: first ? first - started : undefined,
            decodeMs: first ? Date.now() - first : 0, decodeTokens: usage?.completion_tokens ?? 0,
            noUsage: usage === undefined, elapsedMs: Date.now() - started, aborted: request.signal?.aborted === true,
          })
          recordTurn(stats, { model: request.model, ok, recovered: false })
        }
      }
    },
    close() {
      if (closing) return closing
      closed = true
      clearTimeout(refreshTimer)
      rejectAll(new Error('渠道正在停止'))
      closing = (async () => {
        let timer: NodeJS.Timeout | undefined
        await new Promise<void>(resolve => {
          finishClose = resolve
          worker.postMessage({ type: 'close' })
          timer = setTimeout(resolve, 1500)
        })
        clearTimeout(timer)
        await worker.terminate()
      })()
      return closing
    },
  }
  try {
    const timeout = setTimeout(() => readyReject(new Error('渠道初始化超时')), 30000)
    try { await ready } finally { clearTimeout(timeout) }
    runtime.ready = refresh().catch(error => { if (!closed) logger.warn?.(`渠道启动清单刷新失败：${error.message}`) })
    return runtime
  } catch (error) { await runtime.close(); throw error }
}
