/**
 * Unit checks for the free lane's client fingerprint — the part a 403 hinges on.
 *
 * The gate compares the *declared definitions*, not the tool names: a stub with
 * a placeholder property was refused the moment the upstream started comparing
 * descriptions and schemas. So the checks here are byte-level:
 *
 * - the two gate definitions are carried verbatim (`applyFingerprint` for the
 *   chat wire, `applyFingerprintWire` for Responses' flat items and Messages'
 *   `input_schema`);
 * - a caller tool that collides with a gate name is renamed out of the slot and
 *   its history and `tool_choice` follow the rename — otherwise the model reads
 *   its own earlier calls as calls to the injected placeholder;
 * - `tool_choice: 'none'` never reaches the wire;
 * - only Responses gets `auto` when the caller sent none.
 *
 * Runs on plain node:  node test/fingerprint-shapes.test.ts
 */
import assert from 'node:assert/strict'
import { applyFingerprint, applyFingerprintWire, FINGERPRINT_TOOLS } from '../dist/fingerprint.js'
import { restoreToolName } from '../dist/upstream.js'

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

check('the chat wire carries both gate definitions verbatim', () => {
  const body: any = { messages: [], tools: [] }
  applyFingerprint(body, {})
  const names = declared(body)
  for (const gate of FINGERPRINT_TOOLS) assert.ok(names.includes(gate), `${gate} was not declared`)
  const read = body.tools.find((tool: any) => tool.function?.name === 'read')
  assert.ok(read.function.description.length > 100, 'the description was shortened')
  assert.equal(read.function.parameters.required[0], 'path')
})

check('a caller tool that collides with a gate name is renamed, and its history follows', () => {
  const body: any = {
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    ],
    tools: [chatTool('read')],
  }
  const aliases = new Map<string, string>()
  applyFingerprint(body, { aliases })
  // The caller's `read` moved out of the slot; the gate's own took its place.
  assert.ok(!declared(body).filter((name: string) => name === 'read').length === false)
  const names = declared(body)
  assert.equal(names.filter((name: string) => name === 'read').length, 1, 'two tools answered to `read`')
  const renamed = names.find((name: string) => name.startsWith('read_'))
  assert.ok(renamed !== undefined, 'the caller tool was not renamed')
  // The history call was renamed too, so the model does not read it as a call to
  // the injected placeholder. (A system note is prepended, so the assistant's
  // turn is found by role, not by a fixed index.)
  const assistant = body.messages.find((message: any) => message.role === 'assistant')
  assert.equal(assistant.tool_calls[0].function.name, renamed)
  // And the response side can restore it.
  assert.equal(restoreToolName(renamed, aliases), 'read')
})

check('the flat Responses wire declares the gate in its own shape', () => {
  const body: any = { input: [], tools: [] }
  applyFingerprintWire(body, true)
  const read = body.tools.find((tool: any) => tool.name === 'read')
  assert.ok(read !== undefined, 'the flat shape was not declared')
  assert.ok(read.function === undefined, 'the flat shape gained a function wrapper')
  assert.equal(read.parameters.required[0], 'path')
  // Responses gets `auto` when the caller sent no choice.
  assert.equal(body.tool_choice, 'auto')
})

check('the Anthropic wire declares the gate with input_schema', () => {
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

check('a caller tool already carrying the official definition is left alone', async () => {
  const { FINGERPRINT_TOOL_DEFINITIONS } = await import('../dist/fingerprint.js')
  const gate = { type: 'function', function: { name: 'read', ...FINGERPRINT_TOOL_DEFINITIONS.read } }
  const body: any = { messages: [], tools: [gate] }
  applyFingerprint(body, {})
  assert.equal(declared(body).filter((name: string) => name === 'read').length, 1, 'the official definition was duplicated')
})

Promise.allSettled([running]).then(() => {
  clearInterval(keepAlive)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
  if (failures > 0) process.exitCode = 1
})
