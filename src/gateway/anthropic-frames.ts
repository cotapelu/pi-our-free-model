/**
 * Anthropic wire frames, in the shape the forward listener streams them.
 *
 * `anthropic.ts` carries the request-side codec (`fromAnthropicRequest`) and
 * the token estimate; this module is the *response* half — the event frames a
 * Chat/Responses stream is rewritten into, the assembled non-streaming
 * `anthropicMessage`, the outcome folder, and the exact token count the
 * `/v1/messages` wire answers with. They live beside the listener that calls
 * them because they are write-only code: nothing else in the port reads them.
 *
 * Ported from dsh's `src/anthropic.js`.
 *
 * @module pi-extension/gateway/anthropic-frames.js
 */

import { carryFailure, forwardFailureWire } from '../failure.js'

const CHARS_PER_TOKEN = 4
const IMAGE_TOKENS = 1024
const TOOL_FRAME_TOKENS = 8
/** Fixed framing overhead, so an empty body still answers a small non-zero
 *  number instead of 0 (a client that divides by the count must not see 0). */
const BASE_TOKENS = 16


function isObj(value: any) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function num(value: any) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: any) {
  return typeof value === 'string' ? value : ''
}


function flattenSystem(system: any) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  const parts = []
  for (const block of system) {
    if (typeof block === 'string') {
      if (block !== '') parts.push(block)
      continue
    }
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

function sseFrame(event: any, payload: any) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

function contentDelta(index: any, delta: any) {
  return sseFrame('content_block_delta', { type: 'content_block_delta', index, delta })
}

/** Repair a caller-built state object in place, so a partially seeded state is
 *  usable instead of producing `undefined` indices. */
function ensureState(state: any) {
  if (!Number.isSafeInteger(state.blockIndex) || state.blockIndex < 0) state.blockIndex = 0
  if (state.openBlock === undefined) state.openBlock = null
  if (!(state.toolSlots instanceof Map)) state.toolSlots = new Map()
  if (num(state.inputTokens) === undefined) state.inputTokens = 0
  if (num(state.outputTokens) === undefined) state.outputTokens = 0
}

/** Close the open text/thinking block, if one is open. */
function closeStreamingBlock(frames: any, state: any) {
  if (state.openBlock !== 'text' && state.openBlock !== 'thinking') return
  frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: state.openIndex }))
  state.openBlock = null
  state.openIndex = null
}

/** Open (or keep) a text/thinking block. */
function openStreamingBlock(frames: any, state: any, kind: any) {
  if (state.openBlock === kind) return
  closeStreamingBlock(frames, state)
  const index = state.blockIndex++
  state.openIndex = index
  state.openBlock = kind
  const content_block = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' }
  frames.push(sseFrame('content_block_start', { type: 'content_block_start', index, content_block }))
}

/** The per-slot renderer bookkeeping for one harness tool block. */
function toolSlot(state: any, key: any) {
  let slot = state.toolSlots.get(key)
  if (slot === undefined) {
    slot = { block: null, open: false, id: '', name: '', held: '' }
    state.toolSlots.set(key, slot)
  }
  return slot
}

/**
 * Open a tool_use block for a slot and spill whatever was held for it.
 *
 * Arguments are held until the call names itself (see `anthropicFrames`): an
 * Anthropic tool_use block cannot be announced without a name, and announcing
 * one with an empty name hands the client a call it cannot execute.
 */
function openToolBlock(frames: any, state: any, slot: any) {
  closeStreamingBlock(frames, state)
  const index = state.blockIndex++
  slot.block = index
  slot.open = true
  state.openBlock = 'tool_use'
  frames.push(sseFrame('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
  }))
  if (slot.held !== '') {
    frames.push(contentDelta(index, { type: 'input_json_delta', partial_json: slot.held }))
    slot.held = ''
  }
}

/** Close one tool block. Tool blocks are tracked per slot rather than through
 *  `openBlock` because parallel calls may be open at the same time. */
function closeToolBlock(frames: any, state: any, slot: any) {
  if (slot.open !== true) return
  frames.push(sseFrame('content_block_stop', { type: 'content_block_stop', index: slot.block }))
  slot.open = false
  const another = [...state.toolSlots.values()].some(other => other.open === true)
  if (!another && state.openBlock === 'tool_use') state.openBlock = null
}

