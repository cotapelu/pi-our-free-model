/**
 * Unit checks for the merged failure vocabulary.
 *
 * The contract that must not pass by luck: the fired rule decides the cooldown
 * while the kind describes the failure, wording in the body beats the status
 * code, context overflow is read before everything, and a request-scoped 4xx is
 * never benched — cooling a healthy lane for a bad parameter hides the real cause
 * and makes every later request in the window fail with a copy of it.
 *
 * Usage: node pi-extension/test/classify.test.mjs
 */
import assert from 'node:assert/strict'
import {
  BACKOFF_BASE_MS, BACKOFF_MAX_LEVEL, COOLDOWN_LONG_MS, COOLDOWN_SHORT_MS,
  FAILURE_KIND, FAILURE_SCOPE, MAX_PROVIDER_COOLDOWN_MS, backoffFor, classifyFailure,
  describeVerdict, forwardFailure, shouldAdvance,
} from '../dist/gateway/classify.js'

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failures += 1
  }
}

check('backoff is exponential and clamped at level 0', () => {
  assert.equal(backoffFor(0), BACKOFF_BASE_MS)
  assert.equal(backoffFor(1), BACKOFF_BASE_MS)
  assert.equal(backoffFor(2), BACKOFF_BASE_MS * 2)
  assert.equal(backoffFor(3), BACKOFF_BASE_MS * 4)
})

check('backoff is capped at its maximum however high the level runs', () => {
  assert.equal(backoffFor(BACKOFF_MAX_LEVEL), 300 * 1000)
  assert.equal(backoffFor(BACKOFF_MAX_LEVEL + 50), 300 * 1000)
})

check('a 429 is a rate limit on the account scope with a backoff', () => {
  const verdict = classifyFailure({ status: 429 })
  assert.equal(verdict.kind, FAILURE_KIND.RATE_LIMIT)
  assert.equal(verdict.scope, FAILURE_SCOPE.ACCOUNT)
  assert.equal(verdict.retryable, true)
  assert.equal(verdict.cooldownMs, BACKOFF_BASE_MS)
  assert.equal(verdict.status, 429)
})

check('wording in the body beats the status code', () => {
  const verdict = classifyFailure({ status: 400, message: 'Rate limit reached for this key' })
  assert.equal(verdict.kind, FAILURE_KIND.RATE_LIMIT)
  assert.equal(verdict.cooldownMs, BACKOFF_BASE_MS)
})

check('a 429 that says its credential is gone is an auth refusal, not a rate limit', () => {
  const verdict = classifyFailure({ status: 429, message: 'no credentials for this account' })
  assert.equal(verdict.kind, FAILURE_KIND.AUTH)
  assert.equal(verdict.retryable, false)
})

check('context overflow is read before every other rule', () => {
  const verdict = classifyFailure({ status: 400, code: 'context_length_exceeded' })
  assert.equal(verdict.kind, FAILURE_KIND.CONTEXT_WINDOW)
  assert.equal(verdict.scope, FAILURE_SCOPE.REQUEST)
  assert.equal(verdict.retryable, false)
})

check('a prose context overflow with no code still reads as context window', () => {
  const verdict = classifyFailure({ status: 400, message: 'This model maximum context length is 8192' })
  assert.equal(verdict.kind, FAILURE_KIND.CONTEXT_WINDOW)
})

check('a request-scoped 4xx benches nothing', () => {
  const verdict = classifyFailure({ status: 400, message: 'temperature must be a number' })
  assert.equal(verdict.kind, FAILURE_KIND.INVALID_REQUEST)
  assert.equal(verdict.scope, FAILURE_SCOPE.REQUEST)
  assert.equal(verdict.cooldownMs, 0)
  assert.equal(shouldAdvance(verdict), false)
})

check('an unmatched 4xx is request-scoped, so a bad parameter never benches the lane', () => {
  const verdict = classifyFailure({ status: 418 })
  assert.equal(verdict.scope, FAILURE_SCOPE.REQUEST)
  assert.equal(verdict.retryable, false)
})

check('401 and 403 bench the account for a long cooldown', () => {
  assert.equal(classifyFailure({ status: 401 }).cooldownMs, COOLDOWN_LONG_MS)
  assert.equal(classifyFailure({ status: 401 }).kind, FAILURE_KIND.AUTH)
  assert.equal(classifyFailure({ status: 403 }).kind, FAILURE_KIND.PERMISSION)
})

check('402 is billing, and "add credits" is the actionable answer', () => {
  const verdict = classifyFailure({ status: 402 })
  assert.equal(verdict.kind, FAILURE_KIND.BILLING)
  assert.equal(verdict.cooldownMs, COOLDOWN_LONG_MS)
})

