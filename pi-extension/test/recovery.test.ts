/**
 * Unit checks for turn recovery.
 *
 * The gates are the whole contract: an interrupted turn and a turn that stopped
 * cleanly with only its thinking are two different upstream events that need the
 * same continuation, and every other combination must be left alone — a turn
 * that answered, a tool call, or a truncated checkpoint is not recoverable here.
 *
 * Usage: node pi-extension/test/recovery.test.mjs
 */
import assert from 'node:assert/strict'
import {
  RECOVERY_DEFAULTS, addUsage, canRecover, canRecoverSilentStop, checkpointFits,
  continuationMessages, createBlockTracker, recoveryMessages, recoveryPolicy,
} from '../dist/gateway/recovery.js'

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failures += 1
  }
}

const policy = recoveryPolicy()

function outcome(overrides = {}) {
  return {
    sawFinish: false, sawReasoning: false, sawText: false, sawToolCall: false,
    checkpointTruncated: false, reasoningText: '', answerText: '', ...overrides,
  }
}

check('a stream that never finished and held only reasoning is recoverable', () => {
  assert.equal(canRecover(outcome({ sawReasoning: true, reasoningText: 'thinking about pong' }), policy, 1000), true)
})

check('a stream that finished with only reasoning is recoverable', () => {
  assert.equal(canRecoverSilentStop(outcome({ sawFinish: true, sawReasoning: true, reasoningText: 'thought', finish: 'stop' }), policy, 1000), true)
})

check('a turn that answered text is not recoverable on either gate', () => {
  const answered = outcome({ sawReasoning: true, sawText: true, reasoningText: 'thought', answerText: 'pong' })
  assert.equal(canRecover(answered, policy, 1000), false)
  assert.equal(canRecoverSilentStop({ ...answered, sawFinish: true }, policy, 1000), false)
})

check('a tool call is not recoverable — the turn already did its work', () => {
  const called = outcome({ sawReasoning: true, sawToolCall: true, reasoningText: 'thought' })
  assert.equal(canRecover(called, policy, 1000), false)
  assert.equal(canRecoverSilentStop({ ...called, sawFinish: true }, policy, 1000), false)
})

check('an empty reasoning checkpoint is not recoverable — there is nothing to continue from', () => {
  const empty = outcome({ sawReasoning: true, reasoningText: '   ' })
  assert.equal(canRecover(empty, policy, 1000), false)
  assert.equal(canRecoverSilentStop({ ...empty, sawFinish: true }, policy, 1000), false)
})

check('a truncated checkpoint is not recoverable — the draft itself is unreliable', () => {
  const cut = outcome({ sawReasoning: true, reasoningText: 'thought', checkpointTruncated: true })
  assert.equal(canRecover(cut, policy, 1000), false)
  assert.equal(canRecoverSilentStop({ ...cut, sawFinish: true }, policy, 1000), false)
})

check('a policy left disabled recovers nothing', () => {
  const off = recoveryPolicy({ enabled: false })
  assert.equal(canRecover(outcome({ sawReasoning: true, reasoningText: 'thought' }), off, 1000), false)
})

check('a policy window already spent recovers nothing', () => {
  assert.equal(canRecover(outcome({ sawReasoning: true, reasoningText: 'thought' }), policy, policy.totalTimeoutMs + 1), false)
})

check('a stored value that is not a positive integer is the shipped maximum', () => {
  const clamped = recoveryPolicy({ maxOutputTokens: 0, checkpointLimit: 1.5, maxContinuationMs: -5 })
  assert.equal(clamped.maxOutputTokens, RECOVERY_DEFAULTS.maxOutputTokens)
  assert.equal(clamped.checkpointLimit, RECOVERY_DEFAULTS.checkpointLimit)
  assert.equal(clamped.maxContinuationMs, RECOVERY_DEFAULTS.maxContinuationMs)
})

check('a stored value inside the maximum is honoured', () => {
  const tightened = recoveryPolicy({ maxOutputTokens: 2048 })
  assert.equal(tightened.maxOutputTokens, 2048)
})

