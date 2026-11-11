/**
 * Request trust fence for the extension's HTTP surface.
 *
 * The extension's routes run before the connection service's own admission
 * check and would otherwise answer any loopback caller; this module closes
 * that boundary. Two layers, tried in order:
 *
 * 1. the composition's own `connection` service when present — the exact
 *    admission decision the kernel applies to its `/api` routes (trust fence
 *    plus browser-auth cookie), so the plugin is never weaker than the app;
 * 2. a structural replica of that fence for compositions without the service:
 *    loopback host only, no cross-site fetches, and an `Origin`/`Referer` that
 *    matches the `Host` authority whenever the client supplies one, with a
 *    narrow exception for the desktop's `dsh-app://app` relay Referer.
 *
 * Two rules inside the replica are worth naming, because both were a live
 * boundary: a failure in a mounted Host service answers 503 rather than
 * bypassing browser authentication, and a *missing* service falls through to
 * the structural fence instead of answering "admission unavailable" — that
 * confusion is what turned every request into a 503 on hosts before dsh 0.1.7.
 *
 * Ported from dsh's `src/trust.js`.
 *
 * @module pi-extension/trust.js
 */

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** Hosts before dsh 0.1.7 publish the same decision under the older name. */
const DESKTOP_RELAY_REFERER = 'dsh-app://app'

/**
 * Is this address one a same-machine caller can reach — i.e. may the forward
 * listener bind it? The lanes are keyed to this machine's egress and priced
 * against whoever shares it, so binding a routable interface would hand the
 * quota to the whole subnet on the strength of a string in a settings file.
 */
export function isLoopbackHost(value: string): boolean {
  const raw = String(value ?? '').trim()
  // URL's authority parser requires brackets around an IPv6 literal, but the
  // listener accepts the bare spelling too, so `::1` is checked before parsing.
  if (raw === '::1') return true
  const authority = authorityOf(raw, 'http')
  return authority !== null && LOOPBACK_NAMES.has(authority.hostname)
}

interface Authority {
  scheme: string
  hostname: string
  port: string
}

/** Split a Host/Origin/Referer value into {scheme, hostname, port}, defaulting the port. */
function authorityOf(value: any, defaultScheme = 'http'): Authority | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url: URL
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

/**
 * The fence's view of one connection service, keyed under `admit` (issue #89).
 *
 * The composition may publish `connection` long after plugins have loaded, so
 * the caller reads it per request through this late-binding view. Hosts before
 * dsh 0.1.7 carry the same decision as `requestRejection`: the view maps that
 * method onto `admit` instead of wrapping a property that does not exist — the
 * wrapping call used to throw inside the fence and read as 503 admission
 * unavailable on every request. A bare status rides as the `{rejection}`
 * envelope `rejectionFor` unwraps: handed through bare, an object-shaped return
 * reads as "no rejection" and switches the host's authentication off.
 *
 * Exported so a caller can exercise the real view rather than a replica that
 * can drift from it.
 */
export function connectionAdmissionView(service: any) {
  return {
    get admit() {
      const current = typeof service === 'function' ? service() : service
      if (current === undefined) return undefined
      if (typeof current.admit !== 'function' && typeof current.requestRejection === 'function') {
        return (req: any) => {
          const status = current.requestRejection(req)
          return status === undefined ? undefined : { rejection: status }
        }
      }
      return (req: any) => current.admit(req)
    },
  }
}

export interface RejectionDecision {
  status: number
  source: 'connection' | 'structural'
  reason: string
}

/** Only the owned application page, never arbitrary custom-protocol pages. */
function isDesktopRelayReferer(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:'
      && url.hostname === 'app'
      && url.port === ''
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

/** Return a fixed reason without exposing caller-supplied strings. */
function structuralReason(req: any): string | undefined {
  const host = authorityOf(req.headers?.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback'
  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 'cross-site'
  for (const header of ['origin', 'referer'] as const) {
    const raw = req.headers?.[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    if (header === 'referer' && isDesktopRelayReferer(raw)) {
      // Desktop forwardWebRequest strips both browser markers before relaying
      // to HTTP loopback, but retains this Referer. It is not an Origin grant
      // and never overrides a mounted Host's authentication decision.
      if (req.headers?.origin !== undefined || req.headers?.['sec-fetch-site'] !== undefined) return 'desktop-relay-markers'
      continue
    }
    const authority = authorityOf(raw.trim())
    if (authority === null) return `${header}-invalid`
    // The web server speaks plain http on a loopback bind, so an Origin that
    // claims https — or any other scheme — is not this page.
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) {
      return `${header}-mismatch`
    }
  }
  return undefined
}

/**
 * Decide one request. Returns an HTTP status to reject with, or `undefined` to
 * let the handler run.
 */
export function rejectionFor(req: any, connection: any, onRejection?: (decision: RejectionDecision) => void): number | undefined {
  let decision: RejectionDecision | undefined
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission !== null && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return undefined
      decision = { status, source: 'connection', reason: 'host-rejected' }
    } else {
      const reject = connection?.requestRejection
      if (typeof reject === 'function') {
        const status = reject.call(connection, req)
        if (status === undefined) return undefined
        decision = { status, source: 'connection', reason: 'host-rejected' }
      }
    }
  } catch {
    // Never bypass browser authentication when a mounted Host service fails.
    decision = { status: 503, source: 'connection', reason: 'admission-error' }
  }
  if (decision === undefined) {
    const reason = structuralReason(req)
    if (reason === undefined) return undefined
    decision = { status: 403, source: 'structural', reason }
  }
  try {
    onRejection?.(decision)
  } catch {
    // Diagnostics are observational; a logger cannot change the HTTP decision.
  }
  return decision.status
}

/** The replica fence on its own: 403 or undefined. */
export function structuralRejection(req: any): number | undefined {
  return structuralReason(req) === undefined ? undefined : 403
}

export { DESKTOP_RELAY_REFERER }
