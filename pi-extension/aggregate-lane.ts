/**
 * The aggregate lane, as a pi provider and an HTTP lane.
 *
 * The other lanes are fixed outlets: a pooled anonymous credential, a sealed
 * co-paid credential, a keyless gateway. This one is orthogonal — 76 upstream
 * providers each reachable only with material the user pastes into the settings
 * page. So the module's one job is to keep that decision in one place:
 *
 *   1. `aggregateSettings()` is the single reader for the user's config;
 *   2. `aggregateModels()` projects it into roster rows, carrying each row's own
 *      `providerId`/`modelId` so nothing downstream has to re-parse the address;
 *   3. `resolveProvider()` (in `aggregate.ts`) is the only place a provider's
 *      effective credential, base URL and headers are decided, so the poster and
 *      the two probes can never disagree about which host a key is sent to.
 *
 * A provider whose endpoint cannot be composed never reaches the roster, and an
 * `oauth`/`adc` flow — whose token is minted by its own sign-in, not by a pasted
 * key — is never drivable here.
 *
 * @module pi-extension/aggregate-lane.js
 */
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai/compat'
import { buildAggregateCatalog, resolveProvider } from './aggregate.js'
import { aggregateSettings } from './aggregate-store.js'
import { safeId } from './catalog.js'

/** Provider id, also the pi model prefix: `ofm-aggregate/<provider>/<model>`. */
export const PROVIDER_ID = 'ofm-aggregate'

/** A roster row, carrying the two ids the poster needs to address a provider. */
export interface AggregateModel extends Model<Api> {
  providerId: string
  modelId: string
}

/**
 * The roster the user's config produces right now.
 *
 * Rows are rebuilt from settings on every call rather than cached: a key saved
 * or a provider switched off has to be visible to the next listing without a
 * reload round, and a stale row would be dialed with a credential the user
 * already removed.
 */
export function aggregateModels(): AggregateModel[] {
  return buildAggregateCatalog(aggregateSettings()).map((row: any) => ({
    ...row,
    id: safeId(row.id),
    providerId: row.providerId,
    modelId: row.modelId,
    // The dialable endpoint comes from the seal of this provider: the override
    // the user pasted, else the registry's own base.
    baseUrl: endpointFor(row),
  })) as AggregateModel[]
}

/** The URL one row posts to, or the registry's own base when it has none. */
function endpointFor(row: any): string {
  try {
    const resolved = resolveProvider(aggregateSettings(), row.providerId)
    return String(resolved.chatUrl).replace(/\/chat\/completions$|\/responses$|\/messages$/, '')
  } catch {
    // A row the resolver refuses never reaches the roster anyway (see
    // buildAggregateCatalog), so this is a shape guard, not a live path.
    return ''
  }
}

/**
 * One turn on the aggregate lane.
 *
 * The credential is resolved inside the fetch wrapper rather than at
 * registration: a key saved after the provider was registered must reach the
 * next turn, and a key removed must stop the one after it. The body carries the
 * provider's own bare model id, because the catalog id is namespaced with the
 * provider and the upstream only accepts its own.
 */
export function streamAggregate(model: AggregateModel, context: TranscriptContext, options?: SimpleStreamOptions) {
  // pi-ai's OpenAI implementation is used for message conversion, tool-call
  // assembly, usage accounting and cancellation; only the outbound hop is this
  // lane's own (aggregate.js posts over the shared transport with the provider's
  // headers), so the fetch wrapper is the whole adaptation.
  const inner = openAICompletions(model, context, options, model)
  return inner
}

/**
 * The fetch the gateway uses for an aggregate row.
 *
 * Exported so `dispatch.ts` consumes the same credential decision the pi
 * provider does — one place decides which host a key is sent to, and the two
 * surfaces cannot drift.
 */
export async function aggregatePost(row: AggregateModel, body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
  const { postAggregateStreamed } = await import('./aggregate.js')
  const frames: string[] = []
  await postAggregateStreamed({
    config: aggregateSettings(),
    providerId: row.providerId,
    modelId: row.modelId,
    body,
    signal,
    onData: (payload: string) => frames.push(`data: ${payload}\n\n`),
  })
  const sse = `${frames.join('')}data: [DONE]\n\n`
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close() },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Pi-ai's own OpenAI implementation, imported lazily to keep module load cheap. */
async function openAICompletions(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, row: AggregateModel) {
  const { openAICompletionsApi } = await import('@earendil-works/pi-ai/compat')
  return openAICompletionsApi().streamSimple(
    { ...model, baseUrl: model.baseUrl ?? '', api: 'openai-completions' },
    context,
    {
      ...options,
      onPayload: async (params: any, current: any) => {
        const replaced = await options?.onPayload?.(params, current)
        const payload: any = replaced ?? params
        // The provider only accepts its own bare model id; the catalog id is
        // namespaced with the provider the user configured.
        payload.model = row.modelId
        return payload
      },
    },
  )
}

/** Whether the user has the lane on at all, so a caller can skip it cheaply. */
export function aggregateEnabled(): boolean {
  return aggregateSettings()?.enabled !== false
}

/**
 * Registration payload for `pi.registerProvider`.
 *
 * Returns `null` when the user has no provider configured — a lane with no rows
 * is not a provider, and an empty roster in `pi --list-models` would be a picker
 * entry that can only answer an error.
 */
export function aggregateProvider() {
  const models = aggregateModels()
  if (models.length === 0) return null
  return {
    name: 'Our Free Model · Aggregate (your keys)',
    baseUrl: 'https://aggregate.invalid',
    api: 'ofm-free-api',
    apiKey: 'public',
    models,
    refreshModels: async (_context: { signal?: AbortSignal }) => aggregateModels(),
    streamSimple: streamAggregate,
  }
}
