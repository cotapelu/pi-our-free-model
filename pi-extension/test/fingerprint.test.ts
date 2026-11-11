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
import { applyFingerprint, gatewayHeaders, mintSessionId, sessionFor, SESSION_RE, SESSION_DESCENDING_RE } from '../dist/fingerprint.js'
import { restoreToolName } from '../dist/upstream.js'
import { officialToolDefinition } from '../dist/o2a/official-tools.js'

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

check("the official prompt's <env> block is part of the gate", () => {
  // 2.8.3 moved the environment block inside the official CLI prompt, where it
  // is a superset of the one this port used to append on its own: the model id
  // and today's date ride along. Injection is marker-guarded, so shaping twice
  // cannot double it — the caller's own `<env>` no longer blocks the prompt,
  // because the gate reads the prompt, not the block count.
  const params = applyFingerprint(baseParams())
  const system = params.messages.find((message) => message.role === 'system')
  assert.match(String(system.content), /Working directory:/)
  assert.match(String(system.content), /Platform:/)
  applyFingerprint(params)
  const prompts = params.messages.filter((message) => typeof message.content === 'string' && message.content.includes('You are opencode, an interactive CLI tool'))
  assert.equal(prompts.length, 1, 'the prompt was injected twice')
})

check('every foreign tool name becomes an opaque clint_ name, with its history and choice', () => {
  // The free tier answers a body that still carries another client's vocabulary
  // with 403/429 (measured 2026-10-30), so nothing the caller named survives on
  // the wire under its own spelling. Two names fold onto official tools and are
  // bound instead — see the next check.
  const params = baseParams()
  params.messages.push({
    role: 'assistant',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'subagent_fork', arguments: '{}' } }],
  })
  params.tool_choice = { type: 'function', function: { name: 'working_directory' } }
  const aliases = new Map()
  applyFingerprint(params, { aliases })
  const names = namesOf(params.tools)
  for (const foreign of ['subagent_fork', 'working_directory']) {
    assert.ok(!names.includes(foreign), `${foreign} stayed on the wire`)
    const wire = [...aliases.keys()].find((key) => aliases.get(key) === foreign)
    assert.ok(wire !== undefined && wire.startsWith('clint_'), `${foreign} was not renamed`)
    assert.equal(wire.length, 'clint_'.length + 12, 'the wire name is not the 12-hex digest')
  }
  // The response side restores the caller's spelling from the wire name, which
  // is the whole reason the rename map exists.
  for (const [wire, caller] of aliases) assert.equal(restoreToolName(wire, aliases), caller)
  // The prior-turn call is renamed with its declaration, so the model reads its
  // own history as a call to the tool the wire actually serves this turn — not
  // as a call to something dropped, and not as a call to a placeholder.
  const call = params.messages.find((message) => Array.isArray(message.tool_calls))?.tool_calls?.[0]
  assert.equal(call.function.name.startsWith('clint_'), true, 'the history call kept the caller spelling')
  assert.equal(aliases.get(call.function.name), 'subagent_fork')
  assert.equal(call.id, 'call_1', 'the paired tool result row lost its call')
  // The placeholder note names the officials that were *appended*; the two the
  // caller declared itself are bound, not placeholders, so they are absent.
  const system = params.messages.find((message) => message.role === 'system')
  assert.match(String(system.content), /placeholders that do nothing/)
  assert.match(String(system.content), /`question` or `skill`/)
  assert.doesNotMatch(String(system.content), /Do not call the `read` or `shell` tools/)
})


check('the full official set is appended, and a folding caller tool is bound not duplicated', () => {
  // v1.4.7 BindOfficial: a caller tool whose folded name is one of an official's
  // known client spellings rides the wire under the official name — its own
  // definition, not a `clint_` opaque — and the official definition is not
  // appended a second time. That is the shape the CLI's own clients send.
  const params = applyFingerprint(baseParams())
  const names = namesOf(params.tools)
  assert.equal(names.filter((name) => name === 'read').length, 1, 'the official definition was duplicated')
  assert.equal(names.filter((name) => name === 'shell').length, 1)
  assert.equal(defOf(params.tools, 'read').description, 'Read a file into context.', "the caller's own definition was replaced")
  for (const official of ['edit', 'execute', 'glob', 'grep', 'question', 'skill', 'subagent', 'webfetch', 'websearch', 'write', 'patch']) {
    assert.ok(names.includes(official), `${official} was not appended`)
  }
})

check('tool_choice none is never emitted', () => {
  const params = baseParams()
  params.tool_choice = 'none'
  applyFingerprint(params)
  assert.equal(params.tool_choice, undefined)
})

check('the placeholder note and the official set exist even without tools', () => {
  const params = { model: 'beam-free', messages: [{ role: 'user', content: 'hi' }] }
  applyFingerprint(params)
  assert.ok(Array.isArray(params.tools) && params.tools.length === 13, 'the whole official set was injected')
  const system = params.messages.find((message) => message.role === 'system')
  assert.match(String(system.content), /placeholders that do nothing/)
})

check('a caller tool already carrying the verbatim definition is not duplicated', () => {
  const verbatim = CHAT_TOOL('read', officialToolDefinition('read').description, clone(officialToolDefinition('read').parameters))
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

check('a wire-name collision resolves instead of crashing', () => {
  // Regression guard for a real latent bug the TS pass surfaced: the rename
  // picked `read_ofm1`, found it already taken, and reassigned the alias in the
  // loop — which used to be a `const`, throwing at runtime on that path. The
  // opaque naming keeps the same hazard: two caller names must land on two
  // distinct wire names, and the one already taken keeps its own.
  const params = {
    model: 'demo',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ],
  }
  const aliases = new Map()
  let out
  assert.doesNotThrow(() => { out = applyFingerprint(params, { aliases }) }, 'the collision resolves instead of a const-reassignment crash')
  const names = out.tools.map((tool) => tool.function?.name ?? tool.name)
  const wires = names.filter((name) => name.startsWith('clint_'))
  assert.equal(wires.length, 2, 'two foreign tools must not share one wire name')
  assert.equal(new Set(wires).size, 2, 'two foreign tools must not collide on one name')
  assert.deepEqual([...aliases.values()].sort(), ['a', 'b'], 'each wire name maps to exactly one caller name')
  assert.equal(names.filter((name) => name === 'read').length, 1, 'the folding caller tool owns the read slot')
  assert.equal(aliases.size, 2, 'only the two foreign tools were renamed')
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
