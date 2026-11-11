/**
 * The gateway's durable state: settings, usage, and the JSON file both live in.
 *
 * One file the plugin owns, rather than a host settings service, for two
 * reasons that both showed up in operation: the settings seam has already changed
 * shape once between kernel lines, and history is high-cardinality telemetry that
 * does not belong in a configuration document anyway. A file behaves identically
 * everywhere.
 *
 * The three properties that matter:
 *
 * - **Writes are coalesced.** A scheduled flush never lands twice, and a flush
 *   that cannot write is *retried* by the next mutation rather than dropped —
 *   the alternative is a home that briefly failed losing the last changes.
 * - **A corrupt file is kept.** Without this, the next flush renames a fresh
 *   default over it and the user's settings are gone with nothing on disk to
 *   recover and nothing in the log to explain.
 * - **Restrict to the owner.** The gateway key is a bearer credential for this
 *   machine's free-lane quota, so the file that holds it is 0600.
 *
 * Ported from dsh's `src/store.js`.
 *
 * @module pi-extension/gateway/store.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { restrictPermissions } from '../open-external.js'

export const DATA_DIR_NAME = 'our-free-model'
export const STATS_VERSION = 3

/** `~/.our-free-model`, or `$OFM_DATA_DIR` when the caller relocates it. */
export function dataDir(): string {
  return process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.' + DATA_DIR_NAME)
}

/**
 * A creator-only mode; `icacls` on Windows, where chmod does not exist.
 *
 * Re-exported from `open-external.ts` rather than inlined here: the copy that
 * used to live in this file granted to the *bare* account name, which `icacls`
 * resolves against the account database *and* the computer account — and the
 * computer account wins on a case-only difference. `inheritance:r` in the same
 * call has already removed the inherited ACEs, so the file ends up with a DACL
 * nothing can satisfy and the writer's own `renameSync` fails EPERM (dsh issue
 * #738). One SID-first copy for every store in the package.
 */
export { restrictPermissions }

export interface StoreOptions<T extends Record<string, any>> {
  file: string
  initial: T
  log?: (message: string) => void
}

/**
 * A JSON file read whole and written back atomically, with a debounce.
 *
 * `edit` exists for read-modify-write on nested state: it hands a clone to the
 * callback and keeps whatever comes back, so a caller mutating a nested object
 * cannot leave a half-applied edit behind when it throws.
 */
export class JsonStore<T extends Record<string, any>> {
  private file: string
  private value: T
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private log: ((message: string) => void) | undefined
  private writeFailed = false

  constructor(options: StoreOptions<T>) {
    this.file = options.file
    this.value = options.initial
    this.log = options.log
    this.load()
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = { ...this.value, ...parsed }
      }
    } catch {
      try {
        if (fs.existsSync(this.file)) {
          const backup = `${this.file}.corrupt-${Date.now()}`
          fs.copyFileSync(this.file, backup)
          restrictPermissions(backup)
        }
      } catch {
        /* a home we cannot write to is not this file's problem */
      }
    }
  }

  get(): T {
    return this.value
  }

  update(patch: Partial<T>): T {
    if (this.disposed) return this.value
    this.value = { ...this.value, ...patch }
    this.schedule()
    return this.value
  }

  edit(mutate: (state: T) => T | void): T {
    if (this.disposed) return this.value
    const next = mutate(structuredClone(this.value))
    if (next !== undefined) this.value = next
    this.schedule()
    return this.value
  }

  private schedule(delayMs = 800): void {
    if (this.disposed) return
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delayMs)
    this.timer.unref?.()
  }

  flush(): void {
    if (!this.dirty || this.disposed) return
    this.dirty = false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(this.value, undefined, 2), { mode: 0o600 })
      restrictPermissions(temp)
      fs.renameSync(temp, this.file)
      this.writeFailed = false
    } catch (error) {
      // Re-arm: the flag was cleared before the attempt, so a final flush would
      // otherwise skip a write that never landed and drop the last changes.
      this.dirty = true
      if (!this.writeFailed) {
        this.writeFailed = true
        this.log?.(`our-free-model: could not persist ${path.basename(this.file)} (${(error as Error)?.message ?? error}); changes are kept in memory only`)
      }
    }
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flush()
    this.disposed = true
    this.dirty = false
  }
}

