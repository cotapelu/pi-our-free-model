/**
 * Combos: one model name that is really an ordered chain.
 *
 * A combo turns a quota wall, a region refusal, an expired credential or a 5xx
 * from one upstream into a retry the user never sees: the chain is walked in
 * order, and the first candidate that produces output wins.
 *
 * Two strategies:
 * - `fallback` — always start at the head of the list.
 * - `round-robin` — start at the next candidate each turn (sticky for
 *   `stickyLimit` consecutive turns).
 *
 * Capacities are the *intersection*, not the union.
 *
 * Ported from dsh's `src/combos.js`.
 *
 * @module pi-extension/combos.js
 */

import crypto from 'node:crypto'

export const COMBO_CHANNEL = 'combo'
export const COMBO_PREFIX = 'combo:'
export const COMBO_STRATEGIES = ['fallback', 'round-robin', 'smart', 'usage', 'pace']

/** Rotation cursors, keyed by combo id. In-memory on purpose. */
const rotation = new Map<string, { index: number; used: number }>()

export function isComboEntry(entry: any): boolean {
  return entry?.channel === COMBO_CHANNEL && Array.isArray(entry.combo)
}

/** `My Fast Chain` -> `combo:my-fast-chain`. */
export function comboId(name: string | undefined): string {
  const normalized = String(name ?? '').trim().toLowerCase()
  if (normalized === '') return ''
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const identity = slug && !/[^\x20-\x7e]/.test(normalized) ? slug
    : `${slug || 'u'}-${createHash(normalized).slice(0, 16)}`
  return `${COMBO_PREFIX}${identity}`
}

function createHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/**
 * Coerce the stored settings value into a list of well-formed combos.
 */
export function normalizeCombos(raw: any): any[] {
  const rows = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const out: any[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' && row.id.startsWith(COMBO_PREFIX) ? row.id : comboId(row.name ?? row.id)
    if (id === '' || seen.has(id)) continue
    const models = [...new Set((Array.isArray(row.models) ? row.models : [])
      .map((value: any) => String(value ?? '').trim())
      .filter((value: string) => value !== '' && value !== id))]
    if (models.length === 0) continue
    seen.add(id)
    out.push({
      id,
      name: String(row.name ?? '').trim() || id.slice(COMBO_PREFIX.length),
      models,
      strategy: COMBO_STRATEGIES.includes(row.strategy) ? row.strategy : 'fallback',
      stickyLimit: Number.isFinite(Number(row.stickyLimit)) && Number(row.stickyLimit) > 0 ? Math.trunc(Number(row.stickyLimit)) : 1,
      enabled: row.enabled !== false,
    })
  }
  return out
}

function n(value: any): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * Build the virtual catalog rows for every enabled combo.
 */
export function buildComboCatalog(combos: any[], catalog: any[]): any[] {
  const byId = new Map<string, any>()
  for (const entry of catalog) if (!isComboEntry(entry)) byId.set(entry.id, entry)
  const definitions = new Map(combos.map((combo: any) => [combo.id, combo]))
  const visits = new Map<string, number>()
  const invalid = new Set<string>()
  const cycle = (id: string): boolean => {
    if (visits.get(id) === 1) return true
    if (visits.get(id) === 2) return invalid.has(id)
    const row = definitions.get(id)
    if (!row || row.enabled === false) return false
    visits.set(id, 1)
    const bad = row.models.filter((model: string) => definitions.has(model)).some((model: string) => cycle(model))
    visits.set(id, 2)
    if (bad) invalid.add(id)
    return bad
  }
  for (const combo of combos) cycle(combo.id)
  const built = new Map<string, any>()
  const resolve = (combo: any, path: Set<string> = new Set()): any => {
    if (built.has(combo.id)) return built.get(combo.id)
    if (combo.enabled === false || invalid.has(combo.id) || path.has(combo.id)) return null
    const branch = new Set([...path, combo.id])
    let cycleFound = false
    const members = combo.models.map((id: string) => {
      if (byId.has(id)) return byId.get(id)
      const nested = definitions.get(id)
      if (!nested) return null
      if (branch.has(id)) { cycleFound = true; return null }
      const child = resolve(nested, branch)
      if (child === null && nested.enabled !== false && nested.models.some((model: string) => branch.has(model))) cycleFound = true
      return child
    }).filter(Boolean)
    if (cycleFound || members.length === 0) return null
    const entry = {
      id: combo.id, name: combo.name, channel: COMBO_CHANNEL,
      combo: members.map((member: any) => member.id), strategy: combo.strategy, stickyLimit: combo.stickyLimit,
      vision: members.every((member: any) => member.vision === true),
      reasoning: members.some((member: any) => member.reasoning === true),
      contextWindow: Math.min(...members.map((member: any) => n(member.contextWindow) ?? 131072)),
      maxOutput: Math.min(...members.map((member: any) => n(member.maxOutput) ?? 32768)),
      canDisableThinking: members.every((member: any) => member.canDisableThinking !== false),
      regionSensitive: false, wire: 'chat',
      lanes: [...new Set(members.flatMap((member: any) => member.lanes ?? [member.channel ?? 'free']))],
    }
    built.set(combo.id, entry)
    return entry
  }
  const out: any[] = []
  for (const combo of combos) {
    const entry = resolve(combo)
    if (entry) out.push(entry)
  }
  return out
}

