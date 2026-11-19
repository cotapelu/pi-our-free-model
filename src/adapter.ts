/**
 * The provider adapter — the DSH harness-facing half, ported.
 *
 * In DSH this file was 1.002 lines because it owned *the whole turn loop*: chain
 * walking, recovery, usage accounting, block tracking, dispatch. The pi-extension
 * port already has each of those in its own module — `gateway/dispatch.ts` drives
 * a turn and recovers it, `gateway/chain.ts` walks a chain, `gateway/recovery.ts`
 * owns the policy, `messages.ts` owns the three wire codecs. Copying 500 lines of
 * turn loop into a second file would be two turn loops to keep correct, not a
 * port.
 *
 * So this module carries **exactly the behaviour the port did not already have**,
 * and names where the rest went. Nothing is dropped silently: the table at the
 * bottom of this docblock is the reconciliation.
 *
 * ### What lives here, and why it is not elsewhere
 *
 * 1. **The chain silence watchdog** — `CHAIN_SILENCE_MS` / `nextOrSilence`. A
 *    candidate whose upstream accepts the request and then sends nothing but
 *    keepalive comments never settles `reader.next()`, so the fallback that
 *    exists for exactly that case never reaches its next link. The gateway's
 *    `commitBody` had the buffer-until-commit rule but no deadline; the
 *    deadline lives here and is wired in from `gateway/chain.ts`.
 * 2. **`commitsAnswer`** — the chunk-level commit rule. Reasoning deltas are
 *    *not* a commit: "thought for a minute, then hit a quota wall" is the most
 *    valuable case to fail over. The gateway has the byte-level sibling
 *    (`frameCarriesAnswer`); this is the chunk-level one the adapter used.
 * 3. **`buildPayload`** — the three wire shapes, composed from `messages.ts`
 *    rather than re-implemented.
 * 4. **`savingsFields`** — the usage-record fields the saver measured.
 * 5. **`toFailure`** — the whitelisted failure shape the durable session log
 *    accepts; a malformed one aborts the whole turn.
 * 6. **`describe`** — the `/model` popup's detail line, where the capacities that
 *    matter for *choosing* a model have to fit.
 * 7. **`applySealedPacingHint`** — the one-line pacing ask on every sealed build.
 * 8. **`subscriptionToolChoice`** — validation before account resolution.
 * 9. **`ROUTE_MAIN`/`ROUTE_REGION`/`ROUTE_LABELS`** — two groups from one
 *    adapter, because the picker groups strictly by route and has no other
 *    grouping field.
 *
 * ### Reconciliation — every export of `src/adapter.js` and where it went
 *
 * | DSH export | Home in pi-extension |
 *|---|---|
 * `ROUTE_MAIN`, `ROUTE_REGION`, `ROUTE_LABELS` | here |
 * `FreeModelAdapter` | `gateway/dispatch.ts` (the turn loop), `gateway/chain.ts` (the walk) |
 * `providerRetryPolicy` — retryable set, no RATE_LIMIT/REGION | `gateway/classify.ts` (`retryableCodes`, `shouldAdvance`) |
 * `imageRequestPricing` | `image-pricing.ts` (`FALLBACK_IMAGE_PRICING`) |
 * `listModels`/`resolveModel`/`prepareCall` | `catalog.ts` + `gateway/dispatch.ts` (`resolveModel`, `modelRows`) |
 * `runStream`/`runCombo`/`runSingle`/`runSubscription` | `gateway/dispatch.ts` + `gateway/chain.ts` + `subscription-adapter.ts` |
 * `nextOrSilence`, `CHAIN_SILENCE_MS`, `SILENT_CANDIDATE` | here |
 * `commitsAnswer` | here (chunk-level); `gateway/chain.ts` has the byte-level sibling |
 * `buildPayload` | here (composed from `messages.ts`) |
 * `savingsFields` | here |
 * `toFailure` | here |
 * `describe` | here |
 * `applySealedPacingHint`, `SEALED_PACING_HINT` | here |
 * `subscriptionToolChoice` | here |
 * `postSealedTurn` | `eac.ts` (`postSealedStreamed`) + `eac-lane.ts` |
 * `wireOf`, `STYLE_FOR_WIRE` | here |
 *
 * Ported from dsh's `src/adapter.js`.
 *
 * @module pi-extension/adapter.js
 */

import {
  toChatMessages, toClaudeMessages, toResponseInput,
} from './messages.js'
import { FALLBACK_IMAGE_PRICING } from './image-pricing.js'

