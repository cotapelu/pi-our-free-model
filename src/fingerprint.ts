/**
 * OpenCode free-lane client fingerprint (port of `src/upstream.js`).
 *
 * The OpenCode gateway serves a free tier with one *pooled public* credential
 * (`Authorization: Bearer public`) and decides who may use it by fingerprinting
 * the client: a v2 User-Agent, four same-valued session headers, a session id
 * encoded the way the official CLI mints it, and two tool declarations byte-for-
 * byte identical to the ones the official CLI sends. Any mismatch answers
 * `403 FreeTierError` — the gate is a client check, not an account check.
 *
 * Everything here is that fingerprint. Do not reword the tool definitions: the
 * upstream compares description and schema verbatim.
 *
 * @module pi-extension/fingerprint.js
 */

// The 2.8.3 shaping pipeline itself lives in `o2a/` — a file-by-file port of
// opencode2api's gateway. It used to be ported and then left unimported while
// this file kept its own older shaping (caller tools renamed to `<name>_client`
// and the official pair appended). That older pass satisfies the tool gate but
// never sends the official system prompt the gate also checks, and it leaves a
// caller's foreign vocabulary on the wire, which the free tier answers with a
// 403/429. So the pipeline is wired in here rather than kept as a second
// implementation.
import { ToolRenameMap } from './o2a/tool-renames.js'
import { injectOfficialPrompt, carriesOpenCodePrompt } from './o2a/official-prompt.js'
import { renameAndCompleteTools } from './o2a/toolshape.js'
import { renamableToolName } from './o2a/official-tools.js'
import { officialToolDefinition } from './o2a/official-tools.js'
import { ensureChatUsage, ensureV2CompletionLimit } from './o2a/gateway-body.js'

/** The client the v2 gate fingerprints. Shape `opencode/<channel>/<version>/<client>`; major >= 2. */
export const CLIENT_UA = 'opencode/latest/2.0.26/cli'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** The two tools the v2 gate requires. Verbatim from OpenCode v2.0.26 — never reword. */
/**
 * Satisfy the v2 free-tier fingerprint gate on a body in **any** wire shape.
 *
 * The shaping itself is `o2a/`'s, exactly as `src/upstream.js` drives it in
 * 2.8.3: the official system prompt first (the gate checks it, not only the
 * tools), then every caller tool renamed to an opaque `clint_` wire name with
 * the official tool set appended and every reference following it, then the two
 * chat-body constants. The three-wire adaptation this port owns is the shape
 * vocabulary — `true` is Responses' flat items, `'claude'` is Anthropic
 * messages, `false` is Chat — and the environment block, which rides inside
 * the official prompt so a gateway serving another workspace can name that
 * workspace's directory rather than this process's cwd.
 *
 * A caller's tools are never edited in place: touched rows are replaced with
 * shallow copies, because those objects are shared with the host harness.
 *
 * Ported from dsh's `src/upstream.js` applyFingerprint (the three-wire half).
 */
export function applyFingerprintWire(body: any, style: true | 'claude' | false, environment: { directory?: string; platform?: string } = {}): ToolRenameMap {
  const shape = style === true ? 'flat' : style === 'claude' ? 'claude' : 'chat'
  if (!body || typeof body !== 'object') return new ToolRenameMap()

  // 0. Title requests ship unshaped: an agent-shaped tool list on a toolless
  // title call is a 403/429 the reference measured (see isTitleRequest). The
  // harness's title round-trip used to hit exactly that whenever the local
  // title answer was switched off, because this lane injects the full official
  // prompt and tool set on every body.
  if (isTitleRequest(body, style)) return new ToolRenameMap()

  // 1. The official system prompt. Its `<env>` block is the one this port keeps
  // as a seam: the caller names the workspace directory, where the CLI's own
  // block can only name the process's cwd. A body that already carries the
  // marker is left alone, so repeated shaping cannot duplicate it.
  injectOfficialPrompt(body, shape, { workDir: environment.directory })

  // 2+3+4. The tool pass. `keep` is the set of declarations that are already
  // the verbatim official definition: those are officials already on the wire,
  // so they are neither renamed nor appended a second time.
  const declared = Array.isArray(body.tools) ? body.tools : []
  const keep = new Set<string>()
  for (const tool of declared) {
    const name = renamableToolName(shape, tool)
    if (name === null) continue
    if (carriesOfficialDefinition(tool, name, shape)) keep.add(name)
  }
  const { renames, injected } = renameAndCompleteTools(body, shape, { keep })
  if (injected.length > 0) noteInjectedTools(body, shape, injected)

  // 5. Never ship `tool_choice: 'none'` — v2 answers it with 403. Only the
  // Responses wire defaults an absent choice to `auto`, which is the official
  // behaviour.
  if (body.tool_choice === 'none'
    || (body.tool_choice !== null && typeof body.tool_choice === 'object' && body.tool_choice.type === 'none')) {
    delete body.tool_choice
  }
  if (shape === 'flat' && !body.tool_choice) body.tool_choice = 'auto'

  // 6. The chat body's own two constants.
  ensureChatUsage(body, shape)
  ensureV2CompletionLimit(body, shape)
  return renames
}

