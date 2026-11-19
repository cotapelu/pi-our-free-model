/**
 * The EAC lane gateway's validation core.
 *
 * This is the module **both hosts run**: the Cloudflare Worker and the Node
 * self-hosted host (`worker/gateway-node.mjs` in dsh). Ported to TypeScript it
 * stays one module for the same reason — a signed request has to be validated
 * identically wherever the gateway happens to be deployed, or a host-specific
 * gap is a bypass.
 *
 * The security model the rest of this provider leans on: the plugin ships **no
 * relay credential**. Its sealed store carries this gateway's URL plus a shared
 * signing secret, and every request arrives signed:
 *
 *     x-ofm-timestamp:  <unix ms>
 *     x-ofm-signature:  hex(HMAC-SHA256(secret, ts \n METHOD \n path \n sha256(body)))
 *
 * The relay credential lives only here, in the gateway's environment. So a seal
 * extracted from the package is an *indirect* entry — revoking a signing secret
 * kills it instantly, without touching the relay key.
 *
 * Four rules, each of which was a live hole:
 *
 * 1. **The body cap is measured in bytes, before decoding.** dsh's Cloudflare
 *    host measured the decoded string's `.length` (UTF-16 code units), so a
 *    multibyte body slipped past at up to three times the cap and the two hosts
 *    disagreed about the same variable.
 * 2. **The replay window is checked before any cryptographic work**, and the
 *    comparison is constant-time, so a timing oracle does not reveal which
 *    secret or how much of it matched.
 * 3. **Every accepted secret is tried, not just the first.** Rotation is: append
 *    the new one → deploy → ship a plugin release sealed with it → drop the old
 *    one → deploy. Refusing during the overlap window would break the old
 *    installs mid-flight.
 * 4. **The relay base is validated for its `/v1` suffix and its scheme.** A base
 *    without `/v1` would forward `/models` to the relay's front page and answer
 *    HTML for the lane; a non-TLS, non-loopback base would put the relay
 *    credential on a network the operator did not choose.
 *
 * Ported from dsh's `worker/worker.js`.
 *
 * @module pi-extension/worker/validation.js
 */

/** The routes the lane actually speaks; everything else is a 404, not a relay. */
/** One route: where it goes upstream, and whether it carries a body to sign. */
export interface LaneRoute {
  upstream: string
  body: boolean
}

export const ROUTES: Readonly<Record<string, LaneRoute>> = Object.freeze({
  'GET /v1/models': Object.freeze({ upstream: '/models', body: false }),
  'POST /v1/chat/completions': Object.freeze({ upstream: '/chat/completions', body: true }),
})

/** Headers the relay's answer may carry back; everything else is dropped. */
export const PASS_HEADERS: readonly string[] = Object.freeze(['content-type', 'retry-after'])

/** The default replay window: ten minutes, in seconds. */
export const DEFAULT_CLOCK_SKEW_SECONDS = 600

/** The default request-body cap: 8 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024

/** A signing secret shorter than this is a configuration error, not a secret. */
const MIN_SECRET_LENGTH = 32

/** Hostnames a self-hosted dev rig (and the test suite) may reach over plain http. */
const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** A JSON error envelope, in the shape the lane's own errors have always had. */
export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The relay base, or `null` when it is unusable.
 *
 * A base without `/v1` is refused at configure time rather than forwarding `/models`
 * into the relay's front page; appending the route suffix first and validating the
 * result would be wrong, because `/v1/models` never ends in `/v1`.
 */
export function relayUrl(raw: unknown): URL | null {
  const cleaned = String(raw ?? '').replace(/\/+$/, '')
  if (!/\/v1$/.test(cleaned)) return null
  let url: URL
  try { url = new URL(cleaned) } catch { return null }
  if (url.protocol === 'https:') return url
  // A loopback relay over plain http: those requests never leave the machine,
  // which is how the suite drives this same handler without TLS.
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)) return url
  return null
}

function bytesToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer)
  let out = ''
  for (const byte of view) out += byte.toString(16).padStart(2, '0')
  return out
}

/** Constant-time compare, so a timing oracle does not narrow the search. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const encoder = new TextEncoder()

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

/**
 * The string a signature covers.
 *
 * The **full pathname the client sent**, prefix included — that is what
 * `new URL(base + '/models').pathname` produced on the plugin's side — and not
 * the stripped, routed one.
 */
export async function signatureMessage(timestamp: string, method: string, path: string, body: string): Promise<string> {
  return `${timestamp}\n${method}\n${path}\n${await sha256Hex(body)}`
}

/** The accepted signing secrets, in the order they are tried. */
export function acceptedSecrets(raw: unknown): string[] {
  return String(raw ?? '').split(',').map(secret => secret.trim()).filter(secret => secret.length >= MIN_SECRET_LENGTH)
}

/**
 * Does this signature correspond to one of the accepted secrets?
 *
 * Every secret is tried: a rotation that accepted only the newest would break
 * the installs still sealed with the old one during the overlap window.
 */