export const MIN_DECODE_MS = 250
export const MAX_CREDIBLE_TPS = 250

/** `YYYY-MM-DD` in the machine's own calendar, which is what a heatmap needs. */
export function dayKey(at = Date.now()): string {
  const date = new Date(at)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Two bounds on what counts as a measurable decode window.
 *
 * A window too short to time at all, and one so fast the frames must have been
 * coalesced rather than decoded, are both *no* measurement — they are dropped
 * instead of averaged in, because one bogus sample drags a mean for weeks.
 */
export function decodeWindow(decodeMs: number, tokens: number, ok: boolean): { measurable: boolean; decodeMs: number; tps: number | null } {
  const ms = Number.isFinite(decodeMs) && decodeMs > 0 ? decodeMs : 0
  const count = Number.isFinite(tokens) ? tokens : 0
  if (ok !== true || count <= 0 || ms < MIN_DECODE_MS) return { measurable: false, decodeMs: 0, tps: null }
  const tps = (count / ms) * 1000
  if (!Number.isFinite(tps) || tps > MAX_CREDIBLE_TPS) return { measurable: false, decodeMs: 0, tps: null }
  return { measurable: true, decodeMs: ms, tps: Math.round(tps) }
}

/**
 * Fold one call's token-saver report into the lifetime accumulator.
 *
 * Counted from the same rows the usage charts are, so the first question anyone
 * asks of a savings figure — "out of how many calls?" — has an answer beside it.
 */
export function accumulateSavings(total: any, savings: any) {
  const base = total ?? { bytesBefore: 0, bytesAfter: 0, saved: 0, blocks: 0, calls: 0, promptCalls: 0 }
  const saved = Number(savings?.saved) || 0
  return {
    bytesBefore: (Number(base.bytesBefore) || 0) + (Number(savings?.bytesBefore) || 0),
    bytesAfter: (Number(base.bytesAfter) || 0) + (Number(savings?.bytesAfter) || 0),
    saved: (Number(base.saved) || 0) + saved,
    blocks: (Number(base.blocks) || 0) + (Number(savings?.blocks) || 0),
    calls: (Number(base.calls) || 0) + 1,
    promptCalls: (Number(base.promptCalls) || 0) + (Array.isArray(savings?.prompt) && savings.prompt.length > 0 ? 1 : 0),
  }
}

export interface UsageRecord {
  at: number
  model: string
  ok: boolean
  input: number
  output: number
  reasoning: number
  cacheRead: number
  decodeTokens: number
  decodeMs: number
  ttftMs?: number
  effort?: string
  origin?: string
  truncated?: boolean
  noUsage?: boolean
  savings?: any
  /** The adapter's turn-level bookkeeping, carried onto the persisted row. */
  elapsedMs?: number
  recoveryId?: string
  attempt?: number
  recoveryAttempt?: boolean
  aborted?: boolean
  warnings?: string[]
}

/** Accumulate one completed call into the day/model buckets and a bounded ring. */
export function recordUsage(stats: JsonStore<any>, record: UsageRecord): void {
  stats.edit((state) => {
    const day = dayKey(record.at)
    const days = { ...(state.days ?? {}) }
    const bucket = days[day] ?? { total: 0, models: {} }
    const perModel = { ...(bucket.models ?? {}) }
    const previous = perModel[record.model] ?? {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
      ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
    }
    const measured = decodeWindow(record.decodeMs, record.decodeTokens, record.ok)
    const ttftMs = Number.isFinite(record.ttftMs) && record.ok === true ? record.ttftMs : undefined
    perModel[record.model] = {
      input: previous.input + record.input,
      output: previous.output + record.output,
      reasoning: previous.reasoning + record.reasoning,
      cacheRead: previous.cacheRead + record.cacheRead,
      calls: previous.calls + 1,
      failed: previous.failed + (record.ok ? 0 : 1),
      ttftMs: previous.ttftMs + (ttftMs ?? 0),
      ttftSamples: previous.ttftSamples + (ttftMs === undefined ? 0 : 1),
      decodeMs: previous.decodeMs + measured.decodeMs,
      decodeTokens: previous.decodeTokens + (measured.measurable ? record.decodeTokens : 0),
    }
    days[day] = { ...bucket, models: perModel, total: bucket.total + record.input + record.output }
    const models = { ...(state.models ?? {}) }
    const lifetime = models[record.model] ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0 }
    models[record.model] = {
      input: (lifetime.input ?? 0) + record.input,
      output: (lifetime.output ?? 0) + record.output,
      reasoning: (lifetime.reasoning ?? 0) + record.reasoning,
      cacheRead: (lifetime.cacheRead ?? 0) + record.cacheRead,
      calls: (lifetime.calls ?? 0) + 1,
      failed: (lifetime.failed ?? 0) + (record.ok === true ? 0 : 1),
    }
    // A call the gateway cut mid-stream, and a call that reached its finish token
    // but never sent a usage frame, both land as 0/0. With no marker on the row
    // they are indistinguishable from a genuinely empty completion, and there is
    // then nothing to audit a "that turn vanished" report against.
    const samples = [...(state.samples ?? []), {
      at: record.at, model: record.model, ok: record.ok === true,
      input: record.input, output: record.output,
      ttftMs: ttftMs === undefined ? null : Math.round(ttftMs),
      tps: measured.tps,
      decodeMs: measured.decodeMs,
      decodeTokens: measured.measurable ? record.decodeTokens : 0,
      effort: record.effort ?? '',
      origin: record.origin ?? 'chat',
      ...record.truncated === true ? { truncated: true } : {},
      ...record.noUsage === true ? { noUsage: true } : {},
      ...(Number.isSafeInteger(record.savings?.saved) && record.savings.saved > 0 ? { saved: record.savings.saved } : {}),
    }].slice(-400)
    return {
      ...state,
      days,
      models,
      requests: (state.requests ?? 0) + 1,
      failedRequests: (state.failedRequests ?? 0) + (record.ok === true ? 0 : 1),
      samples,
      savings: accumulateSavings(state.savings, record.savings),
    }
  })
}

