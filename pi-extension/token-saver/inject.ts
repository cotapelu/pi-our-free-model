/**
 * System-prompt injection for the three wires this provider builds.
 *
 * The prompt families in `./prompts.js` only matter once their text is inside the
 * outgoing body, and each wire keeps its system text somewhere else:
 * a `{role:'system'}` message on `chat`, the `system` field on `messages`
 * (a string or a list of blocks), and `instructions` or a system item on
 * `responses`. This module puts one prompt into whichever of those the body has,
 * exactly once, without disturbing anything around it.
 *
 * Idempotency and stripping share one mechanism: the injected text travels as a
 * marker-delimited segment
 *
 *     <!-- ofm-token-saver -->
 *     <prompt text>
 *     <!-- /ofm-token-saver -->
 *
 * The upstream RTK injector deduped on the raw prompt as an exact `\n\n`
 * delimited segment instead (`systemInject.js`, `hasPrompt`), but it never had to
 * take an injection back. This port needs `stripInjected` for the user-facing off
 * switch and for round-trip tests, and a bare prompt cannot be told apart from
 * the user's own system text of the same wording — so the segment carries a
 * marker, and stripping removes exactly the marked region plus the separator that
 * joined it to its neighbours. The exact-segment test itself is kept: a body is
 * "already injected" only when *this very* segment is present, so two different
 * prompts coexist and a re-injection of either is a no-op.
 *
 * Every failure is fail-open: an unrecognised wire or body shape changes nothing
 * and says so. This module sits between the user's turn and the provider, so its
 * worst acceptable outcome is injecting nothing.
 *
 * Ported from dsh's `src/token-saver/inject.js`.
 *
 * @module pi-extension/token-saver/inject.js
 */

/** Opens the injected region; its presence is what `hasInjected` reports. */
export const INJECT_MARKER = '<!-- ofm-token-saver -->'

/** Closes the region {@link INJECT_MARKER} opens; a cut needs both. */
const MARKER_END = '<!-- /ofm-token-saver -->'

/**
 * Joins prompt segments — the same `\n\n` this project's projectors use
 * (`messages.ts` joins system parts with it, and the sealed-lane pacing hint in
 * `adapter.ts` appends with it), so one system message reads the same however it
 * was assembled.
 */
const SEP = '\n\n'

/** Which wire a body is shaped for. */
export type Wire = 'chat' | 'messages' | 'responses'

export interface InjectResult {
  payload: any
  injected: boolean
  reason: 'injected' | 'already-injected' | 'no-text' | 'shape-not-recognised' | 'inject-failed'
}

export interface StripResult {
  payload: any
  stripped: boolean
  reason: 'stripped' | 'not-injected' | 'shape-not-recognised' | 'strip-failed'
}

const injected = (payload: any): InjectResult => ({ payload, injected: true, reason: 'injected' })
const notInjected = (payload: any, reason: InjectResult['reason']): InjectResult => ({ payload, injected: false, reason })
const asStripped = (payload: any): StripResult => ({ payload, stripped: true, reason: 'stripped' })
const notStripped = (payload: any, reason: StripResult['reason']): StripResult => ({ payload, stripped: false, reason })

/**
 * Put `text` into the body's system text, once.
 *
 * Mutates `payload` in place; the returned object carries the same reference so a
 * caller can chain without reassigning.
 */
export function injectSystem(payload: any, wire: Wire | string, text: string): InjectResult {
  try {
    if (payload === null || typeof payload !== 'object') return notInjected(payload, 'shape-not-recognised')
    if (typeof text !== 'string' || text === '') return notInjected(payload, 'no-text')
    const segment = `${INJECT_MARKER}${SEP}${text}${SEP}${MARKER_END}`
    if (wire === 'chat') return injectChat(payload, segment)
    if (wire === 'messages') return injectMessages(payload, segment)
    if (wire === 'responses') return injectResponses(payload, segment)
    return notInjected(payload, 'shape-not-recognised')
  } catch {
    // Fail-open: a frozen body (or one behind a proxy that throws on set) must
    // never fail the turn over a token-saving nicety.
    return notInjected(payload, 'inject-failed')
  }
}

/**
 * Remove every injected region, restoring what `injectSystem` was given.
 *
 * This is the user-facing off switch and the round-trip half of the tests.
 */
