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

/**
 * The accumulated savings total.
 *
 * A `RtkStats` describes **one** request; this describes **many**. The panel and
 * the usage record both want the running total, so it is computed by adding each
 * request's report into the same shape rather than re-deriving it from rows that
 * were each rounded separately.
 *
 * Ported from dsh's `src/token-saver.js` (`emptySavings`, `addSavings`,
 * `savingsPercent`, `describeSavingsTotal`).
 */
export interface SavingsTotal {
  bytesBefore: number
  bytesAfter: number
  saved: number
  blocks: number
  calls: number
  promptCalls: number
}

/** A total with nothing counted. */
export function emptySavings(): SavingsTotal {
  return { bytesBefore: 0, bytesAfter: 0, saved: 0, blocks: 0, calls: 0, promptCalls: 0 }
}

/** Fold one request's report into the running total. */
export function addSavings(total: SavingsTotal | null | undefined, report: any): SavingsTotal {
  const base = total ?? emptySavings()
  const blocks = Array.isArray(report?.rtk?.hits) ? report.rtk.hits.length : 0
  return {
    bytesBefore: base.bytesBefore + (Number(report?.bytesBefore) || 0),
    bytesAfter: base.bytesAfter + (Number(report?.bytesAfter) || 0),
    saved: base.saved + (Number(report?.saved) || 0),
    blocks: base.blocks + blocks,
    calls: base.calls + 1,
    promptCalls: base.promptCalls + (report?.prompt?.injected === true ? 1 : 0),
  }
}

/** The saved share of what was sent, as a whole percent. */
export function savingsPercent(total: SavingsTotal | null | undefined): number {
  const before = Number(total?.bytesBefore) || 0
  const saved = Number(total?.saved) || 0
  if (before <= 0) return 0
  return Math.round(saved / before * 100)
}

/** The one-line summary the panel prints above its own rows. */
export function describeSavingsTotal(total: SavingsTotal | null | undefined): string {
  const safe = total ?? emptySavings()
  const percent = savingsPercent(safe)
  if (safe.calls === 0) return 'token saver: no requests measured yet'
  return `token saver: ${humanBytes(safe.saved)} saved over ${safe.calls} request(s) (${percent}%), ${safe.blocks} block(s) compacted`
}

/**
 * The token-saving pipeline, as one entry the adapter calls per attempt.
 *
 * Three independent savers run over one outbound payload, in this order:
 *
 * 1. **Prompt shaping** (`prompts.ts` + `inject.ts`) — a terse-response or
 *    YAGNI instruction appended to the system prompt. This changes what the
 *    model *writes*, so it is the only saver that can reduce output tokens.
 * 2. **Tool-output compaction** (`compressRequest` above) — the largest single
 *    win on an agent turn, and the one saver invisible to the model's
 *    reasoning: the compacted text is what the model reads.
 * 3. Nothing else. Response-side trimming is deliberately absent — the
 *    reasoning channel is measured rather than muzzled.
 *
 * Every saver is fail-open and independently switchable, and the pipeline
 * reports what it did in bytes so a panel shows a measurement instead of a
 * claim. A saver that throws is a saver that is skipped: a request must never
 * fail because the thing that was supposed to make it cheaper broke.
 *
 * Ported from dsh's `src/token-saver/index.js` (the pipeline entry itself; the
 * savers it drives were already ported here).
 *
 * @module pi-extension/token-saver/index.js
 */

import { activePrompts } from './prompts.js'
import { injectSystem } from './inject.js'

/** Prompt families this pipeline knows, for the settings schema and the UI. */
export const PROMPT_FAMILIES = ['caveman', 'ponytail']

/**
 * Read the `tokenSaver` settings section into the shape the pipeline wants.
 *
 * Every field is optional and every default is "off" except RTK, which is the
 * only saver whose output the user can verify at a glance (the compacted tool
 * result is right there in the transcript) and the only one that cannot change
 * the model's behaviour. A prompt-level saver changes the assistant's voice, so
 * it is opt-in.
 */
export function saverConfig(settings: any): any {
  const section = settings?.tokenSaver ?? {}
  const prompts = section.prompts ?? {}
  return {
    enabled: section.enabled !== false,
    rtk: section.rtk !== false,
    caveman: PROMPT_FAMILIES.includes('caveman') ? String(prompts.caveman ?? 'off') : 'off',
    ponytail: String(prompts.ponytail ?? 'off'),
    /** Per-request header/query opt-out is handled by the caller; this is the
     *  stored preference only. */
  }
}

