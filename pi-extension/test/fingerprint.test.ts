/**
 * Unit checks for the OpenCode v2 fingerprint payload pass.
 *
 * The upstream free lane is gated by byte-for-byte client shape; a missing piece
 * is a 403 or a 429 on the wire, invisible in code review. These checks pin the
 * pieces: the required `<env>` block, the identity-metered tool renames, the
 * gate-slot alias + verbatim injection, history renaming, `tool_choice`
 * retargeting, and the removal of `none`.
 *
 * Usage: node pi-extension/test/fingerprint.test.mjs
 */
import assert from 'node:assert/strict'
import { applyFingerprint, gatewayHeaders, mintSessionId, sessionFor, FINGERPRINT_TOOL_DEFINITIONS, SESSION_RE, SESSION_DESCENDING_RE } from '../dist/fingerprint.js'

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

const CHAT_TOOL = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } })
// applyFingerprint mutates its payload in place, so every check starts from a deep
// clone: a shared fixture would carry one check's renames into the next.
const PI_TOOLS = [
  CHAT_TOOL('read', 'Read a file into context.', { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }),
  CHAT_TOOL('shell', 'Run a shell command.', { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }),
  CHAT_TOOL('subagent_fork', 'Fork a sub-agent.', { type: 'object', properties: { task: { type: 'string' } } }),
  CHAT_TOOL('working_directory', 'Set the working directory.', { type: 'object', properties: { path: { type: 'string' } } }),
]
const clone = (value) => structuredClone(value)
const namesOf = (tools) => tools.map((tool) => tool.function?.name ?? tool.name)
const defOf = (tools, name) => { const tool = tools.find((entry) => (entry.function?.name ?? entry.name) === name); return tool?.function ?? tool }

const baseParams = () => ({
  model: 'beam-free',
  messages: [{ role: 'system', content: 'You are a coding agent.' }, { role: 'user', content: 'hi' }],
  tools: clone(PI_TOOLS),
})

check('the required environment block is added', () => {
  const params = applyFingerprint(baseParams())
  const system = params.messages.find((message) => message.role === 'system')
  assert.match(String(system.content), /Working directory:/)
  assert.match(String(system.content), /Platform:/)
})

check("a caller's own <env> block is kept, not doubled", () => {
  const params = baseParams()
  params.messages[0].content = 'original\n<env>\n  Working directory: /mine\n</env>'
  applyFingerprint(params)
  const system = params.messages.find((message) => message.role === 'system')
  assert.match(String(system.content), /Working directory: \/mine/)
  assert.equal((String(system.content).match(/Working directory:/g) ?? []).length, 1)
})

check('the identity-metered tool names are renamed with a mapping note', () => {
  const params = applyFingerprint(baseParams())
  const names = namesOf(params.tools)
  assert.ok(names.includes('conversation_delegate'), 'subagent_fork renamed')
  assert.ok(names.includes('workspace_directory'), 'working_directory renamed')
  assert.ok(!names.includes('subagent_fork'))
  assert.ok(!names.includes('working_directory'))
  const system = params.messages.find((message) => message.role === 'system')
  assert.match(String(system.content), /use `conversation_delegate` for `subagent_fork`/)
})

check('the gate slots carry the verbatim declarations; the caller tools survive aliased', () => {
  const params = applyFingerprint(baseParams())
  const names = namesOf(params.tools)
  assert.ok(names.includes('read') && defOf(params.tools, 'read').description.startsWith('Read the contents of a file or directory.'))
  assert.ok(names.includes('shell') && defOf(params.tools, 'shell').description.startsWith('Execute a shell command and return its output.'))
  assert.ok(names.includes('read_ofm1'), 'pi read survives under an alias')
  assert.ok(names.includes('shell_ofm2'), 'pi shell survives under an alias')
  assert.equal(names.filter((name) => name === 'read').length, 1, 'the gate name appears exactly once')
})

