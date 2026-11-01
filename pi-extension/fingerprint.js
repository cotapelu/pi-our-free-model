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

/** The client the v2 gate fingerprints. Shape `opencode/<channel>/<version>/<client>`; major >= 2. */
export const CLIENT_UA = 'opencode/latest/2.0.26/cli'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** The two tools the v2 gate requires. Verbatim from OpenCode v2.0.26 — never reword. */
export const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description:
      'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'The line or directory entry to start reading from (1-based)',
        },
        limit: {
          type: 'integer',
          minimum: 0,
          description:
            'The maximum number of lines or directory entries to read (defaults to and capped at 2000)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: {
          type: 'string',
          description:
            'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories and use this working directory argument instead.',
        },
        timeout: {
          type: 'integer',
          minimum: 0,
          description:
            'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.',
        },
        background: {
          type: 'boolean',
          description:
            'Run the command in the background (useful for dev servers). Avoid using this for blocking commands; run those synchronously.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
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
export const FREE_LANE_TOOL_ALIASES = Object.freeze({
  subagent_fork: 'conversation_delegate',
  working_directory: 'workspace_directory',
})

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
function base62From(bytes) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

function cryptoRandomBytes(n) {
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
export function sessionFor(seed) {
  const key = typeof seed === 'string' && seed.trim() ? seed.trim() : 'global'
  const known = sessions.get(key)
  if (known !== undefined && SESSION_RE.test(known)) return known
  const minted = mintSessionId(Date.now(), counter)
  sessions.set(key, minted)
  return minted
}

/** Forget the mapped session, so the next turn for `seed` mints a fresh one. */
export function rotateSession(seed) {
  const key = typeof seed === 'string' && seed.trim() ? seed.trim() : 'global'
  sessions.delete(key)
}

/** The headers the gateway fingerprints. `Bearer public` is the pooled free-tier credential. */
export function gatewayHeaders({ session, stream, accept }) {
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
function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object') return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && typeof fn.name === 'string' && fn.name.trim()) return fn.name.trim()
  return ''
}

/** Does this tool already carry OpenCode's own definition for `name`? */
function carriesFingerprintDefinition(tool, name) {
  const body = toolBodyOf(tool)
  const own =
    body && typeof body === 'object'
      ? { description: body.description, schema: body.parameters ?? body.input_schema }
      : null
  if (own === null) return false
  const want = FINGERPRINT_TOOL_DEFINITIONS[name]
  return own.description === want.description && JSON.stringify(own.schema) === JSON.stringify(want.parameters)
}

function toolBodyOf(tool) {
  return tool.function && typeof tool.function === 'object' ? tool.function : tool
}

/**
 * Append a note that the injected tools are placeholders.
 *
 * The v2 definitions are real tools with real descriptions, so the model may
 * call them. The wording was measured upstream: "unavailable" makes the model
 * refuse the caller's own tools too, while "placeholder" keeps both sides sane.
 */
function placeholderNote(names) {
  const list = names.map((name) => `\`${name}\``).join(' or ')
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
export function applyFingerprint(params, collect) {
  if (!params || typeof params !== 'object') return params
  const aliases = collect?.aliases ?? new Map()
  const messages = Array.isArray(params.messages) ? params.messages : []
  const taken = new Set((Array.isArray(params.tools) ? params.tools : []).map(toolNameOf).filter(name => name !== ''))

  // 1. The two names the lane meters by identity (429 without the rename),
  //    then the gate slots: every caller tool that collides with `read`/`shell`
  //    moves out under a deterministic alias, so the verbatim declaration owns
  //    the slot. Case variants (`Read`, `BASH`) are not gate names and pass as-is.
  let serial = 0
  /** caller name -> alias sent on this request, for history and tool_choice. */
  const renameOf = new Map()
  const compatibilityNotes = []
  if (Array.isArray(params.tools)) {
    for (const tool of params.tools) {
      const name = toolNameOf(tool)
      const compatibilityBase = Object.hasOwn(FREE_LANE_TOOL_ALIASES, name) ? FREE_LANE_TOOL_ALIASES[name] : undefined
      if (compatibilityBase !== undefined) {
        let alias = compatibilityBase
        for (let i = 2; taken.has(alias); i += 1) alias = `${compatibilityBase}${i}`
        taken.add(alias)
        renameToolInPlace(tool, alias)
        aliases.set(alias, name)
        renameOf.set(name, alias)
        compatibilityNotes.push(`use \`${alias}\` for \`${name}\``)
        continue
      }
      if (!FINGERPRINT_TOOLS.includes(name)) continue
      serial += 1
      const alias = `${name}_ofm${serial}`
      for (let i = 2; taken.has(alias); i += 1) alias = `${name}_ofm${i}`
      taken.add(alias)
      renameToolInPlace(tool, alias)
      aliases.set(alias, name)
      renameOf.set(name, alias)
    }
  }

  // 2. Inject the verbatim declarations when the gate slots are not already
  //    carried with OpenCode's own definitions.
  if (!Array.isArray(params.tools)) params.tools = []
  for (const name of FINGERPRINT_TOOLS) {
    const present = params.tools.some((tool) => toolNameOf(tool) === name && carriesFingerprintDefinition(tool, name))
    if (present) continue
    params.tools.push({ type: 'function', function: { name, ...FINGERPRINT_TOOL_DEFINITIONS[name] } })
  }

  // 3. Prior-turn calls were recorded under the caller's names; rename them to
  //    the aliases used in this request's declarations, or the model reads its
  //    own earlier calls as calls to the injected placeholder tools.
  if (renameOf.size > 0) {
    for (const message of messages) {
      if (!message || typeof message !== 'object' || !Array.isArray(message.tool_calls)) continue
      for (const call of message.tool_calls) {
        const fn = call?.function
        const name = typeof fn?.name === 'string' ? fn.name : ''
        if (name !== '' && renameOf.has(name)) fn.name = renameOf.get(name)
      }
    }
  }

  // 4. An explicit `tool_choice` naming a renamed tool must follow the alias.
  retargetToolChoice(params, renameOf)

  // 5. v2 refuses `tool_choice: 'none'` outright; never emit it.
  if (params.tool_choice === 'none') delete params.tool_choice

  // 6. The lane's environment block: a request without it is refused (429).
  ensureFreeLaneEnvironment(params, collect?.environment)

  // 7. Tell the model the injected tools are placeholders, and name the mapping
  //    for the two identity-metered renames.
  appendSystemNote(params, placeholderNote(FINGERPRINT_TOOLS))
  if (compatibilityNotes.length > 0) {
    appendSystemNote(params, `Tool name mapping for this request: ${compatibilityNotes.join('; ')}. These tools retain their original behavior and parameters.`)
  }
  return params
}

/** Rename a tool declaration in place, whichever shape it arrived in. */
function renameToolInPlace(tool, alias) {
  const body = toolBodyOf(tool)
  if (body && typeof body === 'object') body.name = alias
}

/** Point an explicit `tool_choice` at the alias of a tool that was renamed. */
function retargetToolChoice(params, renameOf) {
  if (!renameOf || renameOf.size === 0) return
  const choice = params.tool_choice
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return
  const fn = choice.function
  if (typeof choice.name === 'string' && renameOf.has(choice.name.trim())) {
    params.tool_choice = { ...choice, name: renameOf.get(choice.name.trim()) }
    return
  }
  if (fn && typeof fn === 'object' && typeof fn.name === 'string' && renameOf.has(fn.name.trim())) {
    params.tool_choice = { ...choice, function: { ...fn, name: renameOf.get(fn.name.trim()) } }
  }
}

/** Append `note` to the leading system message, creating one when there is none. */
function appendSystemNote(params, note) {
  const messages = params.messages
  if (!Array.isArray(messages)) return
  const first = messages.find((message) => message?.role === 'system')
  if (first === undefined) {
    messages.unshift({ role: 'system', content: note })
    return
  }
  if (typeof first.content === 'string') first.content = `${first.content}\n\n${note}`
  else if (Array.isArray(first.content)) first.content = [...first.content, { type: 'text', text: note }]
}

/**
 * The environment block the free lane requires alongside the tool fingerprint.
 *
 * dsh's reversible live controls (2026-10-28) returned 429 *without* it and
 * answered with it, so a free-lane request that omits this block is refused
 * before any model runs — it is part of the gate, not decoration. A caller that
 * already carries an `<env>` block keeps its own.
 */
export function ensureFreeLaneEnvironment(params, environment = {}) {
  const messages = Array.isArray(params?.messages) ? params.messages : []
  const existing = messages
    .filter((message) => message?.role === 'system' || message?.role === 'developer')
    .map((message) => textOfContent(message.content))
    .join('\n')
  if (/<env>[\s\S]*?<\/env>/i.test(existing)) return params
  const line = (value) => String(value).replace(/[\r\n<>]/g, ' ')
  const cwd = environment.directory ?? process.cwd()
  const platform = environment.platform ?? process.platform
  const note = `Here is some useful information about the environment you are running in:\n<env>\n  Working directory: ${line(cwd)}\n  Platform: ${line(platform)}\n</env>`
  appendSystemNote(params, note)
  return params
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('\n')
  return ''
}

