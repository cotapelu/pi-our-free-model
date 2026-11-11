/**
 * One failure vocabulary for every lane the gateway can walk.
 *
 * A failed turn has to answer two different questions, and neither source this
 * module ports from answers both.
 *
 * - *What went wrong?* so the caller can choose between replaying, rotating to
 *   the next link, or telling the user something they can act on. The FCC
 *   `failure_policy` owns this vocabulary: `FailureKind` plus a `retryable` flag,
 *   derived from the HTTP status and from structured markers in the body.
 * - *Should the lane that answered be benched, and for how long?* so one bad
 *   exit cannot eat every later request. 9router's `ERROR_RULES` owns this: a
 *   small ordered policy table whose text rules win over its status rules, with
 *   exponential backoff for rate-limit wording and a 30 s default for everything
 *   unmatched.
 *
 * This module merges them with one authority each: the fired rule decides the
 * cooldown (`cooldownMs`/`cooldownLevel` — the legacy names, kept so a caller
 * ported from 9router needs no translation), while `kind`/`retryable`/`scope`
 * describe the failure itself. Where the two sources disagree the rule table
 * wins on duration and FCC wins on meaning, because a cooldown is an operational
 * policy (how long to leave a connection out of rotation) and a kind is a fact
 * about the failure.
 *
 * `scope` is where the fault lives: `request` (a replay of the same body
 * reproduces the refusal — bench nothing), `account`, `provider`, or `transient`.
 *
 * Pure by construction: no timers, no I/O, no clock, no randomness. The only
 * time-shaped input a caller may supply is a provider-reported reset duration
 * (`retryAfterMs`), clamped to 30 minutes — providers do report multi-hour
 * resets, and honouring one would silently empty a chain.
 *
 * Ported from dsh's `src/route/classify.js`.
 *
 * @module pi-extension/gateway/classify.js
 */

export const FAILURE_KIND = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  CONTEXT_WINDOW: 'context_window',
  AUTH: 'auth',
  PERMISSION: 'permission',
  BILLING: 'billing',
  RATE_LIMIT: 'rate_limit',
  OVERLOADED: 'overloaded',
  TIMEOUT: 'timeout',
  UPSTREAM: 'upstream',
  UNAVAILABLE: 'unavailable',
  ABORTED: 'aborted',
  UNKNOWN: 'unknown',
})

export const FAILURE_SCOPE = Object.freeze({
  REQUEST: 'request',
  ACCOUNT: 'account',
  PROVIDER: 'provider',
  TRANSIENT: 'transient',
})

export const COOLDOWN_LONG_MS = 2 * 60 * 1000
export const COOLDOWN_SHORT_MS = 5 * 1000
export const TRANSIENT_COOLDOWN_MS = 30 * 1000
export const MAX_PROVIDER_COOLDOWN_MS = 30 * 60 * 1000
export const BACKOFF_BASE_MS = 2000
export const BACKOFF_MAX_MS = 300 * 1000
export const BACKOFF_MAX_LEVEL = 15

export interface CooldownVerdict {
  kind: string
  scope: string
  retryable: boolean
  cooldownMs: number
  cooldownLevel: number
  rule: string
  status?: number
}

export interface FailureVerdict extends CooldownVerdict {
  status: number
}

/**
 * Cooldown for one backoff level, in milliseconds.
 *
 * The `Math.max(0, level-1)` guard matters because a fresh lane carries level 0
 * and the first rate-limit hit must not produce a sub-second cooldown that
 * immediately re-enters rotation. Levels above the ceiling clamp to it, and the
 * millisecond value is capped independently of the level.
 */
export function backoffFor(level: number): number {
  const numeric = typeof level === 'number' && Number.isFinite(level) ? Math.floor(level) : 0
  const clamped = Math.min(Math.max(numeric, 1), BACKOFF_MAX_LEVEL)
  return Math.min(BACKOFF_BASE_MS * 2 ** (clamped - 1), BACKOFF_MAX_MS)
}

