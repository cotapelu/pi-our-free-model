/**
 * Outbound wire for the co-paid lane.
 *
 * Two lane modes, decided by the credential the sealed store hands over:
 *
 * - `direct` — one bearer credential, straight to the relay.
 * - `worker` — a signing gateway in front of the relay carries the real
 *   credential in its own environment; requests here carry no secret at all,
 *   only an HMAC-SHA256 signature over `timestamp \n METHOD \n path \n
 *   sha256(body)` under the seal's shared signing secret, plus the timestamp
 *   for the gateway's replay window. A seal extracted from this package is
 *   therefore an indirect entry the gateway can revoke (rotate its accepted
 *   secrets), not the credential itself.
 *
 * The credential material arrives per call from `vault.js` and lives only
 * inside the call frame that builds the headers; nothing here logs it, caches
 * it, or names it in an error. Every failure is classified into the same
 * harness-neutral codes the free lane uses, with the endpoint and every secret
 * absent from every message.
 *
 * Ported from dsh's `src/eac.js`.
 *
 * @module pi-extension/eac.js
 */

import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import { classifyFailure, forwardFailure, FAILURE_KIND } from './gateway/classify.js'
import { readEacUser } from './eac-user.js'
import { readHead, replayStream, sniffBody, transportCause, SNIFF_BYTES } from './transport.js'

const LISTING_TIMEOUT_MS = 15000
const TURN_TIMEOUT_MS = 300000

/**
 * The socket-level fact behind a transport failure, walked off the error's
 * `cause` chain. (Duplicate of transport.ts:transportCause for module
 * independence; eac.ts must not depend on gateway modules beyond classify.)
 */
function socketCause(error: unknown): string {
  const parts: string[] = []
  let node: any = error
  for (let depth = 0; depth < 3 && node?.cause !== undefined; depth += 1) {
    node = node.cause
    if (node === null || typeof node !== 'object') break
    const code = typeof node.code === 'string' && node.code !== '' ? node.code : ''
    const line = typeof node.message === 'string' ? node.message.split('\n')[0].trim() : ''
    if (line === '' && code === '') continue
    const fact = line === '' || line.includes(code) ? (line === '' ? code : line) : `${line} (${code})`
    if (!parts.includes(fact)) parts.push(fact)
  }
  return parts.length > 0 ? ` — ${parts.join('; ')}` : ''
}

/** An upstream error with a machine-readable code. */
export class UpstreamError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
  }
}

export const CODE = {
  aborted: 'aborted',
  timeout: 'timeout',
  transport: 'transport',
  empty: 'empty',
  client: 'client',
  server: 'server',
  credential: 'credential',
}

/**
 * Test seam: the offline suite drives this lane through a fetch-shaped stub
 * (it must not reach the network). Production code never touches it — the
 * whole point of laneFetch is that nothing else in the process can intercept
 * the signed bytes. Assignment is module-private by convention, exactly like
 * the free lane's upstream override.
 */
export const lane = { fetch: null as any, proxy: undefined as any }

type ProxyConfig = { server: string; bypass: string } | null

const proxyDispatchers = new Map<string, any>()
let windowsProxy: ProxyConfig = null
let windowsProxyAt = 0

function proxyBypassed(target: URL, patterns: string, windows = false): boolean {
  const hostname = target.hostname.toLowerCase()
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')
  return String(patterns ?? '').split(/[;,\s]+/).filter(Boolean).some((raw: string) => {
    let pattern = raw.toLowerCase()
    if (pattern === '*') return true
    if (windows && pattern === '<local>') return !hostname.includes('.') && !hostname.includes(':')
    const withPort = /^(.*):(\d+)$/.exec(pattern)
    if (withPort) {
      if (withPort[2] !== port) return false
      pattern = withPort[1]
    }
    if (pattern.includes('*')) {
      const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return new RegExp(`^${escaped}$`, 'i').test(hostname)
    }
    const domain = pattern.replace(/^\./, '')
    return hostname === domain || (!windows && hostname.endsWith(`.${domain}`))
  })
}

