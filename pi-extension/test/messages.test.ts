/**
 * Unit checks for the harness ↔ wire message projection.
 *
 * The property this suite exists for: **a tool call is never orphaned**. Every
 * supported wire enforces that a `tool_calls` entry is followed by its result,
 * and a turn interrupted between the two — the tool failed to start, the user
 * aborted, the harness crashed — leaves exactly that in the durable history.
 * Replaying it is not merely untidy: the free lane answers `400`, which then
 * fails every later turn in that session, not just the one that broke.
 *
 * So `repairToolPairing` is pinned here against every shape the kernel has
 * written a tool answer in, and the three projectors are pinned on the shapes
 * they must produce.
 *
 * Runs on plain node:  node test/messages.test.ts
 */
import assert from 'node:assert/strict'
import {
  repairToolPairing, toChatMessages, toClaudeMessages, toResponseInput, toToolDefs, needsVision,
} from '../dist/messages.js'

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

const CALL = { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' }
const answer = (id = 'call_1') => ({
  role: 'tool',
  content: [{ type: 'text', text: 'file contents' }],
  toolCallId: id,
  source: { kind: 'tool', callId: id },
})
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (...blocks: any[]) => ({ role: 'assistant', content: blocks })

// ── repairToolPairing ────────────────────────────────────────────────────────
check('an answered call and its result both survive a round trip', () => {
  const kept = repairToolPairing([user('read a.txt'), assistant(CALL), answer()])
  assert.equal(kept.length, 3)
  assert.equal(kept[1].content[0].type, 'tool-call')
  assert.equal(kept[2].role, 'tool')
})

check('an unanswered call is dropped — the wire would 400 on it', () => {
  const kept = repairToolPairing([user('read a.txt'), assistant(CALL)])
  assert.equal(kept.length, 1, 'the orphaned call is still in the history')
  assert.equal(kept[0].role, 'user')
})

check('a result whose call never happened is dropped', () => {
  const kept = repairToolPairing([user('hi'), answer('never_made')])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].role, 'user')
})

check('a nameless call is dropped like an unanswered one', () => {
  // A call that reached the host was answered `Error: unknown tool ""` — an
  // *answered* poison pill repairToolPairing would keep forever, failing every
  // later turn on every model (issue #92).
  const kept = repairToolPairing([
    user('go'),
    assistant({ type: 'tool-call', id: '', name: '', arguments: '{}' }),
    { role: 'tool', content: [{ type: 'text', text: 'Error: unknown tool' }], toolCallId: '' },
  ])
  assert.equal(kept.length, 1, 'the nameless call survived')
  assert.equal(kept[0].role, 'user')
})

check('a pre-V4 tool-result wrapper block is read as well as a V4 tool message', () => {
  const wrapped = {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }],
  }
  const answered = repairToolPairing([assistant(CALL), wrapped])
  assert.equal(answered.length, 2, 'the wrapped result was not recognised')
  assert.equal(answered[1].role, 'user')
  // The wrapper itself is stripped from the projected turn.
  const orphan = repairToolPairing([
    assistant({ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }),
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'other', content: [{ type: 'text', text: 'x' }] }] },
  ])
  // Both sides are orphans: the call was never answered, the wrapper answers a
  // call that never happened. Neither survives, so the turn list is empty.
  assert.equal(orphan.length, 0, 'the wrapper with no matching call survived')
})

check('a user turn whose only content was a dropped wrapper leaves the rest alone', () => {
  const kept = repairToolPairing([
    assistant({ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }),
    answer('call_1'),
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'x' }] },
        { type: 'text', text: 'and now this' },
      ],
    },
  ])
  // The wrapper goes; the real text stays on the same turn.
  assert.deepEqual(kept[2].content, [{ type: 'text', text: 'and now this' }])
})

