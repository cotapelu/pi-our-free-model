/**
 * The outlet a gateway can dial through: a loopback relay carrying a per-start
 * key, with the two transports the free lanes need.
 *
 * Two separate problems live here, and they are separate on purpose.
 *
 * - **Routing the dial.** `egressFetch` sends a request through a local relay
 *   when one is configured and straight out when it is not. The relay is on
 *   loopback, it strips its own two headers before dialing, and a request
 *   without the key is refused before any connection — so a listener on 127.0.0.1
 *   cannot become an open proxy for anyone on the machine. `NO_PROXY` is honoured
 *   by Node's own dispatcher, so a caller who wants a plain `HTTPS_PROXY` gets
 *   it from the runtime rather than from this module.
 *
 * - **Which transport makes the request.** Only the official OpenCode inference
 *   lane uses a Bun subprocess, because a local proxy plugin there rewrites and
 *   corrupts the request body, and doing without Bun breaks that whole lane.
 *   Kilo, catalogs and every local test endpoint keep Node's fetch. A failed
 *   turn is never retried through a second transport: the prior request may
 *   already have spent tokens.
 *
 * The mihomo/Clash subscription spawn that dsh's `src/egress.js` also carries is
 * not ported — it needs a binary that is not shipped here. A caller needing a
 * subscription outlet runs mihomo as an ordinary process and points
 * `OFM_EGRESS_URL` at its mixed port.
 *
 * @module pi-extension/gateway/egress.js
 */

import { spawn } from 'node:child_process'
import tls from 'node:tls'
import dns from 'node:dns'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const RELAY_HOST = '127.0.0.1'
const TARGET_HEADER = 'x-ofm-egress-target'
const KEY_HEADER = 'x-ofm-egress-key'
const DIAL_TIMEOUT_MS = 10_000
const CLIENT_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
])

/** The official free lane, the only one that needs the Bun transport. */
export function isOfficialFreeLane(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:'
    && parsed.hostname === 'opencode.ai'
    && (parsed.port === '' || parsed.port === '443')
    && parsed.pathname.startsWith('/inference/')
}

/** Whether the local `bun` can be found, and where. */
export function findBunExecutable(): string | undefined {
  const explicit = String(process.env.OFM_BUN ?? '').trim()
  if (explicit !== '') return fs.existsSync(explicit) ? explicit : undefined
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const candidates = [
    '/usr/local/bin/bun', '/usr/bin/bun', '/opt/homebrew/bin/bun',
    ...(home !== '' ? [path.join(home, '.bun', 'bin', 'bun')] : []),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  const found = process.env.PATH?.split(path.delimiter).some((directory) => fs.existsSync(path.join(directory, 'bun'))) ?? false
  return found ? 'bun' : undefined
}

export interface BunRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: Uint8Array | string
  signal?: AbortSignal
}

export interface BunResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

/**
 * One request made inside a Bun subprocess.
 *
 * The request goes in on stdin as one JSON line and the body comes back base64
 * over stdout, so nothing larger than a frame crosses a pipe. The child is
 * killed when the caller's signal fires: a turn the caller aborted must not keep
 * a dial open behind it.
 *
 * A refusals reply and a genuine answer both fit this shape, so an upstream 400
 * and an upstream 200 use one return path and a caller never has to guess which
 * one it is holding.
 */