interface Rule {
  text?: string
  marker?: string
  status?: number
  backoff?: true
  cooldownMs?: number
  kind: string
  scope: string
  retryable?: boolean
}

const ERROR_RULES: readonly Rule[] = Object.freeze([
  Object.freeze({ text: 'no credentials', cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false }),
  Object.freeze({ text: 'request not allowed', cooldownMs: COOLDOWN_SHORT_MS, kind: FAILURE_KIND.PERMISSION, scope: FAILURE_SCOPE.ACCOUNT, retryable: false }),
  Object.freeze({ text: 'improperly formed request', cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.INVALID_REQUEST, scope: FAILURE_SCOPE.ACCOUNT, retryable: false }),
  Object.freeze({ text: 'rate limit', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true }),
  Object.freeze({ text: 'too many requests', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true }),
  Object.freeze({ text: 'quota exceeded', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true }),
  Object.freeze({ text: 'capacity', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true }),
  Object.freeze({ text: 'overloaded', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true }),
  Object.freeze({ status: 401, cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false }),
  Object.freeze({ status: 402, cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.BILLING, scope: FAILURE_SCOPE.ACCOUNT, retryable: false }),
  Object.freeze({ status: 403, cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.PERMISSION, scope: FAILURE_SCOPE.ACCOUNT, retryable: false }),
  Object.freeze({ status: 404, cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.ACCOUNT, retryable: false }),
  Object.freeze({ status: 429, backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true }),
])

const MARKER_RULES: readonly Rule[] = Object.freeze([
  Object.freeze({ marker: 'rate_limit', backoff: true, kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true }),
  Object.freeze({ marker: 'resourceexhausted', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true }),
  Object.freeze({ marker: 'resource exhausted', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true }),
  // The Google/gRPC spelling of the same status; the underscore form is the one
  // a structured `code` arrives under.
  Object.freeze({ marker: 'resource_exhausted', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true }),
  Object.freeze({ marker: 'limit reached', backoff: true, kind: FAILURE_KIND.OVERLOADED, scope: FAILURE_SCOPE.PROVIDER, retryable: true }),
  Object.freeze({ marker: 'internal_server_error', cooldownMs: TRANSIENT_COOLDOWN_MS, kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true }),
  Object.freeze({ marker: 'internal server error', cooldownMs: TRANSIENT_COOLDOWN_MS, kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true }),
  // A structured "this model is not routed here" without a 404 still means the
  // same thing the 404 status rule says.
  Object.freeze({ marker: 'model_not_found', cooldownMs: COOLDOWN_LONG_MS, kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.ACCOUNT, retryable: false }),
])

const CODE_VERDICTS: Record<string, Rule> = Object.freeze({
  aborted: Object.freeze({ kind: FAILURE_KIND.ABORTED, scope: FAILURE_SCOPE.REQUEST, retryable: false, cooldownMs: 0 }),
  timeout: Object.freeze({ kind: FAILURE_KIND.TIMEOUT, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS }),
  transport: Object.freeze({ kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS }),
  server: Object.freeze({ kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS }),
  stream_cut: Object.freeze({ kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS }),
  empty_response: Object.freeze({ kind: FAILURE_KIND.UPSTREAM, scope: FAILURE_SCOPE.TRANSIENT, retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS }),
  client_error: Object.freeze({ kind: FAILURE_KIND.INVALID_REQUEST, scope: FAILURE_SCOPE.REQUEST, retryable: false, cooldownMs: 0 }),
  invalid_credential: Object.freeze({ kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS }),
  invalid_api_key: Object.freeze({ kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS }),
  unauthorized: Object.freeze({ kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS }),
  permission_denied: Object.freeze({ kind: FAILURE_KIND.PERMISSION, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS }),
  forbidden: Object.freeze({ kind: FAILURE_KIND.PERMISSION, scope: FAILURE_SCOPE.ACCOUNT, retryable: false, cooldownMs: COOLDOWN_LONG_MS }),
  rate_limit: Object.freeze({ kind: FAILURE_KIND.RATE_LIMIT, scope: FAILURE_SCOPE.ACCOUNT, retryable: true, backoff: true }),
  region_blocked: Object.freeze({ kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.PROVIDER, retryable: false, cooldownMs: 0 }),
  authorization_required: Object.freeze({ kind: FAILURE_KIND.AUTH, scope: FAILURE_SCOPE.PROVIDER, retryable: false, cooldownMs: 0 }),
  lane_locked: Object.freeze({ kind: FAILURE_KIND.UNAVAILABLE, scope: FAILURE_SCOPE.PROVIDER, retryable: false, cooldownMs: 0 }),
})