/** Trim day buckets older than `keepDays`, keeping the payload chart-sized. */
export function pruneDays(state: any, keepDays = 120): any {
  const keys = Object.keys(state.days ?? {}).sort()
  if (keys.length <= keepDays) return state
  const drop = new Set(keys.slice(0, keys.length - keepDays))
  const days: Record<string, any> = {}
  for (const key of keys) if (!drop.has(key)) days[key] = state.days[key]
  return { ...state, days }
}

export const STATS_INITIAL = Object.freeze({
  version: STATS_VERSION,
  days: {},
  models: {},
  requests: 0,
  failedRequests: 0,
  samples: [],
  /** The **logical** turn layer: what the caller sees, not what the provider
   *  billed. Present from the first write so a store created before the field
   *  existed migrates into the same shape rather than reading `undefined`. */
  logical: { turns: 0, failed: 0, recovered: 0, models: {} },
  savings: { bytesBefore: 0, bytesAfter: 0, saved: 0, blocks: 0, calls: 0, promptCalls: 0 },
})

/** Extract output token count from a usage record. */
export function windowTokens(usage: any, sawReasoning: boolean): number {
  if (!usage) return 0
  const output = Number(usage.outputTokens ?? usage.output ?? 0)
  if (sawReasoning) {
    const reasoning = Number(usage.reasoningTokens ?? usage.reasoning ?? 0)
    return Math.max(0, output - reasoning)
  }
  return output
}

