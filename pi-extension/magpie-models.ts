/**
 * Expose the Magpie engine's live catalog through a simple model provider
 * interface. This is a simplified port of dsh's `src/magpie-models.js` that
 * works without the full subscription-completion runtime.
 *
 * Ported from dsh's `src/magpie-models.js`.
 *
 * @module pi-extension/magpie-models.js
 */

import { loopbackFetch } from './loopback-fetch.js'
import { deniedModel } from './magpie-policy.js'

const PREFIX = 'subscription:magpie/'

export interface MagpieModel {
  id: string
  name: string
  context_window?: number
  max_output_tokens?: number
  vision: boolean
  reasoning: boolean
  efforts?: string[]
}

export interface MagpieEngine {
  status(): { state: string; available: boolean; version?: string; revision?: string; error?: string }
  gateway(): { url: string; key: string }
}

/**
 * Create a Magpie models provider that fetches the engine's live catalog.
 */
export function createMagpieModels({ engine, stats, logger, onChanged = () => {}, fetchImpl = loopbackFetch }: {
  engine: MagpieEngine
  stats: any
  logger: any
  onChanged?: () => void
  fetchImpl?: typeof loopbackFetch
}) {
  let models: MagpieModel[] = []
  let closed = false
  let pending: Promise<void> | undefined

  const refresh = async (): Promise<void> => {
    if (closed) return
    if (engine.status().state !== 'ready') {
      if (models.length) { models = []; onChanged() }
      return
    }
    if (pending) return
    pending = (async () => {
      try {
        const gateway = engine.gateway()
        const response: Response = await (fetchImpl(`${gateway.url.replace(/\/$/, '')}/v1/models`, {
          headers: { authorization: `Bearer ${gateway.key}` },
          signal: AbortSignal.timeout(15000), redirect: 'error',
        }) as Promise<Response>)
        if (!response.ok) throw new Error('Model catalog unavailable')
        const payload: any = await response.json()
        if (!Array.isArray(payload?.data)) throw new Error('Invalid model catalog')
        const next: MagpieModel[] = []
        const seen = new Set<string>()
        for (const row of payload.data) {
          if (typeof row?.id !== 'string' || !row.id || /[\r\n\0]/.test(row.id) || seen.has(row.id)) continue
          if (deniedModel(row)) continue
          seen.add(row.id)
          next.push({
            id: row.id,
            name: typeof row.display_name === 'string' ? row.display_name
              : typeof row.name === 'string' ? row.name : row.id,
            context_window: row.context_window,
            max_output_tokens: row.max_output_tokens,
            vision: row.vision === true || row.modalities?.input?.includes('image') === true,
            reasoning: row.reasoning === true,
            // Only a level list the engine actually declared is carried: an
            // absent one stays `undefined`, so a picker can tell "this model
            // declared no menu" from "this model declared an empty one".
            ...(Array.isArray(row.reasoning_levels)
              ? { efforts: row.reasoning_levels.filter((level: any) => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)) }
              : {}),
          })
        }
        if (!closed && JSON.stringify(models) !== JSON.stringify(next)) {
          models = next
          onChanged()
        }
      } catch {
        // Silent failure - retry on next interval
      } finally {
        pending = undefined
      }
    })()
    return pending
  }

  const timer = setInterval(refresh, 15000)
  timer.unref?.()

  return {
    handles: (id: string): boolean => typeof id === 'string' && id.startsWith(PREFIX),
    catalog: (): any[] => models.map(row => ({
      id: PREFIX + row.id,
      provider: 'magpie',
      model: row.id,
      wire: 'chat',
      name: row.name,
      contextWindow: row.context_window,
      maxOutput: row.max_output_tokens,
      vision: row.vision,
      reasoning: row.reasoning,
      ...row.efforts === undefined ? {} : { efforts: row.efforts },
    })),
    refresh,
    close: () => { closed = true; models = []; clearInterval(timer) },
  }
}

/**
 * Combine multiple subscription runtimes into one.
 */
export function combineSubscriptionRuntimes(...runtimes: any[]) {
  const active = runtimes.filter(Boolean)
  return {
    catalog: () => active.flatMap((runtime: any) => runtime.catalog()),
    routingQuota: () => Object.assign({}, ...active.map((runtime: any) => runtime.routingQuota?.() ?? {})),
    complete: (request: any, onChunk: any) => {
      // A runtime that cannot answer whether it owns an address must not crash
      // the walk: it simply does not get the request. `handles` is optional, and
      // a runtime without one is a legacy catch-all only when it says so.
      const runtime = active.find((candidate: any) => typeof candidate.handles === 'function'
        && candidate.handles(request.model) === true)
      if (!runtime) throw Object.assign(new Error('Subscription model not found'), { code: 'NOT_FOUND' })
      return runtime.complete(request, onChunk)
    },
  }
}