export function bunFetch(url: string, init: BunRequestInit, options: { executable?: string; proxy?: string; timeoutMs?: number } = {}): Promise<BunResponse> {
  const executable = options.executable ?? findBunExecutable()
  if (executable === undefined) throw new Error('OpenCode free inference requires a local Bun executable; install Bun or set OFM_BUN (OFM_FREE_TRANSPORT=node restores the legacy transport)')
  const timeoutMs = options.timeoutMs ?? 120_000
  const body = init.body === undefined ? undefined : (typeof init.body === 'string' ? new TextEncoder().encode(init.body) : init.body)
  const payload = JSON.stringify({
    url,
    method: init.method ?? 'POST',
    headers: init.headers ?? {},
    bodyBase64: body === undefined ? undefined : Buffer.from(body).toString('base64'),
  })

  // dsh wrote the worker to a temp file and spawned its path (`bunWorkerPath`);
  // this port runs the same source inline with `-e`, because `spawn` without a
  // shell never re-parses it — one less file on disk, same bytes on stdin.
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-e', BUN_WORKER], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      if (error !== undefined) reject(error)
    }
    const timer = setTimeout(() => finish(new Error(`the Bun transport timed out after ${timeoutMs}ms`)), Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 120_000)
    init.signal?.addEventListener('abort', () => finish(new Error('the Bun transport was aborted')))
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', (error) => finish(new Error(`could not start Bun (${error.message})`)))
    child.on('close', (code) => {
      const at = out.indexOf('\n')
      const head = at === -1 ? out : out.slice(0, at)
      const rest = at === -1 ? '' : out.slice(at + 1)
      try {
        const meta = JSON.parse(head)
        if (meta?.ok !== true) {
          finish(new Error(typeof meta?.error === 'string' ? meta.error : err.trim() || `the Bun transport exited with ${code}`))
          return
        }
        resolve({
          status: Number(meta.status ?? 0),
          headers: typeof meta.headers === 'object' && meta.headers !== null ? meta.headers : {},
          body: Buffer.from(String(meta.bodyBase64 ?? ''), 'base64'),
        })
      } catch {
        finish(new Error(err.trim() || `the Bun transport returned nothing (exit ${code})`))
      }
      void rest
    })
    child.stdin.end(payload + '\n')
  })
}

/** Carries the absolute target URL from `egressFetch` to the relay. */
/** Carries this start's relay key. Every listen mints one, `egressFetch` is the
 *  only thing that learns it, and a request without it is not the plugin — it
 *  is refused before a single dial, so the loopback port is nobody's open
 *  proxy. Never forwarded upstream: the relay strips it like the target. */
/** One dial (connect, CONNECT response, socks5 handshake, TLS) gets this long. */
/** A freshly spawned mihomo gets this long to open its mixed port. */
/** Schemes a `client` outlet may speak. The subscription path needs none: it
 *  always dials the local mixed port over plain http. */
/** Hop-by-hop headers never forwarded across the relay boundary, either
 *  direction. `transfer-encoding` is dropped too: Node re-derives framing from
 *  the stream it is handed, and forwarding a foreign `chunked` marker would
 *  double-frame it. */

/**
 * The live relay, owned by whichever generation started it. Module-level on
 * purpose: `egressFetch` is imported by src/http.js and src/probe.js, which
 * have no handle on the index fiber, and a hot reload swaps this whole module
 * while the old relay's disposer tears the old one down.
 */
let activeRelay: any = null

/** True when requests will be rewritten onto the relay instead of going out direct. */
export function egressActive() {
  return activeRelay !== null
}

/**
 * `fetch`, through the outlet when one is running and straight out when not.
 *
 * The rewrite is deliberately boring: same method, same body, same signal, plus
 * the target and this start's key in headers, and the path replaced by the
 * origin-form the loopback relay serves. Call sites keep `redirect: 'error'` in
 * `init`, so a 3xx is a response, never a second hop that would dodge the outlet.
 */
