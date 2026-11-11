/**
 * What the token saver last measured, per lane, for `/ofm saver stats`.
 *
 * Process-local on purpose: it is a reading of the most recent request, not a
 * telemetry store. The byte counts describe the payload that actually shipped,
 * so they answer "is the saver doing anything right now" without any of the
 * machinery a usage dashboard would need. One slot per provider, overwritten on
 * each turn — a stale reading is not a wrong one, it is an old one.
 *
 * @module pi-extension/saver-stats.js
 */

import type { RtkStats } from './token-saver/index.js'
import { PROVIDER_ID as OPENECODE_ID } from './opencode.js'
import { PROVIDER_ID as KILO_ID } from './kilo.js'

/** What one lane last reported. */
export interface LaneSavings {
  at: number
  stats: RtkStats
}

/** `provider id -> last reading`. */
const readings = new Map<string, LaneSavings>()

/** Replace the reading for one lane. Called from the lane's `onPayload`. */
export function recordSavings(provider: string, stats: RtkStats) {
  readings.set(provider, { at: Date.now(), stats })
}

/** The reading for one lane, or undefined when it has not sent a request yet. */
export function lastSavings(provider: string): LaneSavings | undefined {
  return readings.get(provider)
}

/** Every reading, in a stable order (`/ofm saver stats` walks this). */
export function allSavings(): Array<{ provider: string; reading: LaneSavings }> {
  const out = []
  for (const provider of [KILO_ID, OPENECODE_ID]) {
    const reading = readings.get(provider)
    if (reading !== undefined) out.push({ provider, reading })
  }
  return out
}
