/**
 * Last-resort compactor for an unstructured blob: keep head and tail.
 *
 * Ported verbatim from `src/token-saver/rtk/filters/smartTruncate.js`. When
 * nothing recognises the shape, the honest assumption is that the useful lines
 * are at the start (the command's header, the first failures) and the end (the
 * final status, the last error). The middle is replaced by a count. This is the
 * same strategy the Rust `filter::smart_truncate` uses, and it is why the marker
 * says how many lines are missing — a model must know it is looking at a window,
 * not the whole output.
 *
 * @module pi-extension/token-saver/filters/smartTruncate.js
 */

import { SMART_TRUNCATE_HEAD, SMART_TRUNCATE_TAIL, SMART_TRUNCATE_MIN_LINES } from '../constants.js'
import type { RtkFilter } from '../applyFilter.js'

export function smartTruncate(input: string): string {
  const lines = input.split('\n')
  // Below the minimum, head+tail+marker is not smaller than the input.
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input

  const head = lines.slice(0, SMART_TRUNCATE_HEAD)
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL)
  const cut = lines.length - head.length - tail.length
  return [...head, `... +${cut} lines truncated`, ...tail].join('\n')
}

;(smartTruncate as RtkFilter).filterName = 'smart-truncate'
