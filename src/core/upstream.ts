/**
 * The shared upstream wire the model runtime needs: the classified-error
 * vocabulary, one JSON GET, and the conversation→session map.
 *
 * Three things live here because all three are about *what the upstream said*,
 * and each was verified against the live gateway (see `src/upstream.js`'s
 * measurements in the ported comments):
 *
 * - `CODE` / `UpstreamError` — every refusal this product can classify, as one
 *   vocabulary. A code that is not in this list is something the product has
 *   not seen, and guessing at it is how a region block becomes a retry.
 * - `getJson` — one GET with the client fingerprint and a deadline, whose
 *   abort reason decides the code: this call's own deadline is a retryable
 *   timeout, the caller ending the request is not a failure at all.
 * - `sessionForConversation` — one upstream session per downstream
 *   conversation, persisted so a restart does not mint a second session for the
 *   same conversation (the free lane meters per session: a fresh id per request
 *   answers 429 on a conversation that was working). The data directory is a
 *   parameter, not a resolved constant: the two entries (`server.ts`, the
 *   standalone) must not disagree about where the user's state lives.
 *
 * Transport note: dsh's `egressFetch` routed the official free lane through a
 * local Bun executable and everything else through `fetch` (or the egress
 * relay). This build's lanes run on plain `fetch` (`catalog.ts`, `opencode.ts`,
 * `kilo.ts`), so this GET does too; `gateway/egress.ts` keeps the Bun seam for
 * the relay it serves.
 *
 * Ported from dsh's `src/http.js` (CODE, UpstreamError, getJson,
 * classifyFailure) and `src/upstream.js` (the session map and model predicates).
 *
 * @module pi-extension/core/upstream.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gatewayHeaders, SESSION_DESCENDING_RE, SESSION_RE } from '../fingerprint.js'
import { userAgentWith } from '../attribution.js'
import { SNIFF_BYTES, sniffBody, readHead, replayStream, readSse, readRemainder, transportCause } from '../transport.js'

/**
 * Overridable so a test can point the runtime at a dead port and exercise the
 * transport-failure path without spending the real lane's quota.
 */
export const UPSTREAM_BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'

export const CODE = {
  region: 'REGION_BLOCKED',
  quota: 'RATE_LIMIT',
  credential: 'INVALID_CREDENTIAL',
  // The co-paid lane's per-user gate (GitHub login + star): the credential
  // store is fine and the endpoint is reachable — this install just has not
  // been authorized yet. Its own code keeps it out of INVALID_CREDENTIAL, so
  // a refusal neither wipes the cached roster nor sends anyone chasing a
  // re-install; the settings page answers it with a login prompt instead.
  authorization: 'AUTHORIZATION_REQUIRED',
  // The free lane's client gate: the gateway judged *this client* and refused
  // the whole lane (403 FreeTierError). Not a credential, not a model, not
  // retryable — a refusal this install cannot retry away.
  laneLocked: 'LANE_LOCKED',
  permission: 'PERMISSION_DENIED',
  exhausted: 'QUOTA_EXHAUSTED',
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  server: 'SERVER',
  client: 'CLIENT_ERROR',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
}

export class UpstreamError extends Error {
  code: string
  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    Object.assign(this, details)
  }
}

/** Models served by /responses instead of /chat/completions. */
const RESPONSES_MODELS = new Set(['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'])
/** Models served by the Anthropic-shaped /messages endpoint. */
const MESSAGES_MODELS = new Set(['union-alpha'])

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function isResponsesModel(modelId: unknown): boolean {
  const base = String(modelId ?? '')
  return RESPONSES_MODELS.has(base) || /muse.?spark/i.test(base)
}

export function isMessagesModel(modelId: unknown): boolean {
  return MESSAGES_MODELS.has(String(modelId ?? ''))
}

/** Whether `id` is a session the upstream free tier will accept as-is. */
export function isCanonicalSession(id: unknown): boolean {
  return typeof id === 'string' && SESSION_RE.test(id.trim()) && SESSION_DESCENDING_RE.test(id.trim().slice(4, 16))
}

/**
 * Re-encode any session id into the descending layout the gate accepts, keeping
 * one conversation pinned to one upstream session.
 *
 * The digest is the same `ses\0<signal>` sha256 the reference gateway uses, so a
 * given downstream conversation always maps to the same upstream id. Counter 1
 * keeps the low 12 bits at `0xffe`, inside the accepted window.
 */