function parseWindowsProxy(output: string): ProxyConfig {
  const value = (name: string): string => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'mi').exec(output)?.[1]?.trim() ?? ''
  if (Number(value('ProxyEnable')) !== 1 || value('ProxyServer') === '') return null
  return { server: value('ProxyServer'), bypass: value('ProxyOverride') }
}

async function readWindowsProxy(): Promise<ProxyConfig> {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  try {
    const { stdout } = await promisify(execFile)(executable, [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024, encoding: 'utf8' })
    return parseWindowsProxy(stdout)
  } catch { return null }
}

function windowsProxyFor(target: URL, config: ProxyConfig): string | null {
  if (config === null) return null
  if (proxyBypassed(target, config.bypass, true)) return null
  if (!config.server.includes('=')) return config.server
  const entries = new Map(config.server.split(';').map((row: string) => {
    const at = row.indexOf('=')
    return [row.slice(0, at).trim().toLowerCase(), row.slice(at + 1).trim()]
  }))
  return entries.get(target.protocol.slice(0, -1)) ?? null
}

function supportedProxy(address: string): string | null {
  if (!address) return null
  try {
    const url = new URL(String(address).includes('://') ? String(address) : `http://${address}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? address : null
  } catch { return null }
}

async function proxyFor(target: URL): Promise<string | null> {
  if (lane.proxy !== undefined) return typeof lane.proxy === 'function' ? lane.proxy(target) : lane.proxy
  const env = process.env
  const address = (target.protocol === 'https:' ? env.HTTPS_PROXY ?? env.https_proxy : env.HTTP_PROXY ?? env.http_proxy)
    ?? env.ALL_PROXY ?? env.all_proxy
  if (address) return proxyBypassed(target, env.NO_PROXY ?? env.no_proxy ?? '') ? null : supportedProxy(address)
  if (process.platform !== 'win32') return null
  if (windowsProxy === undefined || Date.now() - windowsProxyAt >= 30_000) {
    windowsProxyAt = Date.now()
    windowsProxy = await readWindowsProxy()
  }
  const config = await windowsProxy
  if (config === null) return null
  const proxy = windowsProxyFor(target, config)
  return proxy === null ? null : supportedProxy(proxy)
}

let undiciModule: any = undefined
async function loadUndici(): Promise<any> {
  if (undiciModule === undefined) {
    try { undiciModule = await import('undici') } catch { undiciModule = null }
  }
  return undiciModule
}

async function dispatcherFor(address: string): Promise<any> {
  const url = new URL(String(address).includes('://') ? String(address) : `http://${address}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UpstreamError(`unsupported EAC proxy protocol ${url.protocol}`, CODE.transport)
  const mod = await loadUndici()
  if (mod === null) {
    throw new UpstreamError(
      `an EAC proxy is configured (${url.host}) but undici is unavailable in this host; install undici or clear the proxy`,
      CODE.transport,
    )
  }
  const key: string = url.href
  if (!proxyDispatchers.has(key)) {
    proxyDispatchers.set(key, new mod.EnvHttpProxyAgent({ httpProxy: key, httpsProxy: key, noProxy: '' }))
  }
  return proxyDispatchers.get(key)
}

/**
 * Test seam for the per-user authorization token (src/eac-user.js), same
 * convention as `lane`: `undefined` reads the file, any other value —
 * `null` included — is used as-is, so the offline suite never touches a home.
 */
export const laneUser = { token: undefined as string | undefined }

/** The GitHub authorization this install holds, or null. Never logged. */
function laneUserToken(): string | null {
  if (laneUser.token !== undefined) return laneUser.token
  try { return readEacUser()?.token ?? null } catch { return null }
}

/**
 * The lane's module-private transport, shared with the pool proxy: plugin
 * backend outbound calls must not ride the swappable global fetch (#50 class
 * of interference — the signed lane already learned this the hard way), and
 * the sealed gateway URL should only ever travel over this module's bytes.
 */
export { laneFetch as directFetch }

type LaneFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  redirect?: string
}

type LaneFetchResponse = {
  ok: boolean
  status: number
  headers: { get: (name: string) => string | string[] | null }
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  json(): Promise<any>
}

/**
 * The lane's own poster over `node:http`/`node:https`, not the global fetch.
 * The signature covers sha256(body), so the body must reach the gateway
 * byte-for-byte as signed. Local proxy plugins (billion-context et al.) work
 * by replacing `globalThis.fetch` and re-serializing the request body on the
 * way out; a re-serialized body breaks the HMAC even though the credential is
 * perfectly valid, and the gateway answers `request signature rejected`
 * (issue #50). The core `node:https` module cannot be swapped by another
 * plugin, so the signed bytes leave this process untouched.
 */
async function laneFetch(url: string, { method = 'GET', headers = {}, body = undefined, signal }: LaneFetchInit = {}): Promise<LaneFetchResponse> {
  if (signal?.aborted === true) return Promise.reject(new UpstreamError('request aborted', CODE.aborted))
  if (typeof lane.fetch === 'function') return lane.fetch(url, { method, headers, body, signal })
  const target = new URL(url)
  const proxy = await proxyFor(target)
  if (proxy) {
    if ((await loadUndici()) === null) {
      throw new UpstreamError(
        `an EAC proxy is configured (${new URL(proxy).host}) but undici is unavailable in this host; install undici or clear the proxy`,
        CODE.transport,
      )
    }
    return (await loadUndici()).fetch(target, {
      method, headers, body, signal, redirect: 'manual', dispatcher: await dispatcherFor(proxy),
    }) as any
  }
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'http:' ? http : https
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method,
      headers: body !== undefined ? { ...headers, 'content-length': Buffer.byteLength(body, 'utf8') } : headers,
    }, response => {
      resolve({
        ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
        status: response.statusCode ?? 0,
        headers: { get: (name: string) => response.headers[String(name).toLowerCase()] ?? null },
        body: Readable.toWeb(response),
        async text() {
          const chunks = []
          for await (const chunk of response) chunks.push(Buffer.from(chunk))
          return Buffer.concat(chunks).toString('utf8')
        },
        async json() { return JSON.parse(await (this as any).text()) },
      })
    })
    request.on('error', reject)
    const abort = () => request.destroy(new Error('The operation was aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => signal?.removeEventListener?.('abort', abort))
    if (body !== undefined) request.write(body, 'utf8')
    request.end()
  })
}