check('a call answered on one spelling only is judged by the answered id', () => {
  // `call_1` is answered; `call_2` is not. Both calls are in one assistant turn.
  const two = assistant(CALL, { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{}' })
  const kept = repairToolPairing([two, answer('call_1')])
  const calls = kept[0].content.filter((block: any) => block.type === 'tool-call')
  assert.equal(calls.length, 1, `expected 1 surviving call, got ${calls.length}`)
  assert.equal(calls[0].id, 'call_1')
})

check('an interrupted assistant turn between two parallel calls keeps the answered half', () => {
  const a = { type: 'tool-call', id: 'c_a', name: 'read', arguments: '{}' }
  const b = { type: 'tool-call', id: 'c_b', name: 'read', arguments: '{}' }
  const kept = repairToolPairing([
    assistant(a, b),
    { role: 'tool', content: [{ type: 'text', text: 'A' }], toolCallId: 'c_a' },
  ])
  const calls = kept[0].content.filter((block: any) => block.type === 'tool-call')
  assert.deepEqual(calls.map((call: any) => call.id), ['c_a'])
})

check('a turn whose only content was dropped calls leaves no empty assistant turn', () => {
  const kept = repairToolPairing([user('hi'), assistant(CALL)])
  assert.equal(kept.filter((row: any) => row.role === 'assistant').length, 0)
})

check('text survives when the calls beside it are dropped', () => {
  const kept = repairToolPairing([
    user('hi'),
    assistant({ type: 'text', text: 'let me look' }, CALL),
  ])
  assert.equal(kept.length, 2)
  assert.deepEqual(kept[1].content, [{ type: 'text', text: 'let me look' }])
})

check('an untouched history comes back identical — including the all-text case', () => {
  const history = [user('a'), user('b'), assistant({ type: 'text', text: 'done' })]
  assert.deepEqual(repairToolPairing(history), history)
  const plain = [user('just text')]
  assert.deepEqual(repairToolPairing(plain), plain)
  assert.deepEqual(repairToolPairing(undefined), [])
  assert.deepEqual(repairToolPairing(null as any), [])
})

check('a bare-string content is normalised, not dropped', () => {
  const kept = repairToolPairing([{ role: 'user', content: 'plain string' }])
  assert.deepEqual(kept, [{ role: 'user', content: 'plain string' }])
})

// ── toChatMessages ───────────────────────────────────────────────────────────
check('chat: system is projected as a leading system turn and text as a string', () => {
  const out = toChatMessages([
    { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
    user('hello'),
  ])
  assert.deepEqual(out[0], { role: 'system', content: 'be terse' })
  assert.deepEqual(out[1], { role: 'user', content: 'hello' })
})

check('chat: a tool result becomes a first-class tool turn keyed by its call id', () => {
  const out = toChatMessages([assistant(CALL), answer()])
  const results = out.filter((row: any) => row.role === 'tool')
  assert.equal(results.length, 1)
  assert.equal(results[0].tool_call_id, 'call_1')
  assert.equal(results[0].content, 'file contents')
})

check('chat: an assistant tool call rides as OpenAI tool_calls', () => {
  const out = toChatMessages([assistant(CALL)])
  assert.equal(out[0].tool_calls.length, 1)
  assert.deepEqual(out[0].tool_calls[0], {
    id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' },
  })
})

check('chat: an image a tool returned travels as the user turn after it, not dropped', () => {
  const withImage = {
    role: 'tool', toolCallId: 'call_1',
    content: [{ type: 'text', text: 'see' }, { type: 'image', attachment: { url: 'data:image/png;base64,AA' } }],
  }
  const out = toChatMessages([withImage])
  const imageTurn = out.find((row: any) => Array.isArray(row.content) && row.content.some((p: any) => p.type === 'image_url'))
  assert.ok(imageTurn !== undefined, 'the returned image was dropped')
  assert.equal(imageTurn.role, 'user')
  // The lead text explains why an image arrived without its call.
  assert.equal(imageTurn.content[0].type, 'text')
  assert.equal(imageTurn.content[1].type, 'image_url')
  assert.equal(imageTurn.content[1].image_url.url, 'data:image/png;base64,AA')
  // The tool turn itself carries the text only.
  assert.equal(out[0].content, 'see')
})

check('chat: an unresolvable image is reported as a warning and dropped', () => {
  const warnings: string[] = []
  const out = toChatMessages(
    [user('look'), { role: 'user', content: [{ type: 'image', offloaded: true, attachment: {} }] }],
    undefined,
    warnings,
  )
  assert.deepEqual(warnings, ['image-dropped'])
  assert.equal(out[out.length - 1].content, 'look')
})

check('chat: forwarded reasoning_content survives, including an explicit empty string', () => {
  const out = toChatMessages([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }], reasoning_content: '' }])
  assert.ok('reasoning_content' in out[0], 'the empty string was dropped')
  assert.equal(out[0].reasoning_content, '')
})

// ── toClaudeMessages ─────────────────────────────────────────────────────────
check('claude: system text is lifted out of the turn list', () => {
  const shaped = toClaudeMessages([{ role: 'system', content: [{ type: 'text', text: 'be terse' }] }, user('hi')])
  assert.equal(shaped.system, 'be terse')
  assert.equal(shaped.messages.length, 1)
  assert.equal(shaped.messages[0].role, 'user')
})

check('claude: a tool result becomes a user tool_result block, never a second user turn', () => {
  // The assistant turn opens the tool_use; the result lands on a *user* turn as
  // a tool_result block. Two consecutive user turns would be rejected.
  const shaped = toClaudeMessages([assistant(CALL), answer()])
  assert.equal(shaped.messages.length, 2)
  assert.equal(shaped.messages[0].role, 'assistant')
  assert.equal(shaped.messages[0].content[0].type, 'tool_use')
  const lead = shaped.messages[1]
  assert.equal(lead.role, 'user')
  assert.equal(lead.content[0].type, 'tool_result')
  assert.equal(lead.content[0].tool_use_id, 'call_1')
  assert.equal(lead.content[0].content[0].text, 'file contents')
})