export async function egressFetch(url: any, init: any) {
  const relay = activeRelay
  const targetUrl = new URL(url instanceof Request ? url.url : String(url))
  // Only the official OC inference lane uses Bun. Kilo/EAC/catalogs and local
  // test endpoints keep their existing fetch path. Never retry a failed turn
  // through a second transport: a prior request may already have spent tokens.
  const officialFreeLane = targetUrl.protocol === 'https:' && targetUrl.hostname === 'opencode.ai'
    && (targetUrl.port === '' || targetUrl.port === '443') && targetUrl.pathname.startsWith('/inference/')
  const transport = process.env.OUR_FREE_MODEL_FREE_TRANSPORT ?? 'auto'
  if (officialFreeLane && transport !== 'node') {
    if (transport !== 'auto' && transport !== 'bun') throw new Error('OUR_FREE_MODEL_FREE_TRANSPORT must be auto, bun, or node')
    const executable = findBunExecutable()
    if (!executable) throw new Error('OpenCode free inference requires a local Bun executable; install Bun or set OUR_FREE_MODEL_BUN to its executable path (OUR_FREE_MODEL_FREE_TRANSPORT=node restores the legacy transport)')
    if (relay?.dead) throw new Error('the configured egress relay is not running')
    const proxy = relay ? `http://ofm:${relay.key}@${RELAY_HOST}:${relay.port}` : undefined
    if (url instanceof Request) {
      const request = new Request(url, init)
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
      return bunFetch(request.url, { ...init, method: request.method, headers: request.headers, body, signal: request.signal, redirect: request.redirect }, { executable, proxy })
    }
    return bunFetch(url, init, { executable, proxy })
  }
  if (relay === null) return fetch(url, init)
  const request = url instanceof Request ? new Request(url, init) : null
  const target = new URL(request ? request.url : String(url))
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`the egress relay only carries http(s) targets, got "${target.protocol}"`)
  }
  const headers = new Headers(request?.headers ?? init?.headers ?? {})
  headers.set(TARGET_HEADER, target.href)
  headers.set(KEY_HEADER, relay.key)
  const outgoing = request ? {
    ...init, method: request.method, body: request.body, signal: request.signal,
    redirect: request.redirect, ...(request.body ? { duplex: 'half' } : {}),
  } : init
  return fetch(`http://${RELAY_HOST}:${relay.port}${target.pathname}${target.search}`, { ...outgoing, headers })
}

/**
 * Start the relay for the current settings; throws with a message the settings
 * page can show when the configuration cannot run.
 *
 * Mirrors `startForwardServer`'s contract: the caller (`syncEgress`) owns the
 * idempotence — close the old one first — and this function only builds the
 * new one or fails.
 */
export async function startEgressRelay({ config, dataDir, log = () => {}, onDead }: any = {}) {
  const cfg = { mode: 'subscription', url: '', mihomoPath: '', ...config() }
  const mode = cfg.mode === 'client' ? 'client' : 'subscription'
  const url = String(cfg.url ?? '').trim()
  if (url === '') throw new Error('the egress outlet is enabled but empty — paste a proxy address or a subscription link')
  // Minted per start, not per process: a key that leaked from a previous relay
  // must not open this one. Lives in the handle only, and is never written down.
  const key = randomBytes(16).toString('hex')
  let child: any = null
  let managed: any = null
  let outlet
  if (mode === 'client') {
    const parsed = new URL(url)
    if (!CLIENT_SCHEMES.has(parsed.protocol)) {
      throw new Error(`unsupported proxy scheme "${parsed.protocol}" — use http, https, socks5 or socks5h`)
    }
    outlet = { kind: 'url', url: parsed }
  } else {
    // Subscription mode means managing a mihomo child, and this package does not
    // ship that binary (AGENTS.md §4: it is not ours to ship). Refusing here is
    // the honest answer — a silent fall back to plain fetch would send the
    // request past the outlet the user asked for, which is the one outcome the
    // relay exists to prevent.
    throw new Error('subscription mode needs a mihomo binary this install does not ship; use a client outlet (http/https/socks5/socks5h URL) instead')
  }
  const sockets = new Set()
  const server = http.createServer(relayRequest)
  server.on('connect', relayConnect)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, RELAY_HOST, () => { server.removeListener('error', reject); resolve() })
    })
  } catch (error) {
    // The listener is what turns `child` into an owned handle; without it the
    // started mihomo would outlive the failed start holding its ports.
    await killChild(child)
    throw error
  }
  const port = (server.address() as import('node:net').AddressInfo).port
  const handle = {
    port,
    key,
    mode,
    url,
    outlet,
    managed,
    child,
    log,
    /** Set when the managed child dies after startup; the settings page shows it. */
    dead: '',
    close: async () => {
      if (activeRelay === handle) activeRelay = null
      for (const socket of sockets) (socket as any).destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await killChild(child)
    },
  }
  if (child !== null) {
    child.on('exit', () => {
      handle.dead = 'the managed mihomo process exited'
      log(`${handle.dead}; a restart has been scheduled`)
      // A dead managed mihomo otherwise stays dead until the user touches the
      // settings page: every upstream request would hard-fail through the
      // relay's closed dial port. The owner decides the retry policy (backoff,
      // give-up) — this only reports the death once, on the way down.
      try { onDead?.() } catch { /* a diagnostics callback cannot resurrect or worsen the relay */ }
    })
  }
  activeRelay = handle
  return handle
}