export async function admitsSignature(
  signature: string,
  message: string,
  secrets: readonly string[],
): Promise<boolean> {
  for (const secret of secrets) {
    if (timingSafeEqual(signature, await hmacHex(secret, message))) return true
  }
  return false
}

export interface SignedAdmission {
  ok: boolean
  status?: number
  message?: string
  /** The model the body asks for, when it could be read. */
  model?: string
  /**
   * The request body, **already read**.
   *
   * A `Request` body is a one-shot stream: reading it here for the byte cap
   * consumes it, and a caller that reads it again gets "Body has already been
   * read" — which is exactly what the composed host did until this field existed.
   * It is handed back so the relay reads the same bytes the signature covered.
   */
  body?: string
}

/**
 * Verify one signed request, before anything is forwarded.
 *
 * The order is the whole design: the **body cap** (on the bytes that arrived,
 * not a decoded string), then the **replay window**, then the signature, then
 * the model allowlist. A request that fails an earlier check must not cost the
 * work of a later one.
 */
export async function verifySignedRequest(
  request: Request,
  secrets: readonly string[],
  { route, skewSeconds, maxBodyBytes, models }: {
    /** The resolved route — prefix already stripped by the caller. */
    route: LaneRoute
    skewSeconds?: number
    maxBodyBytes?: number
    models?: string
  },
): Promise<SignedAdmission> {
  // The default is resolved **here**, not at the env-parsing layer: a `0` or a
  // nonsense value then falls back to the documented default rather than being
  // honoured, which would refuse every turn (a cap of zero) or every request (a
  // window of zero). dsh resolved this with `Number.parseInt(...) || default`
  // at each host's config layer, which is why both copies of that `||` existed.
  const skew = (Number.isFinite(skewSeconds) && (skewSeconds as number) > 0 ? skewSeconds : DEFAULT_CLOCK_SKEW_SECONDS) as number
  const cap = (Number.isFinite(maxBodyBytes) && (maxBodyBytes as number) > 0 ? maxBodyBytes : DEFAULT_MAX_BODY_BYTES) as number
  // The route is a parameter, not a lookup. Resolving it here instead means the
  // prefix is stripped twice, in two places, and the copy that does not know about
  // the prefix refuses a correctly-mounted request with a 404.
  const wantsBody = route.body === true
  // Read the bytes, not the text: a decoded `.length` counts UTF-16 code units,
  // so a multibyte body slipped past the cap at up to three times its value.
  let body = ''
  if (wantsBody === true) {
    const received = await request.arrayBuffer()
    if (received.byteLength > cap) return { ok: false, status: 413, message: 'request body too large' }
    body = new TextDecoder().decode(received)
  }

  const timestamp = request.headers.get('x-ofm-timestamp') ?? ''
  const signature = request.headers.get('x-ofm-signature') ?? ''
  const ts = Number.parseInt(timestamp, 10)
  // A clock outside the window is a replay, and it is refused before the
  // expensive work: nothing about the signature matters yet.
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > skew * 1000) {
    return { ok: false, status: 401, message: 'request signature rejected' }
  }
  const message = await signatureMessage(timestamp, request.method, new URL(request.url).pathname, body)
  if (!await admitsSignature(signature, message, secrets)) {
    return { ok: false, status: 401, message: 'request signature rejected' }
  }

  // The requested model is read once and reported either way: the self-hosted
  // host's analytics record the model mix, and an allowlist is a chat-turn
  // control, not the only reason to know what was asked for.
  let requested = ''
  if (wantsBody === true) {
    // A malformed body is the caller's error downstream, not this gateway's.
    try { requested = String(JSON.parse(body).model ?? '') } catch { /* left empty */ }
    if (String(models ?? '').trim() !== '') {
      const allowed = String(models).split(',').map(model => model.trim()).filter(Boolean)
      if (!allowed.includes(requested)) {
        return { ok: false, status: 403, message: 'model is not available on this lane' }
      }
    }
  }
  return { ok: true, model: requested, body }
}

/**
 * The relay request one admitted turn becomes.
 *
 * The relay credential is attached **here and nowhere else**; the caller's own
 * headers (beyond the two in {@link PASS_HEADERS}) are not forwarded, so a
 * request cannot smuggle one.
 */
export function relayRequest(upstream: URL, method: string, body: string, wantsBody: boolean, accept: string | null): Request {
  return new Request(upstream, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: accept ?? (wantsBody === true ? 'text/event-stream' : 'application/json'),
    },
    body: wantsBody === true ? body : undefined,
  })
}

/** Strip a mount prefix from a pathname, or `null` when the path is not under it. */
export function stripPrefix(pathname: string, prefix: string): string | null {
  const cleaned = String(prefix ?? '').replace(/\/+$/, '')
  if (cleaned === '') return pathname
  if (pathname === cleaned) return null
  if (!pathname.startsWith(cleaned + '/')) return null
  return pathname.slice(cleaned.length)
}

