/**
 * Whether a free lane may be called at all, and what to do when it cannot.
 *
 * A failure does not answer that on its own: a 503 is every reverse proxy's way
 * of spelling "the gateway is unwell" and says nothing about this model, a bare
 * 5xx is *no measurement at all* rather than a model that failed, and the free
 * lane's client gate refuses the lane rather than the model while still costing
 * later turns.
 *
 * So a verdict is read from the structured `code` first, then the message, and
 * only then the status — in that order, and with the 5xx carve-out standing
 * between them: the message match is a fallback for a refusal the classifier did
 * not name, so it may only speak when the status did not already answer. Reading
 * "Service Unavailable" as a model being dropped took a working model down until
 * the next round (issue #310), so a 5xx never reads as a named refusal.
 *
 * Ported from dsh's `src/probe.js`.
 *
 * @module pi-extension/gateway/probe.js
 */

import { classifyFailure, shouldAdvance } from './classify.js'

export const STATE = Object.freeze({
  available: 'available',
  regionBlocked: 'region-blocked',
  unavailable: 'unavailable',
  throttled: 'throttled',
  unknown: 'unknown',
})

export const CODE = { region: 'region_blocked', quota: 'quota_exhausted' }

export type Verdict = string

/** Statuses a routing layer uses to say "this model is not on this gateway". */
export const ROUTING_REFUSAL_STATUS: readonly number[] = [400, 404, 422]

const CACHED_DURATION_MS = 15 * 60 * 1000
const MAX_STALENESS_MS = 90 * 60 * 1000

/** Map one failure onto what the picker shows next to that model. */
export function stateOf(error: any): Verdict {
  switch (error?.code) {
    case CODE.region: return STATE.regionBlocked
    case CODE.quota: return STATE.throttled
    case 'lane_locked': return STATE.unavailable
    default: break
  }
  const message = String(error?.message ?? '')
  // A 5xx already answered on the gateway's behalf; the message match may only
  // speak when the status did not.
  const gatewayTrouble = Number.isInteger(error?.status) && error.status >= 500
  const named = error?.unavailable === true
    || (!gatewayTrouble && /unavailable|unsupported|not supported|no such model|unknown model|invalid model/i.test(message))
  if (named) return STATE.unavailable
  if (Number.isInteger(error?.status) && ROUTING_REFUSAL_STATUS.includes(error.status)) return STATE.unavailable
  return STATE.unknown
}

export interface Aggregate {
  ok: number
  region: number
  quota: number
  unavailable: number
  unknown: number
  throttled: number
  unavailableRatio: number
}

/**
 * One verdict for a set of probes: not "was the last one available".
 *
 * Every miss counts as exclusion evidence — an exploratory probe is a ping whose
 * answer is not the model doing the work, so one that fails and one that sits
 * silent are two reasons to distrust it — while quota and region are *scoped*
 * refusals whose count says nothing beyond the first: quota is per account, and
 * changing the egress cannot move a region verdict.
 *
 * A ratio is the only honest reading of mixed evidence, because an origin that
 * answered once and failed twice is not "available". Below 0.5 the origin is
 * unreliable, whatever the ratio, since a coin-flip lane costs the user a failed
 * turn as often as it saves one.
 */
export function aggregate(verdicts: Verdict[]): Aggregate {
  const counts: Record<string, number> = {}
  for (const verdict of verdicts) counts[verdict] = (counts[verdict] ?? 0) + 1
  const ok = counts[STATE.available] ?? 0
  const region = counts[STATE.regionBlocked] ?? 0
  const quota = counts[STATE.throttled] ?? 0
  const unavailable = counts[STATE.unavailable] ?? 0
  const unknown = counts[STATE.unknown] ?? 0
  const throttled = counts[STATE.throttled] ?? 0
  const total = verdicts.length
  const wins = Math.max(total - (region + quota + unavailable + unknown), 0)
  return { ok, region, quota, unavailable, unknown, throttled, unavailableRatio: wins / total }
}

/** Merge an older verdict into a newer one, taking the more likely reading. */
export function prefer(oldVerdict: Verdict, newVerdict: Verdict): Verdict {
  const availability: Verdict[] = [STATE.available, STATE.throttled, STATE.regionBlocked]
  if (newVerdict === oldVerdict) return oldVerdict
  if (availability.includes(newVerdict)) return newVerdict
  if (availability.includes(oldVerdict)) return oldVerdict
  return newVerdict === STATE.unknown ? oldVerdict : newVerdict
}

export interface ProbeRow {
  verdict: Verdict
  at: number
  model: string
  session: string
  status?: number
  message?: string
}

export interface ProberOptions {
  doProbe: (row: { model: string; session: string }) => Promise<{ ok: boolean; error?: { code?: string; status?: number; message?: string } }>
  changed?: (model: string, verdict: Verdict) => void
  timeoutMs?: number
  store?: { get: () => { probes?: Record<string, ProbeRow> } }
  persist?: (row: ProbeRow) => void
}

export interface Prober {
  entry: (model: string) => (ProbeRow & { verdict: string }) | undefined
  probe: (model: string, options?: { force?: boolean }) => Promise<ProbeRow>
}

/**
 * Creates the per-model availability prober the gateway's picker consults.
 *
 * Probes are rate-limited by the last observation rather than by a timer, and a
 * successful one extends a healthy model's quiet period to the full cache
 * duration while an unsuccessful one is retried sooner: the cost of a good probe
 * is freshness, so a model that was refused yesterday deserves a second look
 * today, and one that answered a minute ago does not.
 *
 * Only the verdict is recorded, never the transcript, and a refresh overwrites a
 * previous verdict even an unavailable one: that is what keeps an out-of-date
 * verdict from living longer than its cache.
 *
 * The caller supplies the dial itself (`doProbe`), so the prober stays free of
 * the transport guards and can be exercised against a loopback stand-in.
 */
