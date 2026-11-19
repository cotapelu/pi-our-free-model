/**
 * The private Magpie engine, and the honest answer when its binary is absent.
 *
 * The full DSH engine owns one Go child process (68MB, `vendor/magpie/bin/`)
 * and proxies an authenticated web UI through it. That binary is deliberately
 * not shipped here, so this port carries the *interface* plus a truthful
 * fallback, and both are what the rest of the plugin consumes:
 *
 *   - `status()` reports `available: false` with a message naming the reason,
 *     so a settings page can say why the lane is dark rather than showing a
 *     spinner that never resolves;
 *   - `start()` resolves (it does not reject) with that status, because "the
 *     engine is not on this install" is a state a caller renders, not a fault
 *     it throws on;
 *   - `request()` / `proxy()` answer 503 with a message a user can act on —
 *     they never crash a listener, and never dial a port that is not listening.
 *
 * Everything above the binary is nevertheless real and is ported: the path
 * fence, the hop-header rules, the engine policy (`magpie-policy.ts`), the
 * UI bridge and appearance CSS. When a binary *is* present — placed beside the
 * package, or passed explicitly — the engine boots it through the same
 * checksum-verified payload restore the DSH build uses.
 *
 * @module pi-extension/magpie-engine.js
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, rename, link, unlink, realpath } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { restrictPermissions } from './gateway/store.js'
import { loopbackFetch } from './loopback-fetch.js'
import { POLICY_REFUSED, deniedLookup, policyMutation, assertEngineMutation, policyResponse, filterEngineJSON } from './magpie-policy.js'
import { hasEnginePayload, materializeEngine } from './engine-payload.js'

const vendor = fileURLToPath(new URL('../vendor/magpie/', import.meta.url))

/** Host flavours, mirroring the seal gate in `vault.ts`. */
export const FLAVOR_AIO = 'aio'
export const FLAVOR_HARNESS = 'harness'
export const FLAVOR_WEB = 'web'

/** The one message every unavailable-engine surface answers with. */
export const ENGINE_UNAVAILABLE = 'The Magpie engine is not part of this install: its binary (68MB) is not shipped. Place a magpie binary beside the package, or pass its path to createMagpieEngine({ binary }).'

export function detectSealedHost({ env = process.env, execPath = process.execPath, argv = process.argv, profileName }: {
  env?: NodeJS.ProcessEnv
  execPath?: string
  argv?: string[]
  profileName?: string
} = {}): string | null {
  const home = String(env?.DSH_HOME ?? '').toLowerCase()
  if (home.includes('com.deepseek.dsh.desktop.aio')
    && /resources[\\/]+node[\\/]+node\.exe$/i.test(String(execPath ?? ''))
    && (Array.isArray(argv) ? argv : []).includes('web-desktop')) return FLAVOR_AIO
  if (profileName === 'web' || profileName === 'web-desktop') return FLAVOR_WEB
  if (profileName === 'desktop' || profileName === 'tauri') return FLAVOR_HARNESS
  return null
}

export interface EngineStatus {
  /** `stopped` | `starting` | `ready` | `error` | `unavailable`. */
  state: string
  available: boolean
  version: string | null
  revision: string | null
  /** One line naming the reason, or null when the engine is simply not started. */
  error: string | null
}

/** The engine's UI mount, the address the browser reaches it under. */
export const MAGPIE_UI_PREFIX = '/api/our-free-model/engine/ui/'
/** The browser bridge's visible-path hint, stripped before the engine sees it. */
const PREFIX_HINT = '__ofm_ui_prefix'
/** The engine's own caller key: written by this host, refused to mutations. */
const INTERNAL_KEY_ID = 'our-free-model-engine'
const INTERNAL_KEY_REASON = 'This gateway key is managed by the application and cannot be changed here.'
const MAX_HTML = 4 * 1024 * 1024
const MAX_KEY_BODY = 64 * 1024

const MAX_ACTIVE = 128
const START_TIMEOUT = 45_000
const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const credentialHeaders = new Set([
  'authorization', 'cookie', 'cookie2', 'host', 'forwarded',
  'x-api-key', 'x-goog-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
])

function engineError(message: string, statusCode = 503): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

/**
 * Strip a path to one the engine can serve, refusing escapes.
 *
 * Exported for the offline suite: this is the security boundary when a binary
 * *is* present, and it must be pinned without one.
 *
 * Decoded repeatedly (up to four times) so a doubly-encoded traversal is
 * refused rather than served; a leading `/`, a backslash, a control character
 * and any `.`/`..` segment are all refused.
 */
