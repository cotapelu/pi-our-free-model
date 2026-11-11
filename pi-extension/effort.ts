/**
 * Reasoning-effort policy.
 *
 * A live probe of the DSH lane (2026-09-24) settled the design: the gateway
 * accepts `reasoning_effort`, `thinking.budget_tokens`, `enable_thinking` and
 * `thinking_budget` and then ignores all of them — three samples per spelling
 * showed `low` producing *more* reasoning tokens than `xhigh`, and the unknown
 * fields occasionally surfaced as an upstream 503. The single control the pooled
 * account actually enforces is `max_tokens`, and reasoning volume tracks it
 * directly (a 64-token ceiling pulled reasoning from ~397 tokens down to ~63).
 *
 * So an effort level here is a real, enforced generation budget rather than a
 * hint. Every declared level therefore changes measured behaviour; a level that
 * could not be enforced would not be declared, because an effort menu that does
 * nothing is worse to a user than no effort menu at all.
 *
 * Because the ceiling is shared by thinking and the visible answer, a lower
 * level shortens both — that is the only modulation this lane offers, and it is
 * why the levels are stated as token budgets rather than as vague adjectives.
 *
 * A model whose thinking cannot be switched off pays for it out of the same
 * ceiling before the answer starts, so every rung of its ladder is doubled.
 *
 * Two producers, two shapes: the free lane declares a token ladder (this
 * module), while a model that carries an `efforts` menu offers its own levels,
 * which the gateway honours as an effort field (`effortPatchFor`). Both
 * absorbed channels and the free lane's own ids declare menus today.
 *
 * Ported from dsh's `src/effort.js`.
 *
 * @module pi-extension/effort.js
 */

/** Ordered for display: the array order is the picker's order. */
export const LEVELS = [
  { id: 'light', name: 'Light', zh: '精简', ceiling: 2048, hint: 'terse deliberation, the fastest answer here.' },
  { id: 'balanced', name: 'Balanced', zh: '均衡', ceiling: 8192, hint: 'enough to reason through a normal turn.' },
  { id: 'deep', name: 'Deep', zh: '深思', ceiling: undefined, hint: 'the model\'s full output capacity, extended deliberation.' },
] as const

export const DEFAULT_LEVEL = 'balanced'

/** Rungs of a model that must think are widened by this factor; see the module note. */
export const ALWAYS_THINKING_FACTOR = 2

/** Below this the answer itself cannot land, so no level is allowed to go. */
export const MIN_BUDGET = 512

/** Does this model expose an effort menu at all? */
export function supportsEffort(model: any): boolean {
  return model?.reasoning === true
}

const LEVEL_ALIASES = new Map<string, string>(Object.entries({
  light: 'light', minimal: 'light', low: 'light', none: 'light', off: 'light', disabled: 'light',
  balanced: 'balanced', medium: 'balanced',
  deep: 'deep', high: 'deep', xhigh: 'deep', max: 'deep',
}))

/** Aliases for the legacy budget ladder, never for a model's declared menu. */
export function normalizeLevel(level: string | undefined): string | undefined {
  return typeof level === 'string' ? LEVEL_ALIASES.get(level.trim().toLowerCase()) : undefined
}

/**
 * The rung in force for one call, resolved the same way for the budget sent
 * upstream and the effort recorded against it.
 *
 * A model with a declared thinking menu records the level the wire actually
 * carries; a model with no effort menu has no rung at all, and a menu model
 * the caller did not answer with a level gets the menu's default.
 */
export function resolveLevel(level: string | undefined, model: any): { id: string } | undefined {
  if (hasDeclaredEffortMenu(model)) {
    const chosen = (model.efforts as string[]).includes(level!) ? level : eacDefaultLevel(model)
    return { id: chosen! }
  }
  if (!supportsEffort(model)) return undefined
  const wanted = normalizeLevel(level)
  return LEVELS.find(candidate => candidate.id === wanted) as { id: string } | undefined
    ?? LEVELS.find(candidate => candidate.id === DEFAULT_LEVEL) as { id: string }
}

/** The ceiling one rung carries on one model, before capacity is applied. */
function ceilingOf(entry: { ceiling?: number } | undefined, model: any): number | undefined {
  if (entry === undefined || entry.ceiling === undefined) return undefined
  return model?.canDisableThinking === false ? entry.ceiling * ALWAYS_THINKING_FACTOR : entry.ceiling
}

