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
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const RELAY_HOST = '127.0.0.1'
const TARGET_HEADER = 'x-ofm-egress-target'
const KEY_HEADER = 'x-ofm-egress-key'
const DIAL_TIMEOUT_MS = 10_000
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

export interface EgressSettings {
  enabled: boolean
  url: string
}

let activeRelay: { server: http.Server; port: number; key: string; dead: boolean } | null = null

/** True when requests will be rewritten onto the relay instead of going direct. */
export function egressActive(): boolean {
  return activeRelay !== null
}

function keyMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Starts the loopback relay that the configured client outlet is dialed through.
 *
 * A request is refused before a single dial when it carries no key, so the port
 * is nobody's open proxy. The target is carried as a URL, never as a set of
 * lines, so the relay instructs `http.request` rather than a socket writer whose
 * target itself could be parsed into instructions.
 */
export async function startEgressRelay(settings: EgressSettings, log: (message: string) => void = () => {}): Promise<{ port: number; close: () => Promise<void> } | null> {
  const url = String(settings.url ?? '').trim()
  if (settings.enabled !== true || url === '') return null
  const key = `ofm-egress-${randomBytes(24).toString('base64url')}`
  let target: URL
  try {
    target = new URL(url)
  } catch {
    log(`egress relay: the outlet URL "${url}" is not a URL`)
    return null
  }

  const server = http.createServer((req, res) => {
    const presented = req.headers[KEY_HEADER]
    if (!keyMatches(Array.isArray(presented) ? presented[0] : presented, key)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('refused')
      return
    }
    const requested = req.headers[TARGET_HEADER]
    const destination = String(Array.isArray(requested) ? requested[0] : requested ?? '')
    let parsed: URL
    try {
      parsed = new URL(destination)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('bad target')
      return
    }
    const proxyReq = http.request(parsed, {
      method: req.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())
        && name.toLowerCase() !== TARGET_HEADER.toLowerCase() && name.toLowerCase() !== KEY_HEADER.toLowerCase()) as [string, string][]) as http.IncomingHttpHeaders,
    }, (proxyRes) => {
      const headers = Object.fromEntries(Object.entries(proxyRes.headers ?? {}).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())))
      res.writeHead(proxyRes.statusCode ?? 502, headers)
      proxyRes.pipe(res)
    })
    proxyReq.setTimeout(DIAL_TIMEOUT_MS, () => proxyReq.destroy(new Error('the relay dial timed out')))
    proxyReq.on('error', (error: Error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(error.message)
    })
    req.pipe(proxyReq)
  })
  server.on('error', (error: Error) => log(`egress relay error: ${error.message}`))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, RELAY_HOST, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port ?? 0 : 0
  activeRelay = { server, port, key, dead: false }
  return {
    port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => {
        if (activeRelay?.port === port) activeRelay = null
        resolve()
      })
    }),
  }
}

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