const OVERLOAD_STATUSES = Object.freeze([502, 503, 504, 529])
const CONTEXT_WINDOW_CODES = Object.freeze(['context_length_exceeded', 'model_context_window_exceeded'])
const CONTEXT_WINDOW_MARKERS = Object.freeze([
  'context_length_exceeded',
  'maximum context length',
  'context window exceeded',
  'exceeds the context window',
  'prompt is too long',
])

function verdictOf(kind: string, scope: string, options: Partial<CooldownVerdict> = {}): CooldownVerdict {
  return {
    kind,
    scope,
    retryable: options.retryable === true,
    cooldownMs: options.cooldownMs ?? 0,
    cooldownLevel: options.cooldownLevel ?? 0,
    rule: options.rule ?? 'default',
  }
}

function backoffOf(kind: string, scope: string, level: number, rule: string): CooldownVerdict {
  const cooldownLevel = Math.min(Math.max(0, level) + 1, BACKOFF_MAX_LEVEL)
  return verdictOf(kind, scope, { retryable: true, cooldownMs: backoffFor(cooldownLevel), cooldownLevel, rule })
}

function normalizeLevel(level: unknown): number {
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0
}

function normalizeStatus(status: unknown): number | undefined {
  if (Number.isInteger(status)) return status as number
  if (typeof status === 'string' && /^\d{1,3}$/.test(status.trim())) return Number(status.trim())
  return undefined
}

function bodyTextOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function failureText(message: unknown, body: unknown, code: unknown): string {
  const parts: string[] = []
  const messageText = typeof message === 'string' ? message : bodyTextOf(message)
  if (messageText !== '') parts.push(messageText)
  if (typeof code === 'string' && code !== '') parts.push(code)
  const bodyText = bodyTextOf(body)
  if (bodyText !== '') parts.push(bodyText)
  return parts.join(' ').toLowerCase()
}

function bodyCandidates(body: unknown): unknown[] {
  if (typeof body === 'string') {
    try {
      return bodyCandidates(JSON.parse(body))
    } catch {
      return [body]
    }
  }
  if (body === null || typeof body !== 'object') return [body]
  const nested = (body as { error?: unknown }).error
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? [body, nested] : [body]
}

function failureCodes(code: unknown, body: unknown): string[] {
  const found: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim().toLowerCase()
    if (trimmed !== '' && !found.includes(trimmed)) found.push(trimmed)
  }
  add(code)
  for (const candidate of bodyCandidates(body)) {
    if (candidate === null || typeof candidate !== 'object') continue
    add((candidate as { code?: unknown }).code)
    add((candidate as { type?: unknown }).type)
  }
  return found
}

/** Context overflow is read before every other rule: the fix is a smaller request, never a retry. */
function contextWindowVerdict(codes: string[], text: string): CooldownVerdict | null {
  const named = codes.some((code) => CONTEXT_WINDOW_CODES.includes(code))
  const described = CONTEXT_WINDOW_MARKERS.some((marker) => text.includes(marker))
  if (!named && !described) return null
  return verdictOf(FAILURE_KIND.CONTEXT_WINDOW, FAILURE_SCOPE.REQUEST, { rule: 'context-window' })
}

