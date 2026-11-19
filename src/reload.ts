/**
 * Self hot-reload: replace the running extension with the code now on disk.
 *
 * The correct sequence, mirrored step for step from the kernel's own
 * `partialReload` and from DSH's `src/reload.js`:
 *
 * 1. snapshot the fibers of the current runtime and their configs;
 * 2. back the package's entries out of Node's ESM loadCache (via
 *    `Map.prototype` methods — Node 24's LoadCache subclass only clears a type
 *    slot on `.delete`) and out of the CJS `require.cache`;
 * 3. re-import the entry file through the loader so the new sources evaluate;
 * 4. dispose the old fibers, re-register the replacement under the same config,
 *    and re-attach the loader entry so config writes and volatile updates keep
 *    landing on the live fiber;
 * 5. on any failure, restore the caches and the old registration — the swap
 *    reports whether the previous runtime could be restored. A restoration
 *    failure remains an explicit failure rather than an availability promise.
 *
 * The reload runs outside the fiber being disposed, so the disposal of the
 * caller's own effects cannot cancel the swap mid-way.
 *
 * Ported from dsh's `src/reload.js`.
 *
 * @module pi-extension/reload.js
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

let inFlight: Promise<any> | null = null

/** Whether a reload is currently running; guards against overlapping swaps. */
export function isReloading(): boolean {
  return inFlight !== null
}

/** Directory of the installed package, as a `file://` URL with a trailing slash. */
export function packageUrlOf(entryModuleUrl: string): string {
  return new URL('../', entryModuleUrl).href
}

/** Entry file (`index.js`) of the package, as an absolute `file://` URL. */
export function entryUrlOf(entryModuleUrl: string): string {
  return new URL('../index.js', entryModuleUrl).href
}

/**
 * Every loadCache key that lives inside the package. Key comparison tolerates
 * case and percent-encoding drift between Node's resolver and `new URL`.
 */
export function packageCacheKeys(loadCache: any, packageUrl: string): string[] {
  const base = decodeURIComponent(packageUrl).replace(/\/+$/, '').toLowerCase() + '/'
  const keys: string[] = []
  for (const key of loadCache.keys()) {
    if (typeof key !== 'string') continue
    let normalized: string
    try { normalized = decodeURIComponent(key).toLowerCase() } catch { normalized = key.toLowerCase() }
    if (normalized.startsWith(base)) keys.push(key)
  }
  return keys
}

/**
 * A host is considered reload-capable only when it exposes entries for this
 * package in the cache that `purgeCaches` can safely back up and restore.
 *
 * Guessing via a query-string import bypasses some hosts' module resolvers, so
 * the answer is read off the real cache rather than inferred.
 */
export function canSafelyHotReload(loader: any, packageUrl: string = packageUrlOf(import.meta.url)): boolean {
  if (typeof loader?.import !== 'function' || typeof loader?.unwrapExports !== 'function') return false
  const cache = loader?.internal?.loadCache
  return cache !== null && cache !== undefined && typeof cache.keys === 'function'
    && typeof cache.get === 'function' && typeof cache.delete === 'function'
    && typeof cache.set === 'function'
    && packageCacheKeys(cache, packageUrl).length > 0
}

/**
 * Back up and remove the package's modules from both module caches.
 *
 * The loadCache is accessed duck-typed on purpose: Node 24.12+ replaced the
 * Map subclass with its own structure, so `instanceof Map` is false on newer
 * runtimes even though `keys/get/delete` still behave like a map. Where the
 * cache really is a Map, `Map.prototype` methods are used directly (Node 24's
 * original LoadCache.delete only cleared a type slot); otherwise the object's
 * own methods are used.
 *
 * @returns {{esm: Map<string, unknown>, cjs: Map<string, object>}}
 */
