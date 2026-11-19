/**
 * Compact `tree` output.
 *
 * Ported verbatim from `src/token-saver/rtk/filters/tree.js`. The glyphs and
 * indentation *are* the information here — they show the nesting a model reasons
 * about — so almost nothing is dropped. What goes is the trailing "N
 * directories, M files" summary (whose counts the model can derive from the
 * listing itself) and blank padding. The line cap is a JS-only safeguard against
 * a tree of a build directory; the Rust original has none.
 *
 * @module pi-extension/token-saver/filters/tree.js
 */

import { TREE_MAX_LINES } from '../constants.js'
import type { RtkFilter } from '../applyFilter.js'

export function tree(input: string): string {
  const lines = input.split('\n')
  if (lines.length === 0) return input

  const filtered: string[] = []
  for (const line of lines) {
    // Drop "X directories, Y files" summary
    if (line.includes('director') && line.includes('file')) continue
    // Drop leading blanks
    if (line.trim() === '' && filtered.length === 0) continue
    filtered.push(line)
  }

  // Drop trailing blanks
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
    filtered.pop()
  }

  // Cap overly long trees (JS-only safeguard; Rust has no cap)
  if (filtered.length > TREE_MAX_LINES) {
    const cut = filtered.length - TREE_MAX_LINES
    return filtered.slice(0, TREE_MAX_LINES).join('\n') + `\n... +${cut} more lines`
  }

  return filtered.join('\n')
}

;(tree as RtkFilter).filterName = 'tree'
