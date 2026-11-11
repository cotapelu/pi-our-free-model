/**
 * The attribution User-Agent, resolved through a seam.
 *
 * In DSH this was `adapter/kernel.js`, and it was the **only** module allowed to
 * name an `@deepseek-ai/*` import — the ecosystem packaging rule (audit gate
 * §4.3, "adapter 层外不允许 `@deepseek-ai/*` import") expressible as one grep.
 * Everything the plugin took from the harness kernel crossed here, so the rest of
 * the source stayed a pure consumer of a structural `ctx` and could mount on any
 * kernel line.
 *
 * This provider names no kernel at all — it is not a plugin — but the *shape* of
 * the seam still matters, for the same reason: the adapter contract requires
 * attribution to be **present**, so a host that cannot supply its helper must
 * degrade to a literal rather than send nothing. A request with no User-Agent is
 * a request the upstream can freely refuse.
 *
 * The loader is injected rather than imported, so nothing here pins a module name
 * or a version, and a composition with no host helper at all costs one argument.
 *
 * Ported from dsh's `adapter/kernel.js`.
 *
 * @module pi-extension/attribution.js
 */

/** The literal used whenever a host helper is not available. */
export const FALLBACK_ATTRIBUTION =
  'our-free-model/0.2.0 (+https://github.com/Ebony-Vinyl/dsh-our-free-model)'

/** A host helper's attribution headers, as the seam reads them. */
export interface AttributionHeaders {
  attributionHeaders?: () => Record<string, string> | undefined
}

/** The seam: an optional module loader, plus an optional logger. */
export interface AttributionSeam {
  /** Resolves the host's attribution helper; `null` means there is none. */
  load?: () => Promise<AttributionHeaders | null>
  debug?: (message: string) => void
}

/**
 * Resolve the attribution User-Agent.
 *
 * A missing helper, an unexpected shape or a throwing call all degrade to
 * {@link FALLBACK_ATTRIBUTION} — attribution must be present even when the host's
 * own is not. The reason is logged at `debug`, because "why does my request carry
 * an odd User-Agent" is a question whose answer has to be recoverable.
 */
export async function resolveAttributionUserAgent(seam: AttributionSeam = {}): Promise<string> {
  const load = seam.load
  if (load === undefined) return FALLBACK_ATTRIBUTION
  try {
    const module = await load()
    const headers = typeof module?.attributionHeaders === 'function' ? module.attributionHeaders() : undefined
    // Both spellings, because the header set a host hands over is not obliged to
    // normalise its own keys.
    const agent = headers?.['user-agent'] ?? headers?.['User-Agent']
    if (typeof agent === 'string' && agent !== '') return agent
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    seam.debug?.(`our-free-model: attribution helper unavailable (${message})`)
  }
  return FALLBACK_ATTRIBUTION
}

/** Read one request's User-Agent through the same rule, for the outbound headers. */
export function userAgentWith(attribution: string | undefined): string {
  return typeof attribution === 'string' && attribution !== '' ? attribution : FALLBACK_ATTRIBUTION
}