/**
 * The signing headers for one gateway request. Exported for the offline suite,
 * which pins the exact wire format the gateway validates.
 *
 * @param {string} signingSecret - shared HMAC key from the seal
 * @param {{ method: string, path: string, body?: string }} parts - uppercase method, URL pathname, raw body ('' when none)
 * @param {number} [now] - wall clock, injectable for tests
 * @returns {{ 'x-ofm-timestamp': string, 'x-ofm-signature': string }}
 */
export function signSealedRequest(signingSecret: string, { method, path, body = '' }: { method: string; path: string; body?: string }, now: number = Date.now()) {
  const timestamp = String(Math.trunc(now))
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  const mac = crypto.createHmac('sha256', signingSecret)
    .update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`, 'utf8')
    .digest('hex')
  return { 'x-ofm-timestamp': timestamp, 'x-ofm-signature': mac }
}

/** Wire headers for one request, per lane mode. The signed path is the full
 * URL pathname — exactly what the gateway recomputes from its own request. */
function headersFor(credential: any, method: string, fullUrl: string, body: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept': method === 'POST' ? 'text/event-stream' : 'application/json',
    'user-agent': 'dsh-our-free-model',
  }
  if (credential.mode === 'worker') {
    const pathname = new URL(fullUrl).pathname
    const signed = { ...headers, ...signSealedRequest(credential.signingSecret, { method, path: pathname, body }) }
    const userToken = Object.hasOwn(credential, 'userToken') ? credential.userToken : laneUserToken()
    return userToken === null ? signed : { ...signed, 'x-ofm-user': userToken }
  }
  return { ...headers, 'authorization': `Bearer ${credential.apiKey}` }
}

/** A proxy in front of the relay answers hard failures with a whole HTML error
 * page — Cloudflare's 524 origin-timeout page being the common one. Pasting it
 * into the harness buries the one useful fact (the status) under markup, so an
 * unparseable body that is HTML reduces to one readable line. */
function errorPageMessage(text: string, status: number): string {
  const head = String(text ?? '')
  if (/^\s*<(!doctype|html)/i.test(head)) return `the gateway's front proxy answered HTTP ${status} with an HTML error page`
  return head.slice(0, 300) || `HTTP ${status}`
}