/**
 * The lane's request handler — the entry **both hosts** call.
 *
 * dsh's `worker.js` exported this as `export default { fetch }`, so the Node host
 * imported the very same object the Worker runtime invoked. This port keeps that
 * property: the handler is built once here and every host drives it through a
 * `fetch(request, env, ctx)` call, so a signed request is admitted, rated and
 * relayed identically wherever the gateway runs.
 *
 * The environment is passed **per call** rather than captured, because the Node
 * host fills its limiters and its auth gate into it at request time; a captured
 * environment would freeze one host's decisions into both.
 */
export interface LaneEnv {
  UPSTREAM_URL?: string
  UPSTREAM_API_KEY?: string
  SIGNING_SECRETS?: string
  MODELS?: string
  CLOCK_SKEW_SECONDS?: string
  MAX_BODY_BYTES?: string
  MOUNT_PREFIX?: string
  RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> }
}

export interface LaneContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
  /** Called once admission has fully passed, before the relay is waited on. */
  onUpstreamPending?: () => void
}

export interface LaneHandler {
  fetch(request: Request, env: LaneEnv, ctx: LaneContext): Promise<Response>
}

/** Build the lane's request handler. One instance serves every host. */
export function createLaneHandler(log: (message: string) => void = () => {}): LaneHandler {
  return {
    async fetch(request: Request, env: LaneEnv, ctx: LaneContext): Promise<Response> {
      const started = Date.now()
      const url = new URL(request.url)
      const prefix = String(env.MOUNT_PREFIX ?? '').replace(/\/+$/, '')
      // The signature covers the full pathname the client sent, prefix included;
      // only routing and forwarding look past the prefix.
      const routePath = stripPrefix(url.pathname, prefix)
      if (routePath === null) return jsonError(404, 'not found')
      const route = ROUTES[`${request.method} ${routePath}`]
      if (route === undefined) return jsonError(404, 'not found')

      try {
        const secrets = acceptedSecrets(env.SIGNING_SECRETS)
        if (secrets.length === 0) return jsonError(500, 'gateway is not configured')
        const admission = await verifySignedRequest(request, secrets, {
          route,
          skewSeconds: Number.parseInt(env.CLOCK_SKEW_SECONDS ?? '', 10) || undefined,
          maxBodyBytes: Number.parseInt(env.MAX_BODY_BYTES ?? '', 10) || undefined,
          models: env.MODELS,
        })
        if (admission.ok !== true) {
          return jsonError(admission.status ?? 400, admission.message ?? 'request refused')
        }

        if (env.RATE_LIMITER !== undefined) {
          const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
          const verdict = await env.RATE_LIMITER.limit({ key: ip })
          if (verdict.success === false) return jsonError(429, 'too many requests; retry later')
        }

        const base = relayUrl(String(env.UPSTREAM_URL ?? ''))
        if (base === null) return jsonError(500, 'gateway is not configured')
        const upstream = new URL(base.origin + base.pathname.replace(/\/+$/, '') + route.upstream)
        const wantsBody = route.body === true
        // Called **before** the relay is waited on: the host flushes an SSE head at
        // this point, so a front proxy's origin timeout measures an already-started
        // response instead of the model's thinking time. Fired afterwards it would
        // be useless — the bytes the proxy was waiting for have already arrived.
        ctx.onUpstreamPending?.()
        // The bytes `verifySignedRequest` already read and the signature already
        // covered — read a second time and the stream is empty.
        // The credential is attached **here**, from the environment, and never taken
        // from the caller's own headers — that is the whole reason this gateway
        // exists as a separate half.
        const relayed = await fetch(relayRequest(upstream, request.method, admission.body ?? '', wantsBody, request.headers.get('accept')), {
          // Carry the caller's cancellation into the relay connection: without it a
          // client that hangs up while the relay is still thinking leaves the
          // upstream request running, billing capacity for an answer nobody reads.
          signal: request.signal,
          headers: {
            authorization: `Bearer ${env.UPSTREAM_API_KEY ?? ''}`,
            'user-agent': 'our-free-model-gateway',
          },
        })
        const response = relayed

        const headers = new Headers({ 'cache-control': 'no-store' })
        for (const name of PASS_HEADERS) {
          const value = response.headers.get(name)
          if (value !== null) headers.set(name, value)
        }
        log(JSON.stringify({ lane: 'eac', path: url.pathname, status: response.status, ms: Date.now() - started }))
        ctx.waitUntil(Promise.resolve())
        return new Response(response.body, { status: response.status, headers })
      } catch (error) {
        // A cancellation is the expected way out when the caller hangs up, not a
        // gateway fault: logging it as a 500 makes an operator chase a server error
        // that never happened.
        if (request.signal.aborted === true) return new Response(null, { status: 499 })
        ctx.passThroughOnException()
        log(JSON.stringify({ lane: 'eac', path: url.pathname, status: 500, ms: Date.now() - started, fault: String((error as Error)?.message ?? error).slice(0, 120) }))
        return jsonError(500, 'gateway request failed')
      }
    },
  }
}