function textRuleVerdict(text: string, level: number): CooldownVerdict | null {
  if (text === '') return null
  for (const rule of ERROR_RULES) {
    if (rule.text === undefined || !text.includes(rule.text)) continue
    if (rule.backoff === true) return backoffOf(rule.kind, rule.scope, level, `text:${rule.text}`)
    return verdictOf(rule.kind, rule.scope, { retryable: rule.retryable === true, cooldownMs: rule.cooldownMs, rule: `text:${rule.text}` })
  }
  return null
}

function codeVerdict(codes: string[], level: number): CooldownVerdict | null {
  for (const code of codes) {
    const rule = CODE_VERDICTS[code]
    if (rule === undefined) continue
    if ((rule as Rule).backoff === true) return backoffOf(rule.kind, rule.scope, level, `code:${code}`)
    return verdictOf(rule.kind, rule.scope, { retryable: rule.retryable === true, cooldownMs: rule.cooldownMs, rule: `code:${code}` })
  }
  return null
}

function statusRuleVerdict(status: number | undefined, level: number): CooldownVerdict | null {
  if (status === undefined) return null
  for (const rule of ERROR_RULES) {
    if (rule.status === undefined || rule.status !== status) continue
    if (rule.backoff === true) return backoffOf(rule.kind, rule.scope, level, `status:${status}`)
    return verdictOf(rule.kind, rule.scope, { retryable: rule.retryable === true, cooldownMs: rule.cooldownMs, rule: `status:${status}` })
  }
  return null
}

function markerVerdict(text: string, level: number): CooldownVerdict | null {
  if (text === '') return null
  for (const rule of MARKER_RULES) {
    if (rule.marker === undefined || !text.includes(rule.marker)) continue
    if (rule.backoff === true) return backoffOf(rule.kind, rule.scope, level, `marker:${rule.marker}`)
    return verdictOf(rule.kind, rule.scope, { retryable: rule.retryable === true, cooldownMs: rule.cooldownMs, rule: `marker:${rule.marker}` })
  }
  return null
}

function statusLayerVerdict(status: number | undefined): CooldownVerdict | null {
  if (status === undefined) return null
  if (status === 408) return verdictOf(FAILURE_KIND.TIMEOUT, FAILURE_SCOPE.TRANSIENT, { retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS, rule: 'status:408' })
  if (status === 425) return verdictOf(FAILURE_KIND.UPSTREAM, FAILURE_SCOPE.TRANSIENT, { retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS, rule: 'status:425' })
  if (status >= 400 && status < 500) return verdictOf(FAILURE_KIND.INVALID_REQUEST, FAILURE_SCOPE.REQUEST, { rule: `status:${status}` })
  if (status >= 500 && status <= 599) {
    const kind = OVERLOAD_STATUSES.includes(status) ? FAILURE_KIND.OVERLOADED : FAILURE_KIND.UPSTREAM
    return verdictOf(kind, FAILURE_SCOPE.TRANSIENT, { retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS, rule: `status:${status}` })
  }
  return null
}

function transientVerdict(): CooldownVerdict {
  return verdictOf(FAILURE_KIND.UNKNOWN, FAILURE_SCOPE.TRANSIENT, { retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS, rule: 'transient' })
}

function applyProviderReset(verdict: CooldownVerdict, retryAfterMs: unknown): CooldownVerdict {
  const reported = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? Math.trunc(retryAfterMs) : 0
  if (reported <= 0) return verdict
  if (verdict.retryable !== true || verdict.cooldownMs <= 0) return verdict
  return { ...verdict, cooldownMs: Math.min(reported, MAX_PROVIDER_COOLDOWN_MS), rule: `${verdict.rule}+provider-reset` }
}

export interface FailureInput {
  status?: unknown
  code?: unknown
  message?: unknown
  body?: unknown
  retryAfterMs?: unknown
  backoffLevel?: number
}

/**
 * One failure, classified.
 *
 * The evaluation order is the contract: context overflow first (a smaller request
 * or a bigger window is the fix, never a replay), then text rules (wording in the
 * body beats the status), then structured codes, then status rules, then marker
 * rules, then the plain status layer, then the transient default.
 */
