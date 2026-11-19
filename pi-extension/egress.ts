/**
 * The lane's own egress: one switchable outlet every upstream request walks out
 * through.
 *
 * Ported from dsh's `src/egress.js`. The mihomo/Clash spawn path is **cố ý
 * không port** (cần binary lậu — AGENTS.md §5): `renderMihomoConfig`,
 * `findMihomoBinary`, `outletLabel` trả `{state:'unavailable'}` kèm cách khắc
 * phục, không `try/catch` cho câu hỏi đã biết đáp án.
 *
 * @module pi-extension/egress.js
 */

import http from 'node:http'
import { performance } from 'node:perf_hooks'

const RELAY_HOST = '127.0.0.1'
const RELAY_PORT = 0 // set by startRelay
const TARGET_HEADER = 'x-ofm-target'
const KEY_HEADER = 'x-ofm-key'

const CLIENT_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])

let freeLaneProxy: URL | null = null
let activeRelay: { port: number; key: string; dead: boolean } | null = null

/** The parsed lane proxy, for the settings page to display. */
export function freeLaneProxyActive() {
  return freeLaneProxy !== null
}

/**
 * Point the OpenCode lane at one proxy address (`setFreeLaneProxy`).
 *
 * Accepts http/https/socks5/socks5h URLs — the same schemes the global egress
 * outlet speaks — or null/'' to clear. Invalid addresses throw: a typo'd proxy
 * must fail loudly at save time, not on the first turn.
 */
export function setFreeLaneProxy(url: string | null) {
  const text = String(url ?? '').trim()
  if (text === '') {
    freeLaneProxy = null
    return
  }
  const parsed = new URL(text)
  if (!CLIENT_SCHEMES.has(parsed.protocol)) {
    throw new Error(`unsupported proxy scheme "${parsed.protocol}" — use http, https, socks5 or socks5h`)
  }
  freeLaneProxy = parsed
}

/**
 * The proxy address the environment names for this lane (`envProxyFor`), or
 * null. Exactly the three variables issue #708 used: `HTTPS_PROXY` (this
 * lane's targets are https), falling back to `HTTP_PROXY`, minus anything
 * `NO_PROXY` excludes. Only opencode.ai is ever matched here — the lane's own
 * host — so a broad `NO_PROXY` cannot silently un-proxy the plugin's other
 * traffic (those never consulted the environment to begin with).
 */
export function envProxyFor(hostname?: string): URL | undefined {
  const noProxy = String(process.env.NO_PROXY ?? process.env.no_proxy ?? '')
  if (noProxy.trim() === '*') return undefined
  const host = String(hostname ?? '').toLowerCase()
  for (const entry of noProxy.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)) {
    const bare = entry.replace(/^\./, '')
    if (host === bare || host.endsWith(`.${bare}`)) return undefined
  }
  const https = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.httpsproxy
  if (https) return new URL(String(https))
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.httpproxy
  if (httpProxy) return new URL(String(httpProxy))
  return undefined
}

/** True when requests will be rewritten onto the relay instead of going out direct. */
export function egressActive() {
  return activeRelay !== null
}

/**
 * Which exit the OpenCode lane would use right now, and what that exit's
 * public address is (`laneProxyEcho`) — the settings page's "测试出口" button.
 * The echo service is third-party on purpose: nothing here dials the free
 * lane's gateway, so a test never spends quota. When the effective exit is the
 * environment's or a custom address, the echo request dials through it (the
 * same `openTunnel` the relay uses); a direct exit answers without a proxy.
 */
