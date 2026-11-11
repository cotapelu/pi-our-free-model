/**
 * Unit checks for system-prompt injection.
 *
 * The interesting half is the **strip**: `stripInjected` is the user-facing off
 * switch and the round-trip half of every test here, and it is the part the
 * upstream RTK injector never had to write. So the property being pinned is
 * `inject → strip` restoring the body **byte-for-byte**, in every shape each wire
 * keeps its system text in — including the ones whose projector reports an
 * emptied field as *absent* rather than as `''`.
 *
 * The other half is the marker: a bare prompt cannot be told apart from the
 * user's own system text of the same wording, so a lone marker without its end is
 * text nobody owns and neither function touches it.
 *
 * Runs on plain node:  node test/inject.test.ts
 */
import assert from 'node:assert/strict'
import { INJECT_MARKER, hasInjected, injectSystem, stripInjected } from '../dist/token-saver/inject.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

const PROMPT = 'Be terse.'
/** A body worth injecting into, so one field can be broken at a time. */
function chat(content = 'be brief'): any { return { messages: [{ role: 'system', content }, { role: 'user', content: 'hi' }] } }
function claude(system = 'be brief'): any { return { messages: [{ role: 'user', content: 'hi' }], system } }
function responses(): any { return { instructions: 'be brief', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] } }

// ── injection ───────────────────────────────────────────────────────────────
check('chat injects into the existing system message', () => {
  const body = chat()
  const result = injectSystem(body, 'chat', PROMPT)
  assert.equal(result.injected, true)
  assert.equal(result.reason, 'injected')
  assert.equal(body.messages[0].content, `be brief\n\n${INJECT_MARKER}\n\n${PROMPT}\n\n<!-- /ofm-token-saver -->`)
  // The user turn is untouched.
  assert.equal(body.messages.length, 2)
})

check('chat with no system message gains one in front', () => {
  const body: any = { messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(injectSystem(body, 'chat', PROMPT).injected, true)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages.length, 2)
})

check('chat appends to a block-content system message rather than a second message', () => {
  const body: any = { messages: [{ role: 'system', content: [{ type: 'text', text: 'be brief' }] }] }
  assert.equal(injectSystem(body, 'chat', PROMPT).injected, true)
  assert.equal(body.messages.length, 1, 'a second system message appeared')
  assert.equal(body.messages[0].content.length, 2)
})

check('messages injects into the string system field', () => {
  const body = claude()
  assert.equal(injectSystem(body, 'messages', PROMPT).injected, true)
  assert.equal(body.system, `be brief\n\n${INJECT_MARKER}\n\n${PROMPT}\n\n<!-- /ofm-token-saver -->`)
})

check('messages fills an absent system field rather than failing', () => {
  // `toClaudeMessages` reports an empty system as `undefined`, so an absent one
  // is a shape to fill on this wire.
  const body: any = { messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(injectSystem(body, 'messages', PROMPT).injected, true)
  assert.match(body.system, new RegExp(INJECT_MARKER.replace(/[*/]/g, '\\$&')))
})

check('messages injects into a block system field before the cache breakpoint', () => {
  // Text appended past `cache_control` is the one part of the system prompt the
  // provider processes and bills uncached every turn — the cost this injection
  // exists to avoid.
  const body: any = {
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: 'rules' }, { type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }],
  }
  assert.equal(injectSystem(body, 'messages', PROMPT).injected, true)
  assert.equal(body.system.length, 3)
  // The breakpoint is still the last block, so it still terminates the list.
  assert.equal(body.system[body.system.length - 1].text, 'cached')
  assert.equal(body.system[1].text.includes(INJECT_MARKER), true)
})

check('responses injects into `instructions`, the dedicated field', () => {
  const body = responses()
  assert.equal(injectSystem(body, 'responses', PROMPT).injected, true)
  assert.equal(body.instructions.includes(INJECT_MARKER), true)
  // A body carrying both must not have its system text split across two places.
  assert.equal(body.input.length, 1)
})

check('responses with no instructions injects a system item', () => {
  const body: any = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }
  assert.equal(injectSystem(body, 'responses', PROMPT).injected, true)
  assert.equal(body.input[0].role, 'system')
})

// ── idempotency ─────────────────────────────────────────────────────────────
check('re-injecting the same prompt is a no-op', () => {
  const body = chat()
  assert.equal(injectSystem(body, 'chat', PROMPT).injected, true)
  const second = injectSystem(body, 'chat', PROMPT)
  assert.equal(second.injected, false)
  assert.equal(second.reason, 'already-injected')
  assert.equal(body.messages[0].content.match(new RegExp(INJECT_MARKER.replace(/[*/]/g, '\\$&'), 'g'))?.length, 1)
})

check('two different prompts coexist, each reported as its own', () => {
  // A bare-prompt dedupe would refuse the second one outright.
  const body = chat()
  assert.equal(injectSystem(body, 'chat', 'prompt A').injected, true)
  assert.equal(injectSystem(body, 'chat', 'prompt B').injected, true)
  assert.equal(injectSystem(body, 'chat', 'prompt A').reason, 'already-injected')
  assert.equal(injectSystem(body, 'chat', 'prompt B').reason, 'already-injected')
})