export function stripInjected(payload: any, wire: Wire | string): StripResult {
  try {
    if (payload === null || typeof payload !== 'object') return notStripped(payload, 'shape-not-recognised')
    if (wire === 'chat') return stripChat(payload)
    if (wire === 'messages') return stripMessages(payload)
    if (wire === 'responses') return stripResponses(payload)
    return notStripped(payload, 'shape-not-recognised')
  } catch {
    return notStripped(payload, 'strip-failed')
  }
}

/**
 * Does the body carry a complete injected region?
 *
 * A lone marker without its end is not a region — it is text someone else wrote,
 * and neither `stripInjected` nor this predicate will touch it.
 */
export function hasInjected(payload: any, wire: Wire | string): boolean {
  try {
    if (payload === null || typeof payload !== 'object') return false
    if (wire === 'chat') {
      const messages = payload.messages
      if (!Array.isArray(messages)) return false
      return messages.some((message: any) => isSystem(message) && contentHasRegion(message.content))
    }
    if (wire === 'messages') {
      if (!Array.isArray(payload.messages)) return false
      return contentHasRegion(payload.system)
    }
    if (wire === 'responses') {
      if (hasRegion(payload.instructions)) return true
      const input = payload.input
      if (!Array.isArray(input)) return false
      return input.some((item: any) => isResponsesSystem(item) && contentHasRegion(item.content))
    }
    return false
  } catch {
    return false
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────

const isSystem = (message: any): boolean => message !== null && typeof message === 'object'
  && (message.role === 'system' || message.role === 'developer')

const isResponsesSystem = (item: any): boolean => isSystem(item) && item.type === 'message'

/** Is the exact segment already present in a message's string or block content? */
function contentHasSegment(content: any, segment: string): boolean {
  if (typeof content === 'string') return content.includes(segment)
  if (Array.isArray(content)) {
    return content.some((block: any) => block !== null && typeof block === 'object'
      && typeof block.text === 'string' && block.text.includes(segment))
  }
  return false
}

/** Is a complete marker region present in a string or block content? */
function contentHasRegion(content: any): boolean {
  if (typeof content === 'string') return hasRegion(content)
  if (Array.isArray(content)) {
    return content.some((block: any) => block !== null && typeof block === 'object'
      && typeof block.text === 'string' && hasRegion(block.text))
  }
  return false
}

/**
 * The marker-delimited spans this module put there, as `[from, to)` pairs.
 *
 * The boundary rule is what makes the "not provably ours" promise true, and it is
 * the mirror of how `injectSystem` joins segments: a region it wrote always has
 * its opening marker at the start of the string or right after a `\n\n`, and its
 * closing marker followed by end-of-string or a `\n\n`. A marker that does not sit
 * on a boundary is text somebody else wrote, so it is skipped rather than cut to
 * — without the rule, a *lone* marker in the user's own system text preceded a
 * real region, and the cut ran from the user's marker all the way to the real
 * end, eating everything between.
 */
function markedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let from = text.indexOf(INJECT_MARKER)
  while (from !== -1) {
    const atBoundary = from === 0 || text.endsWith(SEP, from)
    if (atBoundary) {
      const end = text.indexOf(MARKER_END, from + INJECT_MARKER.length)
      if (end !== -1) {
        spans.push([from, end + MARKER_END.length])
        from = text.indexOf(INJECT_MARKER, end + MARKER_END.length)
        continue
      }
    }
    from = text.indexOf(INJECT_MARKER, from + INJECT_MARKER.length)
  }
  return spans
}

function hasRegion(text: any): boolean {
  if (typeof text !== 'string') return false
  return markedSpans(text).length > 0
}

/**
 * Remove every marker-delimited region from a string.
 *
 * Returns `null` when there is no complete region (nothing to do); otherwise the
 * string with each `INJECT_MARKER … MARKER_END` span gone, **including** the
 * `\n\n` that joined it to its neighbours — that separator is what makes
 * `stripInjected` restore the body byte-for-byte. A lone marker is left alone: it
 * is not provably ours, and cutting to an assumed boundary could eat user text.
 */
function cutMarked(content: string): string | null {
  const spans = markedSpans(content)
  if (spans.length === 0) return null
  // Removed back to front, so an earlier cut never shifts a later span's indices.
  let next = content
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    // The separator is part of the region: that is what makes a strip restore the
    // body byte for byte rather than leaving the `\n\n` it was joined with behind.
    let [from, to] = spans[i]
    if (next.startsWith(SEP, to)) to += SEP.length
    else if (from >= SEP.length && next.slice(from - SEP.length, from) === SEP) from -= SEP.length
    next = next.slice(0, from) + next.slice(to)
  }
  return next
}

