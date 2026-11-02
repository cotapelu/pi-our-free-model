/**
 * Re-measure the two keyless lanes against the live upstream.
 *
 * This is the executable form of the periodic maintenance item: the OpenCode
 * free lane is gated by a client fingerprint, and the gate moves without notice
 * (the dsh plugin's own `docs/free-lane-wire.md` records four such moves). A
 * refusal that reads as `403 FreeTierError` means the shape in
 * `pi-extension/fingerprint.js` no longer matches and must be re-measured
 * against a current official client; a `429 FreeUsageLimitError` means the gate
 * *passed* and this egress has simply spent its quota.
 *
 * The script also diffs the live rosters against the extension's offline
 * snapshot, so a model that appears, disappears, or moves to another wire is
 * reported instead of silently changing what `pi --list-models` offers.
 *
 * Usage: node pi-extension/scripts/reverify-upstream.mjs
 * Exits 0 when both lanes answer as expected, 1 on drift or a gate refusal.
 * It talks to the real upstream — it is not part of the offline test suite.
 */
import { mintSessionId, sessionFor, gatewayHeaders } from '../dist/fingerprint.js'
import {
  KILO_BASE,
  OPENECODE_BASE,
  STATIC_KILO_MODELS,
  STATIC_OPENECODE_MODELS,
  isOpencodeFreeId,
  kiloEffortMap,
  safeId,
} from '../dist/catalog.js'

const failures = []
const notes = []

function report(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Body the fingerprint pass ships, so the probe measures the same bytes. */
function probeBody(model) {
  const tools = ['read', 'shell'].map((name) => ({ type: 'function', function: { name, ...TOOLS[name] } }))
  return {
    model,
    stream: true,
    messages: [
      {
        role: 'system',
        content: [
          'You are a coding agent.',
          '',
          'Here is some useful information about the environment you are running in:',
          '<env>',
          `  Working directory: ${process.cwd()}`,
          `  Platform: ${process.platform}`,
          '</env>',
          '',
          'Do not call the `read` or `shell` tools; they are placeholders that do nothing. Use the other tools you have been given instead.',
        ].join('\n'),
      },
      { role: 'user', content: 'ping' },
    ],
    tools,
  }
}

const TOOLS = {
  read: {
    description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File or directory to read' }, offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' }, limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' } }, required: ['path'], additionalProperties: false },
  },
  shell: {
    description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command string to execute' }, timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' } }, required: ['command'], additionalProperties: false },
  },
}

async function reverifyOpencode() {
  const session = sessionFor('reverify')
  const headers = gatewayHeaders({ session, accept: 'application/json' })
  const listing = await fetch(`${OPENECODE_BASE}/inference/v1/models`, { headers, redirect: 'error' })
  report('the listing answers 200 under the fingerprint headers', listing.ok, `HTTP ${listing.status}`)
  if (!listing.ok) return
  const rows = (await listing.json()).data ?? []
  const free = rows.filter((row) => isOpencodeFreeId(row.id))
  const chat = free.filter((row) => row.api?.['chat-completions'])
  const other = free.filter((row) => !row.api?.['chat-completions'])
  report('every free row is chat-wired (the extension speaks one wire)', other.length === 0,
    other.length === 0 ? `${free.length} free ids, all chat` : `${other.map((row) => `${row.id} (${Object.keys(row.api ?? {}).join(',')})`).join(', ')} need another wire`)

  // Roster diff against the offline snapshot: an id that appeared, vanished, or
  // lost its declared thinking menu changes what pi offers and what it may send.
  const live = new Map(free.map((row) => [row.id, row]))
  const snapshot = new Set(STATIC_OPENECODE_MODELS.map((row) => row.id))
  const added = [...live.keys()].filter((id) => !snapshot.has(id))
  const missing = [...snapshot].filter((id) => !live.has(id))
  report('no new free id since the snapshot', added.length === 0, added.join(', '))
  report('no snapshot id disappeared from the lane', missing.length === 0, missing.join(', '))
  for (const [id, row] of live) {
    const declared = Array.isArray(row.capabilities?.reasoning?.effort) ? row.capabilities.reasoning.effort : []
    const row_has_menu = declared.length > 0
    const snapshot_has_menu = STATIC_OPENECODE_MODELS.find((entry) => entry.id === id)?.efforts !== undefined
    if (row_has_menu !== snapshot_has_menu) {
      notes.push(`${id}: declared effort menu changed (${row_has_menu ? `now ${declared.join('|')}` : 'gone'}) — update catalog.js`)
    }
  }

  // One turn, with every fingerprint element in place. A 403 here is the drift
  // this script exists to catch; a 429 is the gate passing on a spent quota.
  const model = free.find((row) => row.api?.['chat-completions'])?.id
  if (model === undefined) {
    report('a chat-wired free model exists to probe', false)
    return
  }
  const chat_headers = gatewayHeaders({ session, stream: true })
  for (const base of ['/inference/v1', '/inference/openai/v1']) {
    const response = await fetch(`${OPENECODE_BASE}${base}/chat/completions`, {
      method: 'POST', headers: chat_headers, redirect: 'error', body: JSON.stringify(probeBody(model)),
    })
    const text = await response.text()
    const refused = /FreeTierError|can only be used from within/i.test(text)
    report(`chat on ${base} keeps the fingerprint`, response.status === 200 || response.status === 429,
      refused ? 'FINGERPRINT REFUSED (403): re-measure per docs/free-lane-wire.md' : `HTTP ${response.status} ${text.slice(0, 90).replace(/\s+/g, ' ')}`)
  }
}