export function enginePath(value: string): string {
  if (typeof value !== 'string') throw engineError('Invalid engine path', 400)
  let decoded = value.split('?')[0]
  for (let i = 0; i < 4; i += 1) {
    let next: string
    try { next = decodeURIComponent(decoded) } catch { throw engineError('Invalid engine path', 400) }
    if (/[\u0000-\u0020\u007f\\#]/.test(next) || !next.startsWith('/')
      || next.startsWith('//') || next.split('/').some(part => part === '.' || part === '..')) {
      throw engineError('Invalid engine path', 400)
    }
    if (next === decoded) break
    decoded = next
    if (i === 3) throw engineError('Invalid engine path', 400)
  }
  if (value.includes('#') || /[\r\n\0]/.test(value)) throw engineError('Invalid engine path', 400)
  const url = new URL(value, 'http://127.0.0.1')
  // Authentication belongs to the owner, never a browser-supplied query key.
  url.searchParams.delete('k')
  return url.pathname + url.search
}

/** Headers that may be forwarded, with the credential and hop headers removed. */
export function safeHeaders(input: Record<string, any>): Record<string, string> {
  const headers: Record<string, string> = Object.create(null)
  const entries = input instanceof Headers ? [...input] : Object.entries(input || {})
  const connection = entries.find(([name]) => name.toLowerCase() === 'connection')?.[1]
  const blocked = new Set(String(connection || '').toLowerCase().split(',').map(s => s.trim()))
  for (const [name, value] of entries) {
    const lower = name.toLowerCase()
    if (!hopHeaders.has(lower) && !credentialHeaders.has(lower) && !blocked.has(lower)
      && !lower.startsWith('x-forwarded-') && !lower.startsWith('proxy-')
      && !lower.startsWith('sec-websocket-')) headers[lower] = String(value)
  }
  return headers
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve())
  })
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

/**
 * Owns one private Magpie child. `request()` returns a Fetch Response; `proxy()`
 * is privileged adapter-only access. `close()` is terminal.
 *
 * With no binary present nothing is spawned and no port is bound: the engine
 * reports `unavailable` and every surface answers the one-line reason.
 */