/**
 * How long a chain candidate may stay silent before the try counts as failed.
 *
 * `runCombo` commits to a candidate only once an answer-bearing chunk arrives,
 * and a candidate whose upstream accepts the request and then sends nothing —
 * keepalive comments only, no deltas — never settles the read. With no deadline
 * that single await blocks the whole chain, so the fallback that exists for
 * exactly this case never reaches its next link. Availability probes do not
 * cover the shape either: the gateway answers 200, so the probe reads it as up.
 *
 * Only the pre-commit window is bounded. Once an answer delta has been handed
 * over, the answer belongs to the caller and the original unbounded await stays,
 * so a slow-but-alive model is never cut off mid-stream — a reasoning model that
 * thinks for a minute while streaming its thoughts keeps resetting the clock.
 */
export const CHAIN_SILENCE_MS = 25_000

/** Distinguishes "the watchdog fired" from a row the reader really produced. */
export const SILENT_CANDIDATE = Symbol('ofm-silent-candidate')

/** A candidate abandoned for silence reports itself as an advanceable end-of-try. */
export const SILENCE_RESULT = Object.freeze({ done: true, value: { advance: true, verdict: null } })

/**
 * Await one reader step, giving up when the candidate stays silent for `ms`.
 *
 * A timeout is reported as an advanceable end-of-try, so the chain walks on
 * exactly as it would after a classified failure. The reader cannot be
 * interrupted, but the generator's own `finally` block aborts its transport once
 * it settles — so `return()` is best-effort and its failure is not an error.
 */
export async function nextOrSilence<T>(
  iterator: { next(): Promise<IteratorResult<T>>; return?(value?: any): Promise<IteratorResult<T>> },
  ms: number = CHAIN_SILENCE_MS,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined
  try {
    const silence = new Promise<typeof SILENT_CANDIDATE>(resolve => {
      timer = setTimeout(() => resolve(SILENT_CANDIDATE), ms)
      timer.unref?.()
    })
    const row = await Promise.race([
      iterator.next().then(value => ({ ok: true as const, value })),
      silence.then(() => ({ ok: false as const, value: undefined })),
    ])
    if (row.ok === true) return row.value as IteratorResult<T>
    // Deliberately **not** awaited. A generator suspended at an `await` never
    // settles its `return()`, so awaiting it would hang the caller on exactly the
    // candidate that went quiet. Fired and forgotten: the generator's own
    // `finally` block aborts its transport once it settles, which is the effect
    // this is after.
    try { void iterator.return?.(undefined) } catch { /* best effort, see above */ }
    return SILENCE_RESULT as unknown as IteratorResult<T>
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const ROUTE_MAIN = 'our-free-model'
export const ROUTE_REGION = 'our-free-model-region'

/** Group headings — the only strings the picker shows as a section title. */
export const ROUTE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [ROUTE_MAIN]: 'Our Free Model',
  [ROUTE_REGION]: 'Our Free Model · region-limited',
})

const STYLE_FOR_WIRE: Readonly<Record<string, string>> = Object.freeze({ chat: 'chat', responses: 'flat', messages: 'claude' })

/** The style the fingerprint pass uses for one wire (`chat`, `flat`, `claude`). */
export function styleForWire(wire: string): string {
  return STYLE_FOR_WIRE[wire] ?? 'chat'
}

/**
 * Which wire serves one catalog row.
 *
 * The absorbed channels speak the Chat wire regardless of what their ids resemble;
 * an aggregate row carries the wire its provider actually serves; the free lane
 * splits its endpoints per model id.
 */
export function wireOf(entry: any): string {
  if (entry === null || entry === undefined) return 'chat'
  if (typeof entry.wire === 'string' && entry.wire !== '') return entry.wire
  return 'chat'
}

/**
 * Does this chunk carry an answer the caller would have to un-see?
 *
 * A chain may only abandon a candidate while the answer is still entirely inside
 * its own buffer. Reasoning deltas are excluded on purpose: thinking is not the
 * answer, and "thought for a minute, then hit a quota wall" is the most valuable
 * failure to fail over — the held thinking is dropped with the rest of the
 * discarded attempt, so the caller never learns it happened. A `block-end` for a
 * reasoning block is the tail of that same reasoning stream, so it does not
 * commit either; letting it commit would pin the chain one chunk before the
 * failure it exists to survive. Text commits only when it carries visible
 * content, the same bar the turn loop's `sawAnswer` uses, so whitespace noise
 * cannot pin a chain either.
 */
export function commitsAnswer(chunk: any): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

