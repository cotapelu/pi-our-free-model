/**
 * Build the usage panel's numbers.
 *
 * Every number the panel shows is derived **once**, here, from the same rows —
 * never re-derived downstream from two numbers that were rounded separately. That
 * is why the percentage rides with the totals rather than being recomputed by the
 * client, and why a rate over too few measurable calls is `null` instead of a
 * rounding error with a unit on it.
 *
 * Two accounting layers have to agree, and they answer different questions:
 * **physical** counts one request per provider call (a chain's link records its
 * own), **logical** counts one turn per user-visible turn (the chain records
 * itself). Both are kept because the row a user configuring a chain looks for is
 * the chain's own — physical-only accounting would show its links and be blind to
 * the thing they configured.
 *
 * Ported from dsh's `src/core/stats.js`.
 *
 * @module pi-extension/core/stats.js
 */

import { MIN_DECODE_MS } from '../gateway/store.js'
import { emptySavings, savingsPercent, describeSavingsTotal, type SavingsTotal } from '../token-saver/index.js'

export interface StatsRow {
  model: string
  name: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  calls: number
  failed: number
  turns: number
  failedTurns: number
  recoveredTurns: number
  tps: number | null
  avgTtftMs: number | null
}

export interface StatsSnapshot {
  requests: number
  requestFailures: number
  requestFailuresEstimated: boolean
  logicalEstimated: boolean
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: Array<{ day: string; total: number; models: Array<Record<string, any>> }>
  models: StatsRow[]
  samples: any[]
  savings: SavingsTotal & { percent: number; summary: string }
  grand: Record<string, number>
}

/** A row with nothing counted, so a model seen only in one layer still has a shape. */
interface PhysicalRow {
  model: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  calls: number
  failed: number
  ttftMs: number
  ttftSamples: number
  decodeMs: number
  decodeTokens: number
}

const emptyModel = (model: string): PhysicalRow => ({
  model,
  input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
  ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
})

/**
 * @param stats - the whole `stats.json` document
 * @param catalog - the merged catalog, for display names
 */
export function buildStats(stats: any, catalog: any[] = []): StatsSnapshot {
  const days = stats?.days ?? {}
  const series = Object.keys(days).sort().map(day => ({
    day,
    total: days[day]?.total ?? 0,
    models: Object.entries(days[day]?.models ?? {}).map(([model, value]) => ({ model, ...(value as any) })),
  }))

  const totals: Record<string, PhysicalRow> = {}
  for (const entry of series) {
    for (const row of entry.models) {
      const previous = totals[row.model] ?? emptyModel(row.model)
      totals[row.model] = {
        ...previous,
        input: previous.input + (row.input ?? 0),
        output: previous.output + (row.output ?? 0),
        reasoning: previous.reasoning + (row.reasoning ?? 0),
        calls: previous.calls + (row.calls ?? 0),
        failed: previous.failed + (row.failed ?? 0),
        ttftMs: previous.ttftMs + (row.ttftMs ?? 0),
        ttftSamples: previous.ttftSamples + (row.ttftSamples ?? 0),
        decodeMs: previous.decodeMs + (row.decodeMs ?? 0),
        decodeTokens: previous.decodeTokens + (row.decodeTokens ?? 0),
      }
    }
  }

  const logical = stats?.logical ?? {}
  const logicalModels = logical.models ?? {}
  const logicalReady = Number.isSafeInteger(logical.turns)
  const lifetimeModels = stats?.models ?? {}

  // The logical map is part of the row set, not just a lookup table: a combo
  // records its turn under the chain's own id and its physical calls under each
  // link's, so a chain that never appeared here would show its links in the panel
  // and be invisible itself.
  const modelIds = new Set([...Object.keys(totals), ...Object.keys(lifetimeModels), ...Object.keys(logicalModels)])
  const named: StatsRow[] = [...modelIds].map(model => {
    const row = totals[model] ?? emptyModel(model)
    const lifetime = lifetimeModels[model] ?? {}
    const physical = {
      ...row,
      input: Number.isSafeInteger(lifetime.input) ? lifetime.input : row.input,
      output: Number.isSafeInteger(lifetime.output) ? lifetime.output : row.output,
      reasoning: Number.isSafeInteger(lifetime.reasoning) ? lifetime.reasoning : row.reasoning,
      cacheRead: Number.isSafeInteger(lifetime.cacheRead) ? lifetime.cacheRead : row.cacheRead,
      calls: Number.isSafeInteger(lifetime.calls) ? lifetime.calls : row.calls,
      failed: Number.isSafeInteger(lifetime.failed) ? lifetime.failed : row.failed,
    }
    return {
      ...physical,
      turns: logicalModels[model]?.turns ?? (logicalReady ? 0 : row.calls),
      failedTurns: logicalModels[model]?.failed ?? (logicalReady ? 0 : row.failed),
      recoveredTurns: logicalModels[model]?.recovered ?? 0,
      name: catalog.find(entry => entry.id === model)?.name ?? model,
      // A rate over too few measurable calls is a rounding error with a unit on it.
      tps: row.decodeMs >= MIN_DECODE_MS ? Math.round(row.decodeTokens / (row.decodeMs / 1000)) : null,
      avgTtftMs: row.ttftSamples > 0 ? Math.round(row.ttftMs / row.ttftSamples) : null,
    }
  })

  const physicalFailed = named.reduce((sum, row) => sum + row.failed, 0)
  const turns = logicalReady ? logical.turns : named.reduce((sum, row) => sum + row.turns, 0)
  const failedTurns = Number.isSafeInteger(logical.failed)
    ? logical.failed
    : named.reduce((sum, row) => sum + row.failedTurns, 0)
  const recoveredTurns = Number.isSafeInteger(logical.recovered)
    ? logical.recovered
    : named.reduce((sum, row) => sum + row.recoveredTurns, 0)
  const hasLifetimeFailures = Number.isSafeInteger(stats?.failedRequests)
  const savings: SavingsTotal = { ...emptySavings(), ...(stats?.savings ?? {}) }

  return {
    requests: stats?.requests ?? 0,
    requestFailures: hasLifetimeFailures ? stats.failedRequests : physicalFailed,
    // A machine whose stats predate the lifetime counter falls back to summing the
    // rows, and says so rather than presenting an estimate as an exact count.
    requestFailuresEstimated: stats?.failedRequestsEstimated === true || !hasLifetimeFailures,
    logicalEstimated: logical.estimated === true,
    turns,
    failedTurns,
    recoveredTurns,
    days: series,
    models: named,
    samples: (stats?.samples ?? []).slice(-200),
    // What the token savers measured. The percentage is computed here, from the
    // same bytes the rows above counted.
    savings: { ...savings, percent: savingsPercent(savings), summary: describeSavingsTotal(savings) },
    grand: {
      input: named.reduce((sum, row) => sum + row.input, 0),
      output: named.reduce((sum, row) => sum + row.output, 0),
      reasoning: named.reduce((sum, row) => sum + row.reasoning, 0),
      calls: named.reduce((sum, row) => sum + row.calls, 0),
      failed: hasLifetimeFailures ? stats.failedRequests : physicalFailed,
      turns,
      failedTurns,
      recoveredTurns,
    },
  }
}
