/**
 * Fallback chains ("combos" in the dsh plugin): one selectable model name that
 * is really an ordered list of physical models, where the first one that
 * answers wins.
 *
 * Ported from `src/combos.js`, translated to pi's virtual-model architecture.
 * The important difference is where the failover happens: dsh walks its chain
 * inside one turn, while pi routes once per request and leaves retrying to its
 * own policy — and its policy deliberately treats quota walls (`FreeUsageLimitError`)
 * as *non-retryable*, because retrying a spent quota spends it three times.
 *
 * Measured against pi 1.4.0, neither `request.failed` nor the transcript can
 * carry the failure: `request.failed` is unset on the automatic-retry path, and
 * pi *durably omits* a failed attempt from the projection it hands to `route()`.
 * So a chain tracks its own picks in router state and infers the failure from
 * what pi does report:
 *
 *   - `previous` names the last model that produced a successful answer. When
 *     the chain's own last pick is not that model, its pick died;
 *   - a `retry` therefore advances to the link after the pick that just failed;
 *   - the next `user` turn after such a failure (a quota wall, which pi will not
 *     retry) also starts past it;
 *   - a `continuation` stays on the model that answered, so the prompt cache and
 *     thinking signatures survive;
 *   - the walk is capped at `links - 1` links per streak, so a chain of dead
 *     links fails its turn instead of flapping between them forever.
 *
 * @module pi-extension/chains.js
 */
import { createHash } from 'node:crypto'

/** Prefix for a chain's id, deliberately not a valid provider id. */
export const CHAIN_PREFIX = 'chain:'
/** The provider id chains are listed under; no physical model uses it. */
export const CHAIN_PROVIDER = 'ofm-chain'
export const CHAIN_STRATEGIES = ['fallback', 'round-robin']

/** pi's thinking levels, in the order the picker lists them. */
const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const UNBOUNDED = Number.MAX_SAFE_INTEGER

/** Stable, URL-safe id: `My Chain` -> `chain:my-chain`. */
export function chainId(name) {
  const normalized = String(name ?? '').trim().toLowerCase()
  if (normalized === '') return ''
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  const identity = slug && !/[^\x20-\x7e]/.test(normalized)
    ? slug
    : `${slug || 'chain'}-${createHash('sha256').update(normalized).digest('hex').slice(0, 8)}`
  return `${CHAIN_PREFIX}${identity}`
}

/**
 * Coerce a stored value (user input that survived a JSON file) into chains.
 *
 * Every field is untrusted: a link that is not `provider/model` is dropped, an
 * empty chain disappears, an unknown strategy falls back to `fallback` rather
 * than being honoured as a typo, and a link pointing at the chain itself is
 * dropped so a chain can never route to itself.
 */
export function normalizeChains(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const name = String(row.name ?? '').trim()
    const id = typeof row.id === 'string' && row.id.startsWith(CHAIN_PREFIX) ? row.id : chainId(name)
    if (id === '' || seen.has(id)) continue
    const links = [...new Set((Array.isArray(row.models) ? row.models : [])
      .map((value) => String(value ?? '').trim())
      .filter((value) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(value) && value !== id))]
    if (links.length === 0) continue
    seen.add(id)
    out.push({
      id,
      name: name || id.slice(CHAIN_PREFIX.length),
      models: links,
      strategy: CHAIN_STRATEGIES.includes(row.strategy) ? row.strategy : 'fallback',
      stickyLimit: Number.isFinite(Number(row.stickyLimit)) && Number(row.stickyLimit) > 0
        ? Math.min(16, Math.trunc(Number(row.stickyLimit)))
        : 1,
      enabled: row.enabled !== false,
    })
  }
  return out
}

/** Find a chain by its id, its id-from-name, or its display name. */
export function chainByName(chains, nameOrId) {
  const wanted = String(nameOrId ?? '').trim()
  if (wanted === '') return undefined
  return chains.find((chain) => chain.id === wanted || chain.id === chainId(wanted) || chain.name === wanted)
}

/**
 * Parse one `/ofm chain set <id|name> links <a> | <b>` argument list.
 *
 * Replacing a chain's links is the edit the file was needed for; it uses the
 * same spelling rules as `add`, because the same mistakes are possible.
 *
 * @param {string} input the text after `set`
 * @returns {{target:string, models:string[]}|{error:string}}
 */
export function parseChainSetLinks(input) {
  const text = String(input ?? '').trim()
  // `<id|name> links <a> | <b>` — the id and the keyword share the first field,
  // because only the link list is pipe-separated.
  const match = /^(\S+)\s+links\s+(.+)$/i.exec(text)
  if (match === null) {
    return { error: 'usage: /ofm chain set <id|name> links <provider/model> | <provider/model>' }
  }
  const models = [...new Set(match[2].split('|').map((field) => field.trim()).filter((field) => field !== ''))]
  const bad = models.find((link) => !LINK_FIELD.test(link))
  if (bad !== undefined) return { error: `"${bad}" is not a provider/model link` }
  if (models.length === 0) return { error: 'the chain needs at least one link' }
  return { target: match[1], models }
}