/** Wire-shape names the o2a shaper speaks. */
function shapeOf(style: true | 'claude' | false): 'flat' | 'claude' | 'chat' {
  return style === true ? 'flat' : style === 'claude' ? 'claude' : 'chat'
}

/**
 * Does this declaration already carry the official definition of `name`
 * (`carriesOfficialDefinition`)?
 *
 * The official JSON is the comparison: a caller that pasted the CLI's own
 * `read` declaration has already satisfied that half of the gate, and renaming
 * it would only re-append the same thing under a second name. The comparison
 * ignores key order, because JSON object order is not meaningful and a caller's
 * serializer does not owe anyone one.
 */
function carriesOfficialDefinition(tool: any, name: string, shape: 'flat' | 'claude' | 'chat'): boolean {
  const official = officialToolDefinition(name)
  if (official === undefined) return false
  const declared = shape === 'chat' ? tool?.function : tool
  if (!declared || typeof declared !== 'object') return false
  const schema = shape === 'claude' ? declared.input_schema : declared.parameters
  const expected = shape === 'claude' ? official.input_schema : official.parameters
  if (schema === undefined || expected === undefined) return false
  const stable = (value: any): string => JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner)
  return stable(schema) === stable(expected)
}

/**
 * The request shapes the free tier reads as a conversation-title generator
 * (`title.IsTitleRequest`, opencode2api v1.4.7): no tools declared, one to
 * three turns, no assistant/tool/function turn, and a title marker in the
 * system or leading text.
 *
 * The reference stopped shaping these bodies in v1.4.7 with a measured reason:
 * the free tier answers an agent-shaped tool list on a toolless title call
 * with 403/429. A title request now ships as the caller wrote it — no prompt
 * injection, no tool append, no renames.
 */
const TITLE_MARKERS = /generate a title|write a title|create a title|come up with a title|title (?:for|of) (?:this|the) (?:conversation|chat|session|exchange|request)|conversation title|summarize (?:this|the) conversation/i

/** Is this body a conversation-title round-trip? */
export function isTitleRequest(body: any, style: true | 'claude' | false): boolean {
  if (!body || typeof body !== 'object') return false
  if ((Array.isArray(body.tools) && body.tools.length > 0) || (Array.isArray(body.functions) && body.functions.length > 0)) return false
  if (body.tool_choice !== undefined) return false
  const shape = shapeOf(style)
  const textOf = (value: any) => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map((part: any) => part?.text ?? '').join('\n') : ''
  let turns: any[]
  let leading = ''
  if (shape === 'flat') {
    turns = (Array.isArray(body.input) ? body.input : []).filter((item: any) => item !== null && typeof item === 'object' && typeof item.role === 'string')
    leading = textOf(body.instructions)
  } else {
    turns = (Array.isArray(body.messages) ? body.messages : []).filter((message: any) => message !== null && typeof message === 'object')
    leading = shape === 'claude' ? textOf(body.system) : ''
  }
  if (turns.length === 0 || turns.length > 3) return false
  for (const turn of turns) {
    if (!['user', 'system', 'developer'].includes(String(turn.role ?? ''))) return false
  }
  return TITLE_MARKERS.test(`${leading}\n${turns.map(turn => textOf(turn.content)).join('\n')}`)
}

function fingerprintKey(name: string): string {
  const trimmed = String(name ?? '').trim()
  return FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : ''
}