/** One wire body for one catalog row, built from the shared codecs. */
export function buildPayload(
  wire: string,
  modelId: string,
  messages: any[],
  options: any,
  budget: number,
  resolveImage?: (attachment: any) => string | undefined,
  warnings?: string[],
): Record<string, any> {
  if (wire === 'responses') {
    const input = toResponseInput(messages, resolveImage, warnings)
    return {
      model: modelId,
      input: input.length > 0 ? input : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }],
      stream: true,
      store: false,
      max_output_tokens: budget,
    }
  }
  if (wire === 'messages') {
    const shaped = toClaudeMessages(messages, resolveImage, warnings)
    return {
      model: modelId,
      messages: shaped.messages,
      stream: true,
      max_tokens: budget,
      ...shaped.system === undefined ? {} : { system: shaped.system },
    }
  }
  const chat = toChatMessages(messages, resolveImage, warnings)
  return {
    model: modelId,
    messages: typeof options?.system === 'string' && options.system !== ''
      ? [{ role: 'system', content: options.system }, ...chat]
      : chat,
    stream: true,
    max_tokens: budget,
  }
}

/**
 * Shape one thrown error into the failure vocabulary.
 *
 * The durable session log writes this object straight into an event, and that log
 * rejects anything that does not survive a lossless JSON round trip — an Error
 * instance, a `NaN`, an explicit `undefined` field. A rejected append aborts the
 * whole turn, so a malformed failure is strictly worse than a sparse one: only
 * the whitelisted fields are carried, each validated, and each dropped rather
 * than emitted in a degraded form.
 */
export function toFailure(error: any): { message: string; code: string; status?: number; providerRetryAfterMs?: number } {
  // An empty string is as useless as a missing message — the durable log accepts
  // it, and the user reading it learns nothing — so it falls back too.
  const raw = typeof error?.message === 'string' && error.message !== ''
    ? error.message
    : String(error ?? '')
  const message = raw === '' ? 'our free model request failed' : raw
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'TRANSPORT'
  const status = error?.status
  const retryAfter = error?.providerRetryAfterMs
  return {
    message,
    code,
    ...Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {},
    ...Number.isFinite(retryAfter) && retryAfter > 0 ? { providerRetryAfterMs: Math.trunc(retryAfter) } : {},
  }
}

/** What the token savers measured for one dispatched body, as usage-record fields. */
export function savingsFields(report: any): Record<string, any> {
  if (report === null || report === undefined) return {}
  const saved = Number(report.saved) || 0
  const promptInjected = report.prompt?.injected === true
  if (saved === 0 && promptInjected !== true) return {}
  return {
    savings: {
      saved,
      bytesBefore: Number(report.bytesBefore) || 0,
      // Carried alongside the other two, not derived from them later: the panel
      // shows "before → after", and an after of 0 beside a before of 2599 reads
      // as "the body became empty" rather than "this field was never recorded".
      bytesAfter: Number(report.bytesAfter) || 0,
      blocks: Array.isArray(report.rtk?.hits) ? report.rtk.hits.length : 0,
      ...promptInjected ? { prompt: report.prompt.families ?? [] } : {},
    },
  }
}

/**
 * The `/model` popup's detail line. The composer renders only the model name, so
 * the capacities that matter for *choosing* a model — modality, window, whether
 * an effort menu exists — have to fit here.
 *
 * A model that cannot switch its thinking off names the shared ceiling outright:
 * on that lane the rung is not only the answer's budget, and a picker that
 * implied otherwise is how "why is it cut off at 8K when my ceiling is 32K" gets
 * asked.
 */
export function describe(entry: any, settings?: any, budgetFor?: (effort: string, entry: any, max?: number, ceiling?: number) => number): string {
  const parts: string[] = [
    entry.vision === true ? 'vision + text input' : 'text input',
    `${Math.round((entry.contextWindow ?? 0) / 1024)}K context`,
  ]
  // A chain's own detail line: which models it will try, in order. Without it a
  // combo in the picker looks like one more model with no endpoint behind it.
  if (Array.isArray(entry.combo) && entry.combo.length > 0) {
    parts.push(`${entry.combo.length}-model chain: ${entry.combo.join(' -> ')}`)
    if (entry.strategy === 'round-robin') parts.push('rotating start')
    return parts.join(' · ')
  }
  if (entry.reasoning === true) {
    // A declared menu is the model's own level list on the wire — naming the
    // levels is the honest detail line; "budget" would describe the free lane's
    // ladder, which is exactly what a menu model does not use.
    if (Array.isArray(entry.efforts) && entry.efforts.length > 0) {
      parts.push(`thinking levels: ${entry.efforts.join(' / ')}`)
    } else if (typeof budgetFor === 'function') {
      const rung = Math.round(budgetFor('balanced', entry, undefined, settings?.defaultMaxTokens) / 1024)
      parts.push(entry.canDisableThinking === false
        ? `thinking always on · ${rung}K default ceiling, shared with the answer`
        : 'tunable thinking budget')
    }
  }
  return parts.join(' · ')
}

