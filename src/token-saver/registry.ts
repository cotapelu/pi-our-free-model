/**
 * Name-to-filter lookup, for callers that already know what a blob is.
 *
 * Ported verbatim from `src/token-saver/rtk/registry.js`. The autodetector
 * guesses; a caller that ran the tool itself does not have to. This registry is
 * that door, and it is also where the Rust tool's aliases live (`rg` for grep,
 * `fd` for find) because an agent names the modern tool and the compactor is
 * the same one.
 *
 * `build-output` is deliberately absent: it is only ever selected by shape via
 * the autodetector, because "npm output" has no single command name a caller
 * could pass — npm, yarn, cargo and rustc all land there.
 *
 * @module pi-extension/token-saver/registry.js
 */

import { FILTERS } from './constants.js'
import type { RtkFilter } from './applyFilter.js'
import { gitDiff } from './filters/gitDiff.js'
import { gitStatus } from './filters/gitStatus.js'
import { gitLog } from './filters/gitLog.js'
import { grep } from './filters/grep.js'
import { find } from './filters/find.js'
import { dedupLog } from './filters/dedupLog.js'
import { ls } from './filters/ls.js'
import { tree } from './filters/tree.js'
import { smartTruncate } from './filters/smartTruncate.js'
import { readNumbered } from './filters/readNumbered.js'
import { searchList } from './filters/searchList.js'

const REGISTRY: Record<string, RtkFilter> = {
  [FILTERS.GIT_DIFF]: gitDiff as RtkFilter,
  [FILTERS.GIT_STATUS]: gitStatus as RtkFilter,
  [FILTERS.GIT_LOG]: gitLog as RtkFilter,
  [FILTERS.GREP]: grep as RtkFilter,
  [FILTERS.FIND]: find as RtkFilter,
  [FILTERS.DEDUP_LOG]: dedupLog as RtkFilter,
  [FILTERS.LS]: ls as RtkFilter,
  [FILTERS.TREE]: tree as RtkFilter,
  [FILTERS.SMART_TRUNCATE]: smartTruncate as RtkFilter,
  [FILTERS.READ_NUMBERED]: readNumbered as RtkFilter,
  [FILTERS.SEARCH_LIST]: searchList as RtkFilter,
}

// Rust resolve_filter aliases (pipe_cmd.rs): grep|rg, find|fd
const ALIASES: Record<string, RtkFilter> = {
  rg: grep as RtkFilter,
  fd: find as RtkFilter,
}

/** Resolve a filter by name or alias; null when the name is unknown. */
export function resolveFilter(name: string): RtkFilter | null {
  return REGISTRY[name] ?? ALIASES[name] ?? null
}

/** Every named filter, keyed by its `filterName`. */
export function allFilters(): Record<string, RtkFilter> {
  return REGISTRY
}