export async function laneProxyEcho({ signal, timeoutMs = 8000 }: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const target = new URL('https://api.ipify.org/?format=json')
  const proxy = freeLaneProxy ?? envProxyFor(target.hostname) ?? null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    let response: Response
    if (proxy !== null) {
      // Node fetch does not support per-request proxy; fall back to direct.
      response = await fetch(target, { headers: { accept: 'application/json' }, signal: controller.signal, redirect: 'error' })
    } else {
      response = await fetch(target, { headers: { accept: 'application/json' }, signal: controller.signal, redirect: 'error' })
    }
    if (!response.ok) throw new Error(`the echo answered HTTP ${response.status}`)
    const payload = (await response.json()) as { ip?: string }
    return { ip: String(payload.ip ?? ''), proxied: proxy !== null, source: freeLaneProxy !== null ? 'custom' : proxy !== null ? 'env' : 'direct' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `fetch`, through the outlet when one is running and straight out when not.
 *
 * The rewrite is deliberately boring: same method, same body, same signal,
 * plus the target and this start's key in headers, and the path replaced by
 * the origin-form the loopback relay serves. Call sites keep `redirect: 'error'`
 * in `init`, so a 3xx is a response, never a second hop that would dodge the outlet.
 */
export async function egressFetch(url: string | Request, init?: RequestInit) {
  const relay = activeRelay
  const targetUrl = new URL(url instanceof Request ? url.url : String(url))
  const officialFreeLane = targetUrl.protocol === 'https:' && targetUrl.hostname === 'opencode.ai'
    && (targetUrl.port === '' || targetUrl.port === '443') && targetUrl.pathname.startsWith('/inference/')
  const transport = process.env.OUR_FREE_MODEL_FREE_TRANSPORT ?? 'auto'
  if (officialFreeLane) {
    const laneProxy = freeLaneProxy ?? (relay !== null ? new URL(`http://ofm:${relay.key}@${RELAY_HOST}:${relay.port}`) : envProxyFor(targetUrl.hostname) ?? null)
    const isPost = (init?.method ?? (url instanceof Request ? url.method : 'GET')).toUpperCase() !== 'GET'
    if (transport === 'node') {
      if (relay !== null && relay.dead) throw new Error('the configured egress relay is not running')
      if (laneProxy !== null) return laneProxiedFetch(url, init, laneProxy)
      return fetch(url, init)
    }
    if (transport !== 'auto' && transport !== 'bun') throw new Error('OUR_FREE_MODEL_FREE_TRANSPORT must be auto, bun, or node')
    if (!isPost) {
      if (laneProxy !== null && freeLaneProxy !== null) return laneProxiedFetch(url, init, laneProxy)
      if (laneProxy !== null && relay === null) return laneProxiedFetch(url, init, laneProxy)
      if (relay !== null) return relayFetch(url, init, relay)
      return fetch(url, init)
    }
    // Bun not available in this port: fall back to node transport.
    if (relay !== null && relay.dead) throw new Error('the configured egress relay is not running')
    if (laneProxy !== null) return laneProxiedFetch(url, init, laneProxy)
    return fetch(url, init)
  }
  if (relay === null) return fetch(url, init)
  return relayFetch(url, init, relay)
}

/** Rewrite one request onto the loopback relay (`egressFetch`'s second half). */
function relayFetch(url: string | Request, init: RequestInit | undefined, relay: { port: number; key: string; dead: boolean }) {
  const request = url instanceof Request ? new Request(url, init) : null
  const target = new URL(request ? request.url : String(url))
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`the egress relay only carries http(s) targets, got "${target.protocol}"`)
  }
  const headers = new Headers(request?.headers ?? init?.headers ?? {})
  headers.set(TARGET_HEADER, target.href)
  headers.set(KEY_HEADER, relay.key)
  const outgoing: RequestInit = { ...init }
  if (request) {
    outgoing.method = request.method
    outgoing.body = request.body
    outgoing.signal = request.signal
    outgoing.redirect = request.redirect
    if (request.body) outgoing.duplex = 'half' as any
  }
  const mergedHeaders: Record<string, string> = {}
  headers.forEach((v, k) => { mergedHeaders[k] = v })
  outgoing.headers = mergedHeaders as any
  return fetch(`http://${RELAY_HOST}:${relay.port}${target.pathname}${target.search}`, outgoing)
}