/**
 * What a fresh machine starts from.
 *
 * `enabled: true` is the master switch; every other default is *closed* — the
 * forward listener off, the LAN relay off, the outlet off — because each of those
 * is a door, and doors stay shut until someone asks for one.
 */
export const SETTINGS_INITIAL = Object.freeze({
  version: 1,
  enabled: true,
  /** Show region-limited models in the picker as soon as they answer. */
  exposeRegionModels: true,
  /** Advertisement only: retain catalog entries and historical model resolution. */
  hiddenModelIds: [] as string[],
  hideFreeModels: false,
  hideEacModels: false,
  probeIntervalMinutes: 15,
  forward: { enabled: false, host: '127.0.0.1', port: 18899, lan: { enabled: false, port: 0 } },
  egress: { enabled: false, mode: 'subscription', url: '', mihomoPath: '' },
  chanGateway: { relay: { enabled: false, host: '127.0.0.1', port: 18326, key: '' } },
  defaultMaxTokens: 32768,
  streamRecovery: true,
})

/** One hidden-model id: a nonempty string inside the cap. */
const validHiddenModelId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= 300

/** The visibility section as it may be stored. */
export function publicModelVisibility(settings: any): { hiddenModelIds: string[]; hideFreeModels: boolean; hideEacModels: boolean } {
  const stored: unknown[] = Array.isArray(settings?.hiddenModelIds) ? settings.hiddenModelIds : []
  return {
    hiddenModelIds: [...new Set(stored.filter(validHiddenModelId))].slice(0, 1000),
    hideFreeModels: settings?.hideFreeModels === true,
    hideEacModels: settings?.hideEacModels === true,
  }
}

/**
 * Validate one visibility patch, whole, before any of it is written.
 *
 * The rejection is a `TypeError` with a `statusCode`, which is what the route
 * layer turns into a 400: a half-applied visibility patch would leave the picker
 * hiding a model the user asked to show, with nothing on disk to say why.
 */
export function validateModelVisibility(patch: any): Record<string, any> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new TypeError('settings must be a JSON object'), { statusCode: 400 })
  }
  const result: Record<string, any> = {}
  for (const key of ['hideFreeModels', 'hideEacModels', 'hiddenModelIds']) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (key === 'hiddenModelIds'
      ? !Array.isArray(value) || value.length > 1000 || value.some((id: unknown) => !validHiddenModelId(id))
      : typeof value !== 'boolean') {
      throw Object.assign(new TypeError(`${key} must be ${key === 'hiddenModelIds'
        ? 'an array of at most 1000 nonempty model ids (up to 300 characters each)'
        : 'a boolean'}`), { statusCode: 400 })
    }
    result[key] = Array.isArray(value) ? [...new Set(value)] : value
  }
  return result
}

/**
 * Is this row hidden from the picker right now?
 *
 * An id list hides one model; `hideFreeModels` hides the *free* lanes as a class,
 * which is why a chain whose every link is a free lane counts as free — the user
 * hiding the free lanes asked about the models, not about the chain's label.
 */
export function isModelHidden(entry: any, settings: any): boolean {
  return (Array.isArray(settings?.hiddenModelIds) && settings.hiddenModelIds.includes(entry.id))
    || (settings?.hideFreeModels === true && (!entry.channel || entry.channel === 'anonymous' || entry.channel === 'kilo'
      || (entry.channel === 'combo' && Array.isArray(entry.lanes) && entry.lanes.length > 0 && entry.lanes.every((lane: string) => lane === 'free'))))
    || (settings?.hideEacModels === true && entry.channel === 'eac')
}

