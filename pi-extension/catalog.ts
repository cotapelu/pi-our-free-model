/**
 * Live catalogs for the two keyless lanes, plus the measured fallback both
 * degrade to. Model rows are transcribed into pi's `ProviderChatModelConfig`
 * shape. Two facts govern the numbers here, both ported from the dsh plugin's
 * own probes (src/catalog.js) and re-checked against the live upstream:
 *
 *   1. the listing's `limit` is a **floor** — the same upstream accepted ~1M-token
 *      prompts on `deepseek-v4.1-flash-free` and `glm-5.3-flash-free`, so the
 *      per-id table below wins over the listing wherever they disagree;
 *   2. the gateway **validates** `reasoning_effort` against the model's declared
 *      menu (an undeclared value answers 400), so a model that declares no menu
 *      gets no picker either — pi is never handed a value the wire would refuse.
 *
 * @module pi-extension/catalog.js
 */
import { gatewayHeaders, sessionFor } from './fingerprint.js'

export const OPENECODE_BASE = (process.env.OFM_OPENECODE_BASE ?? 'https://opencode.ai').replace(/\/+$/, '')
export const OPENECODE_LISTING = `${OPENECODE_BASE}/inference/v1/models`
/** The chat base the free lane's rows declare in their own `api` block. */
export const OPENECODE_CHAT_BASE = (process.env.OFM_OPENECODE_CHAT_BASE ?? 'https://opencode.ai/inference/openai/v1').replace(/\/+$/, '')

export const KILO_BASE = (process.env.OFM_KILO_BASE ?? 'https://api.kilo.ai/api/gateway').replace(/\/+$/, '')
export const KILO_LISTING = `${KILO_BASE}/models`

const LISTING_TIMEOUT_MS = 20000

/** pi's thinking levels, in the order pi clamps to. */
const PI_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Wire value of the off rung on the OpenCode lane: the gateway's own `none`. */
const OPENECODE_OFF = 'none'

/**
 * Per-id overrides for the free ids this lane serves today, where the listing
 * would mis-state the model. Capacities are the **served** ones (the listing
 * publishes a floor); `efforts` is the model's declared `reasoning_options`
 * menu, and only that menu is offered — the gateway validates the field.
 */