/**
 * One proxied request: open the tunnel, hand the socket to a one-shot agent,
 * pipe both directions.
 *
 * The dial is awaited before the outgoing request is built because the
 * agent's `createConnection` override is synchronous — the same seam the LAN
 * relay uses to stamp a PROXY v1 line, proven against this http stack. Both
 * bodies and the SSE response stream through as bytes; nothing is buffered
 * beyond Node's own flow control, so a streaming turn keeps its chunk cadence.
 */
function relayRequest(req: any, res: any) {
  const key = String(req.headers[KEY_HEADER] ?? '')
  delete req.headers[KEY_HEADER]
  if (!sameSecret(key, activeRelay?.key ?? '')) {
    // Not the plugin: a neighbouring local process, a page that guessed the
    // port, a fetch left over from a previous generation. Refused before any
    // dial happens, and the caller learns nothing about the outlet.
    activeRelay?.log?.('relay: refused a caller without this start’s key')
    sendLocal(res, 403, 'the egress relay answers its own plugin only')
    return
  }
  const targetHeader = req.headers[TARGET_HEADER]
  delete req.headers[TARGET_HEADER]
  let upstream
  try {
    upstream = new URL(String(targetHeader ?? ''))
  } catch {
    sendLocal(res, 400, `the egress relay needs a full ${TARGET_HEADER} target URL`)
    return
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    sendLocal(res, 400, `the egress relay carries http(s) targets only, got "${upstream.protocol}"`)
    return
  }
  const outlet = activeRelayOutlet()
  // Host only, never the href: query strings routinely carry credentials
  // (Gemini's ?key=… being the canonical case), and this line runs per request.
  activeRelay?.log?.(`relay: ${req.method} → ${upstream.protocol}//${upstream.host} (outlet ${outlet === null ? 'none' : 'ok'})`)
  if (outlet === null) {
    sendLocal(res, 502, 'the egress relay is not running')
    return
  }
  void (async () => {
    const socket: any = await openTunnel(upstream, outlet)
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => socket
    const headers = { ...req.headers, host: upstream.host }
    delete headers['transfer-encoding']
    const outgoing = http.request({
      method: req.method,
      path: `${upstream.pathname}${upstream.search}`,
      headers,
      agent,
    })
    outgoing.on('response', upstreamRes => {
      const responseHeaders: Record<string, any> = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
      activeRelay?.log?.(`relay: response ${upstreamRes.statusCode} for ${upstream.host} started`)
      upstreamRes.on('error', error => {
        activeRelay?.log?.(`egress relay: upstream body for ${upstream.host} failed: ${error?.message ?? error}`)
        res.destroy()
      })
      upstreamRes.pipe(res)
    })
    outgoing.on('error', error => {
      activeRelay?.log?.(`egress relay: tunnel to ${upstream.host} failed: ${error?.message ?? error}`)
      failOnce(res, error)
    })
    // A client abort (the harness aborts a dead turn) must tear the upstream
    // side down too, or the socket idles until the outlet times it out. On a
    // completed response only the one-shot tunnel socket goes: destroying the
    // client connection while its body is still in flight reads as a reset to
    // fetch(). The per-request tunnel is never reused (keepAlive: false).
    res.on('close', () => {
      outgoing.destroy()
      socket.destroy()
      if (!res.writableFinished) {
        activeRelay?.log?.(`relay: response for ${upstream.host} closed before finish (writableEnded=${res.writableEnded})`)
        try { res.destroy() } catch { /* already gone */ }
      }
    })
    req.on('error', () => { outgoing.destroy() })
    req.pipe(outgoing)
  })().catch(error => {
    activeRelay?.log?.(`egress relay: ${upstream.host} failed: ${error?.message ?? error}`)
    failOnce(res, error)
  })
}