export function purgeCaches(internal: any, packageUrl: string): { esm: Map<string, unknown>; cjs: Map<string, object> } {
  const backup = { esm: new Map<string, unknown>(), cjs: new Map<string, any>() }
  const cache = internal?.loadCache
  if (cache !== null && cache !== undefined && typeof cache.keys === 'function'
    && typeof cache.get === 'function' && typeof cache.delete === 'function') {
    const read = (key: string): unknown => {
      try { return Map.prototype.get.call(cache, key) } catch { try { return cache.get(key) } catch { return undefined } }
    }
    const drop = (key: string): void => {
      try { Map.prototype.delete.call(cache, key); return } catch { /* not a real Map — fall through */ }
      try { cache.delete(key) } catch { /* best effort */ }
    }
    for (const key of packageCacheKeys(cache, packageUrl)) {
      backup.esm.set(key, read(key))
      drop(key)
    }
  }
  const localRequire = createRequire(import.meta.url)
  for (const key of backup.esm.keys()) {
    try {
      const filePath = fileURLToPath(key)
      if (localRequire.cache[filePath] !== undefined) {
        backup.cjs.set(filePath, localRequire.cache[filePath])
        delete localRequire.cache[filePath]
      }
    } catch {
      // non-file: URL — nothing to purge on the CJS side
    }
  }
  return backup
}

/** Put a purge's backup back (rollback path). */
export function restoreCaches(internal: any, backup: { esm: Map<string, unknown>; cjs: Map<string, any> }): void {
  const cache = internal?.loadCache
  for (const [key, job] of backup.esm) {
    try { Map.prototype.set.call(cache, key, job) } catch { try { cache.set(key, job) } catch { /* best effort */ } }
  }
  const localRequire = createRequire(import.meta.url)
  for (const [filePath, module] of backup.cjs) localRequire.cache[filePath] = module
}

export interface ReloadOptions {
  logger?: any
  packageUrl?: string
  entryUrl?: string
  expectedVersion?: string
}

/**
 * Watch the package directory and hot-reload on any source change.
 *
 * Off by default; a production install does not rewrite its own files, and the
 * settings page exposes an explicit reload button. Meant for development and
 * for demonstrating live edits.
 *
 * @returns stop function
 */
export function watchPackage(packageDir: string, { onChange, logger = console, debounceMs = 600 }: {
  onChange?: () => void
  logger?: any
  debounceMs?: number
} = {}): () => void {
  let timer: NodeJS.Timeout | undefined
  let paused = false
  let watcher: fs.FSWatcher | undefined
  try {
    watcher = fs.watch(packageDir, { recursive: true })
  } catch (error: any) {
    logger.warn?.(`our-free-model: could not watch ${packageDir} (${error?.message ?? error})`)
    return () => {}
  }
  const schedule = () => {
    if (paused) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (paused) return
      onChange?.()
    }, debounceMs)
    timer.unref?.()
  }
  watcher.on('change', schedule)
  watcher.on('error', error => logger.warn?.(`our-free-model: watcher error (${error?.message ?? error})`))
  return () => {
    paused = true
    if (timer !== undefined) clearTimeout(timer)
    try { watcher?.close() } catch { /* already closed */ }
  }
}

/**
 * A host, reduced to the four things a reload needs from it.
 *
 * Declared structurally on purpose: the plugin's whole point is that it mounts
 * on more than one kernel line, and a version-pinned adapter base would pin the
 * install to one of them. A host that supplies less reports its own reason.
 */
export interface ReloadHost {
  loader?: any
  registry?: any
  fiber?: any
}

export interface ReloadResult {
  ok: boolean
  version?: string
  fibers?: number
  error?: string
  restored: boolean
  restartRequired?: boolean
}

/**
 * Reload the calling extension in place.
 *
 * The host is injected, not imported: `selfReload` never names the host's own
 * module, so a composition that cannot reload still gets an answer it can show
 * ("restart the host") rather than a crash.
 */
