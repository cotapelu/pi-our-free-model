/**
 * Preserve classified failures across the three local forwarding protocols.
 *
 * The forwarded envelope travels through several architectures, so it carries only
 * what each of them can represent: a message, a machine-readable code, an HTTP
 * status and a retry-after. Anything else — a stack, a `cause`, an arbitrary
 * provider property — is dropped rather than forwarded, because a downstream
 * consumer has no field for it and an unmatched key is how a random object from
 * an upstream response ends up rendered as an error message.
 *
 * The code is *validated*, not merely passed through: a code that does not look
 * like the vocabulary's own `UPPER_SNAKE` is dropped, so an upstream's `type`
 * string (`rate_limit_error`) cannot masquerade as one of these codes.
 *
 * Ported from dsh's `src/failure.js`.
 *
 * @module pi-extension/failure.js
 */

export interface WireFailure {
  message: string
  code?: string
  status?: number
  providerRetryAfterMs?: number
}

/** `UPPER_SNAKE`, the shape every code in this project's vocabulary has. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * Shape one classified failure for the wire.
 *
 * @param failure - the classified failure, as `classify.ts` reports it
 * @param kind - `'aborted'` forces `ABORTED`; anything else keeps the source code
 */
export function carryFailure(failure: any, kind = 'error'): WireFailure {
  const source = failure !== null && typeof failure === 'object' ? failure : {}
  const code = kind === 'aborted' ? 'ABORTED' : source.code
  const status = source.status ?? source.statusCode
  return {
    message: typeof source.message === 'string' && source.message !== ''
      ? source.message
      : kind === 'aborted' ? 'request aborted' : 'our free model failed the turn',
    ...typeof code === 'string' && CODE_PATTERN.test(code) ? { code } : {},
    ...Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {},
    ...Number.isFinite(source.providerRetryAfterMs) && source.providerRetryAfterMs > 0
      ? { providerRetryAfterMs: Math.trunc(source.providerRetryAfterMs) } : {},
  }
}

/**
 * Wire error metadata for a finished turn; no arbitrary provider properties
 * are forwarded.
 *
 * This is dsh's `src/failure.js` `forwardFailure`, distinct from the same-named
 * export in `gateway/classify.ts` (which renders a *classified verdict* in a
 * dialect's envelope for the extension's gateway). This one answers the
 * forward listener's question: given a turn that ended in failure, what status
 * and error envelope does each protocol's client parse? The code-to-status
 * table is the product's own vocabulary — a named refusal keeps its meaning
 * across all three wires instead of collapsing to the status's default.
 *
 * Ported from dsh's `src/failure.js`.
 *
 * @module pi-extension/failure.js
 */
export function forwardFailureWire(outcome: any, anthropic = false): {
  status: number
  error: { message: string; type: string; code?: string }
  retryAfterMs?: number
  classified: boolean
} {
  const failure = carryFailure(outcome?.failure ?? { message: String(outcome?.error) })
  const classes: Record<string, [number, string]> = {
    INVALID_CREDENTIAL: [401, 'authentication_error'],
    AUTHORIZATION_REQUIRED: [403, 'permission_error'],
    LANE_LOCKED: [403, 'permission_error'],
    REGION_BLOCKED: [403, 'permission_error'],
    PERMISSION_DENIED: [403, 'permission_error'],
    QUOTA_EXHAUSTED: [429, 'insufficient_quota'],
    RATE_LIMIT: [429, 'rate_limit_error'],
    CLIENT_ERROR: [400, 'invalid_request_error'],
    ABORTED: [400, 'invalid_request_error'],
    TIMEOUT: [504, 'server_error'],
    EAC_UPSTREAM_FAILED: [502, 'server_error'],
    NO_PROGRESS: [504, 'server_error'],
  }
  const byStatus: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'invalid_request_error', 429: 'rate_limit_error' }
  const [fallbackStatus, type] = classes[failure.code as string] ?? [502, byStatus[Number(failure.status)] ?? 'server_error']
  return {
    status: failure.status ?? fallbackStatus,
    error: { message: failure.message, type: anthropic && type === 'server_error' ? 'api_error' : type, ...(failure.code ? { code: failure.code } : {}) },
    retryAfterMs: failure.providerRetryAfterMs,
    classified: Boolean(failure.code || failure.status),
  }
}