check('prior-turn calls follow the aliases, and tool_choice is retargeted', () => {
  const params = baseParams()
  params.messages.push({
    role: 'assistant',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } }],
  })
  params.messages.push({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' })
  params.tool_choice = { type: 'function', function: { name: 'read' } }
  const aliases = new Map()
  applyFingerprint(params, { aliases })
  const call = params.messages.find((message) => Array.isArray(message.tool_calls))?.tool_calls?.[0]
  assert.equal(call.function.name, 'read_ofm1', 'history call renamed to the alias')
  assert.equal(params.tool_choice.function.name, 'read_ofm1', 'tool_choice follows the alias')
})

check('tool_choice none is never emitted', () => {
  const params = baseParams()
  params.tool_choice = 'none'
  applyFingerprint(params)
  assert.equal(params.tool_choice, undefined)
})

check('the placeholder note and a system message exist even without tools', () => {
  const params = { model: 'beam-free', messages: [{ role: 'user', content: 'hi' }] }
  applyFingerprint(params)
  assert.ok(Array.isArray(params.tools) && params.tools.length === 2, 'both verbatim tools injected')
  const system = params.messages.find((message) => message.role === 'system')
  assert.match(String(system.content), /Do not call the `read` or `shell` tools/)
})

check('a caller tool already carrying the verbatim definition is not duplicated', () => {
  const verbatim = CHAT_TOOL('read', FINGERPRINT_TOOL_DEFINITIONS.read.description, clone(FINGERPRINT_TOOL_DEFINITIONS.read.parameters))
  const injected = applyFingerprint({ model: 'beam-free', messages: [{ role: 'user', content: 'hi' }], tools: [verbatim] })
  assert.equal(namesOf(injected.tools).filter((name) => name === 'read').length, 1)
  assert.ok(namesOf(injected.tools).includes('shell'), 'the missing slot is still injected')
})

check('session ids are minted canonically', () => {
  const id = mintSessionId()
  assert.ok(SESSION_RE.test(id), `shape: ${id}`)
  assert.ok(SESSION_DESCENDING_RE.test(id.slice(4, 16)), 'descending time half')
  assert.equal(sessionFor('conv-1'), sessionFor('conv-1'), 'stable per conversation')
  assert.notEqual(sessionFor('conv-1'), sessionFor('conv-2'))
})

check('gateway headers carry the pooled credential and the four session headers', () => {
  const headers = gatewayHeaders({ session: 'ses_000000000fffaaaaaaaaaaaaaa', stream: true })
  assert.equal(headers.authorization, 'Bearer public')
  assert.equal(headers['user-agent'], 'opencode/latest/2.0.26/cli')
  assert.equal(headers['x-opencode-session'], headers['x-session-id'])
  assert.equal(headers['x-opencode-session'], headers['x-opencode-session-id'])
  assert.equal(headers['x-opencode-session'], headers['x-session-affinity'])
  assert.equal(headers['x-opencode-request'], undefined, 'no v1-only header')
  assert.equal(headers.accept, 'text/event-stream')
})

check('a gate-slot collision moves the caller tool to a fresh alias instead of crashing', () => {
  // Regression guard for a real latent bug the TS pass surfaced: the gate-slot
  // rename picked `read_ofm1`, found it already taken, and reassigned the alias
  // in the loop — which used to be a `const`, throwing at runtime on that path.
  const params = {
    model: 'demo',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'read_ofm1', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ],
  }
  const aliases = new Map()
  let out
  assert.doesNotThrow(() => { out = applyFingerprint(params, { aliases }) }, 'the collision resolves instead of a const-reassignment crash')
  const names = out.tools.map((tool) => tool.function?.name ?? tool.name)
  assert.ok(names.includes('read_ofm2'), 'the caller read moved out of the slot to read_ofm2')
  assert.ok(names.includes('read_ofm1'), 'the pre-existing read_ofm1 tool is left untouched')
  assert.ok(names.includes('read'), 'a verbatim read declaration owns the gate slot')
  assert.equal(aliases.get('read_ofm2'), 'read', 'the restore mapping points back at the caller tool')
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