export function canonicalizeSession(signal: string): string {
  const digest = crypto.createHash('sha256').update(`ses\0${signal}`).digest()
  const current = ((BigInt(digest[0]) << 28n | BigInt(digest[1]) << 20n | BigInt(digest[2]) << 12n |
    BigInt(digest[3]) << 4n | BigInt(digest[4]) >> 4n) << 12n) | 1n
  const inverted = ~current & 0xffffffffffffn
  const timeHex = inverted.toString(16).padStart(12, '0')
  return `ses_${timeHex}${base62Fixed(digest.subarray(6, 16), 14)}`
}

/** Render `bytes` as exactly `width` base62 characters (big-endian). */
function base62Fixed(bytes: Uint8Array, width: number): string {
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  const base = 62n
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62[Number(n % base)]
    n /= base
  }
  return out.join('')
}

function base62From(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

let lastStamp = 0
let seq = 0

/**
 * Mint a gateway-shaped canonical session id (time-prefixed, monotonic counter).
 *
 * The encoding is the gate's: `~(ts_ms * 0x1000 + counter)`, whose low 12 bits
 * land at `0xfff - counter`. The counter resets every millisecond, so a burst of
 * mints inside one millisecond stays inside the accepted 1–63 window.
 */
export function mintSessionId(timestamp = Date.now()): string {
  if (timestamp !== lastStamp) { lastStamp = timestamp; seq = 0 }
  seq += 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq))
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `ses_${hex}${base62From(crypto.randomBytes(14))}`
}

/**
 * Mint a `msg_`-shaped id for local bookkeeping (turn/recovery records).
 *
 * This value never rides the wire: `x-opencode-request` is the v1-only header
 * and v2 answers 403 when it sees one. The minter stays because recovery
 * records and tests still use it as a one-shot identifier.
 */
export function mintRequestId(timestamp = Date.now()): string {
  const value = BigInt(timestamp) * 0x1000n + 1n
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `msg_${hex}${base62From(crypto.randomBytes(14))}`
}

const SESSION_MAP_FILE = 'session-map.json'
/** Per-data-directory session maps, so two entries in one process never share one. */
const maps = new Map<string, Map<string, string>>()

function sessionStorePath(dataDir: string | undefined): string | undefined {
  try { return path.join(path.resolve(dataDir as string), SESSION_MAP_FILE) } catch { return undefined }
}

function loadSessions(dataDir: string | undefined): Map<string, string> {
  const key = dataDir ?? ':memory:'
  const known = maps.get(key)
  if (known !== undefined) return known
  const sessions = new Map<string, string>()
  maps.set(key, sessions)
  try {
    const file = sessionStorePath(dataDir)
    if (file === undefined) return sessions
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [seed, id] of Object.entries(parsed?.sessions ?? {})) {
      if (typeof id === 'string' && SESSION_RE.test(id)) sessions.set(seed, id)
    }
  } catch { /* first run or unreadable store: start empty */ }
  return sessions
}

function rememberSession(dataDir: string | undefined, seed: string, id: string) {
  loadSessions(dataDir).set(seed, id)
  try {
    const file = sessionStorePath(dataDir)
    if (file === undefined) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: 2, at: Date.now(), sessions: Object.fromEntries(loadSessions(dataDir)) }, undefined, 2))
    fs.renameSync(temp, file)
  } catch { /* non-fatal: the id still works, it just will not survive a restart */ }
}

/**
 * Map one downstream conversation onto one stable upstream session.
 *
 * Mint once using a real creation timestamp and persist the result. Never
 * rotate IDs on retries or model errors. A caller's canonical OC ID is kept.
 *
 * Live A/B controls on 2026-10-28: hash-derived pseudo timestamps returned 429
 * even for an unused ID; a real timestamp returned 200 and repeated use of that
 * same ID also returned 200. Structural regex validation alone is insufficient.
 * Legacy deterministic mappings are migrated once on use; other remembered
 * canonical IDs remain unchanged, including across restarts.
 */
export function sessionForConversation(sessionId: unknown, dataDir?: string): string {
  if (typeof sessionId === 'string' && isCanonicalSession(sessionId)) return sessionId.trim()
  const seed = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'global'
  const remembered = loadSessions(dataDir).get(seed)
  // A hash-derived pseudo timestamp has the right shape but is not a real
  // creation time. Migrate exactly that old mapping once; preserve real IDs.
  if (remembered !== undefined && isCanonicalSession(remembered) && remembered !== canonicalizeSession(seed)) return remembered
  const minted = mintSessionId()
  rememberSession(dataDir, seed, minted)
  return minted
}

