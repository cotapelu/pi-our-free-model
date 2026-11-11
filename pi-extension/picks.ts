/**
 * The recommended-projects page's live numbers.
 *
 * The page's copy is the client's — it is localized and it moves with the
 * product. What cannot be baked into either half is the number the whole page is
 * built to move: how many stars each recommended repository has, and when it
 * last changed. A count frozen at release time reads as abandoned the day after
 * it ships, so GitHub is asked directly, the last answer is kept on disk, and the
 * read fails open in both directions: an unreachable GitHub serves the last good
 * numbers (or none, on a first run) instead of an error, and a malformed answer
 * is dropped rather than half-applied.
 *
 * This rides the direct fetch, not the user's outlet: the outlet exists for the
 * model lanes, and a broken proxy must not take the recommendation page down with
 * it — the same reason the announcement feed bypasses it.
 *
 * Ported from dsh's `src/picks.js`.
 *
 * @module pi-extension/picks.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { restrictPermissions } from './gateway/store.js'

export interface PickRepo {
  readonly id: string
  readonly repo: string
}

/** The repositories the page advertises, in display order. */
export const PICK_REPOS: readonly PickRepo[] = Object.freeze([
  Object.freeze({ id: 'eac-desktop', repo: 'Ebony-Vinyl/EAC-Desktop' }),
  Object.freeze({ id: 'eac-pack', repo: 'Ebony-Vinyl/EAC-Pack' }),
  Object.freeze({ id: 'eac-design-world', repo: 'Ebony-Vinyl/EAC-design-world' }),
])

/**
 * Where the counts come from. The preview harness points this at a local stub so
 * a screenshot run never leaves the machine (same seam, same reason, as
 * `OFM_OPENCODE_BASE` in `catalog.ts`).
 */
export const PICKS_API_BASE = (process.env.OFM_PICKS_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '')

/** A good answer is reused for six hours; a failed one is retried in fifteen minutes. */
const FRESH_MS = 6 * 60 * 60_000
const RETRY_MS = 15 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
/**
 * How long a cold route may wait for the first answer before serving what it
 * has. The page must never hang on GitHub; it may, however, spend a moment
 * longer to arrive with real numbers instead of dashes.
 */
export const VIEW_WAIT_MS = 4_000

/**
 * `owner/name`, nothing else — it interpolates straight into a URL path.
 *
 * The owner segment must start with a letter or digit, which is GitHub's own
 * rule for a user or organisation name. A permissive character class would
 * accept `..`, and `PICKS_API_BASE/repos/../anything` normalises into a request
 * against a different path than the one written here.
 */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/
/** A path segment that is nothing but dots. */
const DOTS_ONLY = /^[.]+$/

export interface PickRow {
  id: string
  repo: string
  stars: number
  forks?: number
  pushedAt?: number
  stale: boolean
}

export interface PickSnapshot {
  fetchedAt: number
  ok: boolean
  repos: PickRow[]
}

/**
 * One star count.
 *
 * Only a number (or a digit string) counts. `Number()` coercion would accept
 * `true` as 1, `null` as 0 and `''` as 0 — each of which is a number the page
 * would then print as if GitHub had said it.
 */
function count(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return undefined
}

function stamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** One repo's row from the GitHub answer, or `undefined` when it is not one. */
function parseRepo(id: string, repo: string, payload: unknown): PickRow | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  const stars = count(body.stargazers_count)
  // Without a star count there is no row: the card's whole subject is that number.
  if (stars === undefined) return undefined
  const forks = count(body.forks_count)
  const pushedAt = stamp(body.pushed_at)
  return {
    id,
    repo,
    stars,
    ...forks === undefined ? {} : { forks },
    ...pushedAt === undefined ? {} : { pushedAt },
    stale: false,
  }
}

/** Coerce one stored row back, or `undefined` when it is not one. */
function parseStoredRow(raw: unknown): PickRow | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const stars = count(row.stars)
  if (stars === undefined || typeof row.repo !== 'string') return undefined
  const forks = count(row.forks)
  // The cache stores the epoch value `parseRepo` produced, not an ISO string.
  const pushedAt = typeof row.pushedAt === 'number' && Number.isFinite(row.pushedAt) && row.pushedAt > 0
    ? row.pushedAt
    : stamp(row.pushedAt)
  return {
    id: String(row.id ?? ''),
    repo: row.repo,
    stars,
    ...forks === undefined ? {} : { forks },
    ...pushedAt === undefined ? {} : { pushedAt },
    stale: row.stale === true,
  }
}

export interface PickStats {
  /** What a route calls: cached while fresh, refreshed behind it otherwise. */
  view(): Promise<PickSnapshot>
  /** Force a fetch; concurrent callers coalesce onto one round trip. */
  refresh(): Promise<PickSnapshot>
  /** The current answer, with no fetch and no wait. */
  snapshot(): PickSnapshot
}

