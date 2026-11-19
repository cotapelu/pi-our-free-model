/**
 * Per-IP analytics for the self-hosted gateway.
 *
 * **Numbers only, and no reversible identifiers.** An IP is stored as a salted
 * hash, stable within a secret rotation and non-reversible from a leaked stats
 * file — the dashboard's job is to show load, not to identify a caller. Rows are
 * pruned (30 days, 500 addresses, per-address hours trimmed to 3 days) and written
 * atomically to a file the process may lose.
 *
 * Persistence is deliberately *loseable*: an unreadable file is a fresh start, not
 * a crash. The gateway is an operational tool, and refusing to boot because a stats
 * file was truncated would take a working lane down for a dashboard.
 *
 * Ported from dsh's `worker/gateway-node.mjs` (the `analytics` singleton).
 *
 * @module pi-extension/worker/analytics.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const KEEP_DAYS = 30
const KEEP_IPS = 500
/** An address's own hourly rows are trimmed to three days: older detail is noise. */
const KEEP_HOUR_DAYS = 3

export interface IpRow {
  first: number
  last: number
  req: number
  in: number
  out: number
  rej: number
  conc: number
  concMax: number
  models: Record<string, number>
  hours: Record<string, number>
}

interface AnalyticsState {
  ips: Record<string, IpRow>
  hourly: Record<string, number>
  days: Record<string, { req: number; in: number; out: number }>
}

const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10)
const hourKey = (ts: number): string => new Date(ts).toISOString().slice(0, 13)

const freshRow = (ts: number): IpRow => ({
  first: ts, last: ts, req: 0, in: 0, out: 0, rej: 0, conc: 0, concMax: 0, models: {}, hours: {},
})

export interface AnalyticsRecord {
  hash: string
  chat: boolean
  status: number
  tokensIn?: number
  tokensOut?: number
  model: string | null
  rejected: boolean
}

export interface AnalyticsApi {
  state: AnalyticsState
  load(file: string): void
  ipHash(ip: string, salt: string): string
  record(record: AnalyticsRecord): void
  concurrency(hash: string, current?: number, peak?: number): void
  flush(file: string): void
  snapshot(): Record<string, any>
  reset(): void
}