/** A caller-supplied token ceiling, or "none" when it is not a positive number. */
function usableTokens(value: any): number {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

/**
 * Resolve the generation ceiling for one level against one model.
 *
 * The level ceiling is the controlling term; the model's own capacity and the
 * session's request can only lower it further, never raise it.
 *
 * A ceiling that is not a positive number is *no* ceiling: the settings page's
 * own cleared input must not reach the wire as a zero.
 */
export function budgetFor(level: string | undefined, model: any, requested: number | undefined, fallback: number | undefined): number {
  const capacity = Math.min(
    model?.maxOutput ?? 32768,
    usableTokens(requested),
    usableTokens(fallback),
  )
  // A model with a declared thinking menu has its level as the real control
  // on the wire, so its ceiling is the model capacity regardless of level.
  if (hasDeclaredEffortMenu(model)) return Math.max(MIN_BUDGET, Math.trunc(capacity))
  const ceiling = ceilingOf(resolveLevel(level, model) as any, model)
  if (ceiling === undefined) return Math.max(MIN_BUDGET, Math.trunc(capacity))
  return Math.max(MIN_BUDGET, Math.trunc(Math.min(ceiling, capacity)))
}

/**
 * The whole ladder as it applies to one model right now, for anything that has
 * to show the user the number that will actually go out on the wire.
 */
export function budgetLadder(model: any, requested: number | undefined, fallback: number | undefined) {
  return LEVELS.map(entry => ({
    id: entry.id,
    name: entry.name,
    tokens: budgetFor(entry.id, model, requested, fallback),
    isDefault: entry.id === DEFAULT_LEVEL,
  }))
}

/** 16384 -> `16 K`, the spelling the settings page and the README both use. */
function kilos(tokens: number): string {
  return `${Math.round(tokens / 1024)} K`
}

/**
 * Deep-clone a declared patch and substitute the selected level for `$effort`.
 */
function instantiatePatch(patch: any, effort: string): any {
  const walk = (value: any): any => {
    if (typeof value === 'string') return value === '$effort' ? effort : value
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, any> = {}
      for (const [key, inner] of Object.entries(value)) out[key] = walk(inner)
      return out
    }
    return value
  }
  return walk(patch)
}

/**
 * The thinking menu a model declares: the model's own level list.
 */
function declaredEffortsFor(model: any) {
  const levels = Array.isArray(model?.efforts) ? model.efforts : undefined
  if (levels === undefined || levels.length === 0) return undefined
  const names: Record<string, string> = { disabled: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max', minimal: 'Minimal', xhigh: 'XHigh' }
  return levels.map((id: string) => ({
    id,
    name: names[id] ?? id,
    description: id === 'disabled'
      ? 'thinking switched off for this turn; the answer alone'
      : `thinking level "${id}", sent to the gateway as this model's own effort field`,
  }))
}

/** The declared default level id for a menu model, or its first level. */
export function eacDefaultLevel(model: any): string | undefined {
  const levels = Array.isArray(model?.efforts) ? model.efforts : []
  if (levels.length === 0) return undefined
  return levels.includes(model.effortDefault) ? model.effortDefault : levels[0]
}

/**
 * The request-body patch a level turns into, or null when the model declares
 * no thinking menu at all.
 */
export function effortPatchFor(level: string | undefined, model: any): any {
  if (!Array.isArray(model?.efforts) || model.efforts.length === 0) return null
  const chosen = typeof level === 'string' && (model.efforts as string[]).includes(level) ? level : eacDefaultLevel(model)
  if (chosen === 'disabled' && model.effortOffPatch !== undefined) {
    return instantiatePatch(model.effortOffPatch, chosen!)
  }
  if (model.effortPatch === undefined) return null
  return instantiatePatch(model.effortPatch, chosen!)
}

/** Does this entry carry a declared thinking menu (its own effort field is
 *  the control on the wire)? Absorbed channels' entries and the free lane's
 *  menu ids do; a plain free-lane id never does. */
export function hasDeclaredEffortMenu(model: any): boolean {
  return Array.isArray(model?.efforts) && model.efforts.length > 0
}

/**
 * The effort id the harness should treat as this model's default.
 */
export function defaultEffortFor(model: any): string {
  if (hasDeclaredEffortMenu(model)) return eacDefaultLevel(model) ?? DEFAULT_LEVEL
  return DEFAULT_LEVEL
}

/**
 * The declared effort list for one model, in picker order.
 */
export function effortsFor(model: any, requested: number | undefined, fallback: number | undefined) {
  if (hasDeclaredEffortMenu(model)) return declaredEffortsFor(model)
  if (!supportsEffort(model)) return undefined
  return budgetLadder(model, requested, fallback).map(row => ({
    id: row.id,
    name: row.name,
    description: `${kilos(row.tokens)} output ceiling, shared by thinking and the answer`
      + (model.canDisableThinking === false ? ' (thinking cannot be switched off on this model)' : '')
      + `: ${LEVELS.find(level => level.id === row.id)?.hint ?? ''}`,
  }))
}
