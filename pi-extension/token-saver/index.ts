/**
 * RTK token saver: compact tool output inside an outgoing request body.
 *
 * Ported from `src/token-saver/rtk/index.js`, reduced to the wire this
 * extension speaks. A long agent turn is mostly tool output — diffs, listings,
 * search results, build logs — and almost all of it is redundancy a model does
 * not need: paths repeated per match, progress lines per compiled crate, hunk
 * bodies far larger than the change they describe. This module rewrites those
 * blobs into the compacted shapes the RTK tool defines, in place, just before
 * the request is handed to the provider.
 *
 * Three rules bound what may be touched (all ported verbatim):
 *
 * - Only tool *output* is compacted. System prompts, user turns and assistant
 *   text are hand-written context; rewriting them would change what the user
 *   asked for.
 * - Error results are never compacted. An error trace is the model's only
 *   evidence of what failed; hiding it makes the model retry the same call, and
 *   the user pays for the loop.
 * - A blob is replaced only when the replacement is non-empty and strictly
 *   smaller. An empty tool result reads as "the tool printed nothing", which is
 *   a different fact than the one the tool reported, and a larger one costs the
 *   context it was meant to save.
 *
 * Every filter failure is fail-open: the original text is sent. This module
 * sits between the user's turn and the provider, so its worst acceptable
 * outcome is saving nothing.
 *
 * ### Why only `chat`
 *
 * pi-ai builds an OpenAI Chat-Completions body for both lanes
 * (`openAICompletionsApi().streamSimple` sets `api:'openai-completions'`), so
 * tool results arrive as `{role:'tool', content:'<string>'}` messages. The
 * `messages` and `responses` walkers are kept for parity with the ported source
 * and exercised by the unit checks, but no request this extension makes uses
 * them — and an unrecognised wire compacts nothing rather than guessing a shape.
 *
 * @module pi-extension/token-saver/index.js
 */

import { RAW_CAP, MIN_COMPRESS_SIZE } from './constants.js'
import { autoDetectFilter } from './autodetect.js'
import { safeApply } from './applyFilter.js'

/** One recorded compaction: which wire shape, which filter, how many bytes. */
export interface RtkHit {
  shape: string
  filter: string
  saved: number
}

/** What one pass measured. */
export interface RtkStats {
  enabled: boolean
  bytesBefore: number
  bytesAfter: number
  saved: number
  hits: RtkHit[]
}

/** The return of {@link compressRequest}: the payload plus its own bookkeeping. */
export interface RtkResult {
  payload: unknown
  stats: RtkStats
}

/**
 * Compact one text blob, adding the outcome to `stats`.
 *
 * The size gate lives here rather than in the filters so every shape shares it:
 * a blob under the minimum is left alone (markers would cost more than the
 * saving), a blob over the cap is left alone (regex over a runaway dump is pure
 * latency), and an unrecognised blob is left alone (no filter fits). When a
 * filter *does* run, its output still has to be non-empty and strictly smaller,
 * which is the last line of defence against a filter bug reaching the wire.
 *
 * Exported because callers holding a bare string (a tool result they built
 * themselves) should not have to wrap it in a fake message to compact it.
 *
 * @param text - the candidate blob
 * @param stats - mutated in place
 * @param shape - the wire shape label recorded on a hit
 * @returns the compacted text, or `text` unchanged
 */
export function compressText(text: string, stats: RtkStats, shape: string): string {
  const bytesIn = text.length
  stats.bytesBefore += bytesIn

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn
    return text
  }

  const fn = autoDetectFilter(text)
  if (!fn) {
    stats.bytesAfter += bytesIn
    return text
  }

  const out = safeApply(fn, text)

  // Safety: never return empty, never grow the input
  if (!out || out.length === 0 || out.length >= bytesIn) {
    stats.bytesAfter += bytesIn
    return text
  }

  stats.bytesAfter += out.length
  stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - out.length })
  return out
}

/**
 * Compact one wire's tool output, in place.
 *
 * The payload is mutated and returned under `payload` (the same reference the
 * caller passed) because that is how this plugin's other request stages work —
 * they adjust the body they were handed rather than allocating a copy. Pass
 * `{ enabled: false }` (or `false`) as the third argument for a per-request off
 * switch: the payload is then returned untouched and `stats.enabled` is false,
 * so a caller can log the decision without a second code path.
 *
 * `stats.bytesBefore`/`bytesAfter` measure only the tool-output text that was
 * considered, not the whole request, and they always satisfy
 * `bytesBefore - bytesAfter === saved` with `saved` equal to the sum of
 * `hits[].saved`.
 *
 * @param payload - the outgoing request body
 * @param wire - which dialect the body is in
 * @param options - per-request switch
 */