/**
 * One **logical** turn: what the caller sees, not what the provider billed.
 *
 * A chain records one turn for itself and its links record their own physical
 * calls, so without this the panel shows a chain's links and is blind to the
 * thing the user actually configured.
 */
export function recordTurn(stats: JsonStore<any>, record: { model: string; ok?: boolean; recovered?: boolean }): void {
  stats.edit((state: any) => {
    const previous = state.logical ?? {}
    const models = { ...(previous.models ?? {}) }
    const row = models[record.model] ?? { turns: 0, failed: 0, recovered: 0 }
    const failed = record.ok === true ? 0 : 1
    const recovered = record.recovered === true ? 1 : 0
    models[record.model] = {
      turns: row.turns + 1,
      failed: row.failed + failed,
      recovered: row.recovered + recovered,
    }
    return {
      ...state,
      logical: {
        ...previous,
        turns: (previous.turns ?? 0) + 1,
        failed: (previous.failed ?? 0) + failed,
        recovered: (previous.recovered ?? 0) + recovered,
        models,
      },
    }
  })
}

/**
 * Bring an older stats document up to the current shape.
 *
 * Every rewrite resets a rate that was wrong before it: a rate computed over a
 * window whose bytes were never counted is a number with no meaning, and keeping
 * it would show a plausible `tok/s` that measures nothing. Called before the
 * store is read, so a machine that upgrades mid-run keeps its history with the
 * broken fields zeroed rather than carried forward.
 */
export function migrateStats(value: any): any {
  if (value?.version === STATS_VERSION) return value
  const version = Number.isSafeInteger(value?.version) ? value.version : 0
  const resetSpeedTotals = version < 2
  const days: Record<string, any> = {}
  for (const [day, bucket] of Object.entries(value?.days ?? {})) {
    const models: Record<string, any> = {}
    for (const [model, row] of Object.entries((bucket as any)?.models ?? {})) {
      models[model] = resetSpeedTotals
        ? { ...(row as object), decodeMs: 0, decodeTokens: 0, ttftMs: 0, ttftSamples: 0 }
        : { ...(row as object) }
    }
    days[day] = { ...(bucket as object), models }
  }
  const logicalModels: Record<string, any> = {}
  const modelFailures: Record<string, any> = {}
  let logicalTurns = 0
  let logicalFailed = 0
  let failedRequests = 0
  for (const row of Object.values(value?.models ?? {}) as any[]) {
    const failed = Number.isSafeInteger(row?.failed) ? row.failed : 0
    modelFailures[row.model] = failed
    failedRequests += failed
  }
  for (const [model, row] of Object.entries(value?.logical?.models ?? {}) as any[]) {
    const turns = Number.isSafeInteger(row?.turns) ? row.turns : 0
    const failed = Number.isSafeInteger(row?.failed) ? row.failed : 0
    const recovered = Number.isSafeInteger(row?.recovered) ? row.recovered : 0
    logicalModels[model] = { turns, failed, recovered }
    logicalTurns += turns
    logicalFailed += failed
  }
  return {
    version: STATS_VERSION,
    days,
    models: modelFailures,
    requests: Number.isSafeInteger(value?.requests) ? value.requests : 0,
    failedRequests,
    // The per-sample half of the same reset: a v1 store's samples carry the
    // poisoned numbers too (one published 63 000 tok/s out of a 1 ms window),
    // and a sample that survives with its tps intact re-teaches the dashboard
    // the lie the migration just cleared.
    samples: Array.isArray(value?.samples)
      ? value.samples.map((sample: any) => resetSpeedTotals
        ? {
            ...sample,
            tps: null,
            decodeMs: 0,
            decodeTokens: 0,
            ttftMs: sample.ok === true && Number.isFinite(sample.ttftMs) ? sample.ttftMs : null,
          }
        : sample)
      : [],
    logical: { turns: logicalTurns, failed: logicalFailed, recovered: 0, models: logicalModels },
  }
}
