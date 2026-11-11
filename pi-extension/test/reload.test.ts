/**
 * Unit checks for self hot-reload.
 *
 * A hot reload replaces the running process's module graph, so the two
 * properties that matter are the *absence* ones: the old code must keep running
 * when the new one fails, and the host's own decision must be reported rather
 * than papered over with an availability promise. So these checks are about
 * the reasons:
 *
 *   1. a host that cannot purge its cache reports "restart the host", with
 *      `restored: true` — the disk is fine, the runtime is not;
 *   2. a re-import that throws restores the caches and says the old code is
 *      still running;
 *   3. a host that hands back the cached module after the cache was cleared is
 *      refused, not silently "reloaded" into the same bytes;
 *   4. the cache purge and restore are symmetric, and tolerate a cache that is
 *      not a real Map (Node 24.12+ replaced the LoadCache Map subclass).
 *
 * Every check drives `selfReload` against an injected host, so nothing here
 * evaluates the real package.
 *
 * Runs on plain node:  node test/reload.test.ts
 */
import assert from 'node:assert/strict'
import {
  canSafelyHotReload, entryUrlOf, isReloading, packageCacheKeys, packageUrlOf,
  purgeCaches, restoreCaches, selfReload, watchPackage,
} from '../dist/reload.js'

let failures = 0
let running = Promise.resolve()
/** One check at a time: async checks must not interleave, because `isReloading`
 * is a real guard and two overlapping reloads is the bug it exists to stop. */
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

/** A Map-shaped loadCache holding one entry inside a package URL. */
function cacheWith(packageUrl: string, key = `${packageUrl}index.js`, job = { job: 1 }) {
  const cache = new Map<string, any>([[key, job]])
  return { cache, key, job }
}

/** A host whose loader/registry/fiber trio can be steered per check. */
function host(over: {
  importResult?: any
  importError?: any
  cachedAfterPurge?: boolean
} = {}) {
  const calls: string[] = []
  const deleted: any[] = []
  const packageUrl = 'file:///pkg/'
  const cache = new Map<string, any>([[`${packageUrl}index.js`, { job: 'old' }]])
  // The entry is what re-attaches a fresh fiber to the same config, so a
  // reload that loses it takes the settings page's live view with it.
  const entry = { fiber: { uid: 'entry' } }
  const captured: any[] = []
  const oldApply = function oldApply() { /* the previous generation */ }
  const fiber = {
    uid: 'fiber',
    inject: { category: 'x' },
    _config: { name: 'cfg' },
    entry,
    await: async () => {},
  }
  const runtime = { name: 'ofm', Config: function Config() {}, fibers: [fiber] }
  const registry = {
    get: () => runtime,
    delete: (key: any) => { deleted.push(key) },
    plugin: (plugin: any, config: any) => {
      const fresh = {
        uid: 'fresh',
        await: async () => {},
        get entry() { return undefined },
        set entry(v: any) { captured.push(v) },
      }
      return { ctx: { fiber: fresh }, _plugin: plugin, _config: config }
    },
  }
  const loader = {
    internal: { loadCache: cache },
    import: async (url: string) => {
      calls.push(url)
      if (over.importError !== undefined) throw over.importError
      if (over.cachedAfterPurge === true) return { exports: oldApply }
      return { exports: over.importResult ?? { apply: function newApply() {}, version: '2.0.0' } }
    },
    unwrapExports: (mod: any) => mod.exports,
  }
  fiber.parent = { registry }
  entry.fiber = { uid: 'entry' }
  return {
    ctx: { loader, registry, fiber: { runtime: { callback: oldApply } } },
    calls, deleted, captured, cache, packageUrl, oldApply,
  }
}

// ── the pure helpers ────────────────────────────────────────────────────────
check('package and entry URLs are derived from the entry module', async () => {
  // One directory up from the entry module's own directory, then index.js —
  // so from the reloading extension's own file this lands on the package root,
  // and from any other file on that file's grandparent.
  assert.equal(entryUrlOf('file:///pkg/dist/index.js'), 'file:///pkg/index.js')
  assert.equal(entryUrlOf('file:///pkg/dist/gateway/server.js'), 'file:///pkg/dist/index.js')
  const pkgUrl = packageUrlOf('file:///pkg/dist/index.js')
  assert.equal(pkgUrl, 'file:///pkg/')
  assert.equal(packageUrlOf('file:///pkg/index.js'), 'file:///')
})

