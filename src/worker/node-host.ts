/**
 * Node host for the EAC gateway — the self-hosted form of the Cloudflare Worker.
 *
 * The validation core is the **same module** the Worker runs (`worker/validation.ts`):
 * this host only adapts Node's HTTP server to the Web `fetch(request, env, ctx)`
 * contract, so a signed request is validated identically on either host. On top of
 * that it adds the self-hosted-only layers:
 *
 * - per-IP concurrency and fixed-window rate limits (this process is the single
 *   point of truth for in-flight counts);
 * - per-IP analytics, numbers only, persisted and rendered behind an admin token;
 * - the GitHub authorization gate (`worker/auth-github.ts`);
 * - the `/pool` snapshot, whose load verdict is this process's own truth;
 * - the **SSE prelude**, which is the difference between a lane that works behind a
 *   reverse proxy and one that dies on it.
 *
 * ## Why the prelude exists
 *
 * A reasoning model can hold the relay's first byte for minutes, and a proxy in
 * front of this gateway (Cloudflare's ~100s origin timeout, nginx's 60s default)
 * would kill the lane before the answer starts. So the moment admission has fully
 * passed, this host writes an SSE head plus keepalive comments: the response has
 * already begun while the upstream thinks, and every idle timer in the chain stays
 * fed until the real frames take over. The Worker host cannot flush early and
 * leaves the hook unset.
 *
 * ## Why the slot release is registered before any await
 *
 * Two of a request's windows are long: the rate-limiter awaits during admission,
 * and the relay fetch lasts until the relay sends its headers. Registering cleanup
 * only *after* the fetch resolved meant neither window released its slot, so the
 * per-IP and per-account counters ratcheted up until a restart and every later
 * turn was refused with 429 (#680). The listener therefore goes on before anything
 * can await.
 *
 * Ported from dsh's `worker/gateway-node.mjs`.
 *
 * @module pi-extension/worker/node-host.js
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import perfHooks from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { createLaneHandler, type LaneEnv, jsonError, relayRequest, relayUrl, verifySignedRequest } from './validation.js'
import { buildRateLimiter, type RateLimiter } from './rate-limiter.js'
import { createAnalytics, type AnalyticsApi } from './analytics.js'
import { createUsageScanner } from './usage-scanner.js'
import { createAuthGate, type AuthGate } from './auth-github.js'

const DAY_MS = 86_400_000

/** Fill unset variables from a sibling `.env`, if present. Real env vars win. */
function loadDotEnv(target: Record<string, string>): void {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = path.join(here, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at === -1) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '')
    if (target[key] === undefined || target[key] === '') target[key] = value
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface GatewayHostOptions {
  /** The GitHub transport the authorization gate uses; production leaves it unset. */
  authFetch?: any
  /** Log line sink; defaults to stdout as JSON, like the Worker host. */
  log?: (message: string) => void
}

/**
 * Build the host server around the shared gateway core. Exported so a test can
 * drive the exact process a deployment would run.
 */
