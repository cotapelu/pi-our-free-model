/**
 * The remote announcement feed.
 *
 * Announcements are published by editing one JSON document in the project's own
 * GitHub repository — no server, no deploy step. Every running installation
 * re-reads it on boot, on a fixed poll, and on demand, so a push to `main` is
 * the whole act of publishing.
 *
 * Sources are tried in order and the fetch is fail-open in both directions: a
 * network failure keeps serving the last cached copy, and a malformed feed is
 * rejected as a whole rather than half-applied (an announcement that renders
 * wrong is worse than one that arrives late).
 *
 * This module is transport and validation only. What a user has acknowledged is
 * state the caller owns, so that a feed refresh never rewrites acknowledgement
 * history — `view()` takes the ack set in from outside rather than storing it
 * here.
 *
 * Ported from dsh's `src/feed.js`.
 *
 * @module pi-extension/feed.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { restrictPermissions } from './gateway/store.js'
import { sanitizeAnnouncementHtml } from './client/sanitizer.js'

export const REPO = 'Ebony-Vinyl/dsh-our-free-model'

/**
 * Feed locations, in preference order.
 *
 * `raw.githubusercontent.com` is first because it is the repository's own bytes,
 * with no third-party cache in front of it. jsDelivr is the fallback for the
 * networks where raw is TLS-interfered and the edge serves the same content
 * there. The repository's default branch is `main`; there is no `master`
 * fallback because GitHub answers that ref with HTTP 422. A minute-resolution
 * cache-buster is appended to jsDelivr URLs at fetch time so a push is never
 * served stale from the CDN (its default cache holds up to 12 hours).
 */