export function classifyFailure({ status, code, message, body, retryAfterMs, backoffLevel = 0 }: FailureInput = {}): FailureVerdict {
  const normalizedStatus = normalizeStatus(status)
  const text = failureText(message, body, code)
  const codes = failureCodes(code, body)
  const level = normalizeLevel(backoffLevel)
  const matched = contextWindowVerdict(codes, text)
    ?? textRuleVerdict(text, level)
    ?? codeVerdict(codes, level)
    ?? statusRuleVerdict(normalizedStatus, level)
    ?? markerVerdict(text, level)
    ?? statusLayerVerdict(normalizedStatus)
  const verdict = applyProviderReset(matched ?? transientVerdict(), retryAfterMs)
  return {
    ...verdict,
    ...(normalizedStatus === undefined ? {} : { status: normalizedStatus }),
  } as FailureVerdict
}

/** Should the walker move on to the next link? */
export function shouldAdvance(verdict: CooldownVerdict | null | undefined): boolean {
  if (verdict === null || verdict === undefined || typeof verdict !== 'object') return false
  return verdict.retryable === true || verdict.cooldownMs > 0
}

function humanCooldown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(' ')
}

/** One line for a log or a command. Never throws on a missing verdict. */
export function describeVerdict(verdict: CooldownVerdict | null | undefined): string {
  if (verdict === null || verdict === undefined || typeof verdict !== 'object') return 'unknown/unknown · no cooldown · via none'
  const parts = [`${verdict.kind ?? FAILURE_KIND.UNKNOWN}/${verdict.scope ?? 'unknown'}`]
  parts.push(verdict.cooldownMs > 0 ? `cooldown ${humanCooldown(verdict.cooldownMs)}` : 'no cooldown')
  if (verdict.cooldownLevel > 0) parts.push(`backoff level ${verdict.cooldownLevel}`)
  if (Number.isInteger(verdict.status)) parts.push(`HTTP ${verdict.status}`)
  parts.push(`via ${typeof verdict.rule === 'string' && verdict.rule !== '' ? verdict.rule : 'none'}`)
  return parts.join(' · ')
}

/** OpenAI's own error type for one failure kind. */
export function openAiErrorType(verdict: CooldownVerdict): string {
  switch (verdict.kind) {
    case FAILURE_KIND.RATE_LIMIT:
    case FAILURE_KIND.OVERLOADED: return 'rate_limit_error'
    case FAILURE_KIND.AUTH:
    case FAILURE_KIND.PERMISSION: return 'authentication_error'
    case FAILURE_KIND.BILLING: return 'billing_error'
    case FAILURE_KIND.CONTEXT_WINDOW:
    case FAILURE_KIND.INVALID_REQUEST: return 'invalid_request_error'
    case FAILURE_KIND.TIMEOUT: return 'timeout_error'
    case FAILURE_KIND.ABORTED: return 'api_error'
    default: return verdict.retryable === true ? 'server_error' : 'api_error'
  }
}

/** Anthropic's own error type for one failure kind. */
export function anthropicErrorType(verdict: CooldownVerdict): string {
  switch (verdict.kind) {
    case FAILURE_KIND.RATE_LIMIT:
    case FAILURE_KIND.OVERLOADED: return 'rate_limit_error'
    case FAILURE_KIND.AUTH: return 'authentication_error'
    case FAILURE_KIND.PERMISSION: return 'permission_error'
    case FAILURE_KIND.BILLING: return 'billing_error'
    case FAILURE_KIND.CONTEXT_WINDOW:
    case FAILURE_KIND.INVALID_REQUEST: return 'invalid_request_error'
    case FAILURE_KIND.TIMEOUT: return 'timeout_error'
    case FAILURE_KIND.ABORTED: return 'api_error'
    default: return verdict.retryable === true ? 'overloaded_error' : 'api_error'
  }
}

