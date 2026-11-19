/**
 * The one place a filter is allowed to fail.
 *
 * Filters are pure string transforms over whatever a tool happened to print, so
 * they run against inputs nobody validated: truncated JSON, mixed encodings, a
 * hunk header without its body. A filter that throws must degrade to *no
 * savings* — never to a broken request — because this module sits between the
 * user's turn and the provider: an exception here would fail the whole turn,
 * and the user would lose the answer to save a few tokens on a tool result.
 *
 * Ported verbatim from `src/token-saver/rtk/applyFilter.js`.
 *
 * @module pi-extension/token-saver/applyFilter.js
 */

/** A compactor: text in, text out. See `registry.js`. */
export type RtkFilter = ((input: string) => string) & { filterName?: string }

/**
 * Run `fn` over `text`, returning `text` unchanged when the filter throws or
 * answers something that is not a string.
 *
 * The non-string check is not defensive padding: a filter that returns
 * `undefined` (a forgotten branch) would otherwise be assigned into the request
 * body, and a `null` tool result is a different message to the model than the
 * output it was supposed to summarise.
 */
export function safeApply(fn: RtkFilter, text: string): string {
  if (typeof fn !== 'function') return text
  try {
    const out = fn(text)
    if (typeof out !== 'string') return text
    return out
  } catch (err) {
    // Rust: eprintln!("[rtk] warning: filter panicked — passing through raw output")
    const name = fn.filterName || fn.name || 'anonymous'
    console.warn(`[rtk] warning: filter '${name}' panicked — passing through raw output: ${err instanceof Error ? err.message : String(err)}`)
    return text
  }
}