export const DEFAULT_FEED_SOURCES: readonly string[] = [
  `https://raw.githubusercontent.com/${REPO}/main/feed/announcements.json`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/feed/announcements.json`,
  // A raw.githubusercontent.com proxy, for networks where both origins above
  // are slow or intermittently unreachable. The feed is a plain read with no
  // signature of its own — every item is sanitized before it is rendered — so
  // this leg only has to return the same bytes; the cache-buster below keeps a
  // proxy's edge from serving a stale copy.
  `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO}/main/feed/announcements.json`,
]

/** jsDelivr's edge caches per full URL; a minute-stamp keeps every poll fresh. */
export function bustCdnCache(url: string, now = Date.now()): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.endsWith('.jsdelivr.net')) {
      parsed.searchParams.set('ofm', Math.floor(now / 60_000).toString())
      return parsed.href
    }
  } catch {
    // leave malformed URLs untouched; fetch will report them
  }
  return url
}

export const LEVELS = new Set(['info', 'update', 'warn', 'urgent'])
/** The transport caps. Exported so a caller (and the test suite) can pin them;
 * they are a compatibility surface, not a knob. */
export const MAX_FEED_BYTES = 512 * 1024
export const MAX_HTML_BYTES = 96 * 1024
export const MAX_ITEMS = 100

export interface Announcement {
  id: string
  title: string
  level: 'info' | 'update' | 'warn' | 'urgent'
  html: string
  createdAt: number
  expiresAt?: number
  pinned?: boolean
  link?: { url: string; label: string }
  /** Annotated by `view()`, from the caller's own ack set. */
  acked?: boolean
}

export interface Feed {
  announcements: Announcement[]
}

/**
 * Validate one raw feed document into the shape the rest of the plugin consumes.
 * Throws when the document is not a feed at all.
 */
export function parseFeed(payload: unknown, now = Date.now()): Feed {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('feed document must be a JSON object')
  }
  const rows = (payload as any).announcements
  if (!Array.isArray(rows)) throw new Error('feed document must carry an announcements array')
  const seen = new Set<string>()
  const announcements: Announcement[] = []
  for (const row of rows.slice(0, MAX_ITEMS)) {
    const item = parseItem(row, now)
    if (item === undefined) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    announcements.push(item)
  }
  return { announcements: sortItems(announcements) }
}

/** Validated, normalised single announcement; `undefined` for rows that fail. */
function parseItem(row: any, now: number): Announcement | undefined {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id === '' || id.length > 128) return undefined
  const title = typeof row.title === 'string' ? row.title.trim().slice(0, 200) : ''
  if (title === '') return undefined
  const html = typeof row.html === 'string' ? row.html : ''
  if (html.length > MAX_HTML_BYTES) return undefined
  const createdAt = timestamp(row.createdAt) ?? 0
  const expiresAt = timestamp(row.expiresAt)
  // An already-lapsed announcement never enters the cache at all, so a
  // re-introduced expired row cannot be resurrected by a later poll.
  if (expiresAt !== undefined && expiresAt <= now) return undefined
  const level = LEVELS.has(row.level) ? row.level : 'info'
  let link: Announcement['link'] | undefined
  if (row.link !== null && typeof row.link === 'object' && typeof row.link.url === 'string'
    && /^https?:\/\//i.test(row.link.url)) {
    link = { url: row.link.url, label: typeof row.link.label === 'string' ? row.link.label.slice(0, 100) : '' }
  }
  return {
    id,
    title,
    level,
    html,
    createdAt,
    ...expiresAt === undefined ? {} : { expiresAt },
    ...row.pinned === true ? { pinned: true } : {},
    ...link === undefined ? {} : { link },
  }
}

/**
 * One timestamp, either way it arrives.
 *
 * The published document carries ISO strings; the on-disk cache this module
 * writes carries epoch milliseconds, because that is what `parseItem` produces.
 * Accepting only one of the two silently dropped every `expiresAt` on reload —
 * which is precisely the case the `view()` live filter exists for, so the cache
 * and the publisher's document have to agree on a value that survives both.
 */
function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Pinned first, then newest first; a stable order keeps the UI calm between polls. */
export function sortItems(items: Announcement[]): Announcement[] {
  const stamp = (item: Announcement) => typeof item.createdAt === 'number' ? item.createdAt : 0
  return [...items].sort((a, b) => {
    if ((b.pinned === true ? 1 : 0) !== (a.pinned === true ? 1 : 0)) {
      return (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0)
    }
    return stamp(b) - stamp(a)
  })
}

export interface FetchFeedOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Fetch the feed, trying each source in turn. Each source is fetched with
 * `redirect: 'error'`, so a redirect cannot move a feed read somewhere the
 * publisher did not name.
 *
 * @returns the parsed feed and the source that answered
 */
export async function fetchFeed(
  sources: readonly string[],
  { timeoutMs = 15000, fetchImpl = fetch }: FetchFeedOptions = {},
): Promise<{ feed: Feed; source: string }> {
  const failures: string[] = []
  for (const source of sources) {
    if (typeof source !== 'string' || source === '') continue
    try {
      const response = await fetchImpl(bustCdnCache(source), {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      })
      if (!response.ok) { failures.push(`${source} -> HTTP ${response.status}`); continue }
      const text = await response.text()
      if (text.length > MAX_FEED_BYTES) { failures.push(`${source} -> feed too large`); continue }
      const feed = parseFeed(JSON.parse(text))
      return { feed, source }
    } catch (error: any) {
      failures.push(`${source} -> ${error?.message ?? error}`)
    }
  }
  throw new Error(`no feed source answered (${failures.join('; ')})`)
}

/** `<dataDir or $OFM_DATA_DIR or ~/.our-free-model>/feed.json`. */
export function feedCachePath(): string {
  return path.join(process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.our-free-model'), 'feed.json')
}

interface FeedDeps {
  settings: () => { feedUrl?: string } | undefined
  cacheFile?: string
  onArrival?: (items: Announcement[]) => void
  log?: (message: string) => void
  defaultSources?: readonly string[]
  /** Transport seam. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * The poll loop's state: last good copy on disk, known ids for arrival
 * detection, and the bookkeeping the settings page reads.
 */
export class AnnouncementFeed {
  private deps: Required<Pick<FeedDeps, 'settings' | 'log'>> & Omit<FeedDeps, 'settings' | 'log'>
  private cacheFile: string
  private cache: { at: number; source: string; announcements: Announcement[] }
  private error: string
  private polling: Promise<{ arrived: Announcement[]; total: number; source: string }> | null = null
  private knownIds: Set<string>

  constructor(deps: FeedDeps) {
    this.deps = {
      settings: deps.settings,
      log: deps.log ?? (() => {}),
      cacheFile: deps.cacheFile,
      onArrival: deps.onArrival,
      defaultSources: deps.defaultSources,
      fetchImpl: deps.fetchImpl ?? fetch,
    } as any
    this.cacheFile = deps.cacheFile ?? feedCachePath()
    this.cache = { at: 0, source: '', announcements: [] }
    this.error = ''
    this.knownIds = new Set()
  }

  /** Read the cached copy from disk; fresh installs start empty and stay silent on first poll. */
  load(disk?: string): { at: number; source: string; announcements: Announcement[] } {
    const raw = disk ?? this.readDisk()
    let rememberedIds: string[] = []
    try {
      const parsed = JSON.parse(raw ?? '')
      const feed = parseFeed(parsed)
      this.cache = {
        at: Number(parsed.fetchedAt) || 0,
        source: String(parsed.source ?? ''),
        announcements: feed.announcements,
      }
      if (Array.isArray(parsed.knownIds)) {
        rememberedIds = parsed.knownIds.filter((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 160)
      }
    } catch {
      this.cache = { at: 0, source: '', announcements: [] }
    }
    this.knownIds = new Set([
      ...this.cache.announcements.map(item => item.id),
      ...rememberedIds,
    ])
    return this.cache
  }

  readDisk(): string {
    try { return fs.readFileSync(this.cacheFile, 'utf8') } catch { return '' }
  }

  /** True when the poll has never succeeded on this installation. */
  get neverFetched(): boolean {
    return this.cache.at === 0
  }

  /** Sources for this installation: the owner's override first, then the defaults.
   *
   * The override must be https and carry no embedded credentials — a plaintext
   * URL would hand any local writer of settings.json a whisper network to the
   * LAN. Loopback http stays allowed: those requests never leave the machine,
   * which keeps a locally-hosted mirror (and the test suites) legitimate. */
  sources(): readonly string[] {
    let settings: { feedUrl?: string } | undefined
    try { settings = this.deps.settings() ?? undefined } catch { settings = undefined }
    const override = typeof settings?.feedUrl === 'string' ? settings.feedUrl.trim() : ''
    const defaults = this.deps.defaultSources ?? DEFAULT_FEED_SOURCES
    if (override === '') return defaults
    const expanded = override.includes('{repo}') ? override.replace('{repo}', REPO) : override
    let parsed: URL | null = null
    try { parsed = new URL(expanded) } catch { parsed = null }
    // URL.hostname keeps brackets on IPv6 (`[::1]`); everything loopback never
    // leaves the machine, so plain http stays acceptable there.
    const host = (parsed?.hostname ?? '').toLowerCase()
    const loopback = host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.')
    const acceptable = parsed !== null && parsed.username === '' && parsed.password === ''
      && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
    if (!acceptable) {
      this.deps.log?.('our-free-model: ignoring feedUrl override — it must be an https URL (loopback http is allowed) without credentials')
      return defaults
    }
    return [expanded, ...defaults]
  }

  /**
   * One poll. Concurrent calls share a single in-flight request. A good copy is
   * persisted to the cache file the moment it is validated.
   */
  poll(): Promise<{ arrived: Announcement[]; total: number; source: string }> {
    if (this.polling !== null) return this.polling
    this.polling = (async () => {
      try {
        const { feed, source } = await fetchFeed(this.sources(), { fetchImpl: this.deps.fetchImpl })
        const hadCache = !this.neverFetched
        const previousIds = new Set(this.knownIds)
        this.cache = { at: Date.now(), source, announcements: feed.announcements }
        // Mirrors may serve an older subset; seeing an id again is not arrival.
        this.knownIds = new Set([...previousIds, ...feed.announcements.map(item => item.id)])
        this.error = ''
        const arrived = hadCache && this.deps.onArrival !== undefined
          ? feed.announcements.filter(item => !previousIds.has(item.id))
          : []
        for (const item of arrived) this.deps.log?.(`our-free-model: announcement arrived "${item.title}"`)
        if (arrived.length > 0) this.deps.onArrival?.(arrived)
        this.persist()
        return { arrived, total: feed.announcements.length, source }
      } catch (error: any) {
        this.error = String(error?.message ?? error)
        this.deps.log?.(`our-free-model: feed poll failed (${this.error})`)
        return { arrived: [], total: this.cache.announcements.length, source: this.cache.source }
      } finally {
        this.polling = null
      }
    })()
    return this.polling
  }

  /** Write the last good copy; a crash mid-poll must not lose the cache.
   *
   * Temp file plus a rename, so a crash mid-write leaves the previous copy
   * intact rather than a truncated JSON that every later boot rejects. The mode
   * is creator-only: the cache names which announcements this machine has seen,
   * and a file another user can edit can mark a security notice as read. */
  persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      const temp = `${this.cacheFile}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify({
        fetchedAt: this.cache.at,
        source: this.cache.source,
        announcements: this.cache.announcements,
        knownIds: [...this.knownIds],
      }, undefined, 2), { mode: 0o600 })
      restrictPermissions(temp)
      fs.renameSync(temp, this.cacheFile)
    } catch (error: any) {
      this.deps.log?.(`our-free-model: could not persist the feed cache (${error?.message ?? error})`)
    }
  }

  /**
   * Snapshot for the API layer and the first `hello` push.
   *
   * The ack set is passed in from outside — a feed refresh never rewrites
   * acknowledgement history — and each item carries the publisher's own `html`
   * beside the sanitized `htmlSafe`/`htmlText` projection.
   */
  view({ ackedIds = [] }: { ackedIds?: Set<string> | string[] } = {}) {
    const acked = ackedIds instanceof Set ? ackedIds : new Set(ackedIds)
    // Annotate each item with its ack state so the client renders unread
    // markers from data instead of guessing.
    // Expired announcements stop rendering the moment they lapse, not whenever
    // the next poll happens to succeed (parseItem only filters on ingest, and an
    // unreachable feed source means no next poll for a long time).
    const now = Date.now()
    const items = this.cache.announcements
      .filter(item => item.expiresAt === undefined || item.expiresAt > now)
      .map((item) => {
        // Every agent that reads this endpoint gets *both* spellings of the body:
        // `html` is what the publisher wrote, and `htmlSafe` is what survived the
        // allowlist parser. A consumer that renders `htmlSafe` is safe whether or
        // not it sanitizes on its own side, which is the whole point of shipping
        // the projection from the provider rather than asking every client to
        // reimplement one.
        const safe = sanitizeAnnouncementHtml(item.html)
        return {
          ...item,
          acked: acked.has(item.id),
          htmlSafe: safe.text,
          htmlText: safe.nodes,
          unsafeLength: safe.dropped > 0 ? safe.dropped : undefined,
        }
      })
    return {
      items,
      unread: items.filter(item => !item.acked).length,
      fetchedAt: this.cache.at,
      source: this.cache.source,
      error: this.error,
      lastError: this.error,
    }
  }
}