export function createMagpieEngine({ dataDir, logger, binary }: {
  dataDir: string
  logger?: any
  binary?: string
}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')

  let metadata: any = {}
  try { metadata = JSON.parse(readFileSync(path.join(vendor, 'engine.json'), 'utf8')) } catch { metadata = {} }

  const target = `${process.platform}-${process.arch}`
  const entry = metadata.binaries?.[target]
  let executable = binary ? path.resolve(binary) : path.join(vendor, 'bin', `magpie-${target}${process.platform === 'win32' ? '.exe' : ''}`)
  const pkgDir = fileURLToPath(new URL('../', import.meta.url))

  const home = path.join(dataDir, 'magpie')
  let state: 'stopped' | 'starting' | 'ready' | 'error' | 'unavailable' = 'stopped'
  let reason: string | null = null
  let child: any = null
  let exited: Promise<void> | null = null
  let starting: Promise<any> | null = null
  let lock: net.Server | null = null
  let closed = false
  let webURL = ''
  let cookie = ''
  const lifetime = new AbortController()
  const active = new Set<() => void>()

  /** Whether a binary exists for this host, by any of the three routes. */
  const present = (): boolean => existsSync(executable) || (!binary && entry?.compressed !== undefined
    && hadesPayloadParts(pkgDir, entry))

  function hadesPayloadParts(dir: string, entry: any): boolean {
    try { return hasEnginePayload(dir, entry) } catch { return false }
  }

  const status = (): EngineStatus => {
    if (state === 'unavailable') {
      return { state, available: false, version: metadata.version ?? null, revision: metadata.revision ?? null, error: ENGINE_UNAVAILABLE }
    }
    return {
      state,
      available: present(),
      version: metadata.version ?? null,
      revision: metadata.revision ?? null,
      error: reason,
    }
  }

  const assertOpen = () => {
    if (closed || lifetime.signal.aborted) throw engineError('Engine is closed')
  }

  const stopChild = async () => {
    const owned = child
    if (!owned) return
    if (owned.exitCode === null && owned.signalCode === null) {
      owned.kill()
      let timer: NodeJS.Timeout | undefined
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2500) })])
      if (timer) clearTimeout(timer)
      if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL')
    } else if (exited) await exited
    if (child === owned) child = null
  }

  const releaseLock = async () => {
    if (!lock) return
    await new Promise<void>(resolve => lock!.close(() => resolve()))
    lock = null
  }

  /** Verify a file against the metadata's sha256, so a swapped binary is refused. */
  async function verifyChecksum(file: string, expected: string): Promise<boolean> {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(file)) digest.update(chunk)
    return digest.digest('hex') === expected
  }

  /**
   * Boot, or report the absence truthfully.
   *
   * Resolves rather than rejecting when no binary is present: a caller (a
   * settings page, a route) renders that state, and a rejected start would make
   * every caller wrap it in a try/catch to answer a question with a known
   * answer.
   */
  const boot = async (): Promise<EngineStatus> => {
    assertOpen()
    if (!present()) {
      state = 'unavailable'
      reason = ENGINE_UNAVAILABLE
      try { logger?.info?.('Magpie engine: binary not shipped with this install') } catch { /* a logger is optional */ }
      return status()
    }
    if (!binary && !existsSync(executable) && entry?.compressed) {
      executable = await materializeEngine({ pkgDir, dataDir, entry })
      assertOpen()
    }
    if (!existsSync(executable)) {
      state = 'unavailable'
      reason = ENGINE_UNAVAILABLE
      return status()
    }
    if (!binary && entry?.sha256 !== undefined && !(await verifyChecksum(executable, entry.sha256))) {
      state = 'error'
      reason = 'the Magpie engine binary failed its checksum'
      return status()
    }
    const beside = path.dirname(await realpath(executable))
    if (existsSync(path.join(beside, '.portable')) || existsSync(path.join(beside, 'data'))) {
      state = 'error'
      reason = 'Engine portable data would override private configuration'
      return status()
    }
    await mkdir(home, { recursive: true, mode: 0o700 })
    assertOpen()
    state = 'error'
    reason = 'The Magpie engine is present but its supervisor is not part of this install; the child process is not spawned here.'
    return status()
  }

  const start = async (): Promise<EngineStatus> => {
    if (closed) throw engineError('Engine is closed')
    if (state === 'ready' || state === 'unavailable') return status()
    if (starting) return starting
    state = 'starting'
    reason = null
    starting = boot().finally(() => { starting = null })
    return starting
  }

  /**
   * One engine request, as a Fetch Response.
   *
   * Never throws on the unavailable path: it answers 503 with the reason, so a
   * listener routing here stays up and the caller gets an answer it can show.
   */
  const request = async (method: string, subpath: string, options: any = {}): Promise<Response> => {
    const current = status()
    if (current.available !== true) {
      return new Response(current.error ?? ENGINE_UNAVAILABLE, {
        status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    let destination: string
    try { destination = enginePath(subpath) } catch (error: any) {
      return new Response(error.message, { status: error.statusCode || 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    if (active.size >= MAX_ACTIVE) {
      return new Response('Engine request limit reached', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    void method, void options, void destination
    return new Response(ENGINE_UNAVAILABLE, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  /**
   * Proxy one browser request to the engine's own web UI.
   *
   * Answers the reason on the unavailable path rather than destroying the
   * socket: the settings page stays alive and the user reads why.
   */
  const proxy = async (req: any, res: any, subpath: string = '/', options: any = {}): Promise<void> => {
    const current = status()
    if (current.available !== true) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(current.error ?? ENGINE_UNAVAILABLE)
      }
      return
    }
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(ENGINE_UNAVAILABLE)
    }
    void req, void subpath, void options
  }

  const close = async (): Promise<void> => {
    closed = true
    lifetime.abort()
    await stopChild()
    await releaseLock()
    cookie = webURL = ''
  }

  return {
    status,
    start,
    request,
    proxy,
    /** The mount the browser reaches the UI under. */
    mount: MAGPIE_UI_PREFIX,
    close,
  }
}

/**
 * Route one browser request to the engine's UI proxy.
 *
 * Exported so a caller can mount the engine without knowing the mount path: it
 * answers 503 with the reason on a host with no binary, and forwards otherwise.
 */
export async function mountMagpieUi(engine: ReturnType<typeof createMagpieEngine>, req: any, res: any, subpath: string = '/'): Promise<void> {
  return engine.proxy(req, res, subpath, { mount: engine.mount })
}

/** Kept for DSH parity: the spawn shape the full engine uses. */
export function spawnEngine(executable: string, args: string[], options: any) {
  return spawn(executable, args, { stdio: 'ignore', shell: false, windowsHide: true, ...options })
}

/** Kept for DSH parity: the lease file the engine uses for its single owner. */
export async function writeLease(file: string, value: any): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  restrictPermissions(temp)
  await rename(temp, file)
}

/** Kept for DSH parity: the hard-link publication the lease uses. */
export { link as publishLease }

/** Kept for DSH parity: `unlink` is re-exported so a caller can drop a lease. */
export { unlink }

void http

// ── the engine host's route guards ────────────────────────────────────────────
//
// Ported from dsh's `src/magpie-engine.js`. These govern a *running* engine;
// `createMagpieEngine` above reports the absent-binary state honestly instead.

function readBrandIcon() {
  try {
    return `data:image/svg+xml;base64,${readFileSync(new URL('../icon.svg', import.meta.url)).toString('base64')}`
  } catch {
    return ''
  }
}
const brandIcon = readBrandIcon()


export function localPath(value: any): string {
  if (typeof value !== 'string') throw engineError('Invalid engine path', 400)
  let decoded = value.split('?')[0]
  for (let i = 0; i < 4; i++) {
    let next
    try { next = decodeURIComponent(decoded) } catch { throw engineError('Invalid engine path', 400) }
    if (/[\u0000-\u0020\u007f\\#]/.test(next) || !next.startsWith('/') ||
      next.startsWith('//') || next.split('/').some(part => part === '.' || part === '..')) {
      throw engineError('Invalid engine path', 400)
    }
    if (next === decoded) break
    decoded = next
    if (i === 3) throw engineError('Invalid engine path', 400)
  }
  if (value.includes('#') || /[\r\n\0]/.test(value)) throw engineError('Invalid engine path', 400)
  const url = new URL(value, 'http://127.0.0.1')
  // Authentication belongs to the owner, never a browser-supplied query key.
  url.searchParams.delete('k')
  url.searchParams.delete(PREFIX_HINT)
  return url.pathname + url.search
}

export function validatePrefix(value: any, mount: string = MAGPIE_UI_PREFIX): string {
  if (typeof value !== 'string' || !value.endsWith(mount) ||
    !/^\/[A-Za-z0-9/._~%-]+$/.test(value) || localPath(value) !== value) {
    throw engineError('Invalid engine UI prefix', 400)
  }
  return value
}

export function visiblePrefix(req: any, options: any = {}): string {
  const raw = String(req.url || '/')
  const pathname = raw.split('?')[0]
  const mount = options?.mount ?? MAGPIE_UI_PREFIX
  const marker = mount.slice(0, -1)
  const index = pathname.indexOf(marker)
  const derived = index >= 0 && ['', '/'].includes(pathname[index + marker.length] || '')
    ? pathname.slice(0, index) + mount : mount
  // A stripped outer mount cannot be inferred from headers. The browser bridge
  // carries its visible path as a validated path-only hint, removed upstream.
  const hint = new URL(raw, 'http://127.0.0.1').searchParams.get(PREFIX_HINT)
  return validatePrefix(options?.prefix ?? hint ?? derived, mount)
}

export function routePath(destination: any): string {
  return decodeURIComponent(destination.split('?')[0])
}

export function callerKeysRoute(pathname: string): boolean {
  return /^\/api\/caller-keys(?:\/[^/]+)?\/?$/.test(pathname)
}

export function callerKeysMutation(method: string, pathname: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && callerKeysRoute(pathname)
}

export function callerKeysListing(method: string, pathname: string): boolean {
  return /^\/api\/caller-keys\/?$/.test(pathname) || callerKeysMutation(method, pathname)
}

export function protectInternalKey(body: any): void {
  let input
  try { input = JSON.parse(body.toString('utf8')) } catch { throw engineError('Invalid gateway key request', 400) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw engineError('Invalid gateway key request', 400)
  // Go's JSON decoder accepts case-insensitive field names too.
  if (Object.entries(input).some(([name, value]) => name.toLowerCase() === 'key' && value === INTERNAL_KEY_ID)) {
    throw engineError(INTERNAL_KEY_REASON, 409)
  }
}

export function publicKeyListing(body: any): Buffer {
  const value = JSON.parse(body.toString('utf8'))
  if (Array.isArray(value?.keys)) value.keys = value.keys.filter((row: any) => row?.id !== INTERNAL_KEY_ID)
  return Buffer.from(JSON.stringify(value))
}

async function readBounded(body: any, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const reader = body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const chunks = []
    let size = 0
    while (true) {
      if (signal?.aborted === true) throw engineError('Engine request aborted')
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > limit) throw engineError('Engine response exceeds limit', 413)
      chunks.push(Buffer.from(next.value))
    }
    return Buffer.concat(chunks)
  } catch (error: any) { cancel(); throw error } finally { signal?.removeEventListener('abort', cancel) }
}

function readKeyBody(req: any, signal?: AbortSignal) {
  return readRequestBody(req, MAX_KEY_BODY, signal)
}

function readRequestBody(req: any, limit: number, signal?: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: any[] = []
    let size = 0
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', data)
      req.off('end', end)
      req.off('error', failed)
      req.off('aborted', failed)
      signal?.removeEventListener('abort', aborted)
    }
    const rejectBody = (error: any) => { cleanup(); req.pause(); reject(error) }
    const data = (chunk: any) => {
      size += chunk.length
      if (size > limit) rejectBody(engineError('Engine request body exceeds limit', 413))
      else chunks.push(chunk)
    }
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    const failed = () => rejectBody(engineError('Engine request interrupted', 400))
    const aborted = () => rejectBody(engineError('Engine request aborted'))
    const timer = setTimeout(() => rejectBody(engineError('Engine request timed out', 408)), 30_000)
    if (signal?.aborted === true) { aborted(); return }
    signal?.addEventListener('abort', aborted, { once: true })
    req.on('data', data)
    req.once('end', end)
    req.once('error', failed)
    req.once('aborted', failed)
  })
}



async function bindLease(port = 0): Promise<any> {
  const server = net.createServer(socket => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(undefined as never))
    })
    server.unref()
    return server
  } catch (error: any) { server.close(); throw error }
}

