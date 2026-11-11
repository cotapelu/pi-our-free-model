/**
 * Unit checks for the free lane's client fingerprint — the part a 403 hinges on.
 *
 * 2.8.3 moved the shaping out of this file and into `o2a/`, a file-by-file port
 * of opencode2api's gateway. That is the behaviour these checks pin, because it
 * is what the live gate sees:
 *
 * - the official CLI system prompt is prepended, not just the tools — the gate
 *   reads the prompt too, and a body that carried only the tool set was refused;
 * - every caller tool that is *not* an official name rides the wire under an
 *   opaque `clint_<sha256[:12]>` name, because the free tier answers a body
 *   carrying another client's vocabulary with 403/429;
 * - a caller tool that folds onto an official name is *bound* to that official
 *   name and the official set is not appended a second time (v1.4.7
 *   `BindOfficial`) — that is the shape the official CLI's own clients send;
 * - every reference follows the rename: `tool_choice`, the legacy
 *   `function_call`, and the tool-call history each wire keeps;
 * - `tool_choice: 'none'` never reaches the wire, and only Responses gets `auto`;
 * - a conversation-title round-trip ships **unshaped**, which is the shape the
 *   reference measured as safe.
 *
 * Runs on plain node:  node test/fingerprint-shapes.test.ts
 */
import assert from 'node:assert/strict'
import { applyFingerprint, applyFingerprintWire, FINGERPRINT_TOOLS } from '../dist/fingerprint.js'
import { restoreToolName } from '../dist/upstream.js'
import { OFFICIAL_PROMPT_MARKER } from '../dist/o2a/official-prompt.js'
import { V2_OFFICIAL_TOOL_ORDER } from '../dist/o2a/official-tools.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 1000)
function check(name: string, fn: () => void | Promise<void>) {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error) { failures++; console.log(`FAIL ${name}\n     ${(error as Error)?.message ?? error}`) }
  })
}

const chatTool = (name: string, extra: Record<string, unknown> = {}) => ({
  type: 'function',
  function: { name, description: `the ${name} tool`, parameters: { type: 'object', properties: { x: { type: 'string' } } }, ...extra },
})
const flatTool = (name: string) => ({ type: 'function', name, description: `the ${name} tool`, parameters: { type: 'object', properties: { x: { type: 'string' } } } })
const claudeTool = (name: string) => ({ name, description: `the ${name} tool`, input_schema: { type: 'object', properties: { command: { type: 'string' } } } })
const declared = (body: any) => (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name)

check('the chat wire carries the full official tool set', () => {
  const body: any = { messages: [], tools: [] }
  applyFingerprint(body, {})
  const names = declared(body)
  for (const official of V2_OFFICIAL_TOOL_ORDER) assert.ok(names.includes(official), `${official} was not declared`)
  const read = body.tools.find((tool: any) => tool.function?.name === 'read')
  assert.ok(read.function.description.length > 100, 'the description was shortened')
  assert.equal(read.function.parameters.required[0], 'path')
})

check('the official system prompt rides along', () => {
  // The gate reads the prompt as well as the tool list; a body that carried only
  // the tools was refused. Marker-guarded, so shaping twice cannot duplicate it.
  const body: any = { messages: [{ role: 'user', content: 'x' }], tools: [] }
  applyFingerprint(body, {})
  applyFingerprint(body, {})
  const prompts = body.messages.filter((message: any) => typeof message.content === 'string' && message.content.includes(OFFICIAL_PROMPT_MARKER))
  assert.equal(prompts.length, 1, 'the prompt was missing or was injected twice')
  assert.match(body.messages[0].content, /Working directory:/)
})

check('a foreign tool name becomes an opaque clint_ name, and its history follows', () => {
  const body: any = {
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'ReportFindings', arguments: '{}' } }] },
    ],
    tools: [chatTool('ReportFindings')],
    tool_choice: { type: 'function', function: { name: 'ReportFindings' } },
  }
  const aliases = new Map<string, string>()
  applyFingerprint(body, { aliases })
  const names = declared(body)
  const wire = names.find((name: string) => name.startsWith('clint_'))
  assert.ok(wire !== undefined, 'the caller tool was not renamed')
  assert.ok(!names.includes('ReportFindings'), 'the foreign vocabulary stayed on the wire')
  assert.equal(wire.length, 'clint_'.length + 12, 'the wire name is not the 12-hex digest the lane meters')
  const assistant = body.messages.find((message: any) => message.role === 'assistant')
  assert.equal(assistant.tool_calls[0].function.name, wire)
  assert.equal(body.tool_choice.function.name, wire)
  assert.equal(restoreToolName(wire, aliases), 'ReportFindings')
  // The paired tool result row follows its call's id, so it is never orphaned.
  assert.equal(assistant.tool_calls[0].id, 'c1')
})