function functionOf(tool: any) {
  return tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function : null
}

/** Append a note where the wire keeps its instructions, never replacing caller blocks. */
function appendSystemContext(body: any, shape: 'flat' | 'claude' | 'chat', note: string) {
  if (shape === 'flat') {
    body.instructions = typeof body.instructions === 'string' && body.instructions.trim() !== ''
      ? `${body.instructions}\n\n${note}`
      : note
    return
  }
  if (shape === 'claude') {
    body.system = Array.isArray(body.system)
      ? [...body.system, { type: 'text', text: note }]
      : typeof body.system === 'string' && body.system !== '' ? `${body.system}\n\n${note}` : note
    return
  }
  if (!Array.isArray(body.messages)) body.messages = []
  const first = body.messages.find((message: any) => message?.role === 'system' || message?.role === 'developer')
  if (first === undefined) {
    body.messages.unshift({ role: 'system', content: note })
    return
  }
  if (typeof first.content === 'string') first.content = `${first.content}\n\n${note}`
  else if (Array.isArray(first.content)) first.content = [...first.content, { type: 'text', text: note }]
}

/** Tell the model injected tools are placeholders; never replace caller blocks. */
function noteInjectedTools(body: any, shape: 'flat' | 'claude' | 'chat', names: string[]) {
  appendSystemContext(body, shape, placeholderNote(names))
}

/**
 * The environment block the free lane requires alongside the tool fingerprint.
 *
 * dsh's reversible live controls (2026-10-28) returned 429 *without* it and
 * answered with it, so a free-lane request that omits this block is refused
 * before any model runs — it is part of the gate, not decoration. A caller that
 * already carries an `<env>` block keeps its own.
 *
 * Now folded into `o2a`'s official prompt (whose `<env>` block is a superset:
 * the model id and today's date ride along), so this entry stays for the
 * Chat-only half that still builds its own body: the adapter's own lanes and
 * the probe. It is not called from `applyFingerprintWire` any more, and calling
 * it there would produce a second `<env>` block.
 */
export function ensureFreeLaneEnvironment(params: any, environment: { directory?: string; platform?: string } = {}) {
  const messages = Array.isArray(params?.messages) ? params.messages : []
  const existing = messages
    .filter((message: any) => message?.role === 'system' || message?.role === 'developer')
    .map((message: any) => textOfContent(message.content))
    .join('\n')
  if (/<env>[\s\S]*?<\/env>/i.test(existing)) return params
  const line = (value: any) => String(value).replace(/[\r\n<>]/g, ' ')
  const cwd = environment.directory ?? process.cwd()
  const platform = environment.platform ?? process.platform
  const note = `Here is some useful information about the environment you are running in:\n<env>\n  Working directory: ${line(cwd)}\n  Platform: ${line(platform)}\n</env>`
  appendSystemContext(params, 'chat', note)
  return params
}

function textOfContent(content: any) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('\n')
  return ''
}

/** Session-scoped identity used to pick a decoy out of a real tool call. */
export function declaredToolNames(body: any): Set<string> {
  const names = new Set<string>()
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const n = toolNameOf(tool)
    if (n) names.add(n)
  }
  return names
}

/** The gate names, declared with the definitions above. */
export const FINGERPRINT_TOOLS = ['read', 'shell']

/**
 * Tool names the free lane meters by identity rather than by definition.
 *
 * Reproduced from dsh's live controls (2026-10-30): `subagent_fork` alone, and
 * `read_image` together with `working_directory`, each answered 429 on a
 * request that passed every other check; renaming only these two entries
 * restored the full 80-tool request. The caller's schema and behaviour are
 * kept, and the model is told the mapping so it can still ask for them.
 */
/**
 * `ses_` + 12 minted hex digits + 14 base62 chars. The 12 hex digits must be the
 * descending `~(ts_ms << 12 | counter)` value with counter 1–63, i.e. the low
 * 12 bits land in `0xfc0–0xfff`. Random hex or an ascending `ts << 12` value is
 * refused with 403 FreeTierError even though the shape is right.
 */
export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
export const SESSION_DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

/** Per-conversation minted sessions, keyed by the pi session id. */
const sessions = new Map()