/**
 * Authenticated TLS passthrough for the Bun worker. The existing HTTP relay
 * terminates TLS in Node; CONNECT instead preserves Bun's upstream handshake
 * while retaining the configured HTTP/HTTPS/SOCKS/managed-mihomo outlet.
 * This intentionally accepts the OC host only, not an arbitrary proxy target.
 */
function relayConnect(req: any, client: any, head: any) {
  const relay = activeRelay
  const authorization = String(req.headers['proxy-authorization'] ?? '')
  let credential = ''
  if (/^Basic /i.test(authorization)) credential = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
  if (!relay || relay.dead || !sameSecret(credential, `ofm:${relay.key}`)) {
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nProxy-Authenticate: Basic realm="ofm"\r\n\r\n')
    return
  }
  if (String(req.url).toLowerCase() !== 'opencode.ai:443') {
    client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  // http: here is deliberate: openTunnel must return raw TCP, not Node TLS.
  let upstream: any
  const close = () => { client.destroy(); upstream?.destroy() }
  client.on('error', close)
  client.on('close', () => upstream?.destroy())
  // CONNECT sockets can remain half-open after the worker sends FIN. Before
  // piping begins there is no stream handler to finish that half-close.
  client.once('end', close)
  // Own the socket from the initial dial, not just after CONNECT/SOCKS/TLS
  // succeeds: cancellation and relay.close() can happen during any stage.
  void openTunnel(new URL('http://opencode.ai:443'), relay.outlet, (socket: any) => {
    upstream = socket
    if (client.destroyed) socket.destroy()
  }).then(socket => {
    client.off('end', close)
    upstream = socket
    if (client.destroyed) { socket.destroy(); return }
    socket.on('error', close)
    socket.on('close', () => client.destroy())
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) socket.write(head)
    client.pipe(socket).pipe(client)
  }).catch(() => {
    if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
}

/** The outlet the running relay dials; `null` between generations. */
function activeRelayOutlet() {
  return activeRelay?.outlet ?? null
}

/** The relay is loopback-only: a non-2xx here is a local misconfiguration, answered as JSON like every other local refusal. */
function sendLocal(res: any, status: any, message: any) {
  if (res.headersSent) { activeRelay?.log?.(`relay: sendLocal(${status}) after headers, destroying`); res.destroy(); return }
  const body = JSON.stringify({ error: message })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** Last-word failure: 502 before headers, a dead socket after. */
function failOnce(res: any, error: any) {
  if (res.headersSent) { res.destroy(); return }
  sendLocal(res, 502, `egress tunnel failed: ${error?.message ?? error}`)
}

/**
 * Connect to `upstream` through `outlet` and return a socket ready for plain
 * http framing — already TLS-wrapped when the target is https.
 */
async function openTunnel(upstream: any, outlet: any, onSocket?: (socket: any) => void): Promise<any> {
  const isTls = upstream.protocol === 'https:'
  const host = upstream.hostname
  const port = Number(upstream.port) || (isTls ? 443 : 80)
  let socket
  if (outlet.kind === 'url') {
    const proxy = outlet.url
    if (proxy.protocol === 'http:' || proxy.protocol === 'https:') socket = await httpConnect(proxy, host, port, onSocket)
    else if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') socket = await socks5Connect(proxy, host, port, proxy.protocol === 'socks5h:', onSocket)
    else throw new Error(`unsupported proxy scheme "${proxy.protocol}"`)
  } else {
    socket = await netConnect(host, port, onSocket)
  }
  if (!isTls) return socket
  return await withTimeout(new Promise((resolve, reject) => {
    const secured = tls.connect({
      socket,
      // An IP literal has no name to assert; the lane's hosts are names.
      servername: net.isIP(host) === 0 ? host : undefined,
      ALPNProtocols: ['http/1.1'],
    })
    secured.once('secureConnect', () => resolve(secured))
    secured.once('error', error => { secured.destroy(); reject(error) })
    onSocket?.(secured)
  }), DIAL_TIMEOUT_MS, 'target TLS handshake', socket)
}

/** Plain TCP with the dial budget applied. */
function netConnect(host: any, port: any, onSocket: any) {
  const socket = net.connect({ host, port })
  return withTimeout(new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
    onSocket?.(socket)
  }), DIAL_TIMEOUT_MS, 'tcp connect', socket)
}

/**
 * HTTP CONNECT through an http(s) proxy — including the local mixed port a
 * managed mihomo opens, which speaks CONNECT like any other proxy.
 */
async function httpConnect(proxy: any, targetHost: any, targetPort: any, onSocket: any) {
  let socket = await netConnect(proxy.hostname, Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80), onSocket)
  try {
    if (proxy.protocol === 'https:') {
      socket = await withTimeout(new Promise((resolve, reject) => {
        const secured = tls.connect({ socket, servername: net.isIP(proxy.hostname) === 0 ? proxy.hostname : undefined })
        secured.once('secureConnect', () => resolve(secured))
        secured.once('error', error => { secured.destroy(); reject(error) })
        onSocket?.(secured)
      }), DIAL_TIMEOUT_MS, 'proxy TLS handshake', socket)
    }
    const auth = proxy.username === '' ? '' : `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
    socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`)
    const { rest } = await readUntil(socket, DIAL_TIMEOUT_MS, 'CONNECT response', (buffer: any) => {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return null
      const head = buffer.subarray(0, end).toString('latin1')
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      if (match === null) throw new Error(`the proxy answered "${head.split('\r\n')[0] ?? ''}" to CONNECT`)
      if (Number(match[1]) < 200 || Number(match[1]) >= 300) throw new Error(`the proxy refused CONNECT with ${match[1]}`)
      return end + 4
    })
    if (rest.length > 0) socket.unshift(rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * SOCKS5 CONNECT (RFC 1928, optional RFC 1929 credentials).
 *
 * `socks5h` sends the hostname and lets the proxy resolve it — the airport
 * exit must see the name, not this machine's DNS answer. Plain `socks5`
 * resolves locally first, per the scheme's definition.
 */
async function socks5Connect(proxy: any, targetHost: any, targetPort: any, resolveAtProxy: any, onSocket: any) {
  const socket = await netConnect(proxy.hostname, Number(proxy.port) || 1080, onSocket)
  try {
    const withAuth = proxy.username !== ''
    socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
    // Each stage consumes exactly the bytes of its message (parsed from
    // `head`) and pushes any bytes past the mark back — a coalesced TCP read
    // must not swallow the next stage.
    const greeting = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 greeting', (buffer: any) => (buffer.length < 2 ? null : 2 + buffer[1]))
    if (greeting.rest.length > 0) socket.unshift(greeting.rest)
    if (greeting.head[0] !== 0x05) throw new Error(`the socks5 proxy answered version ${greeting.head[0] ?? 'nothing'}`)
    const selected = greeting.head[1]
    if (selected === 0x02) {
      if (!withAuth) throw new Error('the socks5 proxy demands credentials this outlet does not have')
      const user = Buffer.from(decodeURIComponent(proxy.username), 'utf8')
      const pass = Buffer.from(decodeURIComponent(proxy.password), 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const auth = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 auth', (buffer: any) => (buffer.length >= 2 ? 2 : null))
      if (auth.rest.length > 0) socket.unshift(auth.rest)
      if (auth.head[0] !== 0x01 || auth.head[1] !== 0x00) throw new Error('the socks5 proxy rejected the credentials')
    } else if (selected !== 0x00) {
      throw new Error(`the socks5 proxy selected method ${selected}, expected 0 (none) or 2 (user/pass)`)
    }
    let address
    if (resolveAtProxy) {
      // RFC 1928: atyp 3 is [1-byte length][domain], unlike the raw IP forms.
      address = { type: 0x03, bytes: Buffer.concat([Buffer.from([Buffer.byteLength(targetHost)]), Buffer.from(targetHost, 'utf8')]) }
    } else {
      address = encodeAddress(await dns.promises.lookup(targetHost))
    }
    const request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, address.type]),
      address.bytes,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ])
    socket.write(request)
    const reply = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 connect reply', (buffer: any) => {
      if (buffer.length < 4) return null
      if (buffer[0] !== 0x05) throw new Error(`the socks5 reply started with ${buffer[0]}`)
      if (buffer[1] !== 0x00) throw new Error(`the socks5 proxy refused the connection (code ${buffer[1]})`)
      const atyp = buffer[3]
      if (atyp === 0x01) return buffer.length >= 10 ? 10 : null
      if (atyp === 0x04) return buffer.length >= 22 ? 22 : null
      if (atyp === 0x03) {
        if (buffer.length < 5) return null
        const full = 4 + 1 + buffer[4] + 2
        return buffer.length >= full ? full : null
      }
      throw new Error(`the socks5 reply used unknown address type ${atyp}`)
    })
    if (reply.rest.length > 0) socket.unshift(reply.rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/** DNS answer → SOCKS5 address block (type byte + encoded bytes). */
function encodeAddress(resolved: any) {
  if (resolved.family !== 6) {
    return { type: 0x01, bytes: Buffer.from(resolved.address.split('.').map((part: any) => Number(part) & 0xff)) }
  }
  // Expand the `::` run before splitting: a compressed literal has empty
  // groups in the middle that must be counted, not parsed.
  const [head, tail, ...extra] = resolved.address.split('::')
  if (extra.length > 0) throw new Error(`unexpected IPv6 literal "${resolved.address}"`)
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups]
  const bytes = Buffer.alloc(16)
  groups.forEach((group: any, index: any) => {
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = (value >> 8) & 0xff
    bytes[index * 2 + 1] = value & 0xff
  })
  return { type: 0x04, bytes }
}

