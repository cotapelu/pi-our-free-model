/**
 * The model runtime both service entries mount: catalog refresh threads,
 * availability probing, egress watching, and the turn entry.
 *
 * In DSH this file was the shared core of **two** products — the plugin and the
 * standalone console — and it was explicit that the core resolves no `DSH_HOME`
 * and discovers no host service: the entry point decides the path and hands it
 * in. The port keeps that shape, and it is the reason this module takes its
 * stores as a parameter rather than opening them: `server.ts` and
 * `packages/standalone/service.ts` must not disagree about where the user's
 * state lives.
 *
 * What it is *not* is a second turn loop: `FreeModelAdapter` (`model-adapter.ts`)
 * is injected as the adapter, exactly as `dispatch.ts` is the extension's own
 * turn loop over pi's models. One upstream classification (`core/upstream.ts`),
 * two entries, no third copy of the retry rules.
 *
 * Creation starts no network task: the entry binds its listener first, then
 * decides when to refresh and probe.
 *
 * Ported from dsh's `src/core/runtime.js`.
 *
 * @module pi-extension/core/model-runtime.js
 */

import { FreeModelAdapter } from './model-adapter.js'
import {
  buildCatalog, buildEacCatalog, buildKiloCatalog, isEacEntry, isKiloEntry, parseListing, reviveKiloCatalog,
} from './catalog-rows.js'
import { buildAggregateCatalog, isAggregateEntry } from '../aggregate.js'
import { isComboEntry, normalizeCombos, pruneRotation, buildComboCatalog } from '../combos.js'
import { pruneDays, recordTurn, recordUsage, isModelHidden } from '../gateway/store.js'
import { STATE, detectEgress, probeCatalog } from './egress-probe.js'
import { CODE, UpstreamError, getJson, sessionForConversation } from './upstream.js'
import { DEFAULT_LEVEL, defaultEffortFor, effortsFor } from '../effort.js'
import { fetchSealedListing } from '../eac.js'
import { fetchKiloListing } from '../catalog.js'
import { createForwardCompletion, publicModelRows } from './completion.js'
import { computeMembership } from './runtime.js'
import { runModelTest } from '../model-test.js'
import { isSubscriptionEntry, subscriptionCatalog } from '../subscription-adapter.js'

const FALLBACK_CATALOG = buildCatalog([
  'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'space-bunny-free',
  'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free',
])

/**
 * 两个产品共同使用的模型运行时。宿主仅注入能力，不传入 Cordis ctx。
 * 创建不启动网络任务；入口先绑定本地监听器，再决定何时刷新和探测。
 * Optional subscriptionRuntime supplies catalog() and complete(request, onChunk);
 * its helper owns accounting. Call syncAggregateCatalog() after account mutations.
 */