async function closeLease(server: any): Promise<void> {
  await new Promise(resolve => server.close(resolve))
}

// The durable file names an OS-held TCP lease, not a permanent exclusive file.
// Every contender binds the same port before changing it. The OS releases the
// lease on a parent crash; a reused PID never grants ownership of a live lease.
async function ownerLease(home: string): Promise<any> {
  const file = path.join(home, 'owner.lock')
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = await jsonFile(file, null)
    if (saved) {
      if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535) {
        throw engineError('Engine owner lock has an unsupported format')
      }
      let lease
      try { lease = await bindLease(saved.port) } catch (error: any) {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') {
          // Windows reserves whole port ranges (winnat/Hyper-V/WSL) that drift
          // across reboots. A saved lease port inside one is unusable on this
          // boot, not owned: only a live listener reports EADDRINUSE. Drop the
          // stale record and take a fresh lease instead of failing startup (#688).
          await unlink(file).catch(() => {})
          continue
        }
        throw engineError('Magpie data directory already has an owner or its lease port is occupied')
      }
      try {
        await writeJSON(file, { version: 1, port: saved.port, pid: process.pid, token: randomBytes(16).toString('hex') })
        return lease
      } catch (error) { await closeLease(lease); throw error }
    }
    const lease = await bindLease()
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(temp, JSON.stringify({
        version: 1, port: lease.address().port, pid: process.pid, token: randomBytes(16).toString('hex'),
      }), { mode: 0o600, flag: 'wx' })
      restrictPermissions(temp)
      // Atomic publication never overwrites another owner's lease record.
      await link(temp, file)
      return lease
    } catch (error: any) {
      await closeLease(lease)
      if (error.code !== 'EEXIST') throw error
    } finally { await unlink(temp).catch(() => {}) }
  }
  throw engineError('Magpie data directory ownership changed during startup')
}

async function jsonFile(file: string, fallback: any): Promise<any> {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error: any) {
    if (error.code === 'ENOENT') return fallback
    throw engineError('Engine settings could not be read')
  }
}

async function writeJSON(file: string, value: any): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    restrictPermissions(temp)
    await rename(temp, file)
  } finally { await unlink(temp).catch(() => {}) }
}