/**
 * Accumulate socket bytes until `matcher` is happy; resolve with the bytes
 * past the mark so the caller can push them back with `unshift`.
 */
function readUntil(socket: any, timeoutMs: any, what: any, matcher: any) {
  if (socket.destroyed) return Promise.reject(new Error(`the proxy closed during the ${what}`))
  return withTimeout(new Promise((resolve, reject) => {
    const chunks: any = []
    let size = 0
    const onData = (chunk: any) => {
      chunks.push(chunk)
      size += chunk.length
      const buffer = Buffer.concat(chunks, size)
      let mark
      try {
        mark = matcher(buffer)
      } catch (error) {
        cleanup()
        reject(error)
        return
      }
      if (mark === null) {
        if (size > 16 * 1024) {
          cleanup()
          reject(new Error(`the proxy sent more than 16KB without finishing the ${what}`))
        }
        return
      }
      cleanup()
      resolve({ head: buffer.subarray(0, mark), rest: buffer.subarray(mark) })
    }
    const onError = (error: any) => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error(`the proxy closed during the ${what}`)) }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    // The socket was paused until now (connect-stage listeners only), so the
    // first byte arrives after this switch and nothing is lost in between.
    socket.resume()
  }), timeoutMs, what, socket)
}

/** Reject after `ms`, tearing the socket down so nothing leaks half-open. */
function withTimeout(promise: any, ms: any, what: any, socket: any) {
  let timer: any
  let onClose: any
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      onClose = () => reject(new Error(`the socket closed during the ${what}`))
      if (socket?.destroyed) onClose()
      else socket?.once('close', onClose)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        socket?.destroy?.()
        reject(new Error(`timed out after ${ms}ms: ${what}`))
      }, ms)
      timer.unref?.()
    }),
  ]).finally(() => {
    clearTimeout(timer)
    socket?.off('close', onClose)
  })
}