/**
 * Run every saver over one payload, in place.
 *
 * Mutating in place is what the adapter expects: `buildPayload` hands back a
 * fresh object per attempt, `applyFingerprint` already mutates it, and the
 * continuation path re-builds rather than reusing. Returning a copy would make
 * the fingerprint's rename map and the payload disagree about which object is
 * on the wire.
 */
export function applyTokenSavers(payload: any, wire: 'chat' | 'messages' | 'responses', config: any): any {
  const report: any = { prompt: null, rtk: null, saved: 0, bytesBefore: 0, bytesAfter: 0, notes: [] }
  if (config?.enabled === false || payload === null || typeof payload !== 'object') return report

  // Prompt shaping first: the injected text is a system instruction, never a
  // tool result, so the order does not change RTK's input — but running it first
  // means the reported byte counts describe the payload that actually shipped.
  if (config.caveman !== 'off' || config.ponytail !== 'off') {
    try {
      const prompts = activePrompts({ caveman: config.caveman, ponytail: config.ponytail })
      if (prompts.length > 0) {
        const text = prompts.map((entry: any) => entry.text).join('\n\n')
        const result = injectSystem(payload, wire, text)
        report.prompt = { injected: result.injected === true, reason: result.reason ?? '', families: prompts.map((entry: any) => `${entry.id}:${entry.level}`) }
        if (result.injected !== true && result.reason !== undefined) report.notes.push(`prompt:${result.reason}`)
      }
    } catch (error: any) {
      report.notes.push(`prompt-failed:${error?.message ?? error}`)
    }
  }

  if (config.rtk !== false) {
    try {
      const result = compressRequest(payload, wire, true)
      report.rtk = result.stats
      report.saved = Number(result.stats?.saved) || 0
      report.bytesBefore = Number(result.stats?.bytesBefore) || 0
      report.bytesAfter = Number(result.stats?.bytesAfter) || 0
    } catch (error: any) {
      report.notes.push(`rtk-failed:${error?.message ?? error}`)
    }
  }
  return report
}

/**
 * The Kiro/CodeWhisperer wire's tool results, compacted in place.
 *
 * Amazon's agent wire carries results under
 * `conversationState.history[].userInputMessage.userInputMessageContext.toolResults`,
 * not under `messages` — the same compaction, reached through a deeper path.
 * An error result is preserved untouched: the trace of *why* a tool failed is
 * the single most valuable thing in a conversation that is being retried.
 *
 * Ported from dsh's `src/token-saver/rtk/index.js` (the wire shape
 * `compressRequest` above does not cover).
 *
 * @module pi-extension/token-saver/index.js
 */
export function compressMessages(body: any, enabled: boolean): any {
  if (!enabled || !body) return null
  if (body.conversationState) return compressKiroFormat(body, enabled)
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null
  if (!items) return null
  return compressRequest(body, Array.isArray(body.input) ? 'responses' : 'chat', enabled).stats
}

function compressKiroFormat(body: any, _enabled: boolean): any {
  const stats: RtkStats = { enabled: true, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] }
  try {
    const state = body.conversationState
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])]
    if (state?.currentMessage) allMessages.push(state.currentMessage)

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults
      if (!Array.isArray(toolResults)) continue

      for (const tr of toolResults) {
        if (tr.status === 'error') continue // preserve error traces
        if (!Array.isArray(tr.content)) continue

        for (const part of tr.content) {
          if (part && typeof part.text === 'string') {
            part.text = compressText(part.text, stats, 'kiro-tool-result')
          }
        }
      }
    }
  } catch (error: any) {
    console.warn(`[RTK] compressKiroFormat error: ${error?.message ?? error}`)
    return null
  }
  stats.saved = stats.bytesBefore - stats.bytesAfter
  return stats
}

/** One log line for a completed pass, or `null` when there is nothing to report. */
export function formatRtkLog(stats: any): string | null {
  if (!stats || !stats.hits || stats.hits.length === 0) return null
  const saved = stats.bytesBefore - stats.bytesAfter
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : '0'
  const filters = Array.from(new Set(stats.hits.map((h: any) => h.filter))).join(',')
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`
}