check('404 is unavailable: the account no longer routes that model at all', () => {
  const verdict = classifyFailure({ status: 404 })
  assert.equal(verdict.kind, FAILURE_KIND.UNAVAILABLE)
  assert.equal(verdict.retryable, false)
})

check('a short cooldown rule clears on a token refresh, so the cooldown moves the walker not retryable', () => {
  const verdict = classifyFailure({ message: 'request not allowed for this session' })
  assert.equal(verdict.kind, FAILURE_KIND.PERMISSION)
  assert.equal(verdict.cooldownMs, COOLDOWN_SHORT_MS)
  assert.equal(verdict.retryable, false)
  assert.equal(shouldAdvance(verdict), true, 'the cooldown is what advances the walker')
})

check('a provider-built bad payload benches the route even at 400', () => {
  const verdict = classifyFailure({ status: 400, message: 'improperly formed request' })
  assert.equal(verdict.kind, FAILURE_KIND.INVALID_REQUEST)
  assert.equal(verdict.scope, FAILURE_SCOPE.ACCOUNT)
  assert.equal(verdict.cooldownMs, COOLDOWN_LONG_MS)
})

check('capacity wording cools the provider scope, not the account', () => {
  const verdict = classifyFailure({ message: 'the server is at capacity' })
  assert.equal(verdict.kind, FAILURE_KIND.OVERLOADED)
  assert.equal(verdict.scope, FAILURE_SCOPE.PROVIDER)
  assert.equal(verdict.retryable, true)
})

check('a structured code is read when no text rule matched', () => {
  const verdict = classifyFailure({ code: 'invalid_api_key' })
  assert.equal(verdict.kind, FAILURE_KIND.AUTH)
  assert.equal(verdict.cooldownMs, COOLDOWN_LONG_MS)
})

check('an abort is request-scoped and never retryable', () => {
  const verdict = classifyFailure({ code: 'aborted' })
  assert.equal(verdict.kind, FAILURE_KIND.ABORTED)
  assert.equal(verdict.scope, FAILURE_SCOPE.REQUEST)
  assert.equal(verdict.retryable, false)
})

check('a region refusal clears on its own and benches nothing', () => {
  const verdict = classifyFailure({ code: 'region_blocked', status: 403 })
  assert.equal(verdict.kind, FAILURE_KIND.UNAVAILABLE)
  assert.equal(verdict.retryable, false)
  assert.equal(verdict.cooldownMs, 0)
})

check('a gRPC spelling of overload is caught by the marker rules', () => {
  const verdict = classifyFailure({ body: { error: { code: 'RESOURCE_EXHAUSTED' } } })
  assert.equal(verdict.kind, FAILURE_KIND.OVERLOADED)
  assert.equal(verdict.scope, FAILURE_SCOPE.PROVIDER)
})

check('a structured model-not-routed without a 404 still means unavailable', () => {
  const verdict = classifyFailure({ code: 'MODEL_NOT_FOUND' })
  assert.equal(verdict.kind, FAILURE_KIND.UNAVAILABLE)
  assert.equal(verdict.retryable, false)
})

check('a 5xx is transient and retryable', () => {
  const verdict = classifyFailure({ status: 500 })
  assert.equal(verdict.retryable, true)
  assert.equal(verdict.scope, FAILURE_SCOPE.TRANSIENT)
  assert.equal(verdict.cooldownMs, 30 * 1000)
})

check('502/503/504 read as overloaded rather than a generic upstream fault', () => {
  for (const status of [502, 503, 504]) {
    assert.equal(classifyFailure({ status }).kind, FAILURE_KIND.OVERLOADED, `status ${status}`)
  }
})

check('408 is the gateway timing out, which a re-send can answer differently', () => {
  const verdict = classifyFailure({ status: 408 })
  assert.equal(verdict.kind, FAILURE_KIND.TIMEOUT)
  assert.equal(verdict.retryable, true)
})

check('a provider reset overrides the rule cooldown but is capped', () => {
  const verdict = classifyFailure({ status: 429, retryAfterMs: 60 * 60 * 1000 })
  assert.equal(verdict.cooldownMs, MAX_PROVIDER_COOLDOWN_MS)
  assert.match(verdict.rule, /provider-reset/)
})

check('a provider reset is ignored on a refusal that is not retryable', () => {
  const verdict = classifyFailure({ status: 401, retryAfterMs: 5000 })
  assert.equal(verdict.cooldownMs, COOLDOWN_LONG_MS)
  assert.equal(verdict.rule.includes('provider-reset'), false)
})