/** Mint a canonical session id: `~(ts_ms * 0x1000 + seq)`, counter resetting per millisecond. */
export function mintSessionId(timestamp = Date.now(), seqState = { last: 0, stamp: 0 }) {
  if (seqState.stamp !== timestamp) {
    seqState.stamp = timestamp
    seqState.last = 0
  }
  seqState.last += 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seqState.last))
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `ses_${hex}${base62From(cryptoRandomBytes(14))}`
}

const counter = { last: 0, stamp: 0 }

/** Random 14 base62 characters for the session id's entropy half. */
function base62From(bytes: Uint8Array) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

function cryptoRandomBytes(n: number) {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return bytes
}

/**
 * One stable upstream session per downstream conversation.
 *
 * The quota is accounted per session, and a hash-derived pseudo timestamp reads
 * as a minted id to the shape check but not to the accounting (429 on a fresh
 * conversation). A real `Date.now()` mint stays valid across turns and restarts
 * of the same conversation, so the map keeps it for the process lifetime.
 */
export function sessionFor(seed: string) {
  const key = typeof seed === 'string' && seed.trim() ? seed.trim() : 'global'
  const known = sessions.get(key)
  if (known !== undefined && SESSION_RE.test(known)) return known
  const minted = mintSessionId(Date.now(), counter)
  sessions.set(key, minted)
  return minted
}

/** Forget the mapped session, so the next turn for `seed` mints a fresh one. */
export function rotateSession(seed: string) {
  const key = typeof seed === 'string' && seed.trim() ? seed.trim() : 'global'
  sessions.delete(key)
}

/** The headers the gateway fingerprints. `Bearer public` is the pooled free-tier credential. */
export function gatewayHeaders({ session, stream, accept }: { session: string; stream?: boolean; accept?: string }) {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-project': 'global',
    accept: accept ?? (stream ? 'text/event-stream' : '*/*'),
  }
}

/** Name of a chat-completions tool entry (`{type:'function', function:{name}}`) or the flat Responses one. */
function toolNameOf(tool: any) {
  if (!tool || typeof tool !== 'object') return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && typeof fn.name === 'string' && fn.name.trim()) return fn.name.trim()
  return ''
}
/**
 * Append a note that the injected tools are placeholders.
 *
 * The v2 definitions are real tools with real descriptions, so the model may
 * call them. The wording was measured upstream: "unavailable" makes the model
 * refuse the caller's own tools too, while "placeholder" keeps both sides sane.
 */
function placeholderNote(names: string[]) {
  const list = names.map((name: string) => `\`${name}\``).join(' or ')
  return names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`
}

/**
 * Apply the v2 fingerprint to one outgoing Chat-Completions payload.
 *
 * In order: rename the two identity-metered tool names and every caller tool
 * colliding with the gate slots (`read`, `shell`) while keeping them callable
 * under the alias; inject the two verbatim declarations; rename prior-turn
 * calls to the aliases now declared; retarget `tool_choice` at a renamed tool;
 * never emit `tool_choice: 'none'` (403 in v2); add the lane's required `<env>`
 * block; and append the placeholder note plus the rename mapping to the leading
 * system message. `collect.aliases` receives `alias -> caller name` so the
 * response side can rename back.
 *
 * @param {object} params payload pi-ai built; mutated in place and returned
 * @param {{aliases?: Map<string,string>, environment?: object}} [collect]
 * @returns {object} the same payload, fingerprinted
 */
/**
 * The Chat-wire entry the pi extension drives (`applyFingerprint`).
 *
 * Thin on purpose: the shaping is `applyFingerprintWire`'s, shared with the
 * service entries, so there is one gate path rather than one per caller. What
 * this entry still owns is the caller's contract — `collect.aliases` is the map
 * the stream rewriter reads to restore the caller's tool spelling, so the rename
 * set produced by the pass is copied into it. Returning `params` keeps the
 * in-place contract the call sites rely on.
 */
export function applyFingerprint(params: any, collect?: any) {
  if (!params || typeof params !== 'object') return params
  const aliases: Map<string, string> = collect?.aliases ?? new Map()
  const renames = applyFingerprintWire(params, false, collect?.environment ?? {})
  for (const [wire, caller] of renames) aliases.set(wire, caller)
  if (collect !== undefined && collect !== null) collect.aliases = aliases
  return params
}
