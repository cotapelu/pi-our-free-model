/**
 * The OpenCode anonymous free lane, as a pi provider.
 *
 * Upstream serves a free tier behind a *pooled public* credential
 * (`Authorization: Bearer public`) and a client fingerprint (see
 * ./fingerprint.js). No account, no key, no login — the secret is public and the
 * gate is the fingerprint. This module borrows pi's own OpenAI-Completions
 * implementation (message conversion, tool-call assembly, usage accounting,
 * cancellation) and only rewrites what the gate fingerprints: headers, the
 * outgoing payload, and the response-side un-aliasing of the caller's tools the
 * fingerprint had to rename out of the gate slots.
 *
 * @module pi-extension/opencode.js
 */
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import { applyFingerprint, gatewayHeaders, sessionFor } from './fingerprint.js'
import {
  OPENECODE_CHAT_BASE,
  fetchOpencodeListing,
  opencodeModel,
  staticOpencodeModels,
} from './catalog.js'
import { composeFetches, restoreAliases, rotateOnQuota, sessionSeedOf, sseGuard } from './lane.js'

/** Provider id, also the pi model prefix: `ofm-opencode/<model>`. */
export const PROVIDER_ID = 'ofm-opencode'

/** DeepSeek v4 sometimes leaks DSML control markup into visible text. */
const DSML_FAMILY = /deepseek/i

/**
 * One turn on the free lane.
 *
 * Four adaptations, all upstream-mandated:
 *  - the fingerprint headers (v2 UA, four session headers, `Bearer public`);
 *  - the payload fingerprint (verbatim `read`/`shell` tools, the `<env>` block,
 *    the identity-metered tool renames, no `tool_choice: 'none'`);
 *  - the response-side un-aliasing (and the DSML scrub for DeepSeek v4);
 *  - the transport guard that reads a mislabelled or non-SSE 200 body by shape
 *    instead of dropping the turn.
 */
export function streamOpencode(model, context, options) {
  const seed = sessionSeedOf(options)
  const aliases = new Map()
  const headers = gatewayHeaders({ session: sessionFor(seed), stream: true })
  const inner = openAICompletionsApi().streamSimple(
    { ...model, baseUrl: model.baseUrl ?? OPENECODE_CHAT_BASE, api: 'openai-completions' },
    context,
    {
      ...options,
      headers,
      fetch: composeFetches(options?.fetch ?? fetch, sseGuard),
      onPayload: async (params, current) => {
        const replaced = await options?.onPayload?.(params, current)
        return applyFingerprint(replaced ?? params, { aliases })
      },
    },
  )
  return restoreAliases(inner, aliases, {
    onEvent: (event) => rotateOnQuota(event, seed),
    scrubDsml: DSML_FAMILY.test(String(model.id)),
  })
}

/** Free models the gateway currently serves, or the offline snapshot on failure. */
export async function opencodeModels({ signal }: { signal?: AbortSignal } = {}) {
  try {
    const listing = await fetchOpencodeListing(signal)
    const rows = Array.isArray(listing?.data) ? listing.data : []
    const models = rows.map(opencodeModel).filter(Boolean)
    return models.length > 0 ? models : staticOpencodeModels()
  } catch {
    return staticOpencodeModels()
  }
}

/** Registration payload for `pi.registerProvider`. */
export function opencodeProvider({ models }) {
  return {
    name: 'Our Free Model · OpenCode',
    baseUrl: OPENECODE_CHAT_BASE,
    api: 'ofm-free-api',
    // The pooled public credential this lane publishes; not a per-user secret.
    apiKey: 'public',
    models,
    refreshModels: async (context) => opencodeModels({ signal: context?.signal }),
    streamSimple: streamOpencode,
  }
}