export function selfReload(ctx: ReloadHost, options: ReloadOptions = {}): Promise<ReloadResult> {
  if (inFlight !== null) return inFlight
  inFlight = (async (): Promise<ReloadResult> => {
    const logger = options.logger ?? console
    const packageUrl = options.packageUrl ?? packageUrlOf(import.meta.url)
    const entryUrl = options.entryUrl ?? entryUrlOf(import.meta.url)
    const loader = ctx.loader
    const registry = ctx.registry
    if (loader === undefined || registry === undefined) {
      return { ok: false, error: 'no loader/registry on this host', restored: false }
    }

    // The extension identity is the exports object the registry keyed the
    // runtime by.
    const previous = ctx.fiber?.runtime?.callback
    if (previous === undefined || previous === null) {
      return { ok: false, error: 'no runtime to reload (was not registered the ordinary way)', restored: false }
    }
    const runtime = registry.get(previous)
    const fibers = [...(runtime?.fibers ?? [])].map((fiber: any) => {
      const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined
      const plugin = typeof previous === 'function'
        ? { apply: previous, inject: { ...fiber.inject }, Config: runtime.Config, name: runtime.name }
        : previous
      return { fiber, entry, plugin, config: entry === undefined ? fiber._config : entry.options.config }
    })
    if (fibers.length === 0) {
      return { ok: false, error: 'runtime has no live fibers', restored: false }
    }

    const internal = loader.internal
    const backup = purgeCaches(internal, packageUrl)
    if (backup.esm.size === 0) {
      logger.warn?.('our-free-model: host module cache is unavailable; hot reload requires a host restart')
      return { ok: false, error: 'safe hot reload is unavailable in this host; restart the host to load installed files', restored: true, restartRequired: true }
    }
    logger.info?.(`our-free-model: hot reload purging ${backup.esm.size} cached module(s)`)

    const importFresh = async (url: string) => loader.unwrapExports(await loader.import(url, () => []))
    let replacement: any
    try {
      replacement = await importFresh(entryUrl)
      if (replacement === undefined || typeof replacement.apply !== 'function') {
        throw new Error('reloaded module does not export apply()')
      }
      if (replacement === previous || replacement.apply === previous
        || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
        restoreCaches(internal, backup)
        return { ok: false, error: 'the host returned the cached extension after cache clearing; restart the host to load installed files', restored: true, restartRequired: true }
      }
      if (options.expectedVersion !== undefined && replacement.version !== options.expectedVersion) {
        throw new Error(`activation version mismatch: expected ${options.expectedVersion}, got ${String(replacement.version ?? '(missing)')}`)
      }
    } catch (error: any) {
      restoreCaches(internal, backup)
      return { ok: false, error: `re-import failed, old code still running (${error?.message ?? error})`, restored: true }
    }
    ;(globalThis as any)[Symbol.for('our-free-model.last-reload')] = { at: Date.now(), purged: backup.esm.size }

    try {
      registry.delete(previous)
      await Promise.all(fibers.map(({ fiber }: any) => fiber.await()))
    } catch (error: any) {
      // Old fibers are gone regardless; the new registration below is still the
      // right move — the error is logged, not propagated, to not skip it.
      logger.warn?.(`our-free-model: hot reload dispose reported ${error?.message ?? error}`)
    }

    try {
      const created: any[] = []
      for (const { fiber, entry, config } of fibers) {
        const registered = fiber.parent.registry.plugin(replacement, config)
        const fresh = registered.ctx.fiber
        if (entry !== undefined) {
          fresh.entry = entry
          entry.fiber = fresh
        }
        created.push(fresh)
      }
      await Promise.all(created.map(fiber => fiber.await()))
      logger.info?.(`our-free-model: hot reload complete, ${created.length} fiber(s) re-registered`)
      return { ok: true, version: String(replacement.version ?? ''), fibers: created.length, restored: false }
    } catch (error: any) {
      // The replacement failed to start. Put the old code back both on disk
      // (the caller's job, via the updater's backup) and in the registry.
      restoreCaches(internal, backup)
      try {
        registry.delete(replacement)
      } catch { /* may never have started */ }
      try {
        const restored: any[] = []
        for (const { fiber, entry, plugin, config } of fibers) {
          const registered = fiber.parent.registry.plugin(plugin, config)
          const fresh = registered.ctx.fiber
          if (entry !== undefined) {
            fresh.entry = entry
            entry.fiber = fresh
          }
          restored.push(fresh)
        }
        await Promise.all(restored.map(fiber => fiber.await()))
        return { ok: false, error: `new code failed to start, previous version restored (${error?.message ?? error})`, restored: true }
      } catch (restoreError: any) {
        return {
          ok: false,
          error: `new code failed to start (${error?.message ?? error}); runtime restore failed too (${restoreError?.message ?? restoreError})`,
          restored: false,
        }
      }
    }
  })()
  return inFlight.finally(() => { inFlight = null })
}