// ── strip ───────────────────────────────────────────────────────────────────
check('strip restores a chat body byte-for-byte', () => {
  const before = chat()
  const original = JSON.stringify(before)
  injectSystem(before, 'chat', PROMPT)
  const result = stripInjected(before, 'chat')
  assert.equal(result.stripped, true)
  assert.equal(JSON.stringify(before), original, 'the body was not restored')
})

check('strip restores a chat body that had no system message', () => {
  const before: any = { messages: [{ role: 'user', content: 'hi' }] }
  const original = JSON.stringify(before)
  injectSystem(before, 'chat', PROMPT)
  stripInjected(before, 'chat')
  assert.equal(JSON.stringify(before), original, 'the shell message was left behind')
})

check('strip restores a messages body, removing the field it filled', () => {
  // `toClaudeMessages` reports an empty system as `undefined`, never `''`.
  const before: any = { messages: [{ role: 'user', content: 'hi' }] }
  injectSystem(before, 'messages', PROMPT)
  assert.equal(stripInjected(before, 'messages').stripped, true)
  assert.equal('system' in before, false, 'the field it filled was left as an empty string')
})

check('strip restores a messages body that already had a system field', () => {
  const before = claude('be brief')
  const original = JSON.stringify(before)
  injectSystem(before, 'messages', PROMPT)
  stripInjected(before, 'messages')
  assert.equal(JSON.stringify(before), original)
})

check('strip restores a responses body, removing an instructions field it filled', () => {
  const before: any = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }
  injectSystem(before, 'responses', PROMPT)
  assert.equal(stripInjected(before, 'responses').stripped, true)
  assert.equal('instructions' in before, false)
})

check('strip restores a responses body that already had instructions', () => {
  const before = responses()
  const original = JSON.stringify(before)
  injectSystem(before, 'responses', PROMPT)
  stripInjected(before, 'responses')
  assert.equal(JSON.stringify(before), original)
})

check('strip removes every region, so two prompts both come off', () => {
  const before = chat()
  const original = JSON.stringify(before)
  injectSystem(before, 'chat', 'A')
  injectSystem(before, 'chat', 'B')
  assert.equal(stripInjected(before, 'chat').stripped, true)
  assert.equal(JSON.stringify(before), original, 'one of the two regions survived')
})

check('a strip on a body that was never injected changes nothing', () => {
  const before = chat()
  const original = JSON.stringify(before)
  const result = stripInjected(before, 'chat')
  assert.equal(result.stripped, false)
  assert.equal(result.reason, 'not-injected')
  assert.equal(JSON.stringify(before), original)
})

// ── the marker ──────────────────────────────────────────────────────────────
check('a lone marker is text nobody owns: neither function touches it', () => {
  // Cutting to an assumed boundary could eat user text, so a partial region is
  // left exactly as written.
  const body = chat(`mine: ${INJECT_MARKER} and more`)
  const original = JSON.stringify(body)
  assert.equal(injectSystem(body, 'chat', PROMPT).injected, true, 'a lone marker blocked injection')
  assert.equal(hasInjected(body, 'chat'), true)
  assert.equal(stripInjected(body, 'chat').stripped, true)
  // The round-trip restores the body the user wrote, marker and all.
  assert.equal(body.messages[0].content, `mine: ${INJECT_MARKER} and more`, 'the user marker was cut')
  assert.equal(JSON.stringify(body), original, 'the user text around the marker moved')
})

check('hasInjected requires the closing marker, not just the opening one', () => {
  const open: any = { messages: [{ role: 'system', content: INJECT_MARKER }] }
  assert.equal(hasInjected(open, 'chat'), false, 'a lone opening marker read as injected')
})

// ── shape failures ──────────────────────────────────────────────────────────
check('an unrecognised shape changes nothing and says so', () => {
  for (const body of [null, undefined, 42, 'text', [], {}, { messages: 'not a list' }]) {
    const result = injectSystem(body, 'chat', PROMPT)
    assert.equal(result.injected, false, `${JSON.stringify(body)} was injected into`)
    assert.equal(result.reason, 'shape-not-recognised')
    assert.equal(stripInjected(body, 'chat').stripped, false)
  }
})

check('an unrecognised wire changes nothing', () => {
  const body = chat()
  const result = injectSystem(body, 'carrier-pigeon' as any, PROMPT)
  assert.equal(result.injected, false)
  assert.equal(result.reason, 'shape-not-recognised')
  assert.equal(hasInjected(body, 'carrier-pigeon' as any), false)
})

check('empty prompt text is refused, not written', () => {
  const body = chat()
  for (const text of ['', undefined as any, null as any, 42 as any]) {
    const result = injectSystem(body, 'chat', text)
    assert.equal(result.injected, false)
    assert.equal(result.reason, 'no-text')
  }
  assert.equal(hasInjected(body, 'chat'), false)
})

check('a frozen body fails open rather than failing the turn', () => {
  // This module sits between the user's turn and the provider: its worst
  // acceptable outcome is injecting nothing.
  const frozen = Object.freeze({ messages: Object.freeze([Object.freeze({ role: 'user', content: 'hi' })]) })
  let threw = false
  try { injectSystem(frozen as any, 'chat', PROMPT) } catch { threw = true }
  assert.equal(threw, false, 'a frozen body threw out of injectSystem')
  assert.equal(stripInjected(frozen as any, 'chat').reason !== undefined, true)
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