/** Close every block still open, in the order they were opened. */
function closeAllBlocks(frames: any, state: any) {
  closeStreamingBlock(frames, state)
  for (const slot of state.toolSlots.values()) closeToolBlock(frames, state, slot)
}

/** Has any tool block actually been announced? Used for the stop_reason
 *  fallback: a nameless call that never opened a block is not one. */
function hasToolBlock(state: any) {
  for (const slot of state.toolSlots.values()) if (slot.block !== null) return true
  return false
}

/**
 * One harness chunk -> zero or more Anthropic SSE frames.
 *
 * The caller owns `state` and must seed it once per stream:
 *
 * ```js
 * const state = {
 *   messageId: 'msg_…', model, started: false, blockIndex: 0,
 *   openBlock: null, toolSlots: new Map(),
 *   inputTokens: 0, outputTokens: 0, stopReason: null,
 * }
 * ```
 *
 * Two implementation fields ride along in it: `openIndex` (the index of the
 * open text/thinking block — `openBlock` only names its kind) and, per
 * `toolSlots` entry, `block`/`open`/`held` (the announced index, whether it is
 * still open, and argument fragments held until the call names itself).
 *
 * Block discipline:
 *
 * - `message_start` is emitted once, before the first chunk's own frames, with
 *   the input count the state already carries (a caller that ran `countTokens`
 *   can seed it; otherwise the real count arrives later and is repeated in
 *   `message_delta`).
 * - One text/thinking block is open at a time; a delta of the other kind closes
 *   it first. Tool blocks are the exception: each is closed by its own
 *   `block-end`, so parallel tool calls can stream concurrently, which is
 *   exactly what index-keyed Anthropic clients expect (the alternative —
 *   closing a tool block to open another — would split one call's JSON across
 *   two blocks with the same id and make the client execute it twice).
 * - `usage` frames carry no frame of their own: Anthropic reports input tokens
 *   in `message_start` and output tokens in `message_delta`.
 *
 * @param {object} chunk - harness StreamChunk (`text-delta`, `reasoning-delta`,
 *   `tool-call-delta`, `block-end`, `usage`, `finish`; anything else is ignored)
 * @param {object} state - per-stream state, mutated in place
 * @returns {string[]} complete `event: …\ndata: …\n\n` frames
 */