/** The envelope's own message, or the whole body when it names none. */
function messageOf(payload: any, status: number): string {
  const named = payload?.error?.message ?? payload?.message
  if (typeof named === 'string' && named !== '') return named
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return raw.slice(0, 300) || `HTTP ${status}`
}

/**
 * Failure-kind → the lane's own code vocabulary.
 *
 * `gateway/classify.js` is a *pure* verdict table: it answers what went wrong
 * and how long to bench the endpoint, and it deliberately carries no message
 * and no host code. The lane's callers read something else — `adapter.js`'s
 * `toFailure` reads `message`/`code`/`status` off a thrown error, and the
 * runtime reads `CODE.credential` to hide a lane whose credential was refused.
 * So the verdict is mapped onto that vocabulary here, once, and the envelope's
 * own message rides the error: a bare `HTTP 403` tells nobody anything.
 */
function codeOf(kind: string): string {
  if (kind === 'auth' || kind === 'permission') return CODE.credential
  if (kind === 'timeout') return CODE.timeout
  if (kind === 'invalid_request' || kind === 'context_window') return CODE.client
  if (kind === 'rate_limit' || kind === 'overloaded' || kind === 'unavailable' || kind === 'upstream') return CODE.server
  return CODE.transport
}

/**
 * Classify one refusal into the lane's own `UpstreamError`, carrying the
 * envelope's message, the mapped code and the verdict that produced them.
 *
 * The verdict is attached rather than discarded: a caller that wants the
 * cooldown or the scope reads it off `error.verdict` instead of re-deriving
 * it from a code the mapping collapsed.
 */
function classifyToUpstream(status: number, payload: any, retryAfterMs?: number): UpstreamError {
  const verdict = classifyFailure({ status, body: payload, retryAfterMs })
  const error = new UpstreamError(messageOf(payload, status), codeOf(verdict.kind))
  if (Number.isFinite(retryAfterMs as number) && (retryAfterMs as number) > 0) {
    (error as any).providerRetryAfterMs = Math.trunc(retryAfterMs as number)
  }
  if (verdict.status !== undefined) (error as any).status = verdict.status
  if (verdict.cooldownMs > 0) (error as any).cooldownMs = verdict.cooldownMs
  ;(error as any).kind = verdict.kind
  ;(error as any).scope = verdict.scope
  ;(error as any).retryable = verdict.retryable
  ;(error as any).rule = verdict.rule
  ;(error as any).verdict = verdict
  return error
}