export function createGatewayServer(hostEnv: Record<string, string> = {}, options: GatewayHostOptions = {}): http.Server {
  const env: Record<string, string> = { ...hostEnv }
  const log = options.log ?? ((message: string) => console.log(message))
  loadDotEnv(env)

  // Every default is resolved here rather than `|| default` at each use: two
  // copies of that fallback are two copies to keep in sync, and `0` would mean
  // "limit everything" instead of the "off" the configuration asks for.
  const intEnv = (name: string, fallback: number, min = 1): number => {
    const parsed = Number.parseInt(env[name] ?? '', 10)
    if (!Number.isFinite(parsed) || parsed < min) return fallback
    return parsed
  }
  const maxBody = intEnv('MAX_BODY_BYTES', 8 * 1024 * 1024)
  const perMinute = Number.parseInt(env.RATE_LIMIT_PER_MINUTE ?? '60', 10)
  const perDay = Number.parseInt(env.RATE_LIMIT_PER_DAY ?? '1000', 10)
  const concLimit = Number.parseInt(env.CONCURRENCY_PER_IP ?? '5', 10)
  const adminToken = String(env.ADMIN_TOKEN ?? '')
  const preludeSeconds = intEnv('SSE_PRELUDE_SECONDS', 15)
  const prefix = String(env.MOUNT_PREFIX ?? '').replace(/\/+$/, '')
  const statsPath = env.STATS_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'stats.json')
  const logSalt = String(env.LOG_SALT ?? '')
    || String(env.SIGNING_SECRETS ?? '').split(',')[0]?.trim() + '/request-log'

  const limiters: Record<string, RateLimiter | undefined> = {
    RATE_LIMITER: buildRateLimiter(perMinute, 60_000),
    DAILY_LIMITER: buildRateLimiter(perDay, DAY_MS),
  }
  const inflight = new Map<string, number>()
  const analytics: AnalyticsApi = createAnalytics(log)

  // The gate is the lane's real door; the per-account ceilings below bound one
  // account however many IPs a shared token travels from.
  const auth: AuthGate = createAuthGate(env, {
    storePath: env.USER_STORE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'users.json'),
    fetchImpl: options.authFetch,
    log,
  })
  const tokenMinute = buildRateLimiter(Number.parseInt(env.TOKEN_RATE_LIMIT_PER_MINUTE ?? String(perMinute), 10), 60_000)
  const tokenDay = buildRateLimiter(Number.parseInt(env.TOKEN_RATE_LIMIT_PER_DAY ?? String(perDay), 10), DAY_MS)
  const tokenConcLimit = intEnv('TOKEN_CONCURRENCY_PER_USER', concLimit)
  const tokenInflight = new Map<string, number>()

  // ── the co-paid pool snapshot ──────────────────────────────────────────────
  // Capacity follows the operator's rule — one star funds 1.5 accounts — unless
  // POOL_SIZE pins the real provisioned count. Stars are never fetched when a
  // configured POOL_SIZE makes them moot.
  //
  // The load verdict is this process's own truth: in-flight chat turns against the
  // POOL_PRESSURE_* thresholds, forced to busy/overloaded when the event loop
  // itself is saturating — a settings page showing a calm pool while the box is
  // dying is worse than none.
  const poolSizeOverride = Number.parseInt(env.POOL_SIZE ?? '', 10)
  const starsOverride = Number.parseInt(env.GITHUB_STARS_OVERRIDE ?? '', 10)
  const pressureBusy = Math.max(0, Number.parseInt(env.POOL_PRESSURE_BUSY ?? '30', 10) || 0)
  const pressureOver = Math.max(0, Number.parseInt(env.POOL_PRESSURE_OVER ?? '80', 10) || 0)
  const loopDelay = perfHooks.monitorEventLoopDelay({ resolution: 20 })
  loopDelay.enable()
  let loopEma: number | null = null
  let loopWarmup = true
  const loopSampler = setInterval(() => {
    // The first window swallows the boot itself (module loading blocks the loop);
    // it says nothing about steady state, so it is discarded.
    if (loopWarmup) { loopWarmup = false; loopDelay.reset(); return }
    if (loopDelay.count > 0) {
      const meanMs = loopDelay.mean / 1e6
      loopEma = loopEma === null ? meanMs : loopEma * 0.85 + meanMs * 0.15
    }
    loopDelay.reset()
  }, 5_000)
  loopSampler.unref?.()
  const pinnedStars = Number.isFinite(starsOverride) && starsOverride >= 0
  const starCache = { stars: pinnedStars ? starsOverride : null, at: pinnedStars ? Date.now() : 0 }
  /** Earliest time the next GitHub attempt may happen after a failure. */
  let starRetryAt = 0
  const loadStars = async (): Promise<number | null> => {
    if (pinnedStars) return starsOverride
    if (poolSizeOverride > 0) return starCache.stars
    if (starCache.stars !== null && Date.now() - starCache.at < 30 * 60_000) return starCache.stars
    // A failed attempt used to be retried by EVERY /pool call, which put a
    // five-second GitHub round trip on the snapshot each time the API was rate
    // limiting this host. The snapshot must never wait on GitHub more than once
    // per backoff window.
    if (Date.now() < starRetryAt) return starCache.stars
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3_000)
      timer.unref?.()
      const response = await (poolProbe.fetchImpl ?? fetch)('https://api.github.com/repos/Ebony-Vinyl/dsh-our-free-model', {
        headers: { 'user-agent': 'eac-gateway', accept: 'application/vnd.github+json' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (response.ok) {
        const body = await response.json() as any
        if (Number.isFinite(body?.stargazers_count)) starCache.stars = body.stargazers_count
        starCache.at = Date.now()
      } else {
        starRetryAt = Date.now() + 120_000
      }
    } catch {
      // Keep the last good count and back off, so a rate-limited or unreachable
      // GitHub does not add latency to every snapshot call.
      starRetryAt = Date.now() + 120_000
    }
    return starCache.stars
  }
  const poolSnapshot = async () => {
    let pool: number | null = null
    let poolSource = 'unavailable'
    if (poolSizeOverride > 0) { pool = poolSizeOverride; poolSource = 'configured' }
    else {
      const stars = await loadStars()
      if (Number.isFinite(stars)) { pool = Math.round((stars as number) * 1.5); poolSource = 'formula' }
    }
    const cutoff = Date.now() - DAY_MS
    let active24h = 0
    for (const row of Object.values(analytics.state.ips)) {
      if ((row.last ?? 0) > cutoff) active24h += 1
    }
    let inFlight = 0
    for (const value of inflight.values()) inFlight += value
    const loopMs = loopEma === null ? null : Math.round(loopEma * 10) / 10
    const level = (pressureOver > 0 && (inFlight >= pressureOver || (loopMs !== null && loopMs >= 300))) ? 'over'
      : (pressureBusy > 0 && (inFlight >= pressureBusy || (loopMs !== null && loopMs >= 100))) ? 'busy'
        : 'ok'
    return { ok: true, stars: starCache.stars, pool, poolSource, active24h, inflight: inFlight, concurrencyPerIp: concLimit, level, loopDelayMs: loopMs, ts: Date.now() }
  }

  analytics.load(statsPath)

  const clientIpOf = (req: http.IncomingMessage): string => {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded !== '') return forwarded.split(',')[0].trim()
    return req.socket?.remoteAddress ?? 'unknown'
  }
  /** A browser asset this gateway serves, read from beside the compiled host. */
  const asset = (name: string, fallback: string): string => {
    try { return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), name), 'utf8') } catch { return fallback }
  }

  const json = (res: http.ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  const lane = createLaneHandler(log)
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    req.on('data', chunk => {
      size += chunk.length
      // Bytes, not a decoded length: a multibyte body at up to three times the
      // cap is exactly what the Worker host got wrong.
      if (size > maxBody) { overflow = true; chunks.length = 0; return }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      const url = new URL('http://127.0.0.1' + (req.url ?? '/'))
      const clientIp = clientIpOf(req)
      const ipHash = analytics.ipHash(clientIp, logSalt)

      // Prelude state, declared before the try so the catch can still finish the
      // response correctly once the head has been committed.
      let earlySent = false
      let keepalive: NodeJS.Timeout | null = null
      const stopKeepalive = () => { if (keepalive !== null) { clearInterval(keepalive); keepalive = null } }
      const emitInStreamError = (payload: unknown) => {
        stopKeepalive()
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
          res.end()
        }
      }

      // ── admin dashboard + feed ────────────────────────────────────────────
      if (url.pathname === prefix + '/stats-data') {
        if (adminToken === '') {
          return json(res, 403, { error: 'admin dashboard disabled: ADMIN_TOKEN is not configured' })
        }
        if (!timingSafeEqual(String(url.searchParams.get('t') ?? req.headers['x-admin-token'] ?? ''), adminToken)) {
          return json(res, 401, { error: 'bad admin token' })
        }
        return json(res, 200, { ...analytics.snapshot(), auth: auth.stats() })
      }
      if (url.pathname === prefix + '/entry.js') {
        // nginx injects this into the New API panel's pages; it clones a sidebar
        // entry that points at /stats. Cacheable because it never changes per
        // request and never carries a secret.
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' })
        return res.end(asset('entry.js', '/* entry.js is missing */'))
      }
      if (url.pathname === prefix + '/stats') {
        // The page itself is public: it self-gates on the token (asked once, kept
        // in the admin's localStorage) before asking for data, which is where the
        // real check lives.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(asset('dashboard.html', '<!doctype html><meta charset="utf-8"><title>EAC 网关</title><p>dashboard.html 缺失。</p>'))
      }

      // ── authorization surface ─────────────────────────────────────────────
      // Reached without the lane signature on purpose: a caller who has not logged
      // in yet has nothing to sign with, and the token itself is the credential.
      if (url.pathname.startsWith(prefix + '/auth')) return void auth.handle(req, res, url)

      // ── public pool snapshot (aggregate numbers only) ─────────────────────
      if (url.pathname === prefix + '/pool') return json(res, 200, await poolSnapshot())

      if (overflow) {
        analytics.record({ hash: ipHash, chat: false, status: 413, tokensIn: 0, tokensOut: 0, model: null, rejected: true })
        return json(res, 413, { error: { message: 'request body too large' } })
      }

      // Slot bookkeeping, declared where the catch below can see it: once a slot
      // is taken, every way this request can leave early must give it back.
      let concReleased = false
      let releaseConc = () => {}

      // Registered before anything can await — see the module note. It also drives
      // the AbortController the upstream fetch actually receives.
      let clientGone = false
      let upstreamStream: Readable | null = null
      const clientAbort = new AbortController()
      const onClientGone = () => {
        if (clientGone) return
        clientGone = true
        stopKeepalive()
        releaseConc()
        try { clientAbort.abort() } catch { /* already aborted */ }
        try { upstreamStream?.destroy() } catch { /* the client is gone either way */ }
      }
      res.on('close', onClientGone)

      try {
        const bodyText = req.method === 'POST' || req.method === 'PUT' ? Buffer.concat(chunks).toString('utf8') : ''
        const isChat = req.method === 'POST' && url.pathname.endsWith('/chat/completions')
        let model: string | null = null
        if (isChat) {
          try { model = String(JSON.parse(bodyText).model ?? '') || null } catch { /* the caller's fault downstream */ }
        }

        // The listing stays open so the plugin can show the lane (locked) before
        // anyone logs in; the turn is where the per-user token is required.
        // `check` reads the stored verdict and never waits on GitHub.
        let accountKey: string | null = null
        if (isChat) {
          const verdict = auth.check(String(req.headers['x-ofm-user'] ?? ''))
          if (verdict.ok !== true) {
            analytics.record({ hash: ipHash, chat: true, status: 401, tokensIn: 0, tokensOut: 0, model, rejected: true })
            const message = verdict.reason === 'unstarred'
              ? `GitHub 授权无效：请先 star ${auth.stats().repo}，再在插件设置页重新登录（${verdict.detail ?? 'star removed'}）`
              : '需要 GitHub 授权：请在插件设置页用 GitHub 登录，并 star 仓库后使用 EAC 模型'
            return json(res, 401, { error: { message, type: 'AuthorizationRequired', reason: verdict.reason ?? 'missing' } })
          }
          if (typeof verdict.githubId === 'string' && verdict.githubId !== '') {
            accountKey = analytics.ipHash(`account:${verdict.githubId}`, logSalt)
            for (const limiter of [tokenMinute, tokenDay]) {
              if (limiter === undefined) continue
              const limit = await limiter.limit({ key: accountKey })
              if (limit.success === false) {
                analytics.record({ hash: ipHash, chat: true, status: 429, tokensIn: 0, tokensOut: 0, model, rejected: true })
                return json(res, 429, { error: { message: 'rate limit reached for this account; retry later' } })
              }
            }
          }
        }

        // A caller that left while the limiters were still answering must not take
        // a slot it will never hand back.
        if (clientGone) return

        // Both verdicts are computed before either slot is taken, with no await in
        // between, so the event loop cannot interleave and a rejection cannot
        // consume a slot the request never releases.
        const ipNext = isChat && concLimit > 0 ? (inflight.get(ipHash) ?? 0) + 1 : null
        // `accountKey` is narrowed here, not just `acctNext`: the map key below needs
        // the string, and a `string | null` narrowing on one variable says nothing
        // about the other.
        const accountKeyed = accountKey !== null ? accountKey : null
        const acctNext = isChat && accountKeyed !== null && tokenConcLimit > 0
          ? (tokenInflight.get(accountKeyed) ?? 0) + 1
          : null
        if (ipNext !== null && ipNext > concLimit) {
          analytics.record({ hash: ipHash, chat: true, status: 429, tokensIn: 0, tokensOut: 0, model, rejected: true })
          return json(res, 429, { error: { message: `concurrency limit reached for this IP (${concLimit} in-flight)` } })
        }
        if (acctNext !== null && acctNext > tokenConcLimit) {
          analytics.record({ hash: ipHash, chat: true, status: 429, tokensIn: 0, tokensOut: 0, model, rejected: true })
          return json(res, 429, { error: { message: `concurrency limit reached for this account (${tokenConcLimit} in-flight)` } })
        }
        if (ipNext !== null) { inflight.set(ipHash, ipNext); analytics.concurrency(ipHash, ipNext, ipNext) }
        if (acctNext !== null && accountKeyed !== null) tokenInflight.set(accountKeyed, acctNext)
        releaseConc = () => {
          if (!isChat || concReleased) return
          concReleased = true
          if (concLimit > 0) {
            const current = (inflight.get(ipHash) ?? 1) - 1
            if (current <= 0) inflight.delete(ipHash)
            else { inflight.set(ipHash, current); analytics.concurrency(ipHash, current) }
          }
          if (accountKeyed !== null && tokenConcLimit > 0) {
            const current = (tokenInflight.get(accountKeyed) ?? 1) - 1
            if (current <= 0) tokenInflight.delete(accountKeyed)
            else tokenInflight.set(accountKeyed, current)
          }
        }

        // The gateway counts rate-limit keys off `cf-connecting-ip`; behind the
        // reverse proxy the client IP arrives on X-Forwarded-For.
        const headers = new Headers(Object.fromEntries(
          Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as Array<[string, string]>
        ))
        if (typeof req.headers['x-forwarded-for'] === 'string' && req.headers['x-forwarded-for'] !== '') {
          headers.set('cf-connecting-ip', req.headers['x-forwarded-for'].split(',')[0].trim())
        }
        const request = new Request('http://127.0.0.1' + (req.url ?? '/'), {
          method: req.method,
          headers,
          body: req.method === 'POST' || req.method === 'PUT' ? bodyText : undefined,
          // Ties the core's upstream call to the client connection.
          signal: clientAbort.signal,
        })
        // The limiters are filled in per call rather than read from the
        // environment: `env` is a plain string map, and a captured limiter would
        // freeze one host's decisions into a handler both hosts share.
        const laneEnv: LaneEnv = {
          ...env,
          RATE_LIMITER: limiters.RATE_LIMITER,
        }
        const response = await lane.fetch(request, laneEnv, {
          waitUntil() {},
          passThroughOnException() {},
          // Called once admission has fully passed and the core is about to wait on
          // the relay: flush the SSE head now, so a front proxy's origin timeout
          // measures an already-started response rather than the model's thinking.
          onUpstreamPending: preludeSeconds > 0 ? () => {
            if (earlySent || res.writableEnded || res.destroyed) return
            earlySent = true
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
            })
            res.write(': channel open\n\n')
            keepalive = setInterval(() => {
              if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n')
            }, preludeSeconds * 1000)
            keepalive.unref?.()
          } : undefined,
        })

        const scanner = createUsageScanner()
        if (clientGone) { releaseConc(); return }
        if (!earlySent) {
          const passthrough: Record<string, string> = {}
          response.headers.forEach((value: string, name: string) => { passthrough[name] = value })
          res.writeHead(response.status, passthrough)
        }
        if (response.body === null) {
          // With the head already committed a refusal has to travel in-stream,
          // because the status line is gone.
          if (earlySent && response.status >= 400) emitInStreamError({ error: { message: `HTTP ${response.status}` } })
          else { stopKeepalive(); res.end() }
          releaseConc()
          analytics.record({ hash: ipHash, chat: isChat, status: response.status, tokensIn: 0, tokensOut: 0, model, rejected: response.status >= 400 })
          return
        }
        if (earlySent && response.status >= 400) {
          const text = await response.text().catch(() => '')
          let payload: unknown
          try { payload = JSON.parse(text) } catch { payload = { error: { message: String(text ?? '').slice(0, 300) || `HTTP ${response.status}` } } }
          analytics.record({ hash: ipHash, chat: isChat, status: response.status, tokensIn: 0, tokensOut: 0, model, rejected: true })
          releaseConc()
          emitInStreamError(payload)
          return
        }
        const upstream = Readable.fromWeb(response.body)
        upstreamStream = upstream
        upstream.on('data', chunk => {
          const text = chunk.toString('utf8')
          res.write(text)
          scanner.push(text)
        })
        upstream.on('end', () => {
          scanner.end()
          stopKeepalive()
          res.end()
          releaseConc()
          const usage = scanner.result()
          analytics.record({ hash: ipHash, chat: isChat, status: response.status, tokensIn: usage.prompt, tokensOut: usage.completion, model, rejected: response.status >= 400 })
        })
        upstream.on('error', () => {
          stopKeepalive()
          releaseConc()
          try { res.destroy() } catch { /* the client is already gone */ }
        })
      } catch (error) {
        // The gates may already be holding this request's slots; a thrown gateway
        // call is exactly the path that used to leak them.
        releaseConc()
        if (clientGone) return
        analytics.record({
          hash: ipHash,
          chat: req.method === 'POST' && url.pathname.endsWith('/chat/completions'),
          status: 500, tokensIn: 0, tokensOut: 0, model: null, rejected: true,
        })
        if (earlySent) emitInStreamError({ error: { message: 'gateway request failed' } })
        else {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { message: 'gateway request failed' } }))
        }
        log(JSON.stringify({ lane: 'eac-node', fault: String((error as Error)?.message ?? error).slice(0, 160) }))
      }
    })
    req.on('error', () => res.destroy())
  })

  // The gate owns a recheck timer and a users.json handle; the server carries it so
  // a test can close both, and so callers read the same counts /stats-data reports.
  ;(server as any).authGate = auth
  ;(server as any).analytics = analytics
  server.once('close', () => {
    clearInterval(loopSampler)
    loopDelay.disable()
    auth.close()
  })
  return server
}