export function createProber(options: ProberOptions): Prober {
  const timeoutMs = options.timeoutMs ?? 45_000
  const persisted = new Map<string, ProbeRow>(Object.entries(options.store?.get().probes ?? {}))
  const changed = options.changed ?? (() => {})

  const entry = (model: string) => {
    const row = persisted.get(model)
    if (row === undefined) return undefined
    return { ...row, verdict: row.verdict ?? STATE.unknown }
  }

  const probe = async (model: string, { force = false }: { force?: boolean } = {}): Promise<ProbeRow> => {
    const previous = entry(model)
    const now = Date.now()
    if (!force && previous !== undefined) {
      const age = now - previous.at
      const limit = previous.verdict === STATE.available ? CACHED_DURATION_MS : CACHED_DURATION_MS / 3
      if (age >= 0 && age < limit) return previous
    }
    const session = `probe:our-free-model:${model}`
    const answer = await options.doProbe({ model, session })
    const verdict = answer.ok ? STATE.available : stateOf(answer.error)
    const row: ProbeRow = {
      verdict,
      at: now,
      model,
      session,
      ...(answer.ok ? {} : { status: answer.error?.status, message: answer.error?.message }),
    }
    const prior = previous?.verdict
    persisted.set(model, row)
    options.persist?.(row)
    if (prior !== undefined && prior !== row.verdict) changed(model, row.verdict)
    return row
  }

  return { entry, probe }
}

/** A probe verdict as it is shaped for the settings page. */
export function publicAvailability(row: ProbeRow | undefined) {
  return {
    verdict: row?.verdict ?? STATE.unknown,
    at: row?.at ?? 0,
    freshAt: row?.at ?? 0,
    actionable: shouldAdvance(classifyFailure({ status: row?.status, message: row?.message })),
    message: row?.message ?? '',
    hidden: false,
  }
}

export { CACHED_DURATION_MS, MAX_STALENESS_MS }

export interface QuotaWindow {
  remainingPercent: number
  resetsAt: string
  kind?: string
  windowSeconds?: number
}

export interface QuotaReading {
  status: 'ok' | 'available' | string
  checkedAt: string
  windows: QuotaWindow[]
}

function percentOf(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 100) return undefined
  return number
}

/**
 * The quota windows a minimal turn discloses, in the shape the chain scorer reads.
 *
 * A free pool discloses remaining quota in the usage frame it sends with an
 * answer, so the only honest way to learn it is to ask — and asking spends
 * tokens, which is why the reading is cached and why the prober is the only
 * caller. Anything upstream does not disclose leaves the window list empty, and
 * an empty list is what a scorer must read as "no evidence" rather than as
 * "nothing left".
 */
export function quotaReading(usage: Record<string, any> | undefined, at = Date.now()): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  const detail = usage ?? {}
  const candidates = [
    detail.remainingPercent, detail.quota_remaining_percent, detail.remaining_percent,
  ]
  for (const candidate of candidates) {
    const percent = percentOf(candidate)
    if (percent !== undefined) {
      windows.push({
        remainingPercent: percent,
        resetsAt: new Date(typeof detail.resetsAt === 'string' ? Date.parse(detail.resetsAt) : at + 3600_000).toISOString(),
        kind: 'window',
      })
    }
  }
  const list = Array.isArray(detail.windows) ? detail.windows : []
  for (const window of list) {
    const percent = percentOf(window?.remainingPercent)
    if (percent === undefined) continue
    windows.push({
      remainingPercent: percent,
      resetsAt: new Date(typeof window?.resetsAt === 'string' ? Date.parse(window.resetsAt) : at + 3600_000).toISOString(),
      kind: typeof window?.kind === 'string' ? window.kind : 'window',
      windowSeconds: Number.isFinite(window?.windowSeconds) ? Number(window.windowSeconds) : undefined,
    })
  }
  return windows
}

/** One probe turn: the shortest one that still discloses a quota reading. */
export const PROBE_PROMPT = 'ping'
export const PROBE_MAX_TOKENS = 16

export interface QuotaProber {
  reading: (address: string) => QuotaReading | undefined
  probe: (address: string, dial: () => Promise<{ ok: boolean; usage?: Record<string, any>; error?: any }>) => Promise<QuotaReading | undefined>
}

/**
 * Runs the quota probe that smart/usage/pace chains need to order their links.
 *
 * The reading is cached for the same duration a healthy model is, and a model
 * whose upstream discloses no window keeps an empty list: no evidence, not no
 * quota. `probe` is supplied by the caller so a chain can drive it through the
 * real dispatch (fingerprints, wire ids, transport guards all apply) and a test
 * can drive it against a stand-in.
 */
export function createQuotaProber(options: { cacheMs?: number; log?: (message: string) => void } = {}): QuotaProber {
  const cacheMs = options.cacheMs ?? CACHED_DURATION_MS
  const readings = new Map<string, QuotaReading>()
  return {
    reading: (address) => readings.get(address),
    async probe(address, dial) {
      const cached = readings.get(address)
      const age = cached === undefined ? Infinity : Date.now() - Date.parse(cached.checkedAt)
      if (cached !== undefined && Number.isFinite(age) && age >= 0 && age < cacheMs) return cached
      const answer = await dial()
      if (answer.ok !== true) return cached
      const windows = quotaReading(answer.usage)
      const reading: QuotaReading = {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        windows,
      }
      readings.set(address, reading)
      return reading
    },
  }
}