/** One listing round: `GET {base}/models`. Returns the parsed JSON document. */
export async function fetchSealedListing(credential: any, { signal, timeoutMs = LISTING_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  const listingUrl = `${credential.base}/models`
  try {
    const response = await laneFetch(listingUrl, { headers: headersFor(credential, 'GET', listingUrl, ''), redirect: 'error', signal: controller.signal } as any)
    const text = await response.text()
    let payload: any
    try { payload = JSON.parse(text) } catch { payload = { error: { message: errorPageMessage(text, response.status) } } }
    if (!response.ok) throw classifyToUpstream(response.status, payload)
    return payload
  } catch (error: any) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (error?.name === 'AbortError') throw new UpstreamError('model listing timed out', CODE.timeout)
    throw new UpstreamError(`model listing failed: ${error?.message ?? error}${socketCause(error)}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }
}

/**
 * POST one turn and stream back decoded SSE `data:` payloads.
 *
 * Mirrors the free lane's poster byte-for byte in discipline — body-shape sniff
 * before believing the Content-Type, head replay so no token is buffered — and
 * drops everything the free lane needs that this relay does not: session
 * fingerprints, request ids, the pooled-credential UA.
 */
export async function postSealedStreamed({ credential, body, signal, onData, timeoutMs = TURN_TIMEOUT_MS }: {
  credential: any
  body: any
  signal?: AbortSignal
  onData: (payload: string) => void
  timeoutMs?: number
}): Promise<{ status: number }> {
  const bodyText = JSON.stringify(body)
  const turnUrl = `${credential.base}/chat/completions`
  let response: any
  try {
    response = await laneFetch(turnUrl, {
      method: 'POST',
      headers: headersFor(credential, 'POST', turnUrl, bodyText),
      body: bodyText,
      redirect: 'error',
      signal,
    })
  } catch (error: any) {
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`model request failed: ${error?.message ?? error}${socketCause(error)}`, CODE.transport)
  }

  const retryHeader = response.headers.get('retry-after')
  const retrySeconds = retryHeader === null ? NaN : Number(retryHeader)
  const setRetry = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.trunc(retrySeconds * 1000) : undefined
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload: any
    try { payload = JSON.parse(text) } catch { payload = { error: { message: errorPageMessage(text, response.status) } } }
    throw classifyToUpstream(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('model stream returned no body', CODE.empty)

  const head = await readHead(response.body, SNIFF_BYTES, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('model stream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status }
  }

  let text = head.text
  if (head.done !== true) {
    try {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) text += head.decoder.decode(row.value, { stream: true })
      }
    } catch (error: any) {
      await head.reader.cancel().catch(() => {})
      classifyStreamFailure(error, signal)
    }
  }
  text += head.decoder.decode()
  let payload: any
  try { payload = JSON.parse(text) } catch {
    if (/^\s*<(!doctype|html[\s>])/i.test(text)) {
      throw new UpstreamError(errorPageMessage(text, response.status), CODE.client)
    }
    throw new UpstreamError(`unexpected non-stream response: ${text.slice(0, 200)}`, CODE.server)
  }
  if (payload.error) throw classifyToUpstream(response.status, payload)
  onData(JSON.stringify(payload))
  return { status: response.status }
}

/** Classify a stream read failure. Ported from src/http.js classifyStreamFailure. */
function classifyStreamFailure(error: any, signal?: AbortSignal): never {
  if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
  throw new UpstreamError(`stream read failed: ${error?.message ?? error}${socketCause(error)}`, CODE.transport)
}

/** Read SSE from a stream, pushing each `data:` payload to onData. */
async function readSse(stream: ReadableStream<Uint8Array>, onData: (payload: string) => void, signal?: AbortSignal, timeoutMs = TURN_TIMEOUT_MS) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (true) {
      if (signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
      const row: any = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new UpstreamError('SSE read timed out', CODE.timeout)), Math.max(0, deadline - Date.now()))
          t.unref?.()
          signal?.addEventListener('abort', () => reject(new UpstreamError('request aborted', CODE.aborted)), { once: true })
        }),
      ])
      if (row.done) break
      buffer += decoder.decode(row.value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLine = block.split('\n').find((line: string) => line.startsWith('data: '))
        if (dataLine) {
          const payload = dataLine.slice(6)
          if (payload !== '[DONE]') onData(payload)
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}
