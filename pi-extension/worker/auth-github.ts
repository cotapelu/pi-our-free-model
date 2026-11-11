/**
 * GitHub authorization gate for the co-paid lane — self-hosted gateway only.
 *
 * The lane's server side is this gateway, not the relay: the plugin never speaks
 * the relay's auth, it only carries a shared signing secret, so the one place a
 * per-user gate can actually hold is here, in front of the relay key.
 *
 *     plugin                          gateway                     github
 *       │ POST login/start (link) ──────▶
 *       │                               │ 302 authorize (state = HMAC)
 *       │   (system browser) ───────────┴──────────▶ user signs in
 *       │◀─ poll /auth/poll?link ───────│◀── callback?code ──┤
 *       │                               │ exchange code, GET /user,
 *       │                               │ GET /user/starred/<repo>
 *       │◀─ token + ack ───────────────│ starred ⇒ mint per-user token
 *       │ ── ack after local save ─────▶│
 *       │ ── x-ofm-user: token ────────▶ chat turns are refused without it
 *
 * Storage is `users.json` beside the gateway (0600, atomic writes): GitHub ids,
 * logins, SHA-256 of issued tokens, star verdicts, and the GitHub OAuth token
 * AES-256-GCM-encrypted under `USER_STORE_KEY`. That encrypted token is the only
 * way to re-check the star later, and a star that is removed must stop working.
 * The pending logins are encrypted the same way, so a login that completes
 * survives a restart: the plugin collects the token by polling, and a restart
 * between callback and poll must not strand the flow.
 *
 * Enforcement is `REQUIRE_USER_TOKEN=1`. With the flag off the gate is a
 * compatibility window — tokens are accepted and tracked, nothing is refused.
 * Flipping the flag is the whole cutover: no code change, one restart.
 *
 * Ported from dsh's `worker/auth-github.mjs`.
 *
 * @module pi-extension/worker/auth-github.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { nodeFetch, type FetchLike } from './github-transport.js'

const DEFAULT_STAR_REPO = 'Ebony-Vinyl/dsh-our-free-model'
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API = 'https://api.github.com'

/** The plugin mints the link code; this is the shape it must arrive in. */
const LINK_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const STATE_TTL_MS = 10 * 60_000
/** How long a completed (or refused) login stays collectable by the plugin. */
const PENDING_TTL_MS = 15 * 60_000
/** A "not starred yet" page keeps this ticket so "recheck" needs no new OAuth. */
const TICKET_TTL_MS = 30 * 60_000
const STORE_VERSION = 1
const AUTH_RATE_PER_MINUTE = 30
/** A GitHub call is bounded: the gate is a door, not a proxy. */
const GITHUB_TIMEOUT_MS = 10_000

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const sha256hex = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const b64url = (buffer: Buffer): string => buffer.toString('base64url')

/**
 * Escape a string for interpolating into an HTML page.
 *
 * These pages interpolate logins and error strings, so everything crossing that
 * boundary goes through here whatever its expected charset. It is an escaper for
 * a *template*, not a node tree — the announcement parser in `client/sanitizer.ts`
 * is the other half of this boundary, for markup rather than for text.
 */