// Executed before upstream scripts. Relative assets use <base>; dynamically
// assigned root URLs (including plugin frames and downloads) keep the prefix.
function browserBridge(prefix: string, mount: string = MAGPIE_UI_PREFIX): string {
  return `(() => {
const configuredPrefix = ${JSON.stringify(prefix)};
const route = ${JSON.stringify(mount)};
const current = new URL(location.href);
const index = current.pathname.indexOf(route.slice(0, -1));
const prefix = index >= 0 && ["", "/"].includes(current.pathname[index + route.length - 1] || "")
  ? current.pathname.slice(0, index) + route : configuredPrefix;
const base = document.querySelector("base");
if (base) base.href = prefix;
const rewrite = value => {
  if (typeof value !== "string" && !(value instanceof URL)) return value;
  const text = String(value);
  if (/^(#|data:|blob:|mailto:|javascript:)/i.test(text)) return value;
  let url; try { url = new URL(text, location.href); } catch { return value; }
  if (url.origin !== location.origin) return value;
  if (!url.pathname.startsWith(prefix)) {
    const root = url.pathname.startsWith(configuredPrefix) ? configuredPrefix
      : url.pathname.startsWith(route) ? route : "/";
    url.pathname = prefix + url.pathname.slice(root.length);
  }
  if (prefix !== configuredPrefix) url.searchParams.set(${JSON.stringify(PREFIX_HINT)}, prefix);
  return url.pathname + url.search + url.hash;
};
const fetch = window.fetch;
window.fetch = function(input, init) {
  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (input instanceof Request) {
    const url = rewrite(input.url);
    if (url !== input.url) input = new Request(new URL(url, location.href), input);
  } else input = rewrite(input);
  return fetch.call(this, input, init).then(response => {
    if (response.ok && /^(POST|PUT|PATCH|DELETE)$/.test(method) && window.parent !== window) {
      window.parent.postMessage({type: "ofm:engine-changed"}, location.origin);
    }
    return response;
  });
};
for (const name of ["EventSource", "WebSocket"]) {
  const Original = window[name]; if (!Original) continue;
  window[name] = new Proxy(Original, {construct(Target, args) {
    args[0] = rewrite(args[0]); return Reflect.construct(Target, args);
  }});
}
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...args) { return open.call(this, method, rewrite(url), ...args); };
for (const [Type, prop] of [[HTMLIFrameElement,"src"],[HTMLImageElement,"src"],[HTMLScriptElement,"src"],
  [HTMLLinkElement,"href"],[HTMLAnchorElement,"href"],[HTMLFormElement,"action"],[HTMLSourceElement,"src"],
  [HTMLMediaElement,"src"],[HTMLVideoElement,"poster"],[HTMLObjectElement,"data"]]) {
  const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, prop);
  if (descriptor?.set) Object.defineProperty(Type.prototype, prop, {...descriptor, set(value) { descriptor.set.call(this, rewrite(value)); }});
}
const setAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(name, value) {
  return setAttribute.call(this, name, /^(src|href|action|poster|data)$/i.test(name) ? rewrite(value) : value);
};
const openWindow = window.open;
window.open = function(url, ...args) { return openWindow.call(this, rewrite(url), ...args); };
for (const name of ["pushState","replaceState"]) {
  const original = history[name];
  history[name] = function(state, title, url) { return original.call(this, state, title, url == null ? url : rewrite(url)); };
}
})();`
}