// ── chat (OpenAI Chat Completions) ───────────────────────────────────────────

function injectChat(payload: any, segment: string): InjectResult {
  const messages = payload.messages
  if (!Array.isArray(messages)) return notInjected(payload, 'shape-not-recognised')
  if (messages.some((message: any) => isSystem(message) && contentHasSegment(message.content, segment))) {
    return notInjected(payload, 'already-injected')
  }
  const target = chatSystemMessage(messages)
  if (target === undefined) {
    messages.unshift({ role: 'system', content: segment })
    return injected(payload)
  }
  appendChatSegment(target, segment)
  return injected(payload)
}

/**
 * The message to append to.
 *
 * `messages[0]` is checked first because that is where `buildPayload` and the
 * sealed-lane pacing hint both keep the system turn; any later system or
 * developer turn is still preferred over adding a second one, which is the
 * upstream behaviour and keeps one system message per body.
 */
function chatSystemMessage(messages: any[]): any {
  const first = messages[0]
  if (isSystem(first)) return first
  return messages.find((message: any) => isSystem(message))
}

function appendChatSegment(message: any, segment: string): void {
  const content = message.content
  if (typeof content === 'string') {
    message.content = content === '' ? segment : `${content}${SEP}${segment}`
    return
  }
  if (Array.isArray(content)) {
    content.push({ type: 'text', text: segment })
    return
  }
  message.content = segment
}

function stripChat(payload: any): StripResult {
  const messages = payload.messages
  if (!Array.isArray(messages)) return notStripped(payload, 'shape-not-recognised')
  let changed = false
  // Backwards, so a splice does not shift the indices still to visit.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!isSystem(message)) continue
    const content = message.content
    if (typeof content === 'string') {
      const cut = cutMarked(content)
      if (cut === null) continue
      changed = true
      // An emptied system message is the shell a whole-message injection leaves
      // behind; removing it restores "no system message" exactly. An original
      // empty-string system message is indistinguishable, and no projector in
      // this project emits one.
      if (cut === '') messages.splice(i, 1)
      else message.content = cut
      continue
    }
    if (!Array.isArray(content)) continue
    let anyBlockChanged = false
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const block = content[j]
      if (block === null || typeof block !== 'object' || typeof block.text !== 'string') continue
      const cut = cutMarked(block.text)
      if (cut === null) continue
      anyBlockChanged = true
      if (cut === '') content.splice(j, 1)
      else block.text = cut
    }
    if (!anyBlockChanged) continue
    changed = true
    if (content.length === 0) messages.splice(i, 1)
  }
  return changed ? asStripped(payload) : notStripped(payload, 'not-injected')
}

// ── messages (Anthropic Messages) ────────────────────────────────────────────

function injectMessages(payload: any, segment: string): InjectResult {
  // An Anthropic body is identified by its `messages` list; the `system` field is
  // optional on this wire (`toClaudeMessages` reports `undefined` for an empty
  // system text), so an absent `system` is a shape to fill, not a failure — but a
  // body without `messages` is not a Messages body at all.
  if (!Array.isArray(payload.messages)) return notInjected(payload, 'shape-not-recognised')
  const system = payload.system
  if (typeof system === 'string') {
    if (system.includes(segment)) return notInjected(payload, 'already-injected')
    payload.system = system === '' ? segment : `${system}${SEP}${segment}`
    return injected(payload)
  }
  if (Array.isArray(system)) {
    if (system.some((block: any) => block !== null && typeof block === 'object'
      && typeof block.text === 'string' && block.text.includes(segment))) {
      return notInjected(payload, 'already-injected')
    }
    const block = { type: 'text', text: segment }
    // Insert *before* the last cache_control block, never after it. The provider
    // caches the prompt prefix up to that breakpoint, so text appended past it
    // would be the one part of the system prompt processed and billed uncached on
    // every turn — exactly the cost the injection exists to avoid. Anchoring the
    // new block inside the cached prefix keeps the caller's breakpoint as the last
    // block, so it still terminates the list and the whole system prompt stays
    // cache-eligible.
    let lastCached = -1
    for (let i = system.length - 1; i >= 0; i -= 1) {
      if (system[i]?.cache_control) { lastCached = i; break }
    }
    if (lastCached >= 0) system.splice(lastCached, 0, block)
    else system.push(block)
    return injected(payload)
  }
  if (system === undefined || system === null) {
    payload.system = segment
    return injected(payload)
  }
  return notInjected(payload, 'shape-not-recognised')
}