/** Google's own status string for one failure kind. */
export function googleErrorStatus(verdict: CooldownVerdict): string {
  switch (verdict.kind) {
    case FAILURE_KIND.INVALID_REQUEST: return 'INVALID_ARGUMENT'
    case FAILURE_KIND.AUTH: return 'UNAUTHENTICATED'
    case FAILURE_KIND.PERMISSION: return 'PERMISSION_DENIED'
    case FAILURE_KIND.CONTEXT_WINDOW: return 'INVALID_ARGUMENT'
    case FAILURE_KIND.RATE_LIMIT:
    case FAILURE_KIND.OVERLOADED: return 'RESOURCE_EXHAUSTED'
    case FAILURE_KIND.TIMEOUT: return 'DEADLINE_EXCEEDED'
    case FAILURE_KIND.ABORTED: return 'CANCELLED'
    default: return verdict.retryable === true ? 'UNAVAILABLE' : 'INTERNAL'
  }
}

/**
 * One failure shaped for the exact dialect that asked.
 *
 * The status is the verdict's — a caller's own HTTP client already names a 429
 * as a rate limit, and a gateway that answered 503 for one would be wrong — so
 * only the envelope's inner spelling changes. The message is the caller's
 * readable form: a caller that wanted the verdict's numbers can read them off the
 * headers the gateway already sends.
 */
export function forwardFailure(dialect: 'openai' | 'anthropic' | 'google' | 'gemini', verdict: CooldownVerdict, message: string): { statusCode: number; body: unknown } {
  const status = Number.isInteger(verdict.status) ? verdict.status as number : (verdict.retryable === true ? 503 : 500)
  if (dialect === 'anthropic') {
    return { statusCode: status, body: { type: 'error', error: { type: anthropicErrorType(verdict), message } } }
  }
  if (dialect === 'google' || dialect === 'gemini') {
    return { statusCode: status, body: { error: { code: status, message, status: googleErrorStatus(verdict) } } }
  }
  return { statusCode: status, body: { error: { message, type: openAiErrorType(verdict), param: null, code: null } } }
}

/**
 * The chain's own question: should the next link get a turn?
 *
 * A *classified* failure answers it by rule — the same text and status tables
 * `classifyFailure` reads, in the same precedence order, so a verdict computed
 * for a chain and a verdict computed for a reply can never disagree about what
 * the failure was. The difference is the shape: the chain needs the cooldown
 * arithmetic (how long to sit this link out), while the reply needs an HTTP
 * envelope.
 *
 * The 4xx carve-out at the end is the important half: a 4xx the table did not
 * name is the *request's* fault, and retrying it on another provider spends a
 * second provider's quota to produce the same refusal. Everything else is
 * transient — sit it out and let the chain advance.
 *
 * Ported from dsh's `src/route/classify.js`.
 *
 * @module pi-extension/gateway/classify.js
 */
export function cooldownVerdict({ status, message, backoffLevel = 0 }: { status?: number; message?: unknown; backoffLevel?: number } = {}): {
  shouldFallback: boolean
  cooldownMs: number
  cooldownLevel: number
  matched: string
} {
  const normalizedStatus = normalizeStatus(status)
  const text = failureText(message, undefined, undefined)
  const level = normalizeLevel(backoffLevel)
  const hit = textRuleVerdict(text, level) ?? statusRuleVerdict(normalizedStatus, level)
  if (hit !== null) {
    return { shouldFallback: true, cooldownMs: hit.cooldownMs, cooldownLevel: hit.cooldownLevel, matched: hit.rule }
  }
  if (normalizedStatus !== undefined && normalizedStatus >= 400 && normalizedStatus < 500
    && normalizedStatus !== 401 && normalizedStatus !== 402 && normalizedStatus !== 403 && normalizedStatus !== 429) {
    return { shouldFallback: false, cooldownMs: 0, cooldownLevel: 0, matched: `request:${normalizedStatus}` }
  }
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS, cooldownLevel: 0, matched: 'transient' }
}
