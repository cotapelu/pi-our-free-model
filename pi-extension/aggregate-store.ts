/**
 * The aggregate lane's settings, as one 0600 JSON file the plugin owns.
 *
 * Keys live here and nowhere else. The file is the same `JsonStore` the gateway
 * uses for its own key: coalesced writes, temp+rename at 0600, and a corrupt
 * file retained rather than renamed over — a home that briefly fails a write
 * must not lose the user's 76-provider configuration on the next flush.
 *
 * The shape is the plugin's own `aggregate` section (see `aggregate.ts`):
 *
 *   { enabled: boolean,
 *     providers: { [providerId]: { enabled, apiKey, baseUrl?,
 *                                  models?: string[], discovered?: string[], addedAt? } } }
 *
 * `apiKey` is the only field that must never leave this file: every surface
 * that reports it shows `hasKey` and a short suffix, never the string.
 *
 * @module pi-extension/aggregate-store.js
 */
import path from 'node:path'
import os from 'node:os'
import { JsonStore } from './gateway/store.js'

/**
 * Where the file lives: the same data dir every other state file uses.
 *
 * Derived rather than configured, because a lane whose key file depends on a
 * second environment variable is a lane nobody can turn on by accident — the
 * user sets `OFM_DATA_DIR` once and every file follows it. `OFM_AGGREGATE_FILE`
 * still overrides for a test or an embedding caller.
 */
function aggregateFile(): string {
  if (process.env.OFM_AGGREGATE_FILE) return process.env.OFM_AGGREGATE_FILE
  const dir = process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.our-free-model')
  return path.join(dir, 'aggregate.json')
}

let store: JsonStore<any> | undefined

/** The one store for this process, created on first use. */
function settingsStore(): JsonStore<any> {
  if (store !== undefined) return store
  store = new JsonStore<any>({ file: aggregateFile(), initial: {} })
  return store
}

/** The user's aggregate config, or `{}` when none is set. */
export function aggregateSettings(): any {
  return settingsStore().get() ?? {}
}

/** Point the store at a file, for tests and for an embedding caller. */
export function setAggregateFile(file: string): void {
  store = undefined
  process.env.OFM_AGGREGATE_FILE = file
}

/**
 * Persist a patch into the config. Returns the merged value.
 *
 * The write lands *immediately*, not on the store's coalesce timer: a key is
 * saved by a user action — a settings-page save, or a `/ofm aggregate add-key`
 * CLI command that exits the moment it answers — and `JsonStore` unrefs its
 * flush timer so a short-lived process would otherwise drop the write on the
 * floor with nothing on disk to recover. Several providers in one interaction
 * is a settings page, not a hot loop, so the coalesce bought nothing and cost
 * the file.
 */
export function writeAggregateSettings(patch: Record<string, any>): any {
  const merged = settingsStore().update(patch)
  flushAggregateSettings()
  return merged
}

/**
 * Land whatever is pending, now.
 *
 * Exported because the pi extension's own teardown and a test's teardown both
 * need one: neither should have to know the store coalesces.
 */
export function flushAggregateSettings(): void {
  settingsStore().flush()
}

/** One provider's setting, or `null` when the config names none. */
export function providerSetting(providerId: string): any {
  const providers = aggregateSettings()?.providers
  if (providers === null || typeof providers !== 'object') return null
  const setting = (providers as Record<string, any>)[providerId]
  return setting !== null && typeof setting === 'object' ? setting : null
}

/**
 * What a surface may report about one credential: whether one is present and a
 * short suffix, never the string.
 *
 * A provider that echoes its key back (a 401 body routinely does) still cannot
 * put it in front of the user through this shape, so the settings API and the
 * logs both read it from here.
 */
export function keyFingerprint(apiKey: unknown): { hasKey: boolean; suffix: string } {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (key === '') return { hasKey: false, suffix: '' }
  return { hasKey: true, suffix: key.length <= 4 ? '…' : `…${key.slice(-4)}` }
}