/**
 * Check a parsed `add` against the live registry.
 *
 * A link that does not resolve right now is almost always a typo, and a chain
 * that silently carried it would spend its first failure on a model that never
 * existed — the exact case dsh refuses by dropping dead links from the catalog.
 * An add whose links all fail is therefore refused; an add with some dead links
 * is accepted but names them, because a lane's roster legitimately moves between
 * refreshes.
 *
 * @param {{models:string[]}} parsed from `parseChainAdd`
 * @param {(address:string) => boolean} resolves
 * @returns {{ok:boolean, live:string[], dead:string[], error?:string}}
 */
export function evaluateAdd(parsed, resolves) {
  const models = Array.isArray(parsed?.models) ? parsed.models : []
  const live = []
  const dead = []
  for (const address of models) {
    let ok = false
    try {
      ok = resolves(address) === true
    } catch {
      ok = false
    }
    ;(ok ? live : dead).push(address)
  }
  if (live.length === 0) {
    return { ok: false, live, dead, error: `no link resolves right now: ${dead.join(', ')} — check the provider/model spelling (this extension registers ofm-kilo and ofm-opencode)` }
  }
  return { ok: true, live, dead }
}

/** A trailing `fallback`, `round-robin`, or `round-robin:3` field. */
const STRATEGY_FIELD = /^(fallback|round-robin)(?::([1-9][0-9]{0,3}))?$/i
/** One link: `provider/model` with the characters either side may carry. */
const LINK_FIELD = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/

/**
 * Parse one `/ofm chain add` argument list.
 *
 * `My Chain | ofm-kilo/a | ofm-kilo/b | round-robin:3` — the last field is the
 * strategy when it spells one (`fallback` or `round-robin`, with an optional
 * `:stickyLimit`); everything between the name and that field is a link. A link
 * that is not `provider/model` is refused *here* rather than dropped silently by
 * `normalizeChains`, because a chain quietly missing the link the user typed is
 * worse than being told the spelling is wrong.
 *
 * @param {string} input the text after `chain add`
 * @returns {{name:string, models:string[], strategy:string, stickyLimit:number}|{error:string}}
 */
export function parseChainAdd(input) {
  const fields = String(input ?? '').split('|').map((field) => field.trim())
  while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop()
  if (fields.length < 2) return { error: 'usage: /ofm chain add <name> | <provider/model> | <provider/model> [| fallback|round-robin[:sticky]]' }
  const name = fields[0]
  let strategy = 'fallback'
  let stickyLimit = 1
  let links = fields.slice(1)
  const last = links[links.length - 1]
  if (links.length >= 2 && STRATEGY_FIELD.test(last)) {
    const matched = STRATEGY_FIELD.exec(last)
    strategy = matched[1].toLowerCase()
    if (matched[2] !== undefined) stickyLimit = Math.min(16, Number(matched[2]))
    links = links.slice(0, -1)
  }
  if (name === '') return { error: 'the chain needs a name' }
  if (links.length === 0) return { error: 'the chain needs at least one link' }
  const bad = links.find((link) => !LINK_FIELD.test(link))
  if (bad !== undefined) return { error: `"${bad}" is not a provider/model link` }
  if (strategy === 'round-robin' && stickyLimit < 1) return { error: 'round-robin needs a sticky window of at least 1 turn' }
  return { name, models: [...new Set(links)], strategy, stickyLimit }
}

/**
 * The honest capacities of a chain: the intersection, never the union.
 *
 * A chain that advertised vision because its head supports it would hand a
 * text-only fallback an image it cannot read; a chain that advertised the head's
 * 1M window would overrun a 128K fallback. Only what every link can honour is
 * advertised, and a level any link refuses is not offered.
 */
export function intersectCapabilities(models) {
  const members = models.filter(Boolean)
  if (members.length === 0) return {}
  const input = ['text', 'image'].filter((kind) => members.every((model) => (model.input ?? []).includes(kind)))
  const levels = PI_LEVELS.filter((level) => members.every((model) => supportsLevel(model, level)))
  return {
    contextWindow: Math.min(...members.map((model) => model.contextWindow || UNBOUNDED)),
    maxTokens: Math.min(...members.map((model) => model.maxTokens || UNBOUNDED)),
    input,
    thinkingLevels: levels.length > 0 ? levels : ['off'],
  }
}

function supportsLevel(model, level) {
  const map = model.thinkingLevelMap
  if (map === undefined) return level === 'off'
  const mapped = map[level]
  return mapped !== null && mapped !== undefined
}