async function reverifyKilo() {
  const body = { model: 'kilo-auto/free', stream: true, messages: [{ role: 'user', content: 'ping' }] }
  const response = await fetch(`${KILO_BASE}/chat/completions`, {
    method: 'POST',
    // No Authorization on purpose: Kilo's free pool answers only a genuinely
    // credential-less request (a placeholder token is a 401).
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': 'pi-ofm-reverify' },
    redirect: 'error',
    body: JSON.stringify(body),
  })
  const text = await response.text()
  report('the Kilo free pool answers with no credential', response.ok && /(^|\n)data:/.test(text),
    `HTTP ${response.status} ${text.slice(0, 90).replace(/\s+/g, ' ')}`)

  const listing = await fetch(`${KILO_BASE}/models`, { headers: { accept: 'application/json' }, redirect: 'error' })
  if (!listing.ok) {
    report('the Kilo listing answers 200', false, `HTTP ${listing.status}`)
    return
  }
  const rows = (await listing.json()).data ?? []
  const free = rows.filter((row) => row.isFree === true)
  const live = new Set(free.map((row) => safeId(row.id)))
  const snapshot = new Set(STATIC_KILO_MODELS.map((row) => row.id))
  const added = [...live].filter((id) => !snapshot.has(id))
  const missing = [...snapshot].filter((id) => !live.has(id))
  report('no new Kilo free id since the snapshot', added.length === 0, added.join(', '))
  report('no snapshot id left the Kilo free pool', missing.length === 0, missing.join(', '))
  for (const row of free) {
    const menu = kiloEffortMap(row)
    const snapshot_row = STATIC_KILO_MODELS.find((entry) => entry.id === safeId(row.id))
    if (snapshot_row === undefined) continue
    const live_off = menu?.off ?? null
    const snapshot_off = snapshot_row.canDisable === false ? null : 'off'
    if (live_off !== snapshot_off) {
      notes.push(`${row.id}: off rung changed (snapshot ${snapshot_off ?? 'none'}, live ${live_off ?? 'none'}) — update catalog.js`)
    }
  }
}

console.log(`OpenCode lane (${OPENECODE_BASE})`)
await reverifyOpencode()
console.log(`\nKilo lane (${KILO_BASE})`)
await reverifyKilo()
for (const note of notes) console.log(`NOTE ${note}`)
console.log(failures.length === 0
  ? '\nBOTH LANES VERIFIED — fingerprint and rosters still match'
  : `\n${failures.length} CHECK(S) FAILED — ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