/**
 * The co-paid reasoning models can burn minutes in the thinking channel on turns
 * that need seconds (observed: an entire small token budget spent on reasoning
 * for a one-line answer, first visible byte minutes late). The effort menu owns
 * the hard depth; this one-line prompt asks for pacing so a turn does not sit
 * silent while the model over-explores. Applied on every sealed build, so the
 * continuation and recovery payloads carry it too.
 */
export const SEALED_PACING_HINT =
  'Avoid overthinking: keep your reasoning brief and proportionate to the task.'

/** Append the pacing hint to whichever field carries a sealed build's system text. */
export function applySealedPacingHint(payload: Record<string, any>): void {
  if (Array.isArray(payload.messages)) {
    const system = payload.messages.find((message: any) => message?.role === 'system' && typeof message.content === 'string')
    if (system !== undefined) {
      system.content = system.content === '' ? SEALED_PACING_HINT : `${system.content}\n\n${SEALED_PACING_HINT}`
      return
    }
    payload.messages.unshift({ role: 'system', content: SEALED_PACING_HINT })
    return
  }
  if (typeof payload.system === 'string') {
    payload.system = payload.system === '' ? SEALED_PACING_HINT : `${payload.system}\n\n${SEALED_PACING_HINT}`
  }
}

/**
 * Validate a subscription-only tool choice before account resolution or dispatch.
 *
 * A `required`/`any` choice with no declared tool is a request nothing can honour,
 * and a function name that does not exist would be rejected by the upstream after
 * the account was already spent — so both are refused here, where the caller can
 * still see the reason.
 */
export function subscriptionToolChoice(value: any, tools: any[]): any {
  if (value === undefined) return undefined
  const names = new Set((Array.isArray(tools) ? tools : [])
    .map((tool: any) => tool?.name ?? tool?.function?.name)
    .filter((name: any) => typeof name === 'string'))
  const named = value !== null && typeof value === 'object' && !Array.isArray(value)
    && ((value.type === 'function' && (value.function?.name ?? value.name))
      || (value.type === 'tool' && value.name)
      || (value.type === undefined && value.name))
  const validName = typeof named === 'string' && named.length > 0 && names.has(named)
  if (value === 'auto' || value === 'none') return value
  if ((value === 'required' || value === 'any') && names.size > 0) return value
  if (validName) return { type: 'function', function: { name: named } }
  throw Object.assign(new Error('Invalid subscription tool choice'), { code: 'INVALID_INPUT', status: 400 })
}

/**
 * The retry policy this adapter reports, in full.
 *
 * Both DSH kernels store this object verbatim instead of running it through a
 * resolver, and the backoff scheduler reads the delay fields off the **top
 * level** — reporting them nested under `backoff` makes every scheduled delay
 * `NaN`, which the durable session log then rejects, turning a recoverable
 * transient failure into an aborted turn.
 *
 * A regional refusal is deliberately absent: it is a property of the egress, not
 * a transient fault, so retrying only spends quota. So is RATE_LIMIT — this
 * lane's 429 carries a *growing* retry-after, and two automatic retries turned
 * every quota wall into three walls: the same turn, paid thrice, arriving later.
 */
export const PROVIDER_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 700,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
})

/** Both routes published from one adapter, plus the model each group carries. */
export interface AdapterRoute {
  route: string
  label: string
}

/** The groups this adapter publishes, in picker order. */
export function adapterRoutes(): readonly AdapterRoute[] {
  return Object.freeze([
    Object.freeze({ route: ROUTE_MAIN, label: ROUTE_LABELS[ROUTE_MAIN] }),
    Object.freeze({ route: ROUTE_REGION, label: ROUTE_LABELS[ROUTE_REGION] }),
  ])
}

/** The synchronous vision-token estimate every route reports. */
export function imageRequestPricing(): typeof FALLBACK_IMAGE_PRICING {
  return FALLBACK_IMAGE_PRICING
}

/** `providerInfo` for one route: the heading the picker shows. */
export function providerInfo(provider: string): { id: string; name: string } {
  return { id: provider, name: ROUTE_LABELS[provider] ?? provider }
}