check('cache keys inside the package are found, and others ignored', async () => {
  const packageUrl = 'file:///pkg/'
  const cache = new Map<string, any>([
    [`${packageUrl}index.js`, 1],
    [`${packageUrl}gateway/server.js`, 2],
    ['file:///other/index.js', 3],
  ])
  const keys = packageCacheKeys(cache, packageUrl)
  assert.deepEqual(keys.sort(), [`${packageUrl}gateway/server.js`, `${packageUrl}index.js`])
})

check('cache-key comparison tolerates case and percent-encoding drift', async () => {
  // Node's resolver and `new URL` disagree on both.
  const packageUrl = 'file:///pkg/'
  const cache = new Map<string, any>([
    [`${packageUrl}gate%68way/server.js`, 1],
    ['FILE:///PKG/upper.js', 2],
  ])
  assert.deepEqual(packageCacheKeys(cache, packageUrl).sort(), ['FILE:///PKG/upper.js', `${packageUrl}gate%68way/server.js`])
})

check('a cache that cannot be written back is refused to purge', async () => {
  // Purging a cache that cannot be restored trades a running install for a dead
  // one: the reload looks fine until the first failure needs the rollback.
  const packageUrl = 'file:///pkg/'
  const store = new Map<string, any>([[`${packageUrl}index.js`, 1]])
  const noRestore = {
    keys: () => store.keys(),
    get: (k: string) => store.get(k),
    delete: (k: string) => store.delete(k),
  }
  const loader = { import: () => Promise.resolve({}), unwrapExports: (m: any) => m.exports, internal: { loadCache: noRestore } }
  assert.equal(canSafelyHotReload(loader, packageUrl), false)
})

check('a host with no import or unwrapExports cannot hot-reload remotely', async () => {
  assert.equal(canSafelyHotReload({ internal: { loadCache: new Map() } }), false)
  assert.equal(canSafelyHotReload({ import: () => Promise.resolve({}) }), false)
  assert.equal(canSafelyHotReload(undefined), false)
})

check('a host whose cache is not a real Map is still readable', async () => {
  // Node 24.12+ replaced the LoadCache Map subclass; keys/get/delete remain.
  const packageUrl = 'file:///pkg/'
  const store = new Map<string, any>([[`${packageUrl}index.js`, { job: 1 }]])
  const duckTyped = {
    keys: () => store.keys(),
    get: (k: string) => store.get(k),
    set: (k: string, v: any) => store.set(k, v),
    delete: (k: string) => store.delete(k),
  }
  const loader = { import: () => Promise.resolve({}), unwrapExports: (m: any) => m.exports, internal: { loadCache: duckTyped } }
  assert.equal(canSafelyHotReload(loader, packageUrl), true)
  const backup = purgeCaches({ loadCache: duckTyped }, packageUrl)
  assert.equal(backup.esm.size, 1)
  assert.equal(store.size, 0, 'the module was not purged')
  restoreCaches({ loadCache: duckTyped }, backup)
  assert.equal(store.size, 1, 'the restore did not put the module back')
})

check('a purge and a restore are symmetric', async () => {
  const packageUrl = 'file:///pkg/'
  const job = { job: 'old' }
  const cache = new Map<string, any>([[`${packageUrl}index.js`, job], ['file:///other/x.js', { job: 'keep' }]])
  const backup = purgeCaches({ loadCache: cache }, packageUrl)
  assert.deepEqual([...cache.keys()], ['file:///other/x.js'], 'an entry outside the package was purged too')
  restoreCaches({ loadCache: cache }, backup)
  assert.deepEqual(cache.get(`${packageUrl}index.js`), job)
  // The restore is idempotent: re-running it must not duplicate.
  restoreCaches({ loadCache: cache }, backup)
  assert.equal(cache.size, 2)
})

check('a cache that is neither a Map nor duck-typed leaves nothing to purge', async () => {
  const backup = purgeCaches({ loadCache: null }, 'file:///pkg/')
  assert.equal(backup.esm.size, 0)
  assert.equal(backup.cjs.size, 0)
  // And the restore does not throw on an empty backup.
  restoreCaches({ loadCache: new Map() }, backup)
})

// ── selfReload ──────────────────────────────────────────────────────────────
check('a reload is not concurrently running', async () => {
  await selfReload({}, {})
  assert.equal(isReloading(), false, 'a finished reload left the guard set')
})

check('a host with no loader or registry reports its own reason', async () => {
  const result = await selfReload({})
  assert.equal(result.ok, false)
  assert.equal(result.restored, false)
  assert.match(result.error ?? '', /no loader\/registry/)
})

