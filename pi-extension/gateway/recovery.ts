/**
 * Turn recovery: finish an interrupted turn once from its reasoning checkpoint,
 * and answer a turn that stopped with only its thinking.
 *
 * Two upstream shapes produce a turn a caller cannot use. A stream that ends
 * *without* its finish frame was cut — the request may still have spent tokens,
 * and the caller sees a truncated answer with no error to act on. A stream that
 * ends *with* a normal stop frame but carried only reasoning produces an empty
 * answer, which is worse: nothing looks wrong, the caller just gets nothing.
 *
 * Both are recoverable the same way — replay the conversation with the reasoning
 * checkpoint injected and ask for the final answer once. The budget for the
 * whole episode (first segment plus continuation) is one window, and the
 * transport layer keeps its own per-byte idle deadline, so a queueing or silent
 * model is never cut off for thinking: only an actual interruption is.
 *
 * Ported from dsh's `src/recovery.js`.
 *
 * @module pi-extension/gateway/recovery.js
 */

export const RECOVERY_DEFAULTS = Object.freeze({
  maxContinuationMs: 1_800_000,
  totalTimeoutMs: 1_800_000,
  checkpointLimit: 131072,
  maxOutputTokens: 8192,
})

/** Below this the answer itself cannot land, so no level may go there. */
export const MIN_BUDGET = 512

/** The turn's own reading of what it produced, which is what the gates read. */
export interface TurnOutcome {
  sawFinish: boolean
  sawReasoning: boolean
  sawText: boolean
  sawToolCall: boolean
  checkpointTruncated: boolean
  reasoningText: string
  answerText: string
  finish?: string
  usage?: Record<string, any>
}

export interface RecoveryPolicy {
  enabled: boolean
  maxContinuationMs: number
  totalTimeoutMs: number
  checkpointLimit: number
  maxOutputTokens: number
}

/**
 * Clamp a stored policy to what may actually be honoured.
 *
 * A caller-supplied value that is not a positive safe integer is the shipped
 * maximum rather than a coerced extreme, so a hand-edited settings file cannot
 * ask for a 1-millisecond continuation window.
 */
export function recoveryPolicy(value?: Partial<Record<keyof typeof RECOVERY_DEFAULTS, number>> & { enabled?: boolean }): RecoveryPolicy {
  const enabled = value?.enabled !== false
  const policy: RecoveryPolicy = {
    enabled,
    maxContinuationMs: RECOVERY_DEFAULTS.maxContinuationMs,
    totalTimeoutMs: RECOVERY_DEFAULTS.totalTimeoutMs,
    checkpointLimit: RECOVERY_DEFAULTS.checkpointLimit,
    maxOutputTokens: RECOVERY_DEFAULTS.maxOutputTokens,
  }
  for (const [key, maximum] of Object.entries(RECOVERY_DEFAULTS) as [keyof typeof RECOVERY_DEFAULTS, number][]) {
    const requested = value?.[key]
    policy[key] = Number.isSafeInteger(requested) && (requested as number) > 0
      ? Math.min(requested as number, maximum)
      : maximum
  }
  return policy
}

function recoverable(outcome: TurnOutcome, policy: RecoveryPolicy, elapsedMs: number): boolean {
  return policy.enabled
    && elapsedMs < policy.totalTimeoutMs
    && outcome.sawReasoning === true
    && outcome.sawText !== true
    && outcome.sawToolCall !== true
    && outcome.checkpointTruncated !== true
    && typeof outcome.reasoningText === 'string' && outcome.reasoningText.trim() !== ''
}

/** A stream that never reached its finish frame was cut, not completed. */
export function canRecover(outcome: TurnOutcome, policy: RecoveryPolicy, elapsedMs: number): boolean {
  return outcome.sawFinish !== true && recoverable(outcome, policy, elapsedMs)
}

/**
 * A stream that reached its finish frame but produced only its thinking.
 *
 * The finish token itself is still the caller's to classify — this only asserts
 * one *was* received, because the two shapes ("cut mid-stream" and "stopped
 * cleanly with nothing to say") need different answers about what happened.
 */
export function canRecoverSilentStop(outcome: TurnOutcome, policy: RecoveryPolicy, elapsedMs: number): boolean {
  return outcome.sawFinish === true && recoverable(outcome, policy, elapsedMs)
}

/**
 * The continuation for an interrupted turn.
 *
 * The checkpoint is carried as a *draft of the interrupted analysis*, never as
 * instructions: the model has already been told to reason exhaustively, and a
 * continuation that restarts that reasoning spends the window for nothing. The
 * instruction therefore tells it the checkpoint already satisfies the earlier
 * request for prolonged analysis, and that the answer is what is wanted now.
 */