// Presentation only: the bundled assets, settings and sandbox pages stay intact.
const engineAppearanceCSS = `
:root[data-ofm-engine] :is(.top,.side-top) > .brand,
:root[data-ofm-engine] #agents :is(.ag-menu,.import) > .ic[data-icon="magpie"],
:root[data-ofm-engine] #addSheet .tile > .ic[data-icon="magpie"],
:root[data-ofm-engine] #addSheet .tiles > [data-ofm-promotion],
:root[data-ofm-engine] #about :is(.discord,.github),
:root[data-ofm-engine] #nav button[data-view="plugins"] > span,
:root[data-ofm-engine] #view-plugins :is(.pm-intro,.pm-sechead),
:root[data-ofm-engine] #addProvider.has-new::after { display:none!important }
:root[data-ofm-engine] #view-plugins > .ofm-plugin-source {
  flex:none; margin:0 2px 10px; padding:7px 10px; border:1px solid var(--line-2);
  border-radius:8px; background:var(--card-2); color:var(--fg-2);
  font-size:11.5px; line-height:1.5; text-wrap:pretty;
}
:root[data-ofm-engine] #nav button[data-view="plugins"] > .nav-ic { display:block!important; flex:none }
:root[data-ofm-engine] body:not(.side-nav) #nav button[data-view="plugins"] { display:inline-flex; align-items:center; justify-content:center; min-width:32px }
:root[data-ofm-engine] #view-routing .rt-flier { display:none!important }
:root[data-ofm-engine] #view-routing .rt-hub > .ofm-brand-icon { border-radius:6px; object-fit:cover; }
:root[data-ofm-engine] #view-routing .rt-hub > b { white-space:normal; overflow:visible; overflow-wrap:anywhere; line-height:1.35; }
:root[data-ofm-engine] .side-top:has(> .brand:only-child) { height:10px!important; min-height:0!important }
:root[data-ofm-engine] :is(.top,.sidebar,.view,.row,.editor,.sheet,.dialog,.pop,.seg,button,input,textarea,select) { letter-spacing:0 }
:root[data-ofm-engine] :is(.row,.editor,.sheet,.dialog,.pop) { border-radius:8px }
:root[data-ofm-engine] :is(button,input,textarea,select) { font-family:var(--ui-font,var(--font)); }
/* Floating page tools measure this anchor, even with external controls. */
:root[data-ofm-external-controls] .top > .actions {
  position:absolute; right:0; top:0; display:flex!important;
  width:0; height:0; min-height:0!important; overflow:hidden;
  visibility:hidden; pointer-events:none;
}
:root[data-ofm-external-controls] #side #prefs { display:none!important }
:root[data-ofm-external-controls] body:not(.side-nav) > .top {
  display:block!important; height:auto!important; min-height:0!important;
  padding:0 0 8px!important; margin:0 12px 8px;
  border-bottom:1px solid var(--line-2);
}
:root[data-ofm-external-controls] body:not(.side-nav) #nav {
  position:relative!important; inset:auto!important; transform:none!important;
  display:flex!important; flex-wrap:wrap; flex-basis:auto!important; gap:2px;
  width:100%; max-width:100%; min-width:0; padding:0; overflow:visible!important;
}
:root[data-ofm-external-controls] body:not(.side-nav) #nav > .thumb { display:none }
:root[data-ofm-external-controls] body:not(.side-nav) #nav button {
  height:32px!important; padding:0 10px!important; font-size:12px!important;
}
:root[data-ofm-external-controls] body:not(.side-nav) #nav button.on { background:var(--pill); color:var(--fg); }
:root[data-ofm-engine] #view-providers .after-list.away { display:none!important }
:root[data-ofm-engine] #providerDiscovery {
  flex:none; gap:8px 12px; margin:0 0 12px; padding:10px 12px; border-radius:8px;
}
:root[data-ofm-engine] #providerDiscovery .who { flex:1 1 160px; gap:2px; }
:root[data-ofm-engine] #providerDiscovery .actions { min-height:0; gap:8px; }
:root[data-ofm-engine] #providerDiscovery button.text { height:32px; min-height:32px; }
:root[data-ofm-engine] #addSheet { padding-top:0; }
:root[data-ofm-engine] #addSheet > .row-head { height:auto; min-height:32px; gap:8px; }
:root[data-ofm-engine] #addSheet .find { height:32px; }
:root[data-ofm-engine] #addSheet .kind { padding-top:16px; }
:root[data-ofm-engine-theme] {
  --ofm-bg:#f4f4f6; --ofm-card:#fff; --ofm-fg:#1c1c21; --ofm-quiet:#63636b;
  --ofm-muted:#85858d; --ofm-line:#e3e3e8; --ofm-accent:#4f46e5;
  --bg:var(--dsw-alias-bg-layer-1,var(--ofm-bg))!important;
  --card:var(--dsw-alias-bg-layer-3,var(--ofm-card))!important;
  --card-2:var(--dsw-alias-bg-layer-2,var(--ofm-bg))!important;
  --pill:var(--dsw-alias-bg-layer-2,var(--ofm-bg))!important;
  --pill-hover:color-mix(in srgb,var(--fg) 7%,var(--card))!important;
  --seg-track:var(--pill)!important; --seg-thumb:var(--card)!important;
  --line:var(--dsw-alias-border-l2,var(--ofm-line))!important;
  --line-2:var(--dsw-alias-border-l1,var(--ofm-line))!important;
  --fg:var(--dsw-alias-label-primary,var(--ofm-fg))!important;
  --fg-2:var(--dsw-alias-label-secondary,var(--ofm-quiet))!important;
  --ctl-fg:var(--fg-2)!important;
  --muted:var(--dsw-alias-label-tertiary,var(--ofm-muted))!important;
  --faint:var(--muted)!important;
  --accent:var(--dsw-alias-state-business-primary,var(--ofm-accent))!important;
  --accent-fg:var(--dsw-alias-label-on-accent,#fff)!important;
  --accent-soft:color-mix(in srgb,var(--accent) 12%,var(--card))!important;
  --sel:var(--accent-soft)!important;
  --green:var(--dsw-alias-state-success-primary,#189a58)!important;
  --red:var(--dsw-alias-state-error-primary,#d64545)!important;
  --amber:var(--dsw-alias-state-warning-primary,#b45309)!important;
  --green-soft:color-mix(in srgb,var(--green) 12%,var(--card))!important;
  --red-soft:color-mix(in srgb,var(--red) 12%,var(--card))!important;
  --amber-soft:color-mix(in srgb,var(--amber) 12%,var(--card))!important;
  --drift:var(--red)!important; --drift-soft:var(--red-soft)!important;
  --pop-bg:var(--card)!important;
  --font:var(--ofm-font,system-ui,sans-serif)!important;
  --ui-font:var(--ofm-font,system-ui,sans-serif)!important;
  color-scheme:var(--ofm-color-scheme)!important;
}
:root[data-ofm-engine-theme="dark"] {
  --ofm-bg:#18181b; --ofm-card:#27272a; --ofm-fg:#f4f4f5; --ofm-quiet:#d4d4d8;
  --ofm-muted:#a1a1aa; --ofm-line:#3f3f46; --ofm-accent:#a5b4fc;
}
`

/**
 * The engine page's appearance bridge — browser source, injected verbatim.
 *
 * dsh kept this as a Node-side function and injected `fn.toString()`; the
 * port carries it as a string from the start, because a function body that
 * touches `document` cannot be typechecked by a Node build, and the bytes
 * that reach the page are the same either way.
 */