export function createModelRuntime({
  settings, stats, availability, catalogStore,
  logger = console,
  attributionUserAgent = 'our-free-model',
  resolveImage,
  sealedCredential = () => null,
  onSealedUnavailable = () => {},
  onTopology = () => {},
  subscriptionRuntime,
}: any) {
  let catalog = materializeCatalog(catalogStore.get().entries ?? [])
  let sealedCatalog = sealedCredential() === null ? [] : buildEacCatalog(catalogStore.get().sealIds ?? [])
  let kiloCatalog = reviveKiloCatalog(catalogStore.get().kiloRows)
  /** The aggregate lane: one row per enabled provider/model the user configured.
   *  Derived from settings, not from a listing, so it is rebuilt on every merge. */
  let aggregateCatalog: any[] = []
  let subscriptionEntries: any[] = []
  /** The virtual rows a combo contributes; rebuilt last, after every real lane. */
  let comboCatalog: any[] = []
  /** The free lane's own roster: the base every other lane is merged onto. */
  let freeCatalog = catalog
  let egress = availability.get().egress ?? null
  let gatewayLatency = { ms: 0, at: 0 }
  let disposed = false
  const lifetime = new AbortController()
  let egressGeneration = 0

  /**
   * Rebuild the merged catalog from its parts, in precedence order.
   *
   * Rebuilt rather than appended to, because every one of these lists can shrink:
   * a provider the user switched off, a chain whose head was removed, a Kilo
   * model that went paid. Appending only ever grew the view, so a removed row
   * stayed dialable until the next full listing round happened to reset it.
   *
   * Combos come last on purpose — a chain's links have to already exist as real
   * rows, which is also what makes `buildComboCatalog` drop a link that is gone
   * instead of keeping a hopeful placeholder.
   */
  const rebuildCatalog = () => {
    const seen = new Set<string>()
    const merged: any[] = []
    for (const entry of [...freeCatalog, ...sealedCatalog, ...kiloCatalog, ...aggregateCatalog, ...subscriptionEntries]) {
      if (entry === null || entry === undefined || seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    const combos = normalizeCombos(settings.get().combos)
    comboCatalog = buildComboCatalog(combos, merged)
    pruneRotation(combos)
    for (const entry of comboCatalog) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    catalog = merged
  }
  const mergeCatalogs = () => {
    aggregateCatalog = buildAggregateCatalog(settings.get().aggregate ?? {})
    subscriptionEntries = subscriptionCatalog(subscriptionRuntime)
    rebuildCatalog()
  }
  mergeCatalogs()
  const state = () => ({
    catalog,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
    routing: {
      quota: subscriptionRuntime?.routingQuota?.() ?? {},
      usage: Object.fromEntries(catalog.map((row: any) => [row.id, stats.get().models?.[row.id]?.calls ?? 0])),
    },
  })
  const emitTopology = () => { if (!disposed) onTopology() }
  const adapter = new FreeModelAdapter({
    state,
    resolveImage,
    subscriptionRuntime,
    sealedCredential,
    recordUsage: (record: any) => {
      if (disposed) return
      recordUsage(stats, record)
      stats.edit((value: any) => pruneDays(value, 120))
    },
    recordTurn: (record: any) => { if (!disposed) recordTurn(stats, record) },
    warn: (message: string) => logger.warn?.(message) ?? logger.log?.(message),
    // Automatic probing is disabled by owner policy: a region refusal from a
    // real turn stays a turn failure and never fires a background probe.
  })

  // 手动强制刷新不能借用一个因限流而跳过探测的普通刷新。
  let catalogRefresh: Promise<any> | null = null
  let catalogRefreshForced = false
  let catalogRefreshProbed = false
  async function refreshCatalog(opts?: { probe?: boolean; force?: boolean; report?: boolean }) {
    // Automatic probing is disabled by owner policy: `probe` defaults to false
    // and every automatic caller passes false. Only an explicit user action (the
    // reprobe button or an explicit caller) asks for `probe: true`.
    const { probe = false, force = false, report = false } = opts ?? {}
    // 管理接口按需取本轮结果，其他调用仍返回模型数组。
    const result = (value: any) => (report ? value : value.catalog)
    if (disposed) return result({ catalog, sources: {} })
    while (catalogRefresh !== null) {
      const shared = catalogRefresh
      const sharedForced = catalogRefreshForced
      const sharedProbed = catalogRefreshProbed
      const value = await shared
      if (disposed || ((!force || sharedForced) && (!probe || sharedProbed))) return result(value)
    }
    const run = refreshCatalogOnce({ probe, force })
    catalogRefresh = run
    catalogRefreshForced = force
    catalogRefreshProbed = probe
    try { return result(await run) } finally {
      if (catalogRefresh === run) {
        catalogRefresh = null; catalogRefreshForced = false; catalogRefreshProbed = false
      }
    }
  }

  async function refreshCatalogOnce({ probe, force }: { probe: boolean; force: boolean }) {
    const sources: any = {}
    let ids: string[] = []
    try {
      ids = parseListing(await fetchListing())
    } catch (error) {
      if (!disposed) logger.warn?.(`our-free-model: model listing refresh failed (${(error as Error)?.message ?? error}); keeping the cached catalog`)
    }
    if (disposed) return { catalog, sources }
    if (ids.length > 0) {
      freeCatalog = buildCatalog(ids)
      catalogStore.update({ at: Date.now(), entries: freeCatalog.map((entry: any) => entry.id) })
      catalogStore.flush()
      settings.update({ catalogSyncedAt: Date.now() })
    } else {
      freeCatalog = materializeCatalog(catalogStore.get().entries ?? [])
    }
    sources.free = { ok: ids.length > 0, count: freeCatalog.length }
    sources.sealed = await refreshSealedRoster()
    if (disposed) return { catalog, sources }
    sources.kilo = { ok: await refreshKiloRoster(), count: kiloCatalog.length }
    if (disposed) return { catalog, sources }
    mergeCatalogs()
    if (probe) await refreshAvailability(force)
    emitTopology()
    return { catalog, sources }
  }

  async function refreshSealedRoster() {
    const credential = sealedCredential()
    if (credential === null) {
      sealedCatalog = []
      onSealedUnavailable()
      return { ok: true, count: 0, skipped: true }
    }
    try {
      const ids = parseListing(await fetchSealedListing(credential, { signal: lifetime.signal }))
      if (disposed) return
      // 独立应用授权变更时，旧账号正在返回的清单不得覆盖新状态。
      if (Object.hasOwn(credential, 'userToken') && sealedCredential()?.userToken !== credential.userToken) return { ok: false, count: sealedCatalog.length, skipped: true }
      if (ids.length > 0) {
        sealedCatalog = buildEacCatalog(ids)
        catalogStore.update({ sealIds: sealedCatalog.map((entry: any) => entry.id) })
      }
      return { ok: ids.length > 0, count: sealedCatalog.length }
    } catch (error: any) {
      if (disposed) return
      if (Object.hasOwn(credential, 'userToken') && sealedCredential()?.userToken !== credential.userToken) return { ok: false, count: sealedCatalog.length, skipped: true }
      if (error?.code === CODE.credential) {
        sealedCatalog = []
        catalogStore.update({ sealIds: [] })
        logger.warn?.('our-free-model: the sealed lane refused its credential; its models are hidden until it is accepted again')
        return { ok: false, count: 0 }
      }
      logger.warn?.(`our-free-model: sealed lane listing failed (${error?.code ?? 'unknown'}); keeping its cached roster`)
      return { ok: false, count: sealedCatalog.length }
    }
  }

  async function refreshSealedLane() {
    await refreshSealedRoster()
    if (disposed) return
    // The rebuild in `mergeCatalogs` drops a stale roster on its own: a closed
    // lane's rows vanish without a filter pass over the merged view.
    mergeCatalogs()
    emitTopology()
  }

  async function refreshKiloRoster() {
    try {
      const payload = await fetchKiloListing(lifetime.signal)
      if (disposed) return
      if (payload?.error || !Array.isArray(payload?.data)) throw new Error('invalid Kilo model listing')
      kiloCatalog = buildKiloCatalog(payload.data)
      catalogStore.update({ kiloRows: kiloCatalog })
      return true
    } catch (error: any) {
      if (!disposed) logger.warn?.(`our-free-model: Kilo channel listing failed (${error?.code ?? error?.message ?? 'unknown'}); keeping its cached roster`)
      return false
    }
  }

  async function fetchListing() {
    if (disposed) return { data: [] }
    const started = Date.now()
    const listing = await getJson('/inference/v1/models', {
      session: sessionForConversation('catalog:our-free-model'),
      attributionUserAgent,
      signal: lifetime.signal,
    })
    if (!disposed) gatewayLatency = { ms: Date.now() - started, at: Date.now() }
    return listing
  }

  let probeRound: Promise<any> | null = null
  let probeRoundGeneration = 0
  let probeThrottleStreak = 0
  let probeBackoffUntil = 0
  async function runProbeRound() {
    const generation = egressGeneration
    // The absorbed channels get no per-model probes: their verdicts would be
    // spent against a different gateway than the one that serves them, and a
    // roster the listing named is advertised as-is (its health is the listing
    // round's, refreshed on the same cadence). The aggregate lane is excluded
    // for a sharper reason — a probe there is a *real request to a provider the
    // user pays for*, spent to learn something the settings page already knows
    // (whether a key is configured). A combo is excluded because it has no
    // endpoint of its own: probing one would send the chain's own id to the free
    // lane as a model name, spending quota to collect a verdict about nothing.
    const probeable = catalog.filter((entry: any) => !isEacEntry(entry) && !isKiloEntry(entry) && !isAggregateEntry(entry) && !isComboEntry(entry) && !isSubscriptionEntry(entry))
    const results = await probeCatalog(probeable, { attributionUserAgent, signal: lifetime.signal }, (id: string, result: any) => {
      if (disposed || generation !== egressGeneration) return
      availability.edit((value: any) => ({
        ...value,
        results: {
          ...value.results,
          [id]: {
            state: result.state,
            ...result.detail === undefined ? {} : { detail: result.detail },
            ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs },
            latencyMs: result.latencyMs, startedAt: result.startedAt, at: Date.now(),
          },
        },
      }))
    }, 2)
    if (disposed || generation !== egressGeneration) return {}
    availability.update({ at: Date.now(), egress })
    availability.flush()
    const verdicts = Object.values(results)
    if (verdicts.length > 0 && verdicts.every((row: any) => row.state === STATE.unavailable)) {
      logger.warn?.(`our-free-model: the gateway refused all ${verdicts.length} models this round (${verdicts[0].detail ?? 'no detail'}); keeping them advertised`)
    }
    const allThrottled = verdicts.length > 0 && verdicts.every((row: any) => row.state === STATE.throttled)
    probeThrottleStreak = allThrottled ? probeThrottleStreak + 1 : 0
    probeBackoffUntil = allThrottled
      ? Date.now() + Math.min(30 * 2 ** (probeThrottleStreak - 1), 120) * 60_000
      : 0
    if (allThrottled) {
      logger.warn?.(`our-free-model: the probe round hit the lane's quota; availability probes pause for ${Math.round((probeBackoffUntil - Date.now()) / 60_000)} minutes (your own requests are unaffected, and the reprobe button forces a round)`)
    }
    emitTopology()
    return results
  }
  async function refreshAvailability(force = false) {
    if (disposed || (!force && probeBackoffUntil > Date.now())) return {}
    if (probeRound !== null && probeRoundGeneration === egressGeneration) return probeRound
    probeRoundGeneration = egressGeneration
    const round = runProbeRound()
    probeRound = round
    try { return await round } finally { if (probeRound === round) probeRound = null }
  }

  async function watchEgress() {
    if (disposed) return false
    const seen = await detectEgress({ signal: lifetime.signal })
    if (disposed || seen === undefined) return false
    const previous = availability.get().egress
    const changed = previous === null || previous === undefined
      || previous.ip !== seen.ip || (seen.country !== undefined && previous.country !== seen.country)
    egress = seen
    if (changed) {
      egressGeneration++
      // 保留历史记录，但旧出口的成功、拒绝和手动测量均不能代表新出口。
      const expire = (rows: any) => Object.fromEntries(Object.entries(rows ?? {}).map(([id, row]) => [id, { ...(row as object), stale: true }]))
      availability.edit((value: any) => ({
        ...value, egress: seen, at: 0,
        results: expire(value.results), manualResults: expire(value.manualResults),
      }))
      availability.flush()
      probeThrottleStreak = 0
      probeBackoffUntil = 0
      emitTopology()
      // 只使旧判定失效并通知选择器，不发送任何自动探测请求。
      logger.info?.(`our-free-model: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ''}; previous availability marked stale`)
    }
    return true
  }

  const latestTests = new Map<string, unknown>()
  async function testModel(id: string, effort: string = DEFAULT_LEVEL, { signal }: { signal?: AbortSignal } = {}) {
    if (disposed) throw new UpstreamError('Model runtime stopped', CODE.aborted)
    if (settings.get().enabled === false) throw new UpstreamError('Inference is paused', CODE.client)
    const entry = catalog.find((candidate: any) => candidate.id === id)
    if (!entry) throw new UpstreamError('Unknown model "' + id + '"', CODE.client, { status: 404 })
    const token = {}
    latestTests.set(id, token)
    const generation = egressGeneration
    const selectedEffort = effort === undefined || effort === '' ? DEFAULT_LEVEL : effort
    const linkedSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const persist = (row: any) => {
      if (disposed || linkedSignal.aborted || latestTests.get(id) !== token || generation !== egressGeneration) return false
      availability.edit((value: any) => ({ ...value, manualResults: { ...value.manualResults, [id]: row } }))
      availability.flush()
      emitTopology()
      return !availability.writeFailed
    }
    try {
      const measured = await runModelTest((testSignal: AbortSignal) => adapter.stream({
        provider: 'our-free-model', model: entry.id,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoningEffort: selectedEffort, sessionId: 'bench:' + entry.id + ':' + selectedEffort,
        signal: testSignal,
      }, entry, state()), { signal: linkedSignal })
      if (linkedSignal.aborted || disposed) throw new UpstreamError('Text test cancelled', CODE.aborted)
      if (generation !== egressGeneration) throw new UpstreamError('Network egress changed during the text test; please test again', CODE.aborted)
      const persisted = persist({ state: STATE.available, source: 'manual', at: Date.now(), ttftMs: measured.ttftMs, latencyMs: measured.totalMs })
      return { model: entry.id, effort: selectedEffort, ok: true, ...measured, persisted }
    } catch (error: any) {
      // Cancellation is a user action, not a fresh availability verdict. Other failures
      // remain unknown instead of silently banning a paid/region-gated route.
      if (error?.code !== CODE.aborted) persist({ state: STATE.unknown, source: 'manual', at: Date.now(), detail: String(error?.message ?? error).slice(0, 200) })
      throw error
    } finally {
      if (latestTests.get(id) === token) latestTests.delete(id)
    }
  }

  return {
    testModel, state, adapter, refreshCatalog, refreshSealedLane, refreshAvailability, watchEgress, fetchListing,
    complete: createForwardCompletion({
      adapter, signal: lifetime.signal,
      state: () => {
        const snapshot = state()
        // Hiding advertisements must not invalidate requests using a saved id.
        return { ...snapshot, membership: computeMembership(snapshot.catalog, availability.get(), {
          ...snapshot.settings, hiddenModelIds: [], hideFreeModels: false, hideEacModels: false,
        }) }
      },
    }),
    publicModelRows: () => publicModelRows(state(), effortsFor, defaultEffortFor),
    // A settings write that changes the aggregate lane or the chains (a key
    // saved, a subscription imported/toggled/removed, a combo edited) rebuilds
    // the merged view without an upstream listing round.
    syncAggregateCatalog() {
      if (disposed) return catalog
      mergeCatalogs()
      emitTopology()
      return catalog
    },
    get catalog() { return catalog },
    get egress() { return egress },
    get gatewayLatency() { return gatewayLatency },
    setAttributionUserAgent(value: string) { attributionUserAgent = value },
    dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort()
    },
  }
}

function materializeCatalog(ids: unknown) {
  const rebuilt = buildCatalog(Array.isArray(ids) ? ids : [])
  return rebuilt.length > 0 ? rebuilt : FALLBACK_CATALOG
}
