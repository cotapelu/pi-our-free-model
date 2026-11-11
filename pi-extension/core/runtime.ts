/**
 * The store set and the membership rule the whole provider reads from.
 *
 * In DSH this file was the shared core of **two** products — the plugin and the
 * standalone console — and it was explicit that the core resolves no `DSH_HOME`
 * and discovers no host service: the entry point decides the path and hands it
 * in. The port keeps that shape, because `pi-extension/` has the same two
 * entries (`index.ts` for the pi extension, `server.ts` for the HTTP provider)
 * and a core that resolved its own data directory would let the two disagree.
 *
 * `createModelRuntime` is **not** ported here. Its body — catalog refresh
 * threads, availability probing, egress watching, the sealed-lane listing — is
 * already the composition root in `server.ts` and `catalog.ts`, and a second copy
 * of a refresh thread is two threads to keep correct. What lives here is what
 * that composition needs and does not yet have:
 *
 * - `createRuntimeStores` — the four JSON stores, opened with the same
 *   discipline, and the seeding rule that keeps an old install from silently
 *   gaining a newly-advertised model.
 * - `computeMembership` — the rule that decides which of the two routes a model
 *   belongs to, including the *egress-refused* fold that keeps a machine whose
 *   whole free lane is blocked from showing an empty picker.
 *
 * Ported from dsh's `src/core/runtime.js`.
 *
 * @module pi-extension/core/runtime.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, migrateStats, isModelHidden } from '../gateway/store.js'
import { ROUTE_MAIN, ROUTE_REGION } from '../adapter.js'
import { STATE } from '../gateway/probe.js'

/**
 * Open the runtime's stores under one directory.
 *
 * The directory is created `0700`: it holds a key ring and the aggregate key.
 * A path that is not absolute is refused rather than resolved against the cwd,
 * because a relative data dir would put the key ring wherever the process
 * happened to start.
 */
export function createRuntimeStores({ dataDir, logger = console }: { dataDir: string; logger?: any }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('dataDir must be an absolute path')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  // One options object, matching the store's own signature: a positional
  // `(file, initial, log)` call reads as a constructor that takes three.
  const open = (file: string, initial: any) => new JsonStore({
    file: path.join(dataDir, file),
    initial: structuredClone(initial),
    log: (message: string) => logger.warn?.(message),
  })
  // Seed the recommended combo only for a genuinely fresh install. Existing
  // settings files must not gain a newly-advertised model merely because a new
  // default was added to SETTINGS_INITIAL; user edits still win through
  // JsonStore's normal merge.
  const settingsInitial: any = structuredClone(SETTINGS_INITIAL)
  const settingsPath = path.join(dataDir, 'settings.json')
  if (fs.existsSync(settingsPath)) {
    settingsInitial.forward = { ...settingsInitial.forward }
    settingsInitial.hiddenModelIds = []
  }
  const settings = new JsonStore({
    file: settingsPath,
    initial: settingsInitial,
    log: (message: string) => logger.warn?.(message),
  })
  const stats = open('stats.json', STATS_INITIAL)
  const availability = open('availability.json', { version: 1, at: 0, egress: null, results: {} })
  const catalogStore = open('catalog.json', { version: 1, at: 0, entries: [] })
  // Migrating before the first read is the only ordering that works: a machine
  // that upgrades mid-run would otherwise serve rows from a shape that no longer
  // matches the reader.
  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)
  return {
    settings, stats, availability, catalogStore,
    dispose() {
      settings.dispose(); stats.dispose(); availability.dispose(); catalogStore.dispose()
    },
  }
}

/** Which route a model belongs to, and which models exist at all right now. */
export interface Membership {
  [ROUTE_MAIN]?: string[]
  [ROUTE_REGION]?: string[]
}

/**
 * Split the catalog into the two routes this provider publishes.
 *
 * The fold is the part that needs explaining. When *every* free-lane model comes
 * back region-blocked, the roster is not trimmed to the paid lanes — it is served
 * in full under the main route. A machine whose VPN is off otherwise shows an
 * empty picker, which reads as "this extension is broken" rather than "your egress
 * changed"; and a device that has genuinely lost access to a model would learn
 * that from the turn's own failure, which is where the information is actionable.
 */
export function computeMembership(catalog: any[], availabilitySnapshot: any, settings: any): Membership {
  const expose = settings?.exposeRegionModels !== false
  const verdictOf = (entry: any) => modelAvailability(entry.id, availabilitySnapshot, entry.channel === undefined || entry.channel === null || entry.channel === '').availability
  const probeable = catalog.filter((entry: any) => !entry.channel)
  const refusedAll = probeable.length > 0 && probeable.every((entry: any) => verdictOf(entry) === STATE.unavailable)
  const usable = refusedAll ? catalog : catalog.filter((entry: any) => verdictOf(entry) !== STATE.unavailable)
  const main: string[] = []
  const region: string[] = []
  for (const entry of usable) {
    if (isModelHidden(entry, settings)) continue
    const verdict = verdictOf(entry)
    if (verdict !== STATE.regionBlocked) main.push(entry.id)
    else if (expose) region.push(entry.id)
  }
  const membership: Membership = {}
  // A group with no models is dropped from the picker by the client, so an empty
  // key is omitted rather than sent as `[]`.
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}

/**
 * What the availability snapshot says about one model.
 *
 * A model with a channel is not on the free lane, so the egress's verdict does not
 * apply to it — the channel's own auth and capacity govern, and the snapshot has
 * nothing to say.
 */
export function modelAvailability(
  modelId: string,
  availabilitySnapshot: any,
  onFreeLane: boolean,
): { availability: string; at?: number } {
  // A paid or channeled model is not on the free lane, so the egress's
  // verdict does not apply: the channel's own auth and capacity govern.
  if (!onFreeLane) return { availability: STATE.unknown, at: undefined }
  const results = availabilitySnapshot?.results ?? {}
  const row = results[modelId]
  if (row === undefined || row === null) return { availability: STATE.unknown }
  return { availability: typeof row.availability === 'string' ? row.availability : STATE.unknown, at: row.at }
}