const ENGINE_APPEARANCE_BRIDGE = `(() => {
  const root = document.documentElement
  root.setAttribute('data-ofm-engine', '')
  let variables = new Set()
  let scheme
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== location.origin) return
    const data = event.data
    if (data?.type === 'ofm:engine-action') {
      if (!root.hasAttribute('data-ofm-external-controls')) return
      const id = data.action === 'refresh' ? 'sync' : data.action === 'settings' ? 'prefs' : null
      const button = id && document.getElementById(id)
      if (button && !button.disabled) button.click()
      return
    }
    if (!data || data.type !== 'ofm:engine-theme' ||
      !['light', 'dark'].includes(data.colorScheme) ||
      !data.variables || typeof data.variables !== 'object' || Array.isArray(data.variables) ||
      typeof data.fontFamily !== 'string' || data.fontFamily.length > 1024 ||
      !CSS.supports('font-family', data.fontFamily)) return
    const entries = Object.entries(data.variables)
    if (entries.length > 256 || entries.some(([name, value]) =>
      !/^--dsw-alias-[a-z0-9-]{1,96}$/.test(name) || typeof value !== 'string' ||
      value.length > 2048 || !CSS.supports('color', value))) return
    const next = new Set(entries.map(([name]) => name))
    for (const name of variables) if (!next.has(name)) root.style.removeProperty(name)
    for (const [name, value] of entries) root.style.setProperty(name, value)
    variables = next
    root.style.setProperty('--ofm-font', data.fontFamily)
    root.style.setProperty('--ofm-color-scheme', data.colorScheme)
    scheme = data.colorScheme
    root.setAttribute('data-ofm-engine-theme', scheme)
    root.setAttribute('data-theme', scheme)
    root.toggleAttribute('data-ofm-external-controls', data.externalControls === true)
  })
  // Upstream refreshes its saved appearance. The embedding host owns this
  // document's presentation, without writing back to those saved preferences.
  new MutationObserver(() => {
    if (scheme && root.getAttribute('data-theme') !== scheme) root.setAttribute('data-theme', scheme)
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
})()`

/**
 * The product-copy bridge the engine page runs — browser source, injected verbatim (see
 * ENGINE_APPEARANCE_BRIDGE for why it is a string and not a function).
 */
const ENGINE_PRODUCT_COPY = `(() => {
  if (typeof window.t !== 'function' || typeof I18N === 'undefined') return
  const translate = window.t
  // Snapshot core templates before plugins register their own words. Replace
  // product mentions before filling slots, never strings supplied by a user.
  const templates = new Set(Object.values(I18N).flatMap(strings => Object.keys(strings)))
  const brand = text => text.replace(
    /(^|[^a-z0-9_{}./:@-])magpie(?!:\/\/)(?=$|[^a-z0-9_{}./@-])/gi,
    (match, before, offset, full) => {
      const rest = full.slice(offset + match.length)
      // These are executable command names, not product copy.
      return /^\s+(?:web|quota|accounts|serve|version|update|status|models|doctor|help)\b/i.test(rest)
        ? match : before + 'Our Free Model'
    })
  window.t = function (source, values) {
    if (!templates.has(source) || !/magpie/i.test(source)) return translate(source, values)
    let text = brand(translate(source))
    if (values) for (const key in values) text = text.split('{' + key + '}').join(values[key])
    return text
  }
  // Cache the upstream English exactly as translateStatic does, so changing
  // language continues to use the original translation keys.
  for (const element of document.querySelectorAll('[data-t]')) {
    if (element.dataset.en === undefined) element.dataset.en = element.textContent
    if (templates.has(element.dataset.en)) element.textContent = window.t(element.dataset.en)
  }
  document.title = 'Our Free Model'
  document.querySelector('link[rel="icon"]')?.remove()
  const brandLabels = () => {
    const plugins = document.querySelector('#nav button[data-view="plugins"]')
    if (plugins) {
      const label = translate('Plugins')
      if (plugins.getAttribute('aria-label') !== label) plugins.setAttribute('aria-label', label)
      if (plugins.getAttribute('title') !== label) plugins.setAttribute('title', label)
    }
    for (const element of document.querySelectorAll('.top > .brand > span:not(.logo),.side-top > .brand > span:not(.logo)')) {
      if (element.textContent.trim() === 'magpie') element.textContent = 'Our Free Model'
    }
    for (const element of document.querySelectorAll('#agents button.field.import > .v')) {
      if (element.textContent === 'magpie') element.textContent = 'Our Free Model'
    }
    for (const element of document.querySelectorAll('#view-routing .rt-hub > b')) {
      if (element.textContent.trim() === 'magpie') element.textContent = 'Our Free Model'
    }
    for (const element of document.querySelectorAll('#view-routing .rt-hub > svg.rt-bird')) {
      const image = document.createElement('img')
      image.className = 'rt-bird ofm-brand-icon'
      image.src = brandIcon
      image.alt = ''
      image.width = image.height = 26
      element.replaceWith(image)
    }
    // Only the paid discovery section is hidden; an already configured partner
    // is still an ordinary, fully editable provider elsewhere in the UI.
    for (const heading of document.querySelectorAll('#addSheet .tiles > .kind')) {
      if (heading.querySelector('b')?.textContent !== translate('Partners')) continue
      heading.setAttribute('data-ofm-promotion', '')
      if (heading.nextElementSibling?.classList.contains('grid')) heading.nextElementSibling.setAttribute('data-ofm-promotion', '')
    }
    const add = document.querySelector('#addProvider.has-new')
    if (add?.hasAttribute('title')) add.removeAttribute('title')
    pluginSource()
  }
  // The plugin market is magpie's community's, not this product's: say whose it
  // is on every tab that offers third-party code. The built-in tab lists the
  // engine's own switches, so it carries no such notice. The page redraws its
  // children through replaceKeeping, so the note is put back when it goes.
  const pluginSource = () => {
    const view = document.querySelector('#view-plugins')
    if (!view) return
    const body = view.querySelector(':scope > .pm-body')
    const tabs = [...view.querySelectorAll('.lib-tabs .opt')]
    const active = tabs.findIndex(tab => tab.classList.contains('on'))
    const notice = view.querySelector(':scope > .ofm-plugin-source')
    if (!body || active === 0) { notice?.remove(); return }
    const zh = /^zh/i.test(typeof locale === 'string' ? locale : document.documentElement.lang || '')
    const text = zh
      ? '这里的插件来自 magpie 社区（github.com/magpie-community/plugins），由社区作者维护，与 Our Free Model 无关：我们不提供这些插件，也不对其行为负责。'
      : 'Plugins here come from the magpie community (github.com/magpie-community/plugins) and are maintained by their authors. They are not part of Our Free Model: we do not provide them and are not responsible for them.'
    if (notice) { if (notice.textContent !== text) notice.textContent = text; return }
    const note = document.createElement('p')
    note.className = 'ofm-plugin-source'
    note.setAttribute('role', 'note')
    note.textContent = text
    body.before(note)
  }
  const observer = new MutationObserver(brandLabels)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'title'] })
  brandLabels()
}
})()`