/** The process-wide analytics singleton, as the self-hosted host runs it. */
export function createAnalytics(log: (message: string) => void = () => {}): AnalyticsApi {
  const api: AnalyticsApi = {
    state: { ips: {}, hourly: {}, days: {} },

    load(file: string): void {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        // A file with the three top-level shapes is ours; anything else is either
        // from another version or truncated, and starting fresh is the better of
        // the two outcomes.
        if (parsed !== null && typeof parsed === 'object' && parsed.ips && parsed.hourly && parsed.days) {
          api.state = parsed
        }
      } catch { /* a fresh start, not a crash */ }
      prune()
    },

    /**
     * A salted hash of one address.
     *
     * The salt defaults to something derived from the accepted secrets, so it
     * rotates with a credential rotation rather than staying constant across one.
     */
    ipHash(ip: string, salt: string): string {
      return crypto.createHash('sha256').update(salt + ip, 'utf8').digest('hex').slice(0, 12)
    },

    record({ hash, status, tokensIn, tokensOut, model, rejected }: AnalyticsRecord): void {
      const now = Date.now()
      const row = api.state.ips[hash] ?? (api.state.ips[hash] = freshRow(now))
      row.last = now
      row.req += 1
      if (rejected === true) row.rej += 1
      row.in += tokensIn ?? 0
      row.out += tokensOut ?? 0
      const hk = hourKey(now)
      row.hours[hk] = (row.hours[hk] ?? 0) + 1
      if (model !== null && model !== undefined) row.models[model] = (row.models[model] ?? 0) + 1
      api.state.hourly[hk] = (api.state.hourly[hk] ?? 0) + 1
      const dk = dayKey(now)
      const day = api.state.days[dk] ?? (api.state.days[dk] = { req: 0, in: 0, out: 0 })
      day.req += 1
      day.in += tokensIn ?? 0
      day.out += tokensOut ?? 0
    },

    concurrency(hash: string, current?: number, peak?: number): void {
      const now = Date.now()
      const row = api.state.ips[hash] ?? (api.state.ips[hash] = freshRow(now))
      if (current !== undefined) row.conc = current
      if (peak !== undefined && peak > (row.concMax ?? 0)) row.concMax = peak
    },

    flush(file: string): void {
      try {
        // `STATS_PATH` may name a directory that does not exist yet; without this
        // every flush would fail silently and the operator would lose a day of
        // analytics to a path typo.
        fs.mkdirSync(path.dirname(file), { recursive: true })
        // Temp file plus rename: a crash mid-write leaves the previous copy
        // intact rather than a truncated one the next boot would reject.
        const temp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify(api.state), { mode: 0o600 })
        fs.renameSync(temp, file)
      } catch (error) {
        log(`eac gateway: stats flush failed: ${String((error as Error)?.message ?? error).slice(0, 100)}`)
      }
    },

    snapshot(): Record<string, any> {
      const now = Date.now()
      const hourNow = hourKey(now)
      const hourAgo = new Date(now - HOUR_MS).toISOString().slice(0, 13)
      const dayNow = dayKey(now)
      const ips = Object.entries(api.state.ips).map(([hash, row]) => ({
        hash,
        req: row.req,
        today: row.hours[hourNow] ?? 0,
        in: row.in,
        out: row.out,
        rej: row.rej,
        conc: row.conc ?? 0,
        concMax: row.concMax ?? 0,
        freq1h: Object.entries(row.hours ?? {}).filter(([h]) => h >= hourAgo).reduce((sum, [, n]) => sum + n, 0),
        models: row.models ?? {},
        first: row.first,
        last: row.last,
      })).sort((a, b) => b.req - a.req)
      const hourly = Object.entries(api.state.hourly).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-168)
      const days = Object.entries(api.state.days).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-30)
      const models: Record<string, number> = {}
      for (const row of Object.values(api.state.ips)) {
        for (const [model, count] of Object.entries(row.models ?? {})) models[model] = (models[model] ?? 0) + count
      }
      return {
        generatedAt: now,
        day: dayNow,
        totals: {
          ips: ips.length,
          req: ips.reduce((sum, row) => sum + row.req, 0),
          in: ips.reduce((sum, row) => sum + row.in, 0),
          out: ips.reduce((sum, row) => sum + row.out, 0),
        },
        ips,
        hourly,
        days,
        models,
      }
    },

    /** Test seam: the analytics is a process-wide singleton, so a suite resets it. */
    reset(): void {
      api.state = { ips: {}, hourly: {}, days: {} }
    },
  }

  function prune(): void {
    const cutoffHour = hourKey(Date.now() - KEEP_DAYS * DAY_MS)
    for (const day of Object.keys(api.state.days)) {
      if (day < cutoffHour.slice(0, 10)) delete api.state.days[day]
    }
    for (const hour of Object.keys(api.state.hourly)) {
      if (hour < cutoffHour) delete api.state.hourly[hour]
    }
    // The least-recently-active rows go first: a cap that evicted by insertion
    // order would punish a busy address that started early.
    const rows = Object.entries(api.state.ips)
    if (rows.length > KEEP_IPS) {
      for (const [hash, row] of rows.sort((a, b) => a[1].last - b[1].last).slice(0, rows.length - KEEP_IPS)) {
        delete api.state.ips[hash]
      }
    }
    const hourCutoff = hourKey(Date.now() - KEEP_HOUR_DAYS * DAY_MS)
    for (const row of Object.values(api.state.ips)) {
      for (const hour of Object.keys(row.hours ?? {})) {
        if (hour < hourCutoff) delete row.hours[hour]
      }
    }
  }

  return api
}