/**
 * Resolve a combo row into the ordered candidate entries for one turn.
 */
export function comboChain(entry: any, catalog: any[], options: { path?: Set<string>; now?: number; quota?: Map<string, any>; usage?: Map<string, number>; peek?: boolean } = {}): any[] {
  const ids = Array.isArray(entry?.combo) ? entry.combo : []
  const byId = new Map<string, any>()
  for (const row of catalog) byId.set(row.id, row)
  const path = new Set(options.path ?? [])
  if (path.has(entry?.id)) return []
  path.add(entry?.id)
  const dedup = new Set<string>()
  const members = ids.flatMap((id: string) => {
    const row = byId.get(id)
    return row ? isComboEntry(row) ? comboChain(row, catalog, { ...options, path }) : [row] : []
  }).filter((row: any) => { if (dedup.has(row.id)) return false; dedup.add(row.id); return true })
  if (members.length <= 1) return members
  if (['smart', 'usage', 'pace'].includes(entry.strategy)) {
    const nowVal = typeof options.now === 'number' ? options.now : Date.now()
    const readings = (row: any) => {
      const quota = options.quota?.get(row.id)
      const checked = Date.parse(quota?.checkedAt ?? '')
      if (!quota || !['ok', 'available'].includes(quota.status) || !Number.isFinite(checked) || nowVal - checked > 15 * 60_000 || checked > nowVal + 60_000) return []
      return (quota.windows ?? []).filter((window: any) => {
        const reset = Date.parse(window.resetsAt ?? '')
        return typeof window.remainingPercent === 'number' && window.remainingPercent >= 0 && window.remainingPercent <= 100
          && (!Number.isFinite(reset) || reset > nowVal)
      })
    }
    const score = (row: any, index: number) => {
      const windows = readings(row)
      const exhausted = windows.some((window: any) => window.remainingPercent <= 0)
      const reset = Math.min(...windows.filter((window: any) => window.remainingPercent > 0)
        .map((window: any) => Date.parse(window.resetsAt ?? '')).filter(Number.isFinite))
      const weekly = windows.find((window: any) => window.kind === 'weekly' || window.windowSeconds === 604800)
      const hours = weekly ? (Date.parse(weekly.resetsAt ?? '') - nowVal) / 3600000 : NaN
      const pace = weekly && Number.isFinite(hours) && hours > 0 ? weekly.remainingPercent / Math.max(hours, 1 / 60) : null
      const use = options.usage?.get(row.id)
      const usage = typeof use === 'number' && Number.isFinite(use) && use >= 0 ? use : null
      return { row, index, exhausted, known: windows.length > 0, reset, pace, usage }
    }
    return members.map(score).sort((left: any, right: any) => {
      if (left.exhausted !== right.exhausted) return left.exhausted ? 1 : -1
      if (entry.strategy === 'usage') {
        if ((left.usage !== null) !== (right.usage !== null)) return left.usage !== null ? -1 : 1
        if (left.usage !== null && right.usage !== null && left.usage !== right.usage) return left.usage - right.usage
      } else if (entry.strategy === 'pace') {
        if ((left.pace !== null) !== (right.pace !== null)) return left.pace !== null ? -1 : 1
        if (left.pace !== null && right.pace !== null && left.pace !== right.pace) return right.pace - left.pace
      } else {
        if (left.known !== right.known) return left.known ? -1 : 1
        if (left.reset !== right.reset) return left.reset - right.reset
      }
      return left.index - right.index
    }).filter((value: any) => !value.exhausted).map((value: any) => value.row)
  }
  if (entry.strategy !== 'round-robin') return members
  const limit = Number.isFinite(Number(entry.stickyLimit)) && Number(entry.stickyLimit) > 0 ? Math.trunc(Number(entry.stickyLimit)) : 1
  const cursor = rotation.get(entry.id) ?? { index: 0, used: 0 }
  const index = Math.min(Math.max(cursor.index, 0), members.length - 1)
  const ordered = [...members.slice(index), ...members.slice(0, index)]
  if (options.peek !== true) {
    const used = cursor.used + 1
    rotation.set(entry.id, used >= limit ? { index: (index + 1) % members.length, used: 0 } : { index, used })
  }
  return ordered
}

/** Drop rotation cursors for combos that no longer exist. */
export function pruneRotation(combos: any[]): void {
  const live = new Set(combos.map((combo: any) => combo.id))
  for (const key of rotation.keys()) if (!live.has(key)) rotation.delete(key)
}

/** Test seam: the rotation map is process state. */
export function resetRotation(): void {
  rotation.clear()
}