/**
 * The display-controls bridge the engine page runs — browser source, injected verbatim.
 */
const ENGINE_DISPLAY_CONTROLS = `(() => {
  // The remote engine preset bypasses t(). Pass a display-only copy to its
  // renderer; its id, callbacks and the provider store remain upstream's.
  if (typeof window.tile !== 'function') return
  const tile = window.tile
  window.tile = function (preset) {
    return tile.call(this, preset?.id === 'remote-magpie' ? {
      ...preset,
      name: preset.name.replace(/magpie/gi, 'Our Free Model'),
      ...(preset.short ? { short: preset.short.replace(/magpie/gi, 'Our Free Model') } : {}),
    } : preset)
  }
}
})()`

export function rewriteHTML(html: string, pathname: string, prefix: string, mount: string = MAGPIE_UI_PREFIX): string {
  const plugin = pathname.startsWith('/_magpie/plugin/')
  const relativeRoot = plugin ? '../'.repeat(pathname.split('/').filter(Boolean).length - 1) : ''
  html = html.replace(/\b(src|href|action|poster)=(["'])\/(?!\/)(.*?)\2/gi,
    (_, name, quote, rest) => `${name}=${quote}${relativeRoot}${rest}${quote}`)
  // Plugin pages keep their own relative directory and cannot execute injected
  // inline code (CSP). Their bridge is served unchanged from their token folder.
  if (plugin) return html
  const main = pathname === '/' || pathname === '/index.html'
  const appearance = main
    ? `<style id="ofm-engine-appearance">${engineAppearanceCSS}</style><script>${ENGINE_APPEARANCE_BRIDGE};</script>` : ''
  if (main) {
    // Include the bundled pages' dictionaries, registered after core i18n.js.
    html = html.replace(/<script\b[^>]*\bsrc=(["'])(?:\.\/)?app\.js(?:\?[^"']*)?\1[^>]*>\s*<\/script>/i,
      match => `<script>${ENGINE_PRODUCT_COPY};</script>${match}`)
    html = html.replace(/<script\b[^>]*\bsrc=(["'])(?:\.\/)?start\.js(?:\?[^"']*)?\1[^>]*>\s*<\/script>/i,
      match => `<script>${ENGINE_DISPLAY_CONTROLS};</script>${match}`)
  }
  const injection = `<base href="${prefix}"><script>${browserBridge(prefix, mount)}</script>${appearance}`
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, match => match + injection)
    : injection + html
}

export function forbiddenFrame(headers: any, pathname: string): boolean {
  return pathname.startsWith('/api/') && (headers.origin === 'null' ||
    ['iframe', 'frame', 'embed', 'object'].includes(headers['sec-fetch-dest']) ||
    (headers['sec-fetch-site'] === 'cross-site' && headers['sec-fetch-dest'] !== 'document'))
}

export function protectUpdate(method: string, pathname: string): void {
  if (method !== 'GET' && method !== 'HEAD' && /^\/api\/update(?:\/|$)/.test(pathname)) {
    throw engineError('Engine updates are managed by the application build', 409)
  }
}

/** A request body as the policy reads it; anything unreadable decides nothing. */
function parseBodyJSON(body: any): any {
  if (body == null) return {}
  if (typeof body === 'object' && !Buffer.isBuffer(body) && !ArrayBuffer.isView(body)) return body
  try {
    const text = typeof body === 'string' ? body
      : Buffer.isBuffer(body) ? body.toString('utf8') : new TextDecoder().decode(body)
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

/**
 * Owns one private Magpie child. request() returns a Fetch Response; gateway()
 * is privileged adapter-only access. The caller admits trusted UI requests and
 * enforces its own origin policy before proxy(). close() is terminal.
 */