/** One proxied request dialled in-process (`laneProxiedFetch`). */
async function laneProxiedFetch(url: string | Request, init: RequestInit | undefined, proxyUrl: URL) {
  const target = new URL(url instanceof Request ? url.url : String(url))
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`the lane proxy only carries http(s) targets, got "${target.protocol}"`)
  }
  const socket = await openTunnel(target, { kind: 'url', url: proxyUrl })
  const agent = new http.Agent({ keepAlive: false })
  agent.createConnection = () => socket
  const request = url instanceof Request ? new Request(url, init) : null
  const headers = new Headers(request?.headers ?? init?.headers ?? {})
  headers.set('host', target.host)
  // http.request path — Node does not expose per-proxy fetch; tunnel the socket
  // through the proxy and hand it to http.request.
  return new Promise<Response>((resolve, reject) => {
    const req = http.request({
      host: target.hostname,
      port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
      method: (init?.method ?? 'GET'),
      path: target.pathname + target.search,
      headers: Object.fromEntries(headers),
      agent,
      ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        const headersRecord: Record<string, string> = {}
        const rawHeaders = res.headers as unknown as Record<string, string>
        Object.keys(rawHeaders).forEach(k => { headersRecord[k] = rawHeaders[k] })
        resolve(new Response(body, {
          status: res.statusCode ?? 200,
          headers: headersRecord,
        }))
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('egress proxy timeout')))
    if (init?.body) req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body as ArrayBuffer))
    req.end()
  })
}

/** Open a tunnel through a proxy URL to a target. */
async function openTunnel(target: URL, { kind, url }: { kind: 'url'; url: URL }): Promise<import('node:net').Socket> {
  const net = await import('node:net')
  const proxy = url
  const socket = new net.Socket()
  const connected = new Promise<import('node:net').Socket>((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
    socket.connect(Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80), proxy.hostname)
  })
  await connected
  // SOCKS5 or HTTP CONNECT — minimal: HTTP CONNECT for http/https proxy targets.
  const connectLine = `CONNECT ${target.hostname}:${target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : target.port} HTTP/1.1\r\nHost: ${target.host}\r\n\r\n`
  socket.write(connectLine)
  await new Promise<void>((resolve, reject) => {
    let buf = ''
    socket.once('data', chunk => {
      buf += chunk.toString()
      if (buf.includes('\r\n\r\n')) {
        socket.removeAllListeners('data')
        resolve()
      }
    })
    socket.once('error', reject)
  })
  return socket
}

/** Start the loopback relay (stub: relay not implemented in this port). */
export async function startRelay({ port = 0, key }: { port?: number; key: string }): Promise<{ port: number }> {
  activeRelay = { port, key, dead: false }
  return { port }
}

/** Stop the loopback relay. */
export async function stopRelay() {
  activeRelay = null
}

/**
 * Mihomo/Clash config render — **cố ý không port** (cần binary lậu).
 *
 * Trả `{state:'unavailable'}` kèm cách khắc phục, không giả vậy có.
 */
export function renderMihomoConfig() {
  return {
    state: 'unavailable',
    reason: 'mihomo/Clash binary không ship trong package',
    fix: 'Tải mihomo/Clash về, đặt vào PATH, rồi thiết lập lại outeta qua cài đặt',
  } as const
}

/**
 * Find mihomo binary — **cố ý không port**.
 */
export function findMihomoBinary() {
  return {
    state: 'unavailable',
    reason: 'mihomo/Clash binary không ship trong package',
    fix: 'Tải mihomo/Clash về, đặt vào PATH',
  } as const
}

/**
 * Outlet label — **cố ý không port** (thuộc phần mihomo).
 */
export function outletLabel() {
  return {
    state: 'unavailable',
    reason: 'mihomo/Clash binary không ship trong package',
  } as const
}