check('claude: a V4 tool message content is not appended twice', () => {
  // The content *is* the result and already went out inside `tool_result`.
  const shaped = toClaudeMessages([answer()])
  const texts = shaped.messages.flatMap((row: any) => row.content).filter((b: any) => b.type === 'text')
  assert.equal(texts.length, 0, `the result was duplicated: ${texts.length} text blocks`)
})

check('claude: an assistant tool call becomes a tool_use block with parsed input', () => {
  const shaped = toClaudeMessages([assistant(CALL)])
  const block = shaped.messages[0].content[0]
  assert.equal(block.type, 'tool_use')
  assert.equal(block.id, 'call_1')
  assert.equal(block.name, 'read')
  assert.deepEqual(block.input, { path: 'a.txt' })
})

check('claude: unparseable arguments degrade to an empty input, not a throw', () => {
  const shaped = toClaudeMessages([assistant({ type: 'tool-call', id: 'c', name: 'read', arguments: '{broken' })])
  assert.deepEqual(shaped.messages[0].content[0].input, {})
})

check('claude: consecutive same-role turns are merged', () => {
  // The messages wire rejects consecutive user turns, so a pre-V4 history that
  // answers a call as a separate user message must merge.
  const shaped = toClaudeMessages([
    user('a'),
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
  ])
  assert.equal(shaped.messages.length, 1)
  assert.equal(shaped.messages[0].content.length, 2)
})

// ── toResponseInput ──────────────────────────────────────────────────────────
check('responses: a tool result becomes function_call_output', () => {
  const out = toResponseInput([answer()])
  assert.equal(out[0].type, 'function_call_output')
  assert.equal(out[0].call_id, 'call_1')
})

check('responses: an assistant tool call becomes a function_call item', () => {
  const out = toResponseInput([assistant(CALL)])
  const call = out.find((item: any) => item.type === 'function_call')
  assert.ok(call !== undefined)
  assert.equal(call.call_id, 'call_1')
  assert.equal(call.name, 'read')
})

check('responses: system and assistant text use the input_text/output_text spellings', () => {
  const out = toResponseInput([
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    assistant({ type: 'text', text: 'out' }),
    user('in'),
  ])
  assert.equal(out[0].content[0].type, 'input_text')
  assert.equal(out[1].content[0].type, 'output_text')
  assert.equal(out[2].content[0].type, 'input_text')
})

check('responses: a returned image travels as the user item after its output', () => {
  const out = toResponseInput([{
    role: 'tool', toolCallId: 'call_1',
    content: [{ type: 'image', attachment: { url: 'data:image/png;base64,AA' } }],
  }])
  const image = out.find((item: any) => Array.isArray(item.content) && item.content.some((p: any) => p.type === 'input_image'))
  assert.ok(image !== undefined, 'the returned image was dropped')
  assert.equal(image.role, 'user')
})

// ── toToolDefs ───────────────────────────────────────────────────────────────
check('a flat harness def and an OpenAI {function:{…}} wrapper both project', () => {
  const flat = toToolDefs([{ name: 'read', description: 'Read', parameters: { type: 'object' } }], 'flat')
  assert.deepEqual(flat[0], { type: 'function', name: 'read', description: 'Read', parameters: { type: 'object' } })
  // The Responses wire's own spelling: no `function` wrapper.
  const wrapped = toToolDefs([{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }], 'flat')
  assert.deepEqual(wrapped[0], flat[0])
})

check('the chat wire keeps the OpenAI function wrapper', () => {
  const out = toToolDefs([{ name: 'read', description: 'Read', parameters: { type: 'object' } }], 'chat')
  assert.deepEqual(out[0], { type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } })
})

check('a def with no name is skipped rather than sent nameless', () => {
  assert.deepEqual(toToolDefs([{ description: 'no name' }], 'chat'), [])
  assert.deepEqual(toToolDefs([{ type: 'function', function: { description: 'x' } }], 'chat'), [])
})

check('claude spelling uses input_schema and no function wrapper', () => {
  const out = toToolDefs([{ name: 'read', description: 'Read', parameters: { type: 'object' } }], 'claude')
  assert.deepEqual(out[0], { name: 'read', description: 'Read', input_schema: { type: 'object' } })
})

check('a missing schema becomes an empty object schema', () => {
  const out = toToolDefs([{ name: 'read' }], 'chat')
  assert.deepEqual(out[0].function.parameters, { type: 'object', properties: {} })
})

check('a non-object schema is not carried through', () => {
  const out = toToolDefs([{ name: 'read', parameters: 'not an object' }], 'chat')
  assert.deepEqual(out[0].function.parameters, { type: 'object', properties: {} })
})

// ── needsVision ──────────────────────────────────────────────────────────────
check('needsVision is true only for an image that can still travel', () => {
  assert.equal(needsVision([{ role: 'user', content: [{ type: 'image', attachment: { url: 'x' } }] }]), true)
  assert.equal(needsVision([{ role: 'user', content: [{ type: 'image', offloaded: true, attachment: {} }] }]), false)
  assert.equal(needsVision([user('text only')]), false)
  assert.equal(needsVision(undefined), false)
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 50)