export interface PickStatsDeps {
  repos?: readonly PickRepo[]
  fetchImpl?: typeof fetch
  /** Where the last good answer is kept. Empty means memory only. */
  cacheFile?: string
  now?: () => number
  log?: (message: string) => void
}

/**
 * The star counts behind the recommended-projects page.
 *
 * `view()` is what the route calls: it answers from cache while a copy is fresh,
 * refreshes in the background while a copy is merely stale, and gives a cold
 * start a bounded head start on its first fetch. `refresh()` forces the fetch
 * and coalesces concurrent callers onto one round trip per repo.
 */
export function createPickStats({
  repos = PICK_REPOS,
  fetchImpl = fetch,
  cacheFile = '',
  now = Date.now,
  log = () => {},
}: PickStatsDeps = {}): PickStats {
  // A repo whose name is not `owner/name` is dropped here rather than allowed to
  // reach a URL: it interpolates straight into a path.
  const wanted = repos.filter(row => {
    const name = String(row?.repo ?? '')
    if (!REPO_PATTERN.test(name)) return false
    // Neither segment may be all dots: `owner/..` passes the character class.
    return !name.split('/').some(segment => segment === '' || DOTS_ONLY.test(segment))
  })
  let state: { at: number; ok: boolean; repos: PickRow[] } = { at: 0, ok: false, repos: [] }
  let inflight: Promise<PickSnapshot> | null = null

  function readDisk(): void {
    if (cacheFile === '') return
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as any).repos)) return
      const at = Number((parsed as any).at)
      if (!Number.isFinite(at) || at <= 0) return
      const rows = (parsed as any).repos.map(parseStoredRow).filter((row: PickRow | undefined) => row !== undefined)
      // A cache written for a different roster must not mask the repos the page
      // asks about today, so it only counts when it covers exactly those rows.
      if (rows.length !== wanted.length || !wanted.every((row: PickRepo) => rows.some((cached: PickRow) => cached.id === row.id))) return
      state = { at, ok: rows.some((row: PickRow) => row.stale !== true), repos: rows as PickRow[] }
    } catch { /* an unreadable cache is the same as no cache */ }
  }

  function writeDisk(): void {
    if (cacheFile === '') return
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      const temp = `${cacheFile}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ at: state.at, repos: state.repos }), { mode: 0o600 })
      restrictPermissions(temp)
      fs.renameSync(temp, cacheFile)
    } catch (error: any) {
      log(`pick stats: could not keep the cache (${error?.message ?? error})`)
    }
  }

  async function fetchOne(row: PickRepo): Promise<PickRow> {
    const previous = state.repos.find(entry => entry.id === row.id)
    try {
      const response = await fetchImpl(`${PICKS_API_BASE}/repos/${row.repo}`, {
        redirect: 'error',
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'pi-our-free-model' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed = parseRepo(row.id, row.repo, await response.json())
      if (parsed === undefined) throw new Error('no star count in the answer')
      return parsed
    } catch (error: any) {
      log(`pick stats: ${row.repo} -> ${error?.message ?? error}`)
      // Keep this repo's last good numbers rather than blanking its card; the
      // `stale` flag is what the page tells the user instead of a silent lie.
      // A card with no numbers at all is still a card: `stars` is what the page
      // renders, so an unanswered repo carries the field it must print.
      return previous !== undefined
        ? { ...previous, stale: true }
        : { id: row.id, repo: row.repo, stars: 0, stale: true }
    }
  }

  const snapshot = (): PickSnapshot => ({ fetchedAt: state.at, ok: state.ok, repos: state.repos.map(row => ({ ...row })) })

  function refresh(): Promise<PickSnapshot> {
    if (inflight !== null) return inflight
    const request = Promise.all(wanted.map(row => fetchOne(row)))
      .then((rows: PickRow[]) => {
        state = { at: now(), ok: rows.some(row => row.stale !== true), repos: rows }
        writeDisk()
        return snapshot()
      })
      .catch((error: any) => {
        log(`pick stats: refresh failed (${error?.message ?? error})`)
        return snapshot()
      })
      .finally(() => { inflight = null })
    inflight = request
    return request
  }

  async function view(): Promise<PickSnapshot> {
    const age = now() - state.at
    if (state.at > 0 && age < (state.ok ? FRESH_MS : RETRY_MS)) return snapshot()
    const pending = refresh()
    if (state.at > 0) {
      // A stale copy keeps answering immediately while the fetch runs behind it.
      return snapshot()
    }
    // Cold start: nothing on disk and nothing in memory. Wait — bounded — for the
    // first answer so the page's first paint usually carries real numbers.
    await Promise.race([
      pending.then(() => undefined, () => undefined),
      new Promise(resolve => {
        const timer = setTimeout(resolve, VIEW_WAIT_MS)
        timer.unref?.()
      }),
    ])
    return snapshot()
  }

  readDisk()

  return { view, refresh, snapshot }
}