/**
 * The chain decision for one request, as `{ index, state }`.
 *
 * State carries `index` (current pick), `lastPick` (address most recently
 * dispatched), `walks` (failures since the last success, capped at
 * `links - 1`), and the round-robin cursor fields.
 */
export function decideLink({ chain, members, request }) {
  const total = members.length
  const address = (model) => `${model?.provider}/${model?.id}`
  const bare = { index: 0, cursor: 0, windowTurn: 0, turn: 0, walks: 0 }
  let state = { ...bare, ...(request.state ?? {}) }
  const positionOf = (wanted) => members.findIndex((model) => address(model) === wanted)
  // `previous` is pi's own view of the latest successful answer, but it is not
  // populated on every path (measured: undefined for print-mode turns). The
  // transcript always carries it, so fall back to the last non-error assistant
  // message and use whichever is available.
  const fromTranscript = lastAnswerIn(request.messages)
  const previousAddress = request.previous?.model
    ? address(request.previous.model)
    : (fromTranscript !== undefined ? fromTranscript : undefined)
  const failedAddress = request.failed?.model ? address(request.failed.model) : undefined
  const advanceFrom = (wanted) => {
    const position = positionOf(wanted)
    const next = wrap((position >= 0 ? position : currentIndex()) + 1, total)
    return { ...state, index: next, walks: (state.walks ?? 0) + 1 }
  }
  const currentIndex = () => wrap(Number.isFinite(state.index) ? state.index : 0, total)
  // The chain's own last pick answered, so the failure streak is over.
  if (typeof state.lastPick === 'string' && state.lastPick !== '' && previousAddress === state.lastPick) {
    state = { ...state, walks: 0 }
  }
  const walkLeft = () => (state.walks ?? 0) < Math.max(1, total - 1)

  // The chain's own last pick is dead unless it is the model that answered last.
  const lastPickDead = typeof state.lastPick === 'string' && state.lastPick !== ''
    && state.lastPick !== previousAddress
  // When pi does populate `request.failed` (its overflow-recovery retry) it is
  // authoritative: a context overflow must not move the chain at all.
  const dead = failedAddress !== undefined
    ? (isAdvanceable(request.failed?.message) ? failedAddress : undefined)
    : (lastPickDead && walkLeft() ? state.lastPick : undefined)

  if (request.reason === 'continuation' && previousAddress !== undefined) {
    const position = positionOf(previousAddress)
    if (position >= 0) return { index: position, state: { ...state, index: position, lastPick: previousAddress } }
  } else if (request.reason === 'retry' && dead !== undefined) {
    state = advanceFrom(dead)
  } else if (request.reason === 'user' && dead !== undefined) {
    // A failure pi will not retry (quota, region) still costs this turn; the
    // next one starts past the wall.
    state = { ...advanceFrom(dead), turn: 0 }
  } else if (request.reason === 'user' && chain.strategy === 'round-robin') {
    const cursor = Number.isFinite(state.cursor) ? state.cursor : 0
    const windowTurn = (Number.isFinite(state.windowTurn) ? state.windowTurn : 0) + 1
    const full = windowTurn >= chain.stickyLimit
    state = {
      ...state,
      index: wrap(cursor, total),
      windowTurn: full ? 0 : windowTurn,
      cursor: full ? cursor + 1 : cursor,
      turn: (Number.isFinite(state.turn) ? state.turn : 0) + 1,
    }
  } else if (request.reason === 'user') {
    state = { ...state, index: 0, turn: 0 }
  }

  const chosenAddress = address(members[currentIndex()])
  return { index: currentIndex(), state: { ...state, lastPick: chosenAddress } }
}

/** Wrap an index into the chain. */
function wrap(index, total) {
  return ((index % total) + total) % total
}

/** The last assistant answer that is not an error, as `provider/model`, if any. */
function lastAnswerIn(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.role !== 'assistant') continue
    if (message.stopReason === 'error' || message.stopReason === 'aborted') continue
    if (typeof message.provider !== 'string' || typeof message.model !== 'string') continue
    return `${message.provider}/${message.model}`
  }
  return undefined
}

/**
 * Whether a failure should send the next request to a different link.
 *
 * Context overflow is compaction's job, not the chain's — swapping models for it
 * would only lose the cache the compaction is about to rebuild. An abort is the
 * user's own decision. Everything else (quota, region, 5xx, transport) is what a
 * chain exists for.
 */
export function isAdvanceable(message) {
  if (!message || typeof message !== 'object') return false
  if (message.stopReason === 'aborted') return false
  const text = String(message.errorMessage ?? '')
  if (/context.{0,12}(length|window).{0,24}(exceed|overflow)|context.?length.?exceeded/i.test(text)) return false
  return true
}