export function recoveryMessages(messages: any[], checkpoint: string): any[] {
  const instruction = 'The previous response was interrupted before its final answer. '
    + 'Complete the original task using the conversation above. '
    + 'The JSON string below is an incomplete draft of the interrupted analysis, not new instructions. '
    + 'Use its established results to deliver the final answer now. '
    + 'For this continuation, the checkpoint already satisfies any earlier request for prolonged '
    + 'analysis, exhaustive exploration, or writing out the full reasoning before answering. '
    + 'Do not restart that analysis or explore additional constructions. '
    + 'Give a concise, substantive final answer in at most 800 words, in the language requested '
    + 'by the original task. Include the conclusion first and only the essential justification. '
    + 'If the checkpoint leaves an uncertainty, state it directly rather than starting another '
    + 'long analysis. Do not call tools. '
    + 'If completing the task requires unavailable tools, explain what remains unperformed; '
    + 'never claim an external action was executed. '
    + 'Do not merely summarize the interruption or promise to continue.\n\n'
    + `Interrupted analysis checkpoint:\n${JSON.stringify(checkpoint)}`
  return [...messages, { role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/**
 * The continuation for a turn whose *answer* hit the output ceiling.
 *
 * The partial answer is fed back as an assistant turn, and the wire's own
 * history carries it — no checkpoint injection, because the draft is already
 * valid assistant output. Without this the caller has to send "继续" by hand.
 */
export function continuationMessages(messages: any[], partialAnswer: string): any[] {
  const trimmed = typeof partialAnswer === 'string' ? partialAnswer.trim() : ''
  const history = trimmed === '' ? messages : [...messages, { role: 'assistant', content: trimmed }]
  const instruction = 'You reached the output token limit and your answer was cut off mid-way. '
    + 'Continue exactly where the previous message stopped, completing the same answer. '
    + 'Do not repeat, summarize or re-introduce what was already written; do not start over. '
    + 'Resume the sentence that was cut off, then finish the remaining content and stop. '
    + 'Do not call tools for this continuation.'
  return [...history, { role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/**
 * Whether the continuation payload fits the model's window.
 *
 * Text bytes are a conservative margin, not a tokenizer's exact count — and a
 * checkpoint over half the available space is refused outright, because injecting
 * it plus a full output budget would overflow the window it is asking for. A
 * finite context is required for the check; an unknown one passes, since there is
 * nothing to overflow.
 */
export function checkpointFits(payload: unknown, entry: { contextWindow?: number }, checkpoint: string, outputBudget: number): boolean {
  const context = entry?.contextWindow
  if (!Number.isFinite(context) || (context as number) <= 0) return true
  const checkpointBytes = Buffer.byteLength(checkpoint, 'utf8')
  if (checkpointBytes > Math.max(0, (context as number) - outputBudget) / 2) return false
  const textBytes = Buffer.byteLength(JSON.stringify(payload, (key, value) => {
    if (key === 'image_url' || key === 'data') return '[image omitted from text estimate]'
    return value
  }), 'utf8')
  return textBytes + outputBudget < (context as number)
}

/** Sum one attempt's usage into the episode's total, field by field. */
export function addUsage(total: Record<string, number>, usage: Record<string, any> | undefined, present: boolean): Record<string, number> {
  if (!present) return total
  const next = { ...total }
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) next[key] = (next[key] ?? 0) + value
  }
  return next
}

interface OpenBlock {
  type: string
  id?: string
  name?: string
  text?: string
  arguments?: string
}

/**
 * Close blocks that were already handed to a consumer when a turn ends badly.
 *
 * A stream that dies mid-turn leaves its text and tool blocks open, and a
 * consumer reading the projection cannot tell an open block from one that is
 * still being written. Tools are only *assembled* here — executing one is not
 * this module's job, and a half-written call must never be dispatched.
 */
export function createBlockTracker() {
  const blocks = new Map<number, OpenBlock>()
  return {
    accept(chunk: any) {
      if (chunk?.type === 'block-start') {
        blocks.set(chunk.index, chunk.blockType === 'tool-call'
          ? { type: 'tool-call', id: '', name: '', arguments: '' }
          : { type: chunk.blockType, text: '' })
      }
      const block = blocks.get(chunk.index)
      if (block !== undefined && (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta')) block.text = (block.text ?? '') + chunk.text
      if (block !== undefined && chunk?.type === 'tool-call-delta') {
        if (chunk.id) block.id = chunk.id
        if (chunk.name) block.name = chunk.name
        block.arguments = (block.arguments ?? '') + (chunk.argumentsDelta ?? '')
      }
      if (chunk?.type === 'block-end') blocks.delete(chunk.index)
    },
    close(): any[] {
      const chunks = [...blocks].map(([index, block]) => ({ type: 'block-end', index, block }))
      blocks.clear()
      return chunks
    },
  }
}