check('the continuation appends one user turn and keeps the history', () => {
  const messages = [{ role: 'user', content: 'say pong' }]
  const next = recoveryMessages(messages, 'reasoning draft')
  assert.equal(next.length, 2)
  assert.equal(next[0].role, 'user')
  assert.equal(next[1].role, 'user')
  assert.equal(messages.length, 1, 'the original history must not be mutated')
})

check('the continuation tells the model the checkpoint is a draft, not an instruction', () => {
  const next = recoveryMessages([], 'reasoning draft')
  const text = next[0].content[0].text
  assert.match(text, /not new instructions/)
  assert.match(text, /"reasoning draft"/)
  assert.match(text, /Do not call tools/)
})

check('the continuation for a cut answer feeds the partial back and asks to resume', () => {
  const messages = [{ role: 'user', content: 'say pong' }]
  const next = continuationMessages(messages, 'pong is a word')
  assert.equal(next.length, 3)
  assert.equal(next[1].role, 'assistant')
  assert.equal(next[1].content, 'pong is a word')
  assert.match(next[2].content[0].text, /Continue exactly where the previous message stopped/)
})

check('an empty partial answer does not fabricate an assistant turn', () => {
  const messages = [{ role: 'user', content: 'say pong' }]
  const next = continuationMessages(messages, '   ')
  assert.equal(next.length, 2)
  assert.equal(next[1].content[0].text.includes('Continue exactly'), true)
})

check('a checkpoint inside the window fits, one over half the space does not', () => {
  const entry = { contextWindow: 100000 }
  assert.equal(checkpointFits({ messages: [] }, entry, 'x'.repeat(1000), 4096), true)
  assert.equal(checkpointFits({ messages: [] }, entry, 'x'.repeat(60000), 4096), false)
})

check('an unknown context window passes the fit check', () => {
  assert.equal(checkpointFits({ messages: [] }, {}, 'x'.repeat(100000), 4096), true)
})

check('the fit check does not price image bytes into the text estimate', () => {
  const payload = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(90000) } }] }] }
  assert.equal(checkpointFits(payload, { contextWindow: 100000 }, 'x'.repeat(1000), 4096), true)
})

check('usage sums field by field and skips non-numbers', () => {
  const total = addUsage({ inputTokens: 10 }, { inputTokens: 5, outputTokens: 3, junk: 'x' }, true)
  assert.equal(total.inputTokens, 15)
  assert.equal(total.outputTokens, 3)
  assert.equal(total.junk, undefined)
})

check('usage is not summed when the attempt reports none', () => {
  assert.deepEqual(addUsage({ inputTokens: 10 }, { inputTokens: 5 }, false), { inputTokens: 10 })
})

check('the tracker closes a block a bad turn left open, and only assembles tools', () => {
  const tracker = createBlockTracker()
  tracker.accept({ type: 'block-start', index: 0, blockType: 'text' })
  tracker.accept({ type: 'text-delta', index: 0, text: 'pong' })
  tracker.accept({ type: 'block-start', index: 1, blockType: 'tool-call' })
  tracker.accept({ type: 'tool-call-delta', index: 1, id: 'call_1', name: 'read', argumentsDelta: '{"a":1}' })
  const closed = tracker.close()
  assert.equal(closed.length, 2)
  const text = closed.find((chunk) => chunk.index === 0)
  const tool = closed.find((chunk) => chunk.index === 1)
  assert.equal(text.block.text, 'pong')
  assert.equal(tool.block.name, 'read')
  assert.equal(tool.block.arguments, '{"a":1}')
})

check('a block that already closed is not closed twice', () => {
  const tracker = createBlockTracker()
  tracker.accept({ type: 'block-start', index: 0, blockType: 'text' })
  tracker.accept({ type: 'text-delta', index: 0, text: 'pong' })
  tracker.accept({ type: 'block-end', index: 0, block: { type: 'text', text: 'pong' } })
  assert.equal(tracker.close().length, 0)
})

if (failures > 0) {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