export function anthropicFrames(chunk: any, state: any) {
  const frames: any[] = []
  if (!isObj(chunk) || !isObj(state)) return frames
  ensureState(state)
  if (state.started !== true) {
    state.started = true
    frames.push(sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: String(state.messageId ?? ''),
        type: 'message',
        role: 'assistant',
        model: String(state.model ?? ''),
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: state.inputTokens, output_tokens: 0 },
      },
    }))
  }

  switch (chunk.type) {
    case 'text-delta': {
      const text = str(chunk.text)
      if (text === '') break
      openStreamingBlock(frames, state, 'text')
      frames.push(contentDelta(state.openIndex, { type: 'text_delta', text }))
      break
    }

    case 'reasoning-delta': {
      const text = str(chunk.text)
      if (text === '') break
      openStreamingBlock(frames, state, 'thinking')
      frames.push(contentDelta(state.openIndex, { type: 'thinking_delta', thinking: text }))
      break
    }

    case 'tool-call-delta': {
      const slot = toolSlot(state, chunk.index)
      const fragment = str(chunk.argumentsDelta)
      if (slot.open === true) {
        if (fragment !== '') frames.push(contentDelta(slot.block, { type: 'input_json_delta', partial_json: fragment }))
        break
      }
      // The name can trail the first argument fragments on a relayed stream;
      // hold the fragments until the call can be announced with a name.
      if (slot.name === '' && typeof chunk.name === 'string' && chunk.name !== '') slot.name = chunk.name
      if (slot.id === '' && typeof chunk.id === 'string' && chunk.id !== '') slot.id = chunk.id
      if (slot.name === '') {
        slot.held += fragment
        break
      }
      // The held prefix goes out before this chunk's own fragment, so the
      // partial_json deltas reassemble in the order the arguments arrived.
      openToolBlock(frames, state, slot)
      if (fragment !== '') frames.push(contentDelta(slot.block, { type: 'input_json_delta', partial_json: fragment }))
      break
    }

    case 'block-end': {
      const block = isObj(chunk.block) ? chunk.block : {}
      if (block.type === 'tool-call') {
        const slot = toolSlot(state, chunk.index)
        if (slot.open === true) {
          closeToolBlock(frames, state, slot)
          break
        }
        // The block never opened: either the call carried no argument delta at
        // all (name only), or its name arrived only here. The block-end carries
        // the assembled arguments, so it replaces any fragments held from a
        // name-less prefix — they are that same string's prefix.
        if (slot.name === '') slot.name = str(block.name)
        if (slot.id === '') slot.id = str(block.id)
        slot.held = str(block.arguments)
        // A call that never learned a name is not executable: the harness
        // downgrades such a turn to max-tokens, and Anthropic's tool_use
        // requires a name, so announcing it would hand the client a call it
        // cannot run.
        if (slot.name === '') {
          slot.held = ''
          break
        }
        openToolBlock(frames, state, slot)
        closeToolBlock(frames, state, slot)
        break
      }
      if (block.type === 'text') {
        if (state.openBlock === 'text') closeStreamingBlock(frames, state)
        break
      }
      if (block.type === 'reasoning') {
        if (state.openBlock === 'thinking') closeStreamingBlock(frames, state)
        break
      }
      break
    }

    case 'usage': {
      const usage = isObj(chunk.usage) ? chunk.usage : {}
      const input = num(usage.inputTokens) ?? num(usage.input_tokens)
      const output = num(usage.outputTokens) ?? num(usage.output_tokens)
      if (input !== undefined) state.inputTokens = input
      if (output !== undefined) state.outputTokens = output
      break
    }

    case 'finish': {
      const reason = isObj(chunk.reason) ? chunk.reason : {}
      // Recorded before anything else: a caller driving this generator over a
      // stream it did not originate (the listener, which has to synthesize an
      // error frame when a turn throws after its headers went out) needs to know
      // the turn already closed its own stream — otherwise it appends a second
      // `message_stop`, which strict clients reject as a protocol error.
      state.finished = true
      closeAllBlocks(frames, state)
      // `error` and `aborted` have no Anthropic stop_reason to report: the
      // protocol answers a turn it could not finish with an error event, and
      // the stream ends there (the message_stop after it is what the client's
      // reader waits for before releasing the request). No message_delta goes
      // out, because a stop_reason would claim the turn ended on purpose.
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const carried = str(reason.failure?.message)
        const message = carried !== '' ? carried : reason.kind === 'aborted' ? 'request aborted' : 'our free model failed the turn'
        state.stopReason = null
        const failure = carryFailure(reason.failure, reason.kind)
        frames.push(sseFrame('error', { type: 'error', error: forwardFailureWire({ error: message, failure }, true).error }))
        frames.push(sseFrame('message_stop', { type: 'message_stop' }))
        break
      }
      const stopReason = reason.kind === 'max-tokens'
        ? 'max_tokens'
        : reason.kind === 'tool-calls' || hasToolBlock(state) ? 'tool_use' : 'end_turn'
      state.stopReason = stopReason
      frames.push(sseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        // `message_start` already carried input_tokens, but the harness reports
        // usage at the end of the turn; repeating the count here keeps a
        // client's final usage from staying at the 0 that went out first.
        usage: state.inputTokens > 0
          ? { input_tokens: state.inputTokens, output_tokens: state.outputTokens }
          : { output_tokens: state.outputTokens },
      }))
      frames.push(sseFrame('message_stop', { type: 'message_stop' }))
      break
    }

    default: break
  }
  return frames
}

/** The usage an outcome carries, in either spelling, as Anthropic counters.
 *  Accepting both lets `anthropicMessage` render an outcome folded by this
 *  module (`input_tokens`/`output_tokens`) or by index.js's OpenAI-side fold
 *  (`prompt_tokens`/`completion_tokens`). */
function usageOf(usage: any) {
  const input = num(usage?.input_tokens) ?? num(usage?.inputTokens) ?? num(usage?.prompt_tokens)
  const output = num(usage?.output_tokens) ?? num(usage?.outputTokens) ?? num(usage?.completion_tokens)
  return { input: input ?? 0, output: output ?? 0 }
}