check('a caller tool folding onto an official name is bound, not duplicated', () => {
  // v1.4.7 BindOfficial: the caller's own definition rides the wire under the
  // official name, and the official set is not appended a second time. This is
  // the shape the official CLI's own clients send.
  const body: any = { messages: [], tools: [chatTool('Read')] }
  applyFingerprint(body, {})
  const names = declared(body)
  assert.equal(names.filter((name: string) => name === 'read').length, 1, 'the official definition was duplicated')
  assert.ok(!names.includes('Read'), 'the caller spelling leaked onto the wire')
  // Every other official still arrives.
  assert.ok(names.includes('shell'))
})

check('a caller tool already carrying the official definition is left alone', async () => {
  const { officialToolDefinition } = await import('../dist/o2a/official-tools.js')
  const definition = officialToolDefinition('read')
  const gate = { type: 'function', function: { name: 'read', ...definition } }
  const body: any = { messages: [], tools: [gate] }
  applyFingerprint(body, {})
  const rows = body.tools.filter((tool: any) => tool.function?.name === 'read')
  assert.equal(rows.length, 1, 'the official definition was duplicated')
  assert.equal(rows[0].function.description, definition.description)
})

check('the flat Responses wire declares the official set in its own shape', () => {
  const body: any = { input: [], tools: [] }
  applyFingerprintWire(body, true)
  const read = body.tools.find((tool: any) => tool.name === 'read')
  assert.ok(read !== undefined, 'the flat shape was not declared')
  assert.ok(read.function === undefined, 'the flat shape gained a function wrapper')
  assert.equal(read.parameters.required[0], 'path')
  // Responses gets `auto` when the caller sent no choice.
  assert.equal(body.tool_choice, 'auto')
})

check('the Anthropic wire declares the official set with input_schema', () => {
  const body: any = { messages: [], tools: [] }
  applyFingerprintWire(body, 'claude')
  const read = body.tools.find((tool: any) => tool.name === 'read')
  assert.ok(read !== undefined)
  assert.ok(read.input_schema !== undefined, 'the Anthropic shape was not used')
  assert.equal(read.input_schema.required[0], 'path')
})

check('tool_choice: none never reaches the wire', () => {
  const body: any = { messages: [], tools: [], tool_choice: 'none' }
  applyFingerprintWire(body, true)
  assert.ok(body.tool_choice !== 'none', 'a 403 was handed to the gateway')
})

check('the chat wire carries its two constant body fields', () => {
  const body: any = { messages: [], tools: [], stream: true }
  applyFingerprint(body, {})
  assert.equal(body.stream_options?.include_usage, true)
  assert.equal(body.max_completion_tokens, 32000)
})

check('a title round-trip ships unshaped', () => {
  // The reference measured a 403/429 when the full agent shape rode a toolless
  // title call, which is what the harness's title generator sends whenever the
  // local title answer is switched off.
  const body: any = {
    messages: [
      { role: 'system', content: 'You write titles.' },
      { role: 'user', content: 'Generate a title for this conversation.' },
    ],
    tools: [],
  }
  const aliases = new Map<string, string>()
  applyFingerprint(body, { aliases })
  assert.equal(aliases.size, 0, 'a title request was shaped')
  assert.deepEqual(body.tools ?? [], [])
  assert.equal(body.messages[1].content, 'Generate a title for this conversation.')
  assert.equal('max_completion_tokens' in body, false)
})

check('a four-turn conversation is not a title request', () => {
  // The turn ceiling is what keeps a real conversation from being mistaken for a
  // title round-trip and shipped without its fingerprint.
  const body: any = { messages: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' }, { role: 'user', content: 'Generate a title for this conversation.' },
  ], tools: [] }
  const aliases = new Map<string, string>()
  applyFingerprint(body, { aliases })
  assert.ok(aliases.size > 0 || (body.tools ?? []).length > 0, 'a real conversation shipped unshaped')
})

check('shaping is idempotent', () => {
  // A retried turn re-shapes an already-shaped body; the marker and the clint_
  // prefix are what keep that a no-op.
  const body: any = { messages: [{ role: 'user', content: 'x' }], tools: [chatTool('ReportFindings')] }
  applyFingerprint(body, {})
  const once = JSON.stringify(body)
  applyFingerprint(body, {})
  assert.equal(JSON.stringify(body), once, 'a second pass changed the body')
})

Promise.allSettled([running]).then(() => {
  clearInterval(keepAlive)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
  if (failures > 0) process.exitCode = 1
})