export function compressRequest(
  payload: unknown,
  wire: 'chat' | 'messages' | 'responses',
  options: boolean | { enabled?: boolean } = true,
): RtkResult {
  const enabled = resolveEnabled(options)
  const stats: RtkStats = { enabled, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] }
  if (!enabled) return { payload, stats }
  if (payload === null || typeof payload !== 'object') return { payload, stats }

  try {
    if (wire === 'chat') compressChatPayload(payload as Record<string, unknown>, stats)
    else if (wire === 'messages') compressMessagesPayload(payload as Record<string, unknown>, stats)
    else if (wire === 'responses') compressResponsesPayload(payload as Record<string, unknown>, stats)
  } catch (error) {
    console.warn(`[rtk] compressRequest error: ${error instanceof Error ? error.message : String(error)}`)
    // A blob whose walk threw was counted as "before" but never as "after";
    // putting the books back in order keeps the stats invariant true even on
    // the failure path (the blob is treated as passed through untouched).
    stats.bytesAfter = stats.bytesBefore - stats.hits.reduce((sum, hit) => sum + hit.saved, 0)
  }

  stats.saved = stats.bytesBefore - stats.bytesAfter
  return { payload, stats }
}

/** `chat`: OpenAI Chat Completions — `{role:'tool'}` results, string or text blocks. */
function compressChatPayload(payload: Record<string, unknown>, stats: RtkStats) {
  const items = Array.isArray(payload.messages) ? payload.messages as unknown[] : []
  for (const msg of items) {
    if (!msg || typeof msg !== 'object') continue
    const entry = msg as Record<string, unknown>
    // Assistant turns carry the model's own `tool_calls`; those arguments are
    // the model's input to the tool, not its output, and rewriting them would
    // change what the tool was asked to do.
    if (entry.role !== 'tool') continue
    if (typeof entry.content === 'string') {
      entry.content = compressText(entry.content, stats, 'openai-tool')
      continue
    }
    if (!Array.isArray(entry.content)) continue
    for (const part of entry.content as unknown[]) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
        && typeof (part as Record<string, unknown>).text === 'string') {
        (part as Record<string, unknown>).text = compressText(
          (part as Record<string, unknown>).text as string, stats, 'openai-tool-array')
      }
    }
  }
}

/** `messages`: Anthropic — `tool_result` blocks inside a user turn. */
function compressMessagesPayload(payload: Record<string, unknown>, stats: RtkStats) {
  const items = Array.isArray(payload.messages) ? payload.messages as unknown[] : []
  for (const msg of items) {
    if (!msg || typeof msg !== 'object') continue
    const content = (msg as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const block of content as unknown[]) {
      if (!block || typeof block !== 'object') continue
      const entry = block as Record<string, unknown>
      if (entry.type !== 'tool_result') continue
      // An errored tool result is the model's only evidence of the failure.
      if (entry.is_error === true) continue
      if (typeof entry.content === 'string') {
        entry.content = compressText(entry.content, stats, 'claude-string')
        continue
      }
      if (!Array.isArray(entry.content)) continue
      for (const part of entry.content as unknown[]) {
        if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
          && typeof (part as Record<string, unknown>).text === 'string') {
          (part as Record<string, unknown>).text = compressText(
            (part as Record<string, unknown>).text as string, stats, 'claude-array')
        }
      }
    }
  }
}

/** `responses`: OpenAI Responses — `function_call_output` items in `input`. */
function compressResponsesPayload(payload: Record<string, unknown>, stats: RtkStats) {
  const items = Array.isArray(payload.input) ? payload.input as unknown[] : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (entry.type !== 'function_call_output') continue
    if (typeof entry.output === 'string') {
      entry.output = compressText(entry.output, stats, 'openai-responses-string')
      continue
    }
    if (!Array.isArray(entry.output)) continue
    for (const part of entry.output as unknown[]) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'input_text'
        && typeof (part as Record<string, unknown>).text === 'string') {
        (part as Record<string, unknown>).text = compressText(
          (part as Record<string, unknown>).text as string, stats, 'openai-responses-array')
      }
    }
  }
}

/**
 * A one-line human summary of a pass, for a UI or a log line the user reads.
 *
 * Returns `null` only when there is nothing to say — no stats, or the pass was
 * switched off — so a caller can treat null as "do not print". An enabled pass
 * with no hits still gets a line: "(0%) — no tool output compacted" is a useful
 * fact (the saver ran and found nothing), and silence would look like the saver
 * never ran at all.
 */
export function describeSavings(stats: RtkStats | null | undefined): string | null {
  if (!stats || stats.enabled === false) return null
  const before = Number.isFinite(stats.bytesBefore) ? stats.bytesBefore : 0
  const after = Number.isFinite(stats.bytesAfter) ? stats.bytesAfter : 0
  const saved = before - after
  const pct = before > 0 ? Math.round((saved / before) * 100) : 0
  const hits = Array.isArray(stats.hits) ? stats.hits : []
  const filters = Array.from(new Set(hits.map((hit) => hit.filter)))
  if (hits.length === 0) {
    return `[token-saver] ${humanBytes(before)} -> ${humanBytes(after)} (0%) — no tool output compacted`
  }
  return `[token-saver] ${humanBytes(before)} -> ${humanBytes(after)} (${pct}%) via ${filters.join(', ')} (${hits.length} blocks)`
}

/** Byte count as a human would read it: B below 1 KiB, one decimal above. */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * Normalise the third argument of {@link compressRequest}: a boolean, or an
 * options object whose `enabled` flag is honoured (anything but an explicit
 * `false` means on, so a missing option is the enabled default).
 */
function resolveEnabled(options: boolean | { enabled?: boolean } | undefined | null): boolean {
  if (options === undefined || options === null) return true
  if (typeof options === 'object') return options.enabled !== false
  return options !== false
}