/** The session id travels in a header, so a stored over-long one is clipped. */
export function truncateSession(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return text.length <= 256 ? text : text.slice(0, 256)
}

/**
 * One JSON GET against the upstream base, wearing the client fingerprint.
 *
 * `path` is a path, not a URL: the base is this module's `UPSTREAM_BASE`, so a
 * caller cannot redirect the request by passing an absolute one. A non-JSON
 * body is kept as an error payload rather than thrown past JSON.parse, and a
 * non-2xx is classified rather than surfaced raw — the caller sees a code it
 * can act on.
 */
export async function getJson(pathname: string, { session, attributionUserAgent, signal, timeoutMs = 15000 }: {
  session?: string
  attributionUserAgent?: string
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<any> {
  const headers: Record<string, string> = gatewayHeaders({ session: truncateSession(session ?? ''), stream: false, accept: 'application/json' })
  headers['user-agent'] = userAgentWith(attributionUserAgent)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  // Which of the two aborted decides the code: this call's own deadline is a
  // retryable timeout, the caller ending the request is not a failure at all.
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const response = await fetch(`${UPSTREAM_BASE}${pathname}`, { headers, redirect: 'error', signal: controller.signal })
    const text = await response.text()
    let payload: any
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 200) } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    return payload
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if ((error as Error)?.name === 'AbortError') throw new UpstreamError('our-free-model: upstream GET timed out', CODE.timeout)
    throw new UpstreamError(`our-free-model: upstream GET failed: ${(error as Error)?.message ?? error}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }
}

/**
 * Which upstream path serves this model. The free lane lives under
 * `/inference/v1` (measured 2026-10-14, and the shape the console's model table
 * documents); `/zen/v1` chat completions answer 403 FreeTierError for free ids.
 */
export function endpointFor(modelId: unknown): string {
  if (isResponsesModel(modelId)) return '/inference/v1/responses'
  if (isMessagesModel(modelId)) return '/inference/v1/messages'
  return '/inference/v1/chat/completions'
}

/** The wire shape one endpoint speaks; drives request encoding and response parsing. */
export function wireFor(modelId: unknown): 'responses' | 'messages' | 'chat' {
  const path = endpointFor(modelId)
  if (path === '/inference/v1/responses') return 'responses'
  if (path === '/inference/v1/messages') return 'messages'
  return 'chat'
}

/**
 * Whether a request body carries image parts.
 *
 * The free lane's gateway answers a share of image requests with a bare 5xx and
 * an empty body, so the status says nothing about the cause. The image content
 * is then the one fact the caller can act on (issue #549).
 *
 * Matched on the `type` spelling rather than one dialect's field name, because
 * the three wires this repo speaks disagree: OpenAI says `image_url`, the
 * harness says `input_image`, Messages says `image`.
 */
export function carriesImageContent(body: any): boolean {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (typeof part?.type === 'string' && part.type.includes('image')) return true
    }
  }
  return false
}

/**
 * The failure an empty 5xx body deserves.
 *
 * `classifyFailure` turns an empty body into the message `HTTP 502`, which tells
 * the caller nothing: a gateway hiccup and a refusal of this exact request read
 * identically, and #549's image requests land here about half the time. Say what
 * is known — the hop that failed, and that the request carried images — and keep
 * the retryability a 5xx implies. A 4xx with an empty body keeps going through
 * `classifyFailure`, which already reads the status correctly.
 */
function emptyBodyFailure(status: number, retryAfterMs: number | undefined, imageContent: boolean): UpstreamError {
  const hint = imageContent
    ? ' — this request carried image content, and the model behind the gateway may not accept vision input'
    : ''
  return new UpstreamError(
    `the gateway answered HTTP ${status} with an empty body: the failure is upstream of the model, not in this request${hint}`,
    CODE.server,
    { status, emptyBody: true, ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }) })
}

function retryAfter(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/**
 * One streaming POST against the upstream base, with every SSE frame handed to
 * `onData` as it arrives.
 *
 * `Content-Type` is a hint, not a verdict: the first bytes are sniffed and
 * replayed in front of the stream, so a gateway that answers `text/plain` with
 * SSE is still read as SSE and nothing is buffered away. A 200 body of markup
 * is a WAF/CDN page in front of the gateway — one readable line, outside the
 * retryable set, because replaying the identical request draws it again.
 */
export async function postStreamed({ path: pathname, body, session, attributionUserAgent, signal, onData, timeoutMs = 300000 }: {
  path: string
  body: any
  session?: string
  attributionUserAgent?: string
  signal?: AbortSignal
  onData: (payload: string) => void
  timeoutMs?: number
}) {
  const headers: Record<string, string> = gatewayHeaders({ session: truncateSession(session ?? ''), stream: true })
  headers['user-agent'] = userAgentWith(attributionUserAgent)
  let response: Response
  try {
    response = await fetch(`${UPSTREAM_BASE}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal })
  } catch (error) {
    // The signal's own reason is what fetch rejects with, and Node's is a
    // `TimeoutError`/user Error rather than `AbortError` — testing the name alone
    // reported a cancelled turn as `TRANSPORT`, which is retryable.
    if (signal?.aborted === true || (error as Error)?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`our-free-model: upstream request failed: ${(error as Error)?.message ?? error}${transportCause(error)}`, CODE.transport)
  }

  const setRetry = retryAfter(response.headers.get('retry-after'))
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // An empty 5xx body is the case #549 is about: there is no envelope to
    // classify, and `HTTP 502` is not an answer the caller can act on.
    if (text.trim() === '' && response.status >= 500) {
      throw emptyBodyFailure(response.status, setRetry, carriesImageContent(body))
    }
    let payload: any
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('our-free-model: upstream returned no body', CODE.empty)

  const head = await readHead(response.body, SNIFF_BYTES, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('our-free-model: upstream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head) as never, onData, signal, timeoutMs)
    return { status: response.status, headers: response.headers }
  }

  const text = head.done ? head.text : await readRemainder(head)
  if (shape !== 'json') {
    if (/^\s*<(!doctype|html[\s>])/i.test(text)) {
      throw new UpstreamError(`the gateway's front proxy answered HTTP ${response.status} with an HTML error page — usually a WAF or body-size limit in front of the gateway`, CODE.client, { status: response.status })
    }
    throw new UpstreamError(`our-free-model: unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  let payload: any
  try { payload = JSON.parse(text) } catch {
    throw new UpstreamError(`our-free-model: unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload?.error !== undefined && payload?.error !== null) throw classifyFailure(response.status, payload, setRetry)
  onData(JSON.stringify(payload))
  return { status: response.status, headers: response.headers }
}

/**
 * Classify one upstream HTTP refusal into this product's vocabulary.
 *
 * The status alone is not the verdict — the gateway's own error body names the
 * gate that fired (region, quota, client fingerprint), and that name is what
 * decides whether a retry could ever help.
 */
export function classifyFailure(status: number, payload: any, retryAfterMs?: number): UpstreamError {
  const error = payload?.error ?? payload
  const code = String(error?.code ?? error?.type ?? '')
  const message = String(error?.message ?? `upstream answered HTTP ${status}`)
  const retry = Number(error?.retry_after_ms ?? payload?.retry_after_ms ?? 0) || retryAfterMs
  if (status === 403 && /region/i.test(code)) return new UpstreamError(message, CODE.region)
  if (status === 429) return new UpstreamError(message, CODE.quota, retry ? { providerRetryAfterMs: retry } : {})
  if (status === 403 && /freetier|fingerprint/i.test(code)) return new UpstreamError(message, CODE.laneLocked)
  if (status === 401 || status === 403) return new UpstreamError(message, CODE.credential)
  if (status === 408) return new UpstreamError(message, CODE.timeout)
  if (status >= 500) return new UpstreamError(message, CODE.server)
  return new UpstreamError(message, CODE.client, { status })
}

/**
 * Classify a failure that happened *while reading* a stream.
 *
 * Distinct from `classifyFailure` because the status is already gone by then:
 * what is left is the reader's own error, and the only distinction that matters
 * is whether the caller walked away (not a failure at all) or the transport
 * broke underneath a live turn (retryable).
 */
export function classifyStreamFailure(error: any, signal?: AbortSignal): UpstreamError {
  if (error instanceof UpstreamError) return error
  if (signal?.aborted === true || error?.name === 'AbortError') return new UpstreamError('request aborted', CODE.aborted)
  return new UpstreamError(`our-free-model: upstream stream read failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
}