function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101418; color: #e8ecf1; }
  main { max-width: 560px; padding: 40px 32px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 8px 0; color: #b7c0cc; }
  a.btn { display: inline-block; margin-top: 16px; padding: 10px 18px; border-radius: 8px; background: #2f81f7; color: #fff; text-decoration: none; font-weight: 600; }
  a.btn.alt { background: #2b3440; }
  code { background: #1b222b; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`
}

/** One per-user row in the store. */
interface GateUser {
  created: number
  login: string
  avatar: string
  ghToken: string
  starred: boolean
  lastCheck: number
  lastCheckError: string | null
  revokedReason?: string
  tokens: Record<string, { created: number; lastSeen: number }>
}

/** One collectable login result. */
interface PendingEntry {
  status: 'waiting' | 'ok' | 'unstarred'
  login?: string
  avatar?: string
  token?: string
  exp: number
}

interface GateStore {
  version: number
  users: Record<string, GateUser>
  pending: Record<string, PendingEntry>
}

export interface GateEnv {
  MOUNT_PREFIX?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  REQUIRE_STAR_REPO?: string
  REQUIRE_USER_TOKEN?: string
  STAR_RECHECK_HOURS?: string
  PUBLIC_ORIGIN?: string
  USER_STORE_KEY?: string
  SIGNING_SECRETS?: string
  USER_STORE_PATH?: string
}

export interface GateOptions {
  /** The GitHub transport. Defaults to {@link nodeFetch} — see its module note. */
  fetchImpl?: FetchLike
  log?: (message: string) => void
  storePath?: string
  now?: () => number
}

export interface GateVerdict {
  ok: boolean
  required: boolean
  reason?: string
  login?: string
  githubId?: string | null
  user?: GateUser | null
  detail?: string | null
}

export interface AuthGate {
  configured: boolean
  enforcement: boolean
  prefix: string
  handle(req: any, res: any, url: URL): boolean
  check(rawToken: string): GateVerdict
  stats(): Record<string, any>
  storePath: string
  recheckAll(): Promise<void>
  recheckUser(githubId: string, force?: boolean): Promise<void>
  snapshot(): GateStore
  close(): void
}

/**
 * Build the gate. Returns the small surface a host wires into its server:
 * `handle` (auth routes), `check` (the per-request verdict for chat turns),
 * `stats` (counts for the dashboard) and `close`.
 */
export function createAuthGate(env: GateEnv = {}, options: GateOptions = {}): AuthGate {
  const log = options.log ?? ((message: string) => console.log(message))
  // `nodeFetch` rather than the global fetch by default: see its module note — on
  // the live host undici cannot open these connections at all, while node:https can.
  const impl = options.fetchImpl ?? nodeFetch
  const now = options.now ?? (() => Date.now())
  const storePath = options.storePath ?? env.USER_STORE_PATH ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'users.json')
  const prefix = String(env.MOUNT_PREFIX ?? '').replace(/\/+$/, '')
  const clientId = String(env.GITHUB_CLIENT_ID ?? '').trim()
  const clientSecret = String(env.GITHUB_CLIENT_SECRET ?? '').trim()
  const starRepo = String(env.REQUIRE_STAR_REPO ?? DEFAULT_STAR_REPO).trim() || DEFAULT_STAR_REPO
  const enforcement = String(env.REQUIRE_USER_TOKEN ?? '0') === '1'
  const recheckHours = Math.max(1, Number.parseInt(env.STAR_RECHECK_HOURS ?? '12', 10) || 12)
  const recheckMs = recheckHours * 3_600_000
  const publicOrigin = String(env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, '')
  const configured = clientId !== '' && clientSecret !== ''
  // The store key doubles as the state/ticket signing key. A dedicated
  // USER_STORE_KEY is preferred; the lane's signing secret keeps deployments that
  // predate this feature working without a new secret to roll out.
  const keyMaterial = String(env.USER_STORE_KEY ?? '').trim()
    || String(env.SIGNING_SECRETS ?? '').split(',')[0]?.trim()
    || ''
  const keyReady = keyMaterial.length >= 16
  const stateKey = crypto.createHash('sha256').update(`ofm-eac-auth-state\0${keyMaterial}`, 'utf8').digest()
  /** Derived, not stored: rotating the key material invalidates the sealed blobs. */
  const encKey = crypto.createHash('sha256').update(`ofm-eac-user-store\0${keyMaterial}`, 'utf8').digest()

  let store: GateStore = { version: STORE_VERSION, users: {}, pending: {} }
  /** token sha256 → github id; rebuilt on load and on every mutation. */
  let tokenIndex = new Map<string, string>()
  /** ticket id → the "starred now?" recheck context. */
  const tickets = new Map<string, { link: string; login: string; gh: string; githubId: string; avatar: string; exp: number }>()
  /** Fixed-window limiter for the auth surface, per IP. */
  const authHits = new Map<string, { start: number; count: number }>()

  function rebuildIndex(): void {
    tokenIndex = new Map()
    for (const [id, user] of Object.entries(store.users)) {
      for (const hash of Object.keys(user.tokens ?? {})) tokenIndex.set(hash, id)
    }
  }

  function load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.users !== null && typeof parsed.users === 'object') {
        store = {
          version: STORE_VERSION,
          users: parsed.users,
          // A store from before the pending section existed loses that window: the
          // entry answers "expired" and the user simply logs in again.
          pending: parsed.pending !== null && typeof parsed.pending === 'object' && !Array.isArray(parsed.pending)
            ? parsed.pending
            : {},
        }
      }
    } catch { /* absent is the normal first boot; unreadable keeps the empty store */ }
    sweepPending(false)
    rebuildIndex()
  }

  function save(): void {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true })
      const temp = `${storePath}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(store, undefined, 2), { mode: 0o600 })
      fs.renameSync(temp, storePath)
    } catch (error) {
      log(JSON.stringify({ lane: 'eac-auth', fault: `user store write failed: ${String((error as Error)?.message ?? error).slice(0, 120)}` }))
    }
  }

  // ── the GitHub token at rest ────────────────────────────────────────────────
  function encryptGh(token: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv, { authTagLength: 16 })
    const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    return `v1.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(ct)}`
  }

  function decryptGh(blob: unknown): string | null {
    try {
      const [version, iv, tag, ct] = String(blob ?? '').split('.')
      if (version !== 'v1' || !iv || !tag || !ct) return null
      const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'), { authTagLength: 16 })
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      // A tampered blob, or one sealed under a rotated key, is indistinguishable
      // here — and both mean "cannot re-check this user's star".
      return null
    }
  }

  // ── signed state / ticket ids ──────────────────────────────────────────────
  function signState(payload: Record<string, unknown>): string {
    const body = b64url(Buffer.from(JSON.stringify(payload)))
    const mac = crypto.createHmac('sha256', stateKey).update(body).digest('base64url')
    return `${body}.${mac}`
  }

  function verifyState(text: string): Record<string, any> | null {
    const [body, mac] = String(text ?? '').split('.')
    if (!body || !mac) return null
    const expected = crypto.createHmac('sha256', stateKey).update(body).digest('base64url')
    if (!timingSafeEqual(mac, expected)) return null
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      if (typeof payload?.exp !== 'number' || payload.exp < now()) return null
      return payload
    } catch {
      return null
    }
  }

  // ── GitHub calls ───────────────────────────────────────────────────────────
  const githubHeaders = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'eac-gateway',
    'x-github-api-version': '2022-11-28',
  })

  async function exchangeCode(code: string, redirectUri: string): Promise<string> {
    const response = await impl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'eac-gateway' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || typeof body?.access_token !== 'string' || body.access_token === '') {
      throw new Error(`github code exchange failed (HTTP ${response.status}${body?.error ? `: ${body.error}` : ''})`)
    }
    return body.access_token
  }

  async function fetchGithubUser(token: string): Promise<{ id: string; login: string; avatar: string }> {
    const response = await impl(`${GITHUB_API}/user`, { headers: githubHeaders(token), signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`github user lookup failed (HTTP ${response.status})`)
    const body = await response.json()
    // A login with no numeric id is not a GitHub user; carrying it would mint an
    // account that can never be re-checked.
    if (!Number.isFinite(body?.id)) throw new Error('github user lookup returned no id')
    return { id: String(body.id), login: String(body.login ?? ''), avatar: String(body.avatar_url ?? '') }
  }

  /**
   * 204 = starred, 404 = not; 401 is a dead authorization (needs re-login),
   * everything else (403 rate limit, 5xx, network) is **transient** and must not
   * take access away from a user who may well still be starred.
   */
  async function checkStar(token: string): Promise<{ starred?: boolean; fatal?: boolean; error?: string }> {
    try {
      const response = await impl(`${GITHUB_API}/user/starred/${starRepo}`, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      })
      if (response.status === 204) return { starred: true }
      if (response.status === 404) return { starred: false }
      if (response.status === 401) return { fatal: true, error: 'github authorization is no longer valid' }
      return { error: `github answered HTTP ${response.status}` }
    } catch (error) {
      return { error: `github unreachable: ${String((error as Error)?.message ?? error).slice(0, 100)}` }
    }
  }

  // ── store mutations ────────────────────────────────────────────────────────
  function mintToken(githubId: string, user: GateUser): string {
    const token = crypto.randomBytes(32).toString('base64url')
    const hash = sha256hex(token)
    user.tokens = { ...(user.tokens ?? {}), [hash]: { created: now(), lastSeen: now() } }
    store.users[githubId] = user
    rebuildIndex()
    save()
    return token
  }

  function lookup(rawToken: string): { githubId: string; user: GateUser; tokenHash: string } | null {
    if (typeof rawToken !== 'string' || rawToken === '') return null
    const hash = sha256hex(rawToken)
    const githubId = tokenIndex.get(hash)
    if (githubId === undefined) return null
    const user = store.users[githubId]
    if (user === undefined) return null
    const row = user.tokens[hash]
    if (row !== undefined) row.lastSeen = now()
    return { githubId, user, tokenHash: hash }
  }

  function revokeToken(rawToken: string): boolean {
    const found = lookup(rawToken)
    if (found === null) return false
    delete found.user.tokens[found.tokenHash]
    rebuildIndex()
    save()
    return true
  }

  async function recheckUser(githubId: string, user: GateUser | undefined, { force = false }: { force?: boolean } = {}): Promise<void> {
    if (user === undefined) return
    if (!force && now() - (user.lastCheck ?? 0) < recheckMs) return
    const gh = decryptGh(user.ghToken)
    if (gh === null) {
      // The stored authorization is unreadable — a rotated key, or a tampered
      // file. There is no way to verify the star again, so the error is recorded
      // rather than silently treated as a pass.
      user.lastCheckError = 'stored github authorization is unreadable'
      save()
      return
    }
    const verdict = await checkStar(gh)
    user.lastCheck = now()
    if (verdict.error !== undefined) {
      user.lastCheckError = verdict.error
      if (verdict.fatal === true) {
        // The user revoked the app on GitHub's side: we can never verify the
        // star again, so access ends until they sign in again.
        user.starred = false
        user.revokedReason = 'github authorization revoked'
      }
    } else {
      user.lastCheckError = null
      user.starred = verdict.starred === true
      if (user.starred === true) delete user.revokedReason
      else user.revokedReason = 'star removed'
    }
    save()
  }

  /** One sweep over users whose verdict is older than the window. Sequential with
   * a small gap: a handful of users per cycle, well inside the API's authenticated
   * quota, and never a burst that looks like abuse. */
  async function recheckAll(): Promise<void> {
    for (const [id, user] of Object.entries(store.users)) {
      if (now() - (user.lastCheck ?? 0) < recheckMs) continue
      await recheckUser(id, user)
      await new Promise(resolve => { const t = setTimeout(resolve, 250); t.unref?.() })
    }
  }

  const timer = setInterval(() => { void recheckAll().catch(() => {}) },
    Math.min(30 * 60_000, Math.max(60_000, Math.floor(recheckMs / 2))))
  timer.unref?.()

  // ── per-request verdict ────────────────────────────────────────────────────
  function check(rawToken: string): GateVerdict {
    if (!enforcement) {
      // Compatibility window: nothing is refused, but a presented token is still
      // resolved so the dashboard can tell who is already onboard.
      const found = lookup(rawToken)
      return { ok: true, required: false, user: found?.user ?? null, login: found?.user?.login, githubId: found?.githubId ?? null }
    }
    if (typeof rawToken !== 'string' || rawToken === '') return { ok: false, required: true, reason: 'missing', githubId: null }
    const found = lookup(rawToken)
    if (found === null) return { ok: false, required: true, reason: 'unknown', githubId: null }
    const user = found.user
    if (user.starred !== true) {
      return {
        ok: false, required: true, reason: 'unstarred',
        login: user.login, githubId: found.githubId,
        detail: user.revokedReason ?? user.lastCheckError ?? null,
      }
    }
    // Decide on the stored verdict; a stale one triggers a background refresh
    // rather than a wait, and a failed refresh never takes access away.
    if (now() - (user.lastCheck ?? 0) > recheckMs) void recheckUser(found.githubId, user).catch(() => {})
    return { ok: true, required: true, user, login: user.login, githubId: found.githubId }
  }

  function stats(): Record<string, any> {
    const users = Object.values(store.users)
    return {
      authorized: users.filter(user => user.starred === true).length,
      known: users.length,
      unstarred: users.filter(user => user.starred !== true).length,
      pending: Object.keys(store.pending).length,
      required: enforcement,
      configured,
      repo: starRepo,
      recheckHours,
    }
  }

  // ── the HTTP surface ───────────────────────────────────────────────────────
  const json = (res: any, status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const page = (res: any, status: number, title: string, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(htmlPage(title, body))
  }

  const callbackUrl = (req: any): string => {
    if (publicOrigin !== '') return `${publicOrigin}${prefix}/auth/github/callback`
    const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim() || 'https'
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim()
    return `${proto}://${host}${prefix}/auth/github/callback`
  }

  function rateLimited(req: any): boolean {
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
    const nowMs = now()
    const row = authHits.get(ip)
    if (row === undefined || nowMs - row.start >= 60_000) {
      // Bounded growth, and only rows whose window has already passed are dropped.
      if (authHits.size > 5_000) {
        for (const [candidate, value] of authHits) {
          if (nowMs - value.start >= 60_000) authHits.delete(candidate)
        }
      }
      authHits.set(ip, { start: nowMs, count: 1 })
      return false
    }
    row.count += 1
    return row.count > AUTH_RATE_PER_MINUTE
  }

  const starLink = (): string => `https://github.com/${starRepo}`

  /** Drop expired pending links. `persist=false` folds the sweep into the next save. */
  function sweepPending(persist = true): boolean {
    const at = now()
    let dropped = false
    for (const [link, entry] of Object.entries(store.pending)) {
      if ((entry?.exp ?? 0) < at) { delete store.pending[link]; dropped = true }
    }
    if (dropped && persist) save()
    return dropped
  }

  /**
   * Record a collectable login result for `link`.
   *
   * The raw per-user token is encrypted at rest like the GitHub token; the
   * plugin collects it by polling, and the entry stays collectable until it
   * expires — a poll whose response dies mid-flight is retried by the plugin's
   * existing loop instead of stranding a completed login.
   */
  function rememberPending(link: string, entry: Omit<PendingEntry, 'exp'>): void {
    sweepPending(false)
    const { token, ...rest } = entry
    store.pending[link] = { ...rest, ...(token === undefined ? {} : { token: encryptGh(token) }), exp: now() + PENDING_TTL_MS }
    save()
  }

  function pendingEntry(link: string): PendingEntry | undefined {
    const entry = store.pending[link]
    if (entry === undefined) return undefined
    if (entry.exp < now()) {
      delete store.pending[link]
      save()
      return undefined
    }
    return entry
  }

  function pendingToken(entry: PendingEntry): string {
    // A plain token is a legacy row from before the encryption existed.
    return decryptGh(entry.token) ?? (typeof entry.token === 'string' && !entry.token.startsWith('v1.') ? entry.token : '')
  }

  function grant(link: string, githubUser: { id: string; login: string; avatar: string }, ghToken: string): string {
    const user = store.users[githubUser.id] ?? { created: now(), login: '', avatar: '', ghToken: '', starred: false, lastCheck: 0, lastCheckError: null, tokens: {} }
    user.login = githubUser.login
    user.avatar = githubUser.avatar
    user.ghToken = encryptGh(ghToken)
    user.starred = true
    user.lastCheck = now()
    user.lastCheckError = null
    delete user.revokedReason
    const token = mintToken(githubUser.id, user)
    rememberPending(link, { status: 'ok', token, login: githubUser.login, avatar: githubUser.avatar })
    return token
  }

  /**
   * Handle one auth route. Returns `true` when the request was answered here.
   */
  function handle(req: any, res: any, url: URL): boolean {
    const route = url.pathname.startsWith(prefix + '/auth') ? url.pathname.slice(prefix.length) : url.pathname
    if (!route.startsWith('/auth/')) return false
    if (rateLimited(req)) {
      json(res, 429, { error: { message: 'too many authorization attempts; retry later' } })
      return true
    }

    if (req.method === 'GET' && route === '/auth/poll') {
      const link = url.searchParams.get('link') ?? ''
      if (!LINK_PATTERN.test(link)) { json(res, 400, { error: { message: 'bad link code' } }); return true }
      const entry = pendingEntry(link)
      // Unknown or swept: the link was never opened, or its window has passed.
      // Telling the plugin apart from "not finished yet" lets it stop polling
      // instead of waiting out its full timeout on a dead link.
      if (entry === undefined) { json(res, 200, { status: 'expired' }); return true }
      if (entry.status === 'waiting') { json(res, 200, { status: 'pending' }); return true }
      if (entry.status === 'unstarred') { json(res, 200, { status: 'unstarred', login: entry.login, repo: starRepo }); return true }
      const token = pendingToken(entry)
      const found = lookup(token)
      if (found === null || found.user.starred !== true) {
        delete store.pending[link]
        save()
        json(res, 200, { status: 'expired' })
        return true
      }
      // A client that ACKs only after local persistence asks to keep the encrypted
      // copy; the legacy delivery stays repeatable either way.
      const retain = url.searchParams.get('retain') === '1'
      json(res, 200, {
        status: 'ok', token, login: entry.login, avatar: entry.avatar ?? '', repo: starRepo,
        ...(retain ? { ackRequired: true } : {}),
      })
      return true
    }

    if (req.method === 'POST' && route === '/auth/ack') {
      const link = url.searchParams.get('link') ?? ''
      if (!LINK_PATTERN.test(link)) { json(res, 400, { error: { message: 'bad link code' } }); return true }
      const token = String(req.headers['x-ofm-user'] ?? '')
      const found = lookup(token)
      const entry = pendingEntry(link)
      if (found === null || found.user.starred !== true || (entry !== undefined && pendingToken(entry) !== token)) {
        json(res, 401, { error: { message: 'invalid delivery confirmation' } })
        return true
      }
      // Idempotent after the matching delivery has already been removed.
      if (entry !== undefined) { delete store.pending[link]; save() }
      json(res, 200, { ok: true })
      return true
    }

    if (req.method === 'GET' && route === '/auth/status') {
      const found = lookup(String(req.headers['x-ofm-user'] ?? ''))
      const base = { configured, required: enforcement, repo: starRepo, recheckHours }
      if (found === null) { json(res, 200, { ...base, authorized: false }); return true }
      const user = found.user
      json(res, 200, {
        ...base,
        authorized: user.starred === true,
        login: user.login ?? '',
        avatar: user.avatar ?? '',
        starred: user.starred === true,
        lastCheck: user.lastCheck ?? null,
        lastCheckError: user.lastCheckError ?? null,
        reason: user.revokedReason ?? null,
      })
      return true
    }

    if (req.method === 'POST' && route === '/auth/logout') {
      const token = String(req.headers['x-ofm-user'] ?? '')
      json(res, 200, { ok: revokeToken(token) })
      return true
    }

    if (req.method === 'GET' && route === '/auth/github/start') {
      if (!configured || !keyReady) {
        page(res, 503, 'EAC 渠道 · GitHub 登录未就绪',
          '<p>服务器尚未配置 GitHub OAuth（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET），请稍后再试或联系维护者。</p>')
        return true
      }
      const link = url.searchParams.get('link') ?? ''
      if (!LINK_PATTERN.test(link)) {
        page(res, 400, '链接无效', '<p>登录链接缺少或格式不正确，请回到插件设置页重新发起登录。</p>')
        return true
      }
      // Open the collectable window now: the plugin polls from the moment it opens
      // the browser, and an unknown link must be distinguishable from "callback not
      // there yet". Reopening the URL must not erase a completed callback or extend
      // the pending window, which is why this only runs when none exists.
      if (pendingEntry(link) === undefined) rememberPending(link, { status: 'waiting' })
      const state = signState({ link, exp: now() + STATE_TTL_MS })
      const authorize = new URL(GITHUB_AUTHORIZE)
      authorize.searchParams.set('client_id', clientId)
      authorize.searchParams.set('redirect_uri', callbackUrl(req))
      authorize.searchParams.set('scope', 'read:user')
      authorize.searchParams.set('state', state)
      res.writeHead(302, { location: authorize.toString(), 'cache-control': 'no-store' })
      res.end()
      return true
    }

    if (req.method === 'GET' && route === '/auth/github/callback') {
      const state = verifyState(url.searchParams.get('state') ?? '')
      const code = url.searchParams.get('code') ?? ''
      if (state === null || code === '') {
        page(res, 400, '授权已过期', '<p>这次登录请求已过期或校验失败，请回到插件设置页重新发起登录。</p>')
        return true
      }
      const link = String(state.link ?? '')
      if (!LINK_PATTERN.test(link)) {
        page(res, 400, '链接无效', '<p>登录链接格式不正确，请重新发起登录。</p>')
        return true
      }
      void (async () => {
        try {
          const ghToken = await exchangeCode(code, callbackUrl(req))
          const githubUser = await fetchGithubUser(ghToken)
          const verdict = await checkStar(ghToken)
          if (verdict.error !== undefined && verdict.fatal !== true) {
            page(res, 502, 'GitHub 暂时不可用', `<p>无法确认 star 状态（${escapeHtml(verdict.error)}），请稍后重试。</p>`)
            return
          }
          if (verdict.starred !== true) {
            // A ticket keeps the OAuth token so "recheck" needs no second login:
            // the user can go star the repo and come back.
            const ticket = crypto.randomBytes(24).toString('base64url')
            tickets.set(ticket, { link, login: githubUser.login, gh: ghToken, githubId: githubUser.id, avatar: githubUser.avatar, exp: now() + TICKET_TTL_MS })
            rememberPending(link, { status: 'unstarred', login: githubUser.login })
            page(res, 200, '还差一步：给仓库点个 Star',
              `<p>已用 GitHub 账号 <code>${escapeHtml(githubUser.login)}</code> 登录成功，但还没有 star 仓库。</p>
               <p>请先点下面的按钮去 star，然后回来点「我已 star，重新检查」——不需要重新登录。</p>
               <a class="btn" href="${starLink()}" target="_blank" rel="noreferrer">⭐ 去 Star</a>
               <a class="btn alt" href="${prefix}/auth/github/recheck?t=${ticket}">我已 star，重新检查</a>`)
            return
          }
          grant(link, githubUser, ghToken)
          page(res, 200, '✅ 授权成功，请返回应用',
            `<p>GitHub 账号 <code>${escapeHtml(githubUser.login)}</code> 已登录，且已 star 仓库。</p>
             <p>插件会在几秒内自动完成授权，现在可以关闭这个页面并回到应用。</p>`)
        } catch (error) {
          page(res, 502, '授权失败', `<p>${escapeHtml(String((error as Error)?.message ?? error).slice(0, 200))}</p><p>请回到插件设置页重新发起登录。</p>`)
        }
      })()
      return true
    }

    if (req.method === 'GET' && route === '/auth/github/recheck') {
      const ticketId = url.searchParams.get('t') ?? ''
      const ticket = tickets.get(ticketId)
      if (ticket === undefined || ticket.exp < now()) {
        page(res, 400, '检查链接已过期', '<p>请回到插件设置页重新发起登录。</p>')
        return true
      }
      void (async () => {
        const verdict = await checkStar(ticket.gh)
        if (verdict.error !== undefined && verdict.fatal !== true) {
          page(res, 502, 'GitHub 暂时不可用', `<p>无法确认 star 状态（${escapeHtml(verdict.error)}），请稍后重试。</p>`)
          return
        }
        if (verdict.starred !== true) {
          // A star that has not propagated yet is not a refusal: the page invites
          // another check rather than ending the flow.
          page(res, 200, '还没有检测到 Star',
            `<p>账号 <code>${escapeHtml(ticket.login)}</code> 的 star 还没生效（GitHub 侧偶尔有几秒延迟）。</p>
             <a class="btn" href="${starLink()}" target="_blank" rel="noreferrer">⭐ 去 Star</a>
             <a class="btn alt" href="${prefix}/auth/github/recheck?t=${url.searchParams.get('t')}">再检查一次</a>`)
          return
        }
        tickets.delete(ticketId)
        grant(ticket.link, { id: ticket.githubId, login: ticket.login, avatar: ticket.avatar }, ticket.gh)
        page(res, 200, '✅ 已确认 Star，授权成功',
          `<p>账号 <code>${escapeHtml(ticket.login)}</code> 已 star 仓库，插件会在几秒内自动完成授权，可以关闭这个页面了。</p>`)
      })()
      return true
    }

    json(res, 404, { error: { message: 'not found' } })
    return true
  }

  load()
  if (enforcement && !configured) {
    // The cutover flag is set before the OAuth app is registered. Saying so once
    // is the difference between an operator fixing it and a night of 401s.
    log(JSON.stringify({ lane: 'eac-auth', fault: 'REQUIRE_USER_TOKEN=1 but GitHub OAuth is not configured — every chat turn will be refused' }))
  }

  return {
    configured,
    enforcement,
    prefix,
    handle,
    check,
    stats,
    storePath,
    /** Test seam: run one recheck sweep now. */
    recheckAll,
    /** Test seam: force a single user's recheck. */
    recheckUser: (githubId: string, force = true) => recheckUser(githubId, store.users[githubId], { force }),
    /** Test seam: inspect the store without touching the file. */
    snapshot: () => JSON.parse(JSON.stringify(store)) as GateStore,
    close() { clearInterval(timer) },
  }
}