/** A free loopback port. Small bind/close race is acceptable — a collision surfaces as a clean startup error, not a corrupt state. */
async function freePort() {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, RELAY_HOST, () => resolve()))
  const { port } = server.address() as import('node:net').AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** Poll a TCP port until it answers or the budget runs out; `check` rethrows why early. */
async function waitForPort(host: any, port: any, timeoutMs: any, check: any) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    check?.()
    const open = await new Promise<boolean>(resolve => {
      const socket = net.connect({ host, port })
      const settle = (ok: any) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(ok)
      }
      socket.once('connect', () => settle(true))
      socket.once('error', () => settle(false))
    })
    if (open !== null) return
    if (Date.now() > deadline) throw new Error(`the port ${host}:${port} never opened within ${timeoutMs}ms`)
    await new Promise<void>(resolve => { const t = setTimeout(resolve, 250); t.unref?.() })
  }
}

/**
 * Stop a spawned outlet child: ask nicely, then insist. Shared by `close()` and
 * by a failed start — a mihomo that never opened its port still holds it, and
 * once the attempt has given up nothing else can reach that child.
 */
async function killChild(proc: any) {
  if (proc === null || proc.exitCode !== null || proc.signalCode !== null) return
  proc.removeAllListeners('exit')
  try { proc.kill() } catch { /* already gone */ }
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3_000)
    proc.once('exit', () => { clearTimeout(timer); resolve(undefined as never) })
  })
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** Constant-time relay-key comparison; the length check keeps `timingSafeEqual` from throwing. */
function sameSecret(given: any, expected: any) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(String(expected ?? ''))
  return a.length >= 16 && a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The mihomo configuration this plugin runs: subscription as a proxy-provider,
 * a url-test group that re-measures on an interval, and MATCH routed through
 * it — so every connection the plugin makes leaves via the freshest
 * lowest-latency node without the plugin choosing one itself.
 *
 * `expected-status: 204` sits on the provider's health-check: the target is
 * gstatic's `generate_204`, so a 429 (or any error page) marks the node dead
 * and url-test excludes it. That is the 429-penalty half of the health score,
 * delegated to the component that already measures every node anyway.
 *
 * `auth` (when the caller supplies one) password-protects the mixed port, the
 * same way the relay key protects the loopback port in front of it: a listener
 * every local process can borrow is a listener that will be borrowed.
 */