/**
 * Tool arguments -> the `input` object of a `tool_use` block.
 *
 * Unparseable arguments become `{}`, and the raw fragment is deliberately not
 * echoed anywhere: Anthropic's `input` is typed as an object, so there is no
 * field that could carry the broken text, and a call with empty input fails
 * loudly at execution time — the model sees an error and can retry — whereas
 * dropping the block would erase a call the model believes it made. The same
 * choice covers JSON that parses to a non-object (a bare string or array):
 * Anthropic's schema rejects it, so it is not passed through.
 */
function parseInput(argumentsText: any) {
  if (typeof argumentsText !== 'string' || argumentsText.trim() === '') return {}
  try {
    const parsed = JSON.parse(argumentsText)
    return isObj(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Non-streaming: fold an outcome into one Anthropic Message object.
 *
 * The outcome is the shape `foldAnthropicOutcome` (or index.js's
 * `foldForwardOutcome`) accumulates. Content order follows Anthropic's rule
 * that a thinking block precedes the answer: thinking, then text, then one
 * `tool_use` block per call. The thinking block carries no `signature` — no
 * valid signature exists on this side of the wire, and an empty string would
 * be a lie a replaying client could not verify; the block is informational
 * here, and the plugin never sends it back upstream.
 *
 * An errored outcome still renders a well-formed message (so a caller that
 * ignores `error` gets an object, not `undefined`), with `stop_reason`
 * `end_turn`; the endpoint is expected to check `outcome.error` first and
 * answer with an HTTP error instead.
 *
 * @param {object} outcome - `{text, thinking, toolCalls:[{id,name,arguments}],
 *   usage, truncated, error}`
 * @param {{model?: string, id?: string}} identity - the message id and model
 *   the endpoint minted for this response
 * @returns {object} Anthropic Message
 */
export function anthropicMessage(outcome: any, { model, id }: any = {}) {
  const text = str(outcome?.text)
  const thinking = str(outcome?.thinking)
  const calls = Array.isArray(outcome?.toolCalls) ? outcome.toolCalls : []
  const content = []
  if (thinking !== '') content.push({ type: 'thinking', thinking })
  if (text !== '') content.push({ type: 'text', text })
  for (const call of calls) {
    content.push({
      type: 'tool_use',
      id: String(call?.id ?? ''),
      name: String(call?.name ?? ''),
      input: parseInput(call?.arguments),
    })
  }
  const usage = usageOf(outcome?.usage)
  return {
    id: String(id ?? ''),
    type: 'message',
    role: 'assistant',
    model: String(model ?? ''),
    content,
    // A ceiling cut wins over a tool call: the harness downgrades a call whose
    // JSON the ceiling cut mid-string to max-tokens, and reporting `tool_use`
    // for it is how a client ends up executing a truncated call.
    stop_reason: outcome?.truncated === true ? 'max_tokens' : calls.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  }
}

/** Harness usage -> the Anthropic spelling stored on an outcome. */
function toAnthropicUsage(usage: any) {
  if (!isObj(usage)) return undefined
  const input = num(usage.inputTokens) ?? num(usage.input_tokens) ?? num(usage.prompt_tokens)
  const output = num(usage.outputTokens) ?? num(usage.output_tokens) ?? num(usage.completion_tokens)
  if (input === undefined && output === undefined) return undefined
  const reasoning = num(usage.reasoningTokens)
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: (input ?? 0) + (output ?? 0),
    ...reasoning === undefined || reasoning <= 0 ? {} : { reasoning_tokens: reasoning },
  }
}

/**
 * Fold one harness chunk into the outcome object — the Anthropic-side twin of
 * index.js's `foldForwardOutcome`.
 *
 * The caller seeds the outcome exactly as the OpenAI path does:
 * `{text:'', thinking:'', toolCalls:[], usage:undefined, truncated:false,
 * error:undefined}`. Tool calls merge by the harness block index (the `slot`
 * field), mirroring `foldForwardOutcome`, because a call's fragments arrive as
 * several deltas and its block-end may be the only chunk that carries it.
 *
 * @param {object} outcome - mutated in place and returned
 * @param {object} chunk - harness StreamChunk
 * @returns {object} the same outcome
 */
export function foldAnthropicOutcome(outcome: any, chunk: any) {
  switch (chunk?.type) {
    case 'text-delta':
      outcome.text += str(chunk.text)
      break
    case 'reasoning-delta':
      outcome.thinking += str(chunk.text)
      break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find((candidate: any) => candidate.slot === chunk.index)
      if (call === undefined) {
        call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }
        outcome.toolCalls.push(call)
      } else {
        call.arguments += chunk.argumentsDelta ?? ''
      }
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        // Match by slot first: the call's deltas were folded under this same
        // block index, and a relayed stream can carry its id late — matching
        // by id alone would miss the slot's entry and fold one call into two
        // (a phantom `tool_use` with an empty id and truncated arguments
        // beside the complete one). The block-end carries the assembled
        // arguments, so a slot match adopts them wholesale — the same
        // replacement the streaming renderer's `held` slot does — while an id
        // match (deltas under another slot) only fills identity fields.
        const bySlot = outcome.toolCalls.find((candidate: any) => candidate.slot === chunk.index)
        if (bySlot !== undefined) {
          bySlot.id = str(chunk.block.id) !== '' ? chunk.block.id : bySlot.id
          bySlot.name = str(chunk.block.name) !== '' ? chunk.block.name : bySlot.name
          if (typeof chunk.block.arguments === 'string') bySlot.arguments = chunk.block.arguments
          break
        }
        const byId = outcome.toolCalls.find((candidate: any) => candidate.id !== '' && candidate.id === chunk.block.id)
        if (byId === undefined) {
          outcome.toolCalls.push({
            slot: chunk.index,
            id: str(chunk.block.id),
            name: str(chunk.block.name),
            arguments: str(chunk.block.arguments),
          })
        }
      }
      break
    case 'usage':
      outcome.usage = toAnthropicUsage(chunk.usage)
      break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
        outcome.failure = carryFailure(chunk.reason.failure, chunk.reason.kind)
        outcome.error = outcome.failure.message
      }
      break
    default: break
  }
  return outcome
}