const FREE_ID_OVERRIDES = {
  'pulse-alpha-free': {
    vision: true, contextWindow: 1048576, maxOutput: 131072,
    efforts: ['low', 'high', 'max'],
  },
  'deepseek-v4.1-flash-free': {
    vision: true, contextWindow: 1048576, maxOutput: 384000,
    efforts: ['disabled', 'low', 'high', 'max'],
  },
  'glm-5.3-flash-free': {
    vision: true, contextWindow: 1048576, maxOutput: 131072,
    efforts: ['low', 'high', 'max'],
  },
  'nemotron-3.5-super-vl-free': {
    vision: true, contextWindow: 1048576, maxOutput: 131072,
    efforts: ['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  'space-bunny-free': {
    vision: true, contextWindow: 1048576, maxOutput: 524288,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  'longcat-2.5-preview-free': {
    vision: false, contextWindow: 1048576, maxOutput: 131072,
  },
  'big-pickle': {
    vision: true, contextWindow: 262144, maxOutput: 131072,
  },
}

/** Family-wide fallbacks, consulted when no per-id override exists. */
const FREE_CAPABILITIES = [
  { match: /^mimo.*v2\.6/, vision: true, contextWindow: 1048576, maxOutput: 131072 },
  { match: /^mimo.*v2\.5/, vision: true, contextWindow: 1048576, maxOutput: 131072 },
  { match: /^mimo/, vision: true, contextWindow: 262144, maxOutput: 131072 },
  { match: /^muse.?spark/, vision: true, contextWindow: 1048576, maxOutput: 131072 },
  { match: /^nemotron/, vision: false, contextWindow: 128000, maxOutput: 32768 },
  { match: /^ling/, vision: false, contextWindow: 128000, maxOutput: 32768 },
  { match: /^space.?bunny/, vision: true, contextWindow: 262144, maxOutput: 65536 },
  { match: /^union/, vision: false, contextWindow: 262144, maxOutput: 131072 },
  { match: /^deepseek/, vision: false, contextWindow: 128000, maxOutput: 64000 },
  { match: /^jev/, vision: false, contextWindow: 32768, maxOutput: 4096 },
]

/** Ids the free lane serves without a `-free` suffix in their id. */
const ALWAYS_FREE = new Set(['union-alpha', 'space-bunny-free', 'big-pickle'])

/** The Kilo families that answer HTTP 400 to an off request. */
const KILO_REASONING_MANDATORY = [/^stepfun\//, /^liquid\//, /^thinkingmachines\//]
/** The two auto-routers accept the parameter and think anyway. */
const KILO_NO_DISABLE_IDS = new Set(['kilo-auto/free', 'openrouter/free'])

/**
 * Map one declared effort menu onto pi's thinking levels.
 *
 * Every rung is a value the upstream actually declares; a level it does not
 * declare maps to `null` so pi refuses to send it (its clamp drops null levels
 * from the picker instead of emitting a 400). `xhigh` rides `max` when the model
 * declares `max` but not `xhigh`, and `max` falls back to `xhigh` the other way.
 */
export function effortMap(declared: string[]) {
  const set = new Set(declared ?? [])
  const map: Record<string, string | null> = {}
  for (const level of PI_LEVELS) {
    if (level === 'xhigh') map[level] = set.has('xhigh') ? 'xhigh' : set.has('max') ? 'max' : null
    else if (level === 'max') map[level] = set.has('max') ? 'max' : set.has('xhigh') ? 'xhigh' : null
    else map[level] = set.has(level) ? level : null
  }
  map.off = set.has('none') || set.has('disabled') ? OPENECODE_OFF : null
  return map
}

/**
 * Kilo's menu: the gateway speaks OpenRouter's `reasoning` object, where the off
 * rung is `{enabled:false}` rather than an absent field. The sentinel `'off'`
 * is what rides `reasoning_effort` on pi's wire, and `kilo.js` translates it —
 * pi itself needs a value, not an absence.
 */
export function kiloEffortMap(row: any) {
  const params = new Set(Array.isArray(row?.supported_parameters) ? row.supported_parameters : [])
  const id = String(row?.id ?? '')
  if (!params.has('reasoning')) return undefined
  const canDisable = !KILO_REASONING_MANDATORY.some((pattern) => pattern.test(id)) && !KILO_NO_DISABLE_IDS.has(id)
  return {
    off: canDisable ? 'off' : null,
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: null,
  }
}

/** `/` and `:` are pi's provider separator and nothing else; ids stay wire-safe. */
export function safeId(id: string) {
  return String(id).replace(/[:/]/g, '-')
}

async function getJson(url: string, { headers = {}, signal }: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(LISTING_TIMEOUT_MS),
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`listing was not JSON: ${text.slice(0, 200)}`)
  }
  if (!response.ok) throw new Error(`listing answered HTTP ${response.status}: ${text.slice(0, 200)}`)
  return payload
}

/** Fetch the OpenCode free lane's listing, wearing the client fingerprint. */
export function fetchOpencodeListing(signal?: AbortSignal) {
  return getJson(OPENECODE_LISTING, { headers: gatewayHeaders({ session: sessionFor('listing'), accept: 'application/json' }), signal })
}

/** Fetch Kilo's public listing. No credential at all: the free pool is anonymous. */
export function fetchKiloListing(signal?: AbortSignal) {
  return getJson(KILO_LISTING, { headers: { accept: 'application/json' }, signal })
}

/** Is this id on the keyless pool? The listing mixes paid and free ids. */
export function isOpencodeFreeId(id: string) {
  const base = String(id)
  return ALWAYS_FREE.has(base) || /(^|[-_])free($|[-_.])/.test(base)
}

/** The free-lane capabilities for one base id: per-id override, family, default. */
function freeCapabilitiesFor(base: string) {
  const override = (FREE_ID_OVERRIDES as any)[base]
  if (override !== undefined) return override
  for (const entry of FREE_CAPABILITIES) {
    if (entry.match.test(base)) {
      // A `-vl` segment is the vendor's own vision-language marker.
      if (entry.vision !== true && /(?:^|[-_])vl(?:$|[-_.])/i.test(base)) return { ...entry, vision: true }
      return entry
    }
  }
  return { vision: false, contextWindow: 131072, maxOutput: 32768 }
}

/**
 * One OpenCode listing row -> pi chat model config, `null` when the row is not
 * a servable chat model.
 *
 * Rows the lane serves on another wire (`muse-spark` on `/responses`,
 * `union-alpha` on `/messages`, or an Anthropic/Google `base_url`) are skipped:
 * this extension speaks one wire, and an id on the wrong one fails every turn.
 */
export function opencodeModel(row: any) {
  if (!row || typeof row.id !== 'string' || !isOpencodeFreeId(row.id)) return null
  const api = row.api ?? {}
  const chat = api['chat-completions']
  if (chat === undefined || chat === null) return null
  const caps = freeCapabilitiesFor(row.id)
  const declared = Array.isArray(caps.efforts) ? caps.efforts : row.capabilities?.reasoning?.effort
  const reasoning = Array.isArray(declared) && declared.length > 0
  const limit = row.limit ?? {}
  const vision = caps.vision === true
    || (row.modalities?.input ?? []).some((m: string) => String(m).startsWith('image/'))
  const model: any = {
    id: safeId(row.id),
    name: typeof row.name === 'string' && row.name ? row.name : row.id,
    reasoning,
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: caps.contextWindow ?? limit.context ?? 200000,
    maxTokens: caps.maxOutput ?? limit.output ?? 32000,
  }
  if (reasoning) model.thinkingLevelMap = effortMap(declared)
  if (typeof chat.base_url === 'string' && chat.base_url) model.baseUrl = chat.base_url
  return model
}

/** One Kilo listing row -> pi chat model config, `null` when the row is not free. */
export function kiloModel(row: any) {
  if (!row || row.isFree !== true || typeof row.id !== 'string' || row.id.trim() === '') return null
  const map = kiloEffortMap(row)
  const vision = (row.architecture?.input_modalities ?? []).includes('image')
  const model: any = {
    id: safeId(row.id),
    name: typeof row.name === 'string' && row.name ? row.name : row.id,
    reasoning: map !== undefined,
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: row.context_length ?? 200000,
    maxTokens: row.top_provider?.max_completion_tokens ?? 32000,
    // The gateway is OpenAI-shaped but rejects the fields a strict OpenAI
    // endpoint accepts: `store` is in no listing row's parameters, and most free
    // rows only take `max_tokens`.
    compat: { supportsStore: false, maxTokensField: 'max_tokens' },
  }
  if (map !== undefined) model.thinkingLevelMap = map
  return model
}

/** The offline fallback, so both lanes exist before the first listing answers. */
export const STATIC_OPENECODE_MODELS = [
  // The lane's own long-standing anonymous id: no `-free` suffix, no declared
  // thinking menu, and it is on the live listing today — the snapshot has to
  // carry it or a machine with no route upstream loses a model the lane serves.
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 262144, maxOutput: 131072, vision: true },
  { id: 'beam-free', name: 'Beam Free', contextWindow: 1048576, maxOutput: 131072, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'flint-40b-free', name: 'Flint 40B Free', contextWindow: 262144, maxOutput: 65536, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free', contextWindow: 1048576, maxOutput: 131072, vision: true },
  { id: 'nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL Free', contextWindow: 1048576, maxOutput: 131072, vision: true, efforts: ['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', contextWindow: 128000, maxOutput: 32768 },
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', contextWindow: 1048576, maxOutput: 384000, vision: true, efforts: ['disabled', 'low', 'high', 'max'] },
  { id: 'glm-5.3-flash-free', name: 'GLM-5.3-Flash Free', contextWindow: 1048576, maxOutput: 131072, vision: true, efforts: ['low', 'high', 'max'] },
  { id: 'pulse-alpha-free', name: 'Pulse Alpha Free', contextWindow: 1048576, maxOutput: 131072, vision: true, efforts: ['low', 'high', 'max'] },
]

export const STATIC_KILO_MODELS = [
  // `wire` is the upstream's own `vendor/name:free` spelling. The registered id
  // is its safe form, and a turn must carry the wire one — so the fallback path
  // (a listing that fails while chat still works) can rebuild the same map the
  // live listing builds, instead of sending an id Kilo will not route.
  { id: 'kilo-auto-free', wire: 'kilo-auto/free', name: 'Kilo Auto Free (router)', contextWindow: 256000, maxTokens: 32768, canDisable: false },
  { id: 'nvidia-nemotron-3.5-super-vl-free', wire: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL', contextWindow: 1000000, maxTokens: 131072, vision: true },
  { id: 'reflection-beam-free', wire: 'reflection/beam-free', name: 'Beam Free', contextWindow: 1048576, maxTokens: 131072 },
  { id: 'stealth-glyph-cluster', wire: 'stealth/glyph-cluster', name: 'Glyph Cluster', contextWindow: 256000, maxTokens: 256000 },
  { id: 'recursive-flint-v1.0-free', wire: 'recursive/flint-v1.0:free', name: 'Flint v1.0', contextWindow: 262144, maxTokens: 235929 },
  { id: 'xingchen-agi-xing4.0-29b-a4b-free', wire: 'xingchen-agi/xing4.0-29b-a4b:free', name: 'Xing 4.0 29B A4B', contextWindow: 262144, maxTokens: 235929 },
  { id: 'dots-studio-dots-3-note-preview-free', wire: 'dots-studio/dots-3-note-preview:free', name: 'Dots 3 Note Preview', contextWindow: 512000, maxTokens: 460800, vision: true },
  { id: 'liquid-lfm-2.5-2.6b-free', wire: 'liquid/lfm-2.5-2.6b:free', name: 'LFM 2.5 2.6B', contextWindow: 65536, maxTokens: 8192, canDisable: false },
  { id: 'nvidia-nemotron-3.5-lightning-free', wire: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning', contextWindow: 1000000, maxTokens: 65536 },
  { id: 'cohere-north-mini-code-free', wire: 'cohere/north-mini-code:free', name: 'North Mini Code', contextWindow: 256000, maxTokens: 64000 },
  { id: 'nvidia-nemotron-3.5-content-safety-free', wire: 'nvidia/nemotron-3.5-content-safety:free', name: 'Nemotron 3.5 Content Safety', contextWindow: 128000, maxTokens: 8192, vision: true },
  { id: 'nvidia-nemotron-3-ultra-550b-a55b-free', wire: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B', contextWindow: 1000000, maxTokens: 65536 },
  { id: 'nvidia-nemotron-3-nano-omni-30b-a3b-reasoning-free', wire: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron 3 Nano Omni', contextWindow: 256000, maxTokens: 65536, vision: true },
  { id: 'openrouter-free', wire: 'openrouter/free', name: 'OpenRouter Free (router)', contextWindow: 200000, maxTokens: 32000, vision: true, canDisable: false },
  { id: 'inclusionai-ling-3.1-flash-1019-free', wire: 'inclusionai/ling-3.1-flash-1019-free', name: 'Ling 3.1 Flash 1019', contextWindow: 1000000, maxTokens: 262144 },
  // 2026-11-02 drift: three ids the free pool started serving. The two
  // `thinkingmachines/` are a mandatory-thinking family (see
  // KILO_REASONING_MANDATORY), so the snapshot marks them canDisable:false and
  // the live path assigns them no off rung either.
  { id: 'thinkingmachines-inkling-free', wire: 'thinkingmachines/inkling:free', name: 'Inkling', contextWindow: 1048576, maxTokens: 262144, vision: true, canDisable: false },
  { id: 'thinkingmachines-inkling-small-free', wire: 'thinkingmachines/inkling-small:free', name: 'Inkling Small', contextWindow: 1048576, maxTokens: 262144, vision: true, canDisable: false },
  { id: 'google-gemma-4-31b-it-free', wire: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B IT', contextWindow: 262144, maxTokens: 32768, vision: true },
]

/**
 * `safeId -> wire id` for the offline snapshot, so a turn routed to a snapshot
 * model still carries the upstream's own spelling on the wire. The live listing
 * path builds the same map from `upstreamIdMap`.
 */
export function staticUpstreamIds() {
  const map = new Map()
  for (const row of STATIC_KILO_MODELS) map.set(row.id, row.wire)
  return map
}

function baseCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Offline model configs, in the same shape the live mapping emits. */
export function staticOpencodeModels() {
  return STATIC_OPENECODE_MODELS.map((row) => {
    const model: any = {
      id: row.id,
      name: row.name,
      reasoning: Array.isArray(row.efforts) && row.efforts.length > 0,
      input: row.vision ? ['text', 'image'] : ['text'],
      cost: baseCost(),
      contextWindow: row.contextWindow,
      maxTokens: row.maxOutput,
    }
    if (Array.isArray(row.efforts) && row.efforts.length > 0) model.thinkingLevelMap = effortMap(row.efforts)
    return model
  })
}

/** Kilo's menu with the off rung the auto-routers and mandatory-thinking families lack. */
const KILO_DEFAULT_MAP = { off: 'off', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }

export function staticKiloModels() {
  return STATIC_KILO_MODELS.map((row) => {
    const model: any = {
      id: row.id,
      name: row.name,
      reasoning: true,
      input: row.vision ? ['text', 'image'] : ['text'],
      cost: baseCost(),
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      compat: { supportsStore: false, maxTokensField: 'max_tokens' },
    }
    if (row.canDisable !== false) model.thinkingLevelMap = { ...KILO_DEFAULT_MAP }
    else model.thinkingLevelMap = { ...KILO_DEFAULT_MAP, off: null }
    return model
  })
}

/** `safeId -> wire id`, for the lanes whose upstream ids carry `/` and `:`. */
export function upstreamIdMap(rows: any[], mapper: (row: any) => any) {
  const map = new Map()
  for (const row of rows) {
    const model = mapper(row)
    if (model) map.set(model.id, row.id)
  }
  return map
}

/**
 * The Kilo roster and its wire-id map, as one piece of state a refresh may
 * replace but must never *unlearn*.
 *
 * pi refreshes a provider behind a generation-scoped AbortController and aborts
 * the previous refresh when a new one begins; measured on ordinary runs, that
 * abort can land *after* a successful fetch. A refresh that delivers no roster
 * is therefore routine, not a failure — and treating it as one is how a turn
 * ends up carrying pi's safe id (`reflection-beam-free`) where the gateway
 * routes `reflection/beam-free`, so a lane that is up answers
 * "model not found".
 *
 * So: the map is seeded from the offline snapshot and only ever grows, every id
 * the extension can dispatch has an upstream spelling even before the first
 * listing answers, and a refresh that learned nothing keeps both the last live
 * roster and everything already learned.
 */
export function createKiloRoster() {
  /** The last roster a live listing actually served, if it ever did. */
  let live: any = null
  /** `safeId -> wire id`; the snapshot seeds it, a live listing tops it up. */
  const wireIds = new Map(staticUpstreamIds())
  return {
    /** The models to register: the last live roster, else the snapshot. */
    models: () => live ?? staticKiloModels(),
    /** The upstream spelling for a registered id, safe on every path. */
    wireId: (id: string) => wireIds.get(id) ?? id,
    /**
     * A listing answered. An empty free slice is authoritative — the gateway
     * saying it serves nothing free right now — so it degrades like a failure
     * instead of resurrecting a roster the upstream just withdrew.
     */
    accept: (rows: any[]) => {
      const models = rows.map(kiloModel).filter(Boolean)
      if (models.length === 0) {
        live = null
        return staticKiloModels()
      }
      live = models
      for (const [id, wire] of upstreamIdMap(rows, kiloModel)) wireIds.set(id, wire)
      return models
    },
    /**
     * The refresh delivered no roster: aborted, timed out, or refused. Keep the
     * last live roster and every wire id already learned.
     */
    degrade: () => live ?? staticKiloModels(),
  }
}