check('a backoff level raises the cooldown', () => {
  const first = classifyFailure({ status: 429, backoffLevel: 0 })
  const third = classifyFailure({ status: 429, backoffLevel: 3 })
  assert.equal(first.cooldownMs, BACKOFF_BASE_MS)
  assert.equal(third.cooldownMs, BACKOFF_BASE_MS * 8)
  assert.equal(third.cooldownLevel, 4)
})

check('a failure with no status at all still classifies as transient', () => {
  const verdict = classifyFailure({ message: 'ECONNRESET' })
  assert.equal(verdict.kind, FAILURE_KIND.UNKNOWN)
  assert.equal(verdict.retryable, true)
  assert.equal(verdict.status, undefined)
})

check('describeVerdict prints one line and never throws on a missing verdict', () => {
  assert.match(describeVerdict(classifyFailure({ status: 429 })), /rate_limit\/account/)
  assert.match(describeVerdict(classifyFailure({ status: 429 })), /cooldown 2s/)
  assert.equal(describeVerdict(null), 'unknown/unknown · no cooldown · via none')
  assert.equal(describeVerdict(undefined), 'unknown/unknown · no cooldown · via none')
})

check('every verdict carries the kind and scope the router reads', () => {
  const verdict = classifyFailure({ status: 503 })
  assert.ok(Object.values(FAILURE_KIND).includes(verdict.kind))
  assert.ok(Object.values(FAILURE_SCOPE).includes(verdict.scope))
})

check('forwardFailure keeps the verdict status, so a 429 does not become a 503', () => {
  const verdict = classifyFailure({ status: 429, message: 'rate limit' })
  assert.equal(forwardFailure('openai', verdict, 'quota spent').statusCode, 429)
  assert.equal(forwardFailure('anthropic', verdict, 'quota spent').statusCode, 429)
})

check('forwardFailure renders OpenAI and Anthropic envelopes in their own vocabulary', () => {
  const verdict = classifyFailure({ status: 429, message: 'rate limit' })
  const openai = forwardFailure('openai', verdict, 'quota spent').body as any
  assert.equal(openai.error.type, 'rate_limit_error')
  assert.equal(openai.error.message, 'quota spent')
  const anthropic = forwardFailure('anthropic', verdict, 'quota spent').body as any
  assert.equal(anthropic.type, 'error')
  assert.equal(anthropic.error.type, 'rate_limit_error')
})

check('forwardFailure renders the Google envelope with a status string', () => {
  const verdict = classifyFailure({ status: 400, message: 'temperature must be a number' })
  const google = forwardFailure('gemini', verdict, 'bad parameter').body as any
  assert.equal(google.error.status, 'INVALID_ARGUMENT')
  assert.equal(google.error.code, 400)
})

check('forwardFailure separates an auth refusal from a permission one per dialect', () => {
  const auth = forwardFailure('anthropic', classifyFailure({ status: 401 }), 'nope').body as any
  const permission = forwardFailure('anthropic', classifyFailure({ status: 403 }), 'nope').body as any
  assert.equal(auth.error.type, 'authentication_error')
  assert.equal(permission.error.type, 'permission_error')
})

check('forwardFailure falls back to 503 for a retryable verdict with no status', () => {
  const verdict = classifyFailure({ message: 'ECONNRESET' })
  const shaped = forwardFailure('openai', verdict, 'connection reset')
  assert.equal(shaped.statusCode, 503)
  assert.equal((shaped.body as any).error.type, 'server_error')
})

check('forwardFailure answers 503 for a refusal no status explains', () => {
  const verdict = classifyFailure({ status: null, message: '' })
  const shaped = forwardFailure('anthropic', verdict, 'refused')
  assert.equal(shaped.statusCode, 503)
  // Anthropic's own 5xx vocabulary: a retryable "we could not serve this" is
  // `overloaded_error`, not the generic `api_error` — a client that reads the
  // type decides whether to back off, and `api_error` says "do not".
  assert.equal((shaped.body as any).error.type, 'overloaded_error')
})

check('forwardFailure keeps the two 5xx Anthropic spellings apart', () => {
  // A refusal no status explains, and which is *not* retryable, is the generic
  // one — the distinction between the two is exactly what a caller acts on.
  const retryable = classifyFailure({ status: null, message: '' })
  const permanent = classifyFailure({ status: null, message: '', code: 'invalid_credential' })
  assert.equal((forwardFailure('anthropic', retryable, 'x').body as any).error.type, 'overloaded_error')
  assert.equal((forwardFailure('anthropic', permanent, 'x').body as any).error.type, 'authentication_error')
  // The OpenAI wire has no overloaded spelling of its own, so both land there.
  assert.equal((forwardFailure('openai', retryable, 'x').body as any).error.type, 'server_error')
  assert.equal((forwardFailure('openai', permanent, 'x').body as any).error.type, 'authentication_error')
})

if (failures > 0) {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