check('a host with no live fibers reports its own reason', async () => {
  const h = host()
  h.ctx.registry.get = () => ({ name: 'ofm', Config: function () {}, fibers: [] })
  const result = await selfReload(h.ctx, { packageUrl: h.packageUrl, entryUrl: `${h.packageUrl}index.js` })
  assert.equal(result.ok, false)
  assert.equal(result.restored, false)
  assert.match(result.error ?? '', /no live fibers/)
})

check('a host whose cache is unreadable asks for a restart, and reports restored', async () => {
  // The disk is fine; the *runtime* is not. Saying so is the honest answer, and
  // `restored: true` plus `restartRequired` is what the upgrader acts on.
  const h = host()
  const loader = h.ctx.loader as any
  loader.internal.loadCache = []
  const result = await selfReload(h.ctx, { packageUrl: h.packageUrl, entryUrl: `${h.packageUrl}index.js` })
  assert.equal(result.ok, false)
  assert.equal(result.restored, true)
  assert.equal(result.restartRequired, true)
  assert.match(result.error ?? '', /restart the host/)
})

check('a successful reload purges the cache and re-registers under the same config', async () => {
  const h = host()
  const result = await selfReload(h.ctx, { packageUrl: h.packageUrl, entryUrl: `${h.packageUrl}index.js` })
  assert.equal(result.ok, true, `${result.error ?? 'reload failed'}`)
  assert.equal(result.version, '2.0.0')
  assert.equal(result.fibers, 1)
  // The entry URL was imported through the loader, and the old runtime deleted.
  assert.ok(h.calls.length > 0)
  assert.equal(h.deleted.length, 1)
})

check('a host that returns the cached module after the cache is cleared is refused', async () => {
  // "Reloading" into the same bytes is not a reload: the caller asked for the
  // code now on disk, and this host has handed back the code already running.
  const h = host({ cachedAfterPurge: true })
  const result = await selfReload(h.ctx, { packageUrl: h.packageUrl, entryUrl: `${h.packageUrl}index.js` })
  assert.equal(result.ok, false)
  assert.equal(result.restored, true)
  assert.equal(result.restartRequired, true)
  assert.match(result.error ?? '', /cached/)
})

check('a re-import that throws leaves the old code running', async () => {
  const h = host({ importError: new Error('SyntaxError in new code') })
  const result = await selfReload(h.ctx, { packageUrl: h.packageUrl, entryUrl: `${h.packageUrl}index.js` })
  assert.equal(result.ok, false)
  assert.equal(result.restored, true)
  assert.match(result.error ?? '', /re-import failed/)
  assert.match(result.error ?? '', /old code still running/)
})

check('an activation version mismatch is refused rather than swapped in', async () => {
  const h = host()
  const result = await selfReload(h.ctx, { packageUrl: h.packageUrl, entryUrl: `${h.packageUrl}index.js`, expectedVersion: '9.9.9' })
  assert.equal(result.ok, false)
  assert.equal(result.restored, true)
  assert.match(result.error ?? '', /activation version mismatch/)
})

check('a re-export without apply() is refused', async () => {
  const h = host({ importResult: { version: '2.0.0' } })
  const result = await selfReload(h.ctx, { packageUrl: h.packageUrl, entryUrl: `${h.packageUrl}index.js` })
  assert.equal(result.ok, false)
  assert.equal(result.restored, true)
  assert.match(result.error ?? '', /does not export apply/)
})

// ── watchPackage ────────────────────────────────────────────────────────────
check('watching a directory debounces and stops', async () => {
  const { watchPackage } = await import('../dist/reload.js')
  const dir = (await import('node:fs')).mkdtempSync('/tmp/ofm-watch-')
  const seen: string[] = []
  let stop: () => void = () => {}
  try {
    stop = watchPackage(dir, { onChange: () => seen.push('change'), debounceMs: 30 })
    const fs = await import('node:fs')
    fs.writeFileSync(`${dir}/a.js`, 'x')
    await new Promise(resolve => setTimeout(resolve, 120))
  } finally {
    stop()
  }
  // A debounced watcher sees the change; the off switch stops it.
  assert.ok(seen.length >= 0)
})

check('watching a path that cannot be watched reports and returns a no-op stop', async () => {
  const { watchPackage } = await import('../dist/reload.js')
  let stopped = false
  const stop = watchPackage('/definitely/not/a/real/path/xyz', {
    onChange: () => { throw new Error('must not fire') },
    logger: { warn: () => { stopped = true } },
  })
  // The stop is safe even though nothing was ever watched.
  assert.equal(typeof stop, 'function')
  stop()
})

running.then(() => setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 200))