/**
 * Cheap token estimate for `POST /v1/messages/count_tokens`.
 *
 * This is an estimate, not a tokenizer: the plugin ships none, and the free
 * lane bills on its own accounting. The heuristic charges one token per four
 * characters of text (system prompt, message text, thinking, tool arguments and
 * tool results alike), a flat 1024 tokens per image — a base64 payload carries
 * no dimensions to price properly — plus one token per four characters of the
 * serialized tool schemas and 8 tokens of framing per tool. A fixed 16-token
 * request overhead keeps an empty body from answering 0, which a client that
 * divides by the count would turn into an error.
 *
 * @param {object} body - an Anthropic Messages request body (may be partial)
 * @returns {{input_tokens: number}}
 */
export function countTokens(body: any) {
  let textChars = flattenSystem(body?.system).length
  let images = 0
  const rows = Array.isArray(body?.messages) ? body.messages : []
  for (const row of rows) {
    const blocks = Array.isArray(row?.content)
      ? row.content
      : typeof row?.content === 'string' ? [{ type: 'text', text: row.content }] : []
    for (const block of blocks) {
      if (block?.type === 'text') textChars += str(block.text).length
      else if (block?.type === 'image') images += 1
      else if (block?.type === 'tool_use') textChars += str(block.name).length + JSON.stringify(block.input ?? {}).length
      else if (block?.type === 'tool_result') {
        if (typeof block.content === 'string') textChars += block.content.length
        else if (Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner?.type === 'text') textChars += str(inner.text).length
            else if (inner?.type === 'image') images += 1
          }
        }
      } else if (block?.type === 'thinking') textChars += str(block.thinking).length
      else if (block?.type === 'redacted_thinking') textChars += str(block.data).length
    }
  }
  let toolChars = 0
  let toolCount = 0
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    if (!isObj(tool)) continue
    toolCount += 1
    toolChars += str(tool.name).length + str(tool.description).length + JSON.stringify(tool.input_schema ?? {}).length
  }
  const toolTokens = toolCount === 0 ? 0 : Math.ceil(toolChars / CHARS_PER_TOKEN) + toolCount * TOOL_FRAME_TOKENS
  return {
    input_tokens: BASE_TOKENS + Math.ceil(textChars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + toolTokens,
  }
}