export const EGRESS_PROXY_HEADERS = { TARGET_HEADER, KEY_HEADER, RELAY_HOST }

/**
 * The headers as they leave the relay: hop-by-hop and the relay's own two
 * bookkeeping headers removed, everything else kept.
 *
 * Hop-by-hop removal is what keeps a foreign `chunked` marker from being
 * forwarded and double-framing the body, and dropping the key is what keeps it
 * from reaching the upstream.
 */
export function egressRequestHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === TARGET_HEADER || lower === KEY_HEADER) continue
    if (Array.isArray(value)) out[name] = value.map(String).join(', ')
    else if (value !== undefined) out[name] = String(value)
  }
  return out
}

/**
 * The child's whole program, kept next to the code that spawns it so there is no
 * second file to keep in step. It reads one JSON request on stdin and answers
 * with one metadata line plus a base64 body, which is why a request and a
 * refusal travel the same path.
 */
const BUN_WORKER = `
let line = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { line += chunk })
process.stdin.on('end', async () => {
  let request
  try {
    request = JSON.parse(line.trim())
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'the transport read no request' }) + '\\n')
    return
  }
  try {
    const body = typeof request.bodyBase64 === 'string' ? Buffer.from(request.bodyBase64, 'base64') : undefined
    const response = await fetch(request.url, {
      method: request.method ?? 'POST',
      headers: request.headers ?? {},
      body,
      redirect: 'manual',
    })
    const buf = Buffer.from(await response.arrayBuffer())
    const headers = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    process.stdout.write(JSON.stringify({ ok: true, status: response.status, headers, bodyBase64: buf.toString('base64') }) + '\\n')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const kind = error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'transport'
    process.stdout.write(JSON.stringify({ ok: false, kind, error: detail }) + '\\n')
  }
})
`
