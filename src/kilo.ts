/**
 * The Kilo AI public gateway's free pool, as a pi provider.
 *
 * Kilo publishes an OpenAI-compatible gateway whose `isFree` slice answers with
 * no credential at all — no key, no login, no fingerprint gate. That makes this
 * the simplest lane: the adaptations are that the request must carry NO
 * Authorization header (a placeholder token is a 401 here), that the payload is
 * normalised onto the gateway's own parameter vocabulary (`reasoning` rather than
 * `reasoning_effort`, `max_tokens` rather than `max_completion_tokens`), and the
 * same body-shape transport guard the other lane uses.
 *
 * The trade is the gateway's own, and it is stated on the model cards: free-pool
 * prompts may be logged by the upstream provider and used to improve its
 * services. That is a property of the free models, not of this provider.
 *
 * @module pi-extension/kilo.js
 */
import { openAICompletionsApi, type Api, type Model, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai/compat'
import { KILO_BASE, createKiloRoster, fetchKiloListing } from './catalog.js'
import { composeFetches, fetchWithoutHeader, restoreAliases, sseGuard } from './lane.js'
import { compressRequest } from './token-saver/index.js'
import { readSaver } from './saver-store.js'
import { recordSavings } from './saver-stats.js'

/** Provider id, also the pi model prefix: `ofm-kilo/<model>`. */
export const PROVIDER_ID = 'ofm-kilo'

/**
 * The gateway's roster and its wire-id map.
 *
 * One instance per process, because pi aborts a refresh when the next one
 * starts and the ids already learned must survive that (see
 * `createKiloRoster`).
 */
export const roster = createKiloRoster()

/**
 * Normalise one payload onto the gateway's parameter set. Exported for the
 * standalone API gateway, which builds its own OpenAI-shaped payload rather
 * than borrowing pi-ai's message conversion.
 *
 * pi-ai sends OpenAI's `reasoning_effort`; this gateway's rows declare
 * OpenRouter's `reasoning` object, where the off rung is `{enabled:false}` rather
 * than an absent field — the `'off'` sentinel comes from the model's
 * `thinkingLevelMap` (see catalog.kiloEffortMap). The gateway is listed as
 * OpenAI-compatible but is not OpenAI-complete, so the rename happens here
 * rather than through compat flags, which would apply to a provider pi shares
 * with other lanes.
 */
export function normalizeKiloPayload(params: any, model: Model<Api>) {
  const effort = params.reasoning_effort
  delete params.reasoning_effort
  const supported = model.reasoning === true
  if (effort === 'off' && supported) {
    params.reasoning = { enabled: false }
    return params
  }
  if (supported && typeof effort === 'string' && effort !== '') {
    params.reasoning = { effort }
    params.include_reasoning = true
  }
  // The gateway ignores unknown OpenAI fields; drop the ones no row declares so
  // a strict validation on its side can never 400 the turn.
  delete params.store
  delete params.stream_options
  delete params.prompt_cache_key
  delete params.prompt_cache_retention
  return params
}

/**
 * One turn on the free pool, with the Authorization header stripped on the wire.
 *
 * The token saver runs last, after the gateway's own payload normalisation and
 * after the wire id is stamped, so the bytes it counts describe the body that
 * actually ships.
 */
export function streamKilo(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  // The registered id stays the identity pi records (usage, transcript, chains);
  // the upstream's `vendor/name:free` spelling rides only the request payload.
  const wireId = roster.wireId(model.id)
  const inner = openAICompletionsApi().streamSimple({ ...model, baseUrl: KILO_BASE, api: 'openai-completions' }, context, {
    ...options,
    // Satisfies pi's key check; the fetch wrapper below removes it from the wire,
    // because Kilo's free pool answers only a genuinely credential-less request.
    headers: { authorization: 'Bearer public' },
    fetch: composeFetches(options?.fetch ?? fetch, fetchWithoutHeader('authorization'), sseGuard),
    onPayload: async (params, current) => {
      const replaced = await options?.onPayload?.(params, current)
      // `onPayload` returns whatever the caller replaced the body with; treat it
      // as the dynamic request payload this normaliser expects.
      const payload: any = replaced ?? params
      payload.model = wireId
      if (readSaver().rtk) recordSavings(PROVIDER_ID, compressRequest(payload, 'chat', { enabled: true }).stats)
      return normalizeKiloPayload(payload, model)
    },
  })
  return restoreAliases(inner, null)
}

/**
 * Free models the gateway currently serves.
 *
 * The listing can fail (rate-limited, 5xx, or pi aborting a superseded
 * refresh) while chat still works; a turn dispatched from the last roster it
 * served keeps its upstream spelling instead of carrying pi's safe id, so the
 * gateway never answers "model not found" on a lane that is up. Only a listing
 * that answers with an empty free slice falls back to the offline snapshot.
 */
export async function kiloModels({ signal }: { signal?: AbortSignal } = {}) {
  try {
    const listing = await fetchKiloListing(signal)
    const rows = Array.isArray(listing?.data) ? listing.data : []
    return roster.accept(rows)
  } catch {
    return roster.degrade()
  }
}

/** Registration payload for `pi.registerProvider`. */
export function kiloProvider({ models }: { models: Model<Api>[] }) {
  return {
    name: 'Our Free Model · Kilo',
    baseUrl: KILO_BASE,
    api: 'ofm-free-api',
    apiKey: 'public',
    models,
    refreshModels: async (context: { signal?: AbortSignal }) => kiloModels({ signal: context?.signal }),
    streamSimple: streamKilo,
  }
}

// The raw poster lives in `kilo-poster.ts` so the service entries can drive this
// lane without this module's `pi-ai` import in their graph; re-exported here so
// the extension's own consumers keep one import path.
export { postKiloStreamed } from './kilo-poster.js'