function stripMessages(payload: any): StripResult {
  if (!Array.isArray(payload.messages)) return notStripped(payload, 'shape-not-recognised')
  const system = payload.system
  if (typeof system === 'string') {
    const cut = cutMarked(system)
    if (cut === null) return notStripped(payload, 'not-injected')
    // `toClaudeMessages` reports an empty system as `undefined`, never as `''`,
    // so an emptied field is restored by removing it.
    if (cut === '') delete payload.system
    else payload.system = cut
    return asStripped(payload)
  }
  if (Array.isArray(system)) {
    let changed = false
    for (let i = system.length - 1; i >= 0; i -= 1) {
      const block = system[i]
      if (block === null || typeof block !== 'object' || typeof block.text !== 'string') continue
      const cut = cutMarked(block.text)
      if (cut === null) continue
      changed = true
      if (cut === '') system.splice(i, 1)
      else block.text = cut
    }
    return changed ? asStripped(payload) : notStripped(payload, 'not-injected')
  }
  return notStripped(payload, 'not-injected')
}

// ── responses (OpenAI Responses) ─────────────────────────────────────────────

function injectResponses(payload: any, segment: string): InjectResult {
  // `instructions` is the dedicated field and wins when present, matching the
  // upstream dispatch: a body carrying both must not have its system text split
  // across two places.
  if (typeof payload.instructions === 'string') {
    if (payload.instructions.includes(segment)) return notInjected(payload, 'already-injected')
    payload.instructions = payload.instructions === '' ? segment : `${payload.instructions}${SEP}${segment}`
    return injected(payload)
  }
  const input = payload.input
  if (!Array.isArray(input)) return notInjected(payload, 'shape-not-recognised')
  if (input.some((item: any) => isResponsesSystem(item) && contentHasSegment(item.content, segment))) {
    return notInjected(payload, 'already-injected')
  }
  const target = input.find((item: any) => isResponsesSystem(item))
  if (target === undefined) {
    input.unshift({ type: 'message', role: 'system', content: [{ type: 'input_text', text: segment }] })
  } else {
    appendResponsesSegment(target, segment)
  }
  return injected(payload)
}

function appendResponsesSegment(item: any, segment: string): void {
  const content = item.content
  if (typeof content === 'string') {
    item.content = content === '' ? segment : `${content}${SEP}${segment}`
    return
  }
  if (Array.isArray(content)) {
    content.push({ type: 'input_text', text: segment })
    return
  }
  item.content = [{ type: 'input_text', text: segment }]
}

function stripResponses(payload: any): StripResult {
  let changed = false
  if (typeof payload.instructions === 'string') {
    const cut = cutMarked(payload.instructions)
    if (cut !== null) {
      changed = true
      if (cut === '') delete payload.instructions
      else payload.instructions = cut
    }
  }
  const input = payload.input
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const item = input[i]
      if (!isResponsesSystem(item)) continue
      const content = item.content
      if (typeof content === 'string') {
        const cut = cutMarked(content)
        if (cut === null) continue
        changed = true
        if (cut === '') input.splice(i, 1)
        else item.content = cut
        continue
      }
      if (!Array.isArray(content)) continue
      let local = false
      for (let j = content.length - 1; j >= 0; j -= 1) {
        const part = content[j]
        if (part === null || typeof part !== 'object' || typeof part.text !== 'string') continue
        const cut = cutMarked(part.text)
        if (cut === null) continue
        changed = true
        if (cut === '') content.splice(j, 1)
        else part.text = cut
      }
      if (!local) continue
      changed = true
      if (content.length === 0) input.splice(i, 1)
    }
  }
  if (changed) return asStripped(payload)
  if (typeof payload.instructions !== 'string' && !Array.isArray(input)) {
    return notStripped(payload, 'shape-not-recognised')
  }
  return notStripped(payload, 'not-injected')
}