/**
 * Start only when this file is the executed entry — directly, or under PM2, whose
 * ProcessContainerFork wrapper makes `process.argv[1]` point at the fork instead of
 * this script (`pm_exec_path` is how PM2 names the real one).
 */
const scriptPath = fileURLToPath(import.meta.url)
const directRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath
const pm2Run = typeof process.env.pm_exec_path === 'string' && process.env.pm_exec_path !== ''
  && path.resolve(process.env.pm_exec_path) === scriptPath
if (directRun || pm2Run) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  loadDotEnv(env)
  const host = env.HOST || '127.0.0.1'
  const port = Number.parseInt(env.PORT ?? '17788', 10) || 17788
  const server = createGatewayServer(env)
  server.listen(port, host, () => {
    console.log(`eac gateway listening on ${host}:${port} → ${String(env.UPSTREAM_URL ?? '(UPSTREAM_URL not set)')}`)
  })
  const stats = path.join(path.dirname(scriptPath), env.STATS_PATH ? path.basename(env.STATS_PATH) : 'stats.json')
  const analytics: AnalyticsApi = (server as any).analytics
  const timer = setInterval(() => analytics.flush(stats), 30_000)
  timer.unref?.()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { analytics.flush(stats); process.exit(0) })
  }
}

export { relayRequest, relayUrl, verifySignedRequest, jsonError }

/**
 * Test seams the offline suite needs, which the per-server structure of this
 * host makes impossible as module globals in dsh's shape.
 *
 * `poolProbe` is the `/pool` endpoint's GitHub read: production leaves it null
 * and uses the global fetch, the offline suite points it at a stub so a star
 * count never costs a network round. `resetAnalytics` answers dsh's module-level
 * reset: analytics are created per server, so the reset reads the instance the
 * server carries (`(server as any).analytics`, the same shape
 * {@link createGatewayServer} attaches for its own admin route).
 *
 * Ported from dsh's `worker/gateway-node.mjs`.
 *
 * @module pi-extension/worker/node-host.js
 */
export const poolProbe: { fetchImpl: typeof fetch | null } = { fetchImpl: null }

export function resetAnalytics(server: http.Server): void {
  const analytics = (server as any).analytics
  if (analytics !== undefined && typeof analytics.reset === 'function') analytics.reset()
}
