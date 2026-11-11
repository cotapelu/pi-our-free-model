/**
 * In-app plugin upgrade.
 *
 * The plugin updates itself from the same place the owner publishes it: a
 * manifest in the repository listing every file of the release with its size
 * and SHA-256. Applying an update is download → verify → stage → backup →
 * replace → verify → reload.
 *
 * The shape of the whole transaction is one rule: **nothing on the installed
 * copy is touched until the staged copy has been hash-verified**, and the
 * running process keeps executing from its in-memory module graph so replacing
 * files on disk cannot disturb a live request. Every step that can fail leaves
 * an answer:
 *
 *  - a download that fails its size or hash never reaches the swap;
 *  - the installed package is backed up first, and a failed verification or a
 *    failed reload restores it from that same backup;
 *  - replacements are written as `<file>.ofm-new` beside their target and
 *    renamed, so a crash mid-swap cannot truncate a file the next boot imports
 *    (transient Windows EPERM from indexers is retried);
 *  - a restore that cannot complete is reported rather than swallowed: the
 *    verified backup is retained and the phase says recovery is required.
 *
 * The signature is what makes a mirror usable at all. Every mirror — the
 * repository's own raw URLs and third-party CDNs alike — is equally untrusted
 * as a *code* source; the sha256 per file pins content, but those hashes travel
 * inside the manifest itself, so whoever forges the manifest forges the hashes.
 * `PINNED_MANIFEST_PUBLIC_KEY` is the step the forger cannot take.
 *
 * Ported from dsh's `src/updater.js`.
 *
 * @module pi-extension/updater.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { restrictPermissions } from './gateway/store.js'

const REPO = 'Ebony-Vinyl/dsh-our-free-model'
/** This package's own name, as a package manager records it in the profile. */
const PACKAGE_NAME = 'dsh-our-free-model'

/**
 * A GitHub raw proxy for networks where the direct origins are slow or
 * intermittently unreachable. It is a *transport* for the same
 * `raw.githubusercontent.com` path, so the snapshot resolver pins it to a full
 * commit exactly like the direct origin — the proxy never becomes a
 * mutable-branch install source. It is only ever asked for an immutable
 * commit-SHA path (see {@link snapshotManifestSource}); a mirror that answered a
 * different commit's bytes would fail the manifest signature and the per-file
 * SHA-256 checks, so it is untrusted by construction.
 */
const RAW_PROXY = 'https://gh-proxy.com'

/** Wrap a raw.githubusercontent.com URL in the proxy, keeping the inner URL intact. */
function viaRawProxy(inner: string): string {
  return `${RAW_PROXY}/https://raw.githubusercontent.com/${inner}`
}

/** Discovery locations, in preference order. */
export const DEFAULT_MANIFEST_SOURCES = [
  `https://raw.githubusercontent.com/${REPO}/main/feed/manifest.json`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/feed/manifest.json`,
  `https://gcore.jsdelivr.net/gh/${REPO}@main/feed/manifest.json`,
  viaRawProxy(`${REPO}/main/feed/manifest.json`),
]

/**
 * The Ed25519 public key (SPKI, base64) every release manifest must be signed
 * with before it may be applied. The matching private key lives with the
 * publisher; it is deliberately not in this repository, because a trust root
 * committed beside the code it authenticates authenticates nothing.
 */
export const PINNED_MANIFEST_PUBLIC_KEY = 'MCowBQYDK2VwAyEAeLdSVwYFyazc2PIBC0oLsvo4LghGEQz9iXIl3CqRuXI='

/** The manifest fields a signature covers. */
const SIGNED_FIELDS = ['version', 'base', 'publishedAt', 'notes', 'files', 'minSupported']

/**
 * Deterministic JSON: sorted keys, no whitespace, `undefined` dropped (object
 * fields) or nulled (array slots) — the same rules JSON.stringify applies, plus
 * key order. Both signer and verifier reduce the manifest to this form, so the
 * signature is over meaning, not byte layout.
 */
export function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map(row => stableStringify(row ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Reduce a manifest to exactly the fields a signature covers. */
function signaturePayload(payload: any): any {
  const source = payload !== null && typeof payload === 'object' ? payload : {}
  const picked: Record<string, any> = {}
  for (const key of SIGNED_FIELDS) if (source[key] !== undefined) picked[key] = source[key]
  return picked
}

/**
 * Sign one manifest's canonical form with an Ed25519 private key (PEM).
 * @param payload - the manifest document (any superset of the signed fields)
 * @param privateKey - PKCS8 PEM, or a loaded key
 * @returns base64 signature to store as the manifest's `signature`
 */
export function signManifest(payload: any, privateKey: string | crypto.KeyObject): string {
  const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey)
  return crypto.sign(null, Buffer.from(stableStringify(signaturePayload(payload))), key).toString('base64')
}

/**
 * Verify a manifest's `signature` against an Ed25519 public key (SPKI, base64).
 * Any malformed input answers `false` — a signature that cannot be checked is a
 * signature that is not there.
 */
export function verifyManifestSignature(payload: any, publicKeyBase64: string): boolean {
  const signature = payload !== null && typeof payload === 'object' && typeof payload.signature === 'string'
    ? payload.signature
    : ''
  if (signature === '' || typeof publicKeyBase64 !== 'string' || publicKeyBase64 === '') return false
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(stableStringify(signaturePayload(payload))), key, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/** Cache hint only: query strings cannot refresh jsDelivr's branch resolution. */
export function bustCdnCache(url: string, now: number = Date.now()): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.endsWith('.jsdelivr.net')) {
      parsed.searchParams.set('ofm', Math.floor(now / 60_000).toString())
      return parsed.href
    }
  } catch { /* malformed URL: let fetch report it */ }
  return url
}

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_ENGINE_BYTES = 128 * 1024 * 1024
const MAX_FILES = 128
const ENGINE_BINARY = /^vendor\/magpie\/bin\/magpie-(?:win32-(?:x64|arm64)\.exe|(?:linux|darwin)-(?:x64|arm64))$/
const SHA_RE = /^[0-9a-f]{64}$/
const PROCESS_EPOCH = Symbol.for('our-free-model.process-epoch')
const processEpoch: string = (globalThis as any)[PROCESS_EPOCH] ??= crypto.randomUUID()
const restartRequiredVersions: Map<string, { version: string; epoch: string }> = (globalThis as any)[Symbol.for('our-free-model.restart-required-versions')] ??= new Map()
// Hot reload evaluates a fresh updater module before the old request finishes.
// A process-wide lock keeps the successor from starting a second transaction.
const upgradeLocks: Set<string> = (globalThis as any)[Symbol.for('our-free-model.upgrade-locks')] ??= new Set()

/** The refusal `apply` raises for a package-manager-owned copy. */
const PACKAGE_MANAGER_REFUSAL = 'this installation is owned by pnpm; the in-app upgrade would be a second writer and can corrupt the copy — update it with pnpm (or reinstall from a release)'

export interface VersionTuple {
  major: number
  minor: number
  patch: number
  pre: string[] | null
}

/** Parse `1.2.3` / `1.2.3-rc.4` into a comparable tuple; `null` when malformed. */
export function parseVersion(value: any): VersionTuple | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(value ?? '').trim())
  if (match === null) return null
  const pre = match[4] === undefined ? null : match[4].split('.')
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/** -1 | 0 | 1 in semver precedence; a pre-release sorts before its release. */
export function compareVersions(a: any, b: any): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a === b ? 0 : (a > b ? 1 : -1)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const width = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < width; i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Detect a plugin install whose package files still belong to a package-manager store. */
export function packageUsesHardLinks(pkgDir: string): boolean {
  for (const rel of ['package.json', 'index.js', 'client.js']) {
    try { if (fs.statSync(path.join(pkgDir, rel)).nlink > 1) return true } catch { /* incomplete package: normal startup diagnostics handle it */ }
  }
  return false
}

/** Detect host rollback to a package version older than the code in memory. */
export function installationIsManaged(pkgDir: string): boolean {
  return packageUsesHardLinks(pkgDir)
}

export interface Manifest {
  version: string
  base: string
  files: Array<{ path: string; sha256: string; size: number }>
  notes: string
  publishedAt: number
  minSupported?: string
  signature?: string
}

/**
 * Validate the manifest document.
 * @throws {Error} with a reason the settings page can show
 */
export function parseManifest(payload: any): Manifest {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('manifest must be a JSON object')
  }
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (parseVersion(version) === null) throw new Error(`manifest version "${version}" is not a valid semver`)
  const base = typeof payload.base === 'string' && payload.base !== '' ? payload.base : '../'
  // The base is resolved against the manifest's own URL, so it must stay
  // relative: an absolute or protocol-relative value would point every download
  // at a host of the manifest author's choosing, and the sha256 pins would ride
  // along inside the same forged document. A relative URL cannot leave the
  // origin it resolves against.
  if (/^[a-z][a-z0-9+.-]*:/i.test(base) || base.startsWith('//') || base.startsWith('/') || base.includes('\\')) {
    throw new Error(`manifest base "${base}" must be a path relative to the manifest`)
  }
  const rows = payload.files
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('manifest carries no file list')
  if (rows.length > MAX_FILES) throw new Error(`manifest lists ${rows.length} files, above the ${MAX_FILES} cap`)
  const files: Array<{ path: string; sha256: string; size: number }> = []
  const seen = new Set<string>()
  for (const row of rows) {
    const file = parseFileEntry(row)
    if (seen.has(file.path)) throw new Error(`manifest lists ${file.path} twice`)
    seen.add(file.path)
    files.push(file)
  }
  if (!seen.has('package.json')) throw new Error('manifest must include package.json')
  return {
    version,
    base,
    files,
    notes: typeof payload.notes === 'string' ? payload.notes.slice(0, 32 * 1024) : '',
    publishedAt: timestampOf(payload.publishedAt) ?? 0,
    ...typeof payload.minSupported === 'string' ? { minSupported: payload.minSupported } : {},
    ...typeof payload.signature === 'string' ? { signature: payload.signature } : {},
  }
}

function parseFileEntry(row: any): { path: string; sha256: string; size: number } {
  const rel = typeof row?.path === 'string' ? row.path.trim() : ''
  const normalized = rel.replace(/\\/g, '/')
  if (normalized === '' || normalized.startsWith('/') || normalized.includes('../') || normalized.endsWith('..')
    || /[A-Za-z]:/.test(normalized) || normalized.split('/').includes('')) {
    throw new Error(`manifest file path "${rel}" is not a safe relative path`)
  }
  const sha256 = typeof row?.sha256 === 'string' ? row.sha256.toLowerCase() : ''
  if (!SHA_RE.test(sha256)) throw new Error(`manifest entry "${normalized}" has no valid sha256`)
  const size = row?.size
  const limit = ENGINE_BINARY.test(normalized) ? MAX_ENGINE_BYTES : MAX_FILE_BYTES
  if (!Number.isInteger(size) || size <= 0 || size > limit) {
    throw new Error(`manifest entry "${normalized}" has an out-of-range size`)
  }
  return { path: normalized, sha256, size }
}

function timestampOf(value: any): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Resolve one manifest-relative path against the URL the manifest came from. */
export function fileUrlOf(manifestUrl: string, manifest: Manifest, relativePath: string): string {
  return new URL(manifest.base + relativePath.split('/').map(encodeURIComponent).join('/'), manifestUrl).href
}

/** Git pkt-line lengths count bytes, including UTF-8 ref names. */
export function parseUploadPackRefs(body: string | Buffer): Map<string, string> {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const refs = new Map<string, string>()
  let offset = 0
  let ended = false
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('latin1')
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid ref advertisement packet')
    const length = Number.parseInt(header, 16)
    if (length <= 2) {
      offset += 4
      ended = offset === bytes.length && (length === 0 || length === 2)
      continue
    }
    ended = false
    if (length < 4 || offset + length > bytes.length) throw new Error('truncated ref advertisement packet')
    const payload = bytes.subarray(offset + 4, offset + length).toString('utf8').split('\0')[0]
    const match = /^([a-f0-9]{40}) ([^\s]+)\n?$/.exec(payload)
    if (match !== null) refs.set(match[2], match[1])
    offset += length
  }
  if (!ended) throw new Error('incomplete ref advertisement packet sequence')
  return refs
}

async function resolveViaApi(ref: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, {
    redirect: 'error', signal,
    headers: { accept: 'application/vnd.github.sha', 'user-agent': 'our-free-model-updater' },
  })
  if (!response.ok) {
    const remaining = response.headers?.get('x-ratelimit-remaining')
    const limited = response.status === 429 || (response.status === 403 && remaining === '0')
    const diagnostics = ['x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'].flatMap(name => {
      const value = response.headers?.get(name)
      return value !== null && /^\d{1,16}$/.test(value) ? [`${name}=${value}`] : []
    })
    throw new Error(`HTTP ${response.status}${limited ? '; GitHub API rate limit exceeded' : ''}${diagnostics.length ? '; ' + diagnostics.join('; ') : ''}`)
  }
  const text = (await response.text()).trim()
  if (text.length > MAX_MANIFEST_BYTES) throw new Error('snapshot resolution response too large')
  const sha = /^[a-f0-9]{40}$/.test(text) ? text : (() => { try { return JSON.parse(text)?.sha } catch { return undefined } })()
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('snapshot resolution did not return a full commit SHA')
  return sha
}

async function resolveViaRefAdvertisement(ref: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  const response = await fetchImpl(`https://github.com/${REPO}/info/refs?service=git-upload-pack`, {
    redirect: 'error', signal,
    headers: { accept: 'application/x-git-upload-pack-advertisement', 'user-agent': 'our-free-model-updater' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > MAX_MANIFEST_BYTES * 8) throw new Error('ref advertisement too large')
  const refs = parseUploadPackRefs(body)
  for (const name of [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`, ...(ref === 'HEAD' ? ['HEAD'] : [])]) {
    if (refs.has(name)) return refs.get(name)!
  }
  throw new Error(`no full commit SHA for ${ref} in ref advertisement`)
}

async function resolveViaCommitFeed(ref: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  const response = await fetchImpl(`https://github.com/${REPO}/commits/${encodeURIComponent(ref)}.atom`, {
    redirect: 'error', signal,
    headers: { accept: 'application/atom+xml', 'user-agent': 'our-free-model-updater' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.text()
  if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES * 8) throw new Error('commit feed too large')
  const entry = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/.exec(body)
  const match = entry && /<id>\s*tag:github\.com,2008:Grit::Commit\/([a-f0-9]{40})\s*<\/id>/.exec(entry[1])
  if (!match) throw new Error('commit feed carried no full commit SHA')
  return match[1]
}

/**
 * Pin an official discovery URL without changing the signed manifest format.
 *
 * The resolver supplies a location, never authority to install its contents: a
 * mutating branch is resolved to an immutable commit so the manifest read and
 * the file downloads describe the same bytes, and a mirror that answered a
 * different commit's bytes would fail the signature and the per-file hashes.
 */
async function snapshotManifestSource(source: string, fetchImpl: typeof fetch, signal: AbortSignal | undefined, revisions: Map<string, string | Error>, resolverTimeoutMs: number): Promise<string> {
  const url = new URL(source)
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return source
  const rawPrefix = `/${REPO}/`
  const cdnPrefix = `/gh/${REPO}@`
  // The raw proxy wraps a raw.githubusercontent.com URL after its own origin, so
  // its path is `/https://raw.githubusercontent.com/<REPO>/<ref>/feed/…`.
  const proxiedRawPrefix = `/https://raw.githubusercontent.com/${REPO}/`
  const prefix = url.hostname === 'raw.githubusercontent.com' ? rawPrefix
    : ['cdn.jsdelivr.net', 'gcore.jsdelivr.net'].includes(url.hostname) ? cdnPrefix
      : url.hostname === 'gh-proxy.com' ? proxiedRawPrefix : null
  if (prefix === null || !url.pathname.startsWith(prefix)) return source
  const match = /^([^/]+)\/feed\/manifest\.json$/.exec(url.pathname.slice(prefix.length))
  if (match === null) return source
  const ref = match[1]
  if (/^[a-f0-9]{40}$/.test(ref)) return source
  // Never insert arbitrary URL/path syntax in a resolver request.
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error('unsupported update source ref')
  let revision = revisions.get(ref)
  if (revision instanceof Error) throw revision
  if (revision === undefined) {
    const failures: string[] = []
    for (const [name, resolve] of [['api', resolveViaApi], ['refs', resolveViaRefAdvertisement], ['feed', resolveViaCommitFeed]] as const) {
      try {
        // Leave time for the remaining resolvers and the signed manifest even
        // when one official endpoint accepts a connection but never responds.
        const timeout = AbortSignal.timeout(resolverTimeoutMs)
        const routeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        revision = await resolve(ref, fetchImpl, routeSignal)
        break
      } catch (error: any) {
        failures.push(`${name}: ${error?.message ?? error}`)
        if (signal?.aborted) break
      }
    }
    if (revision === undefined) {
      const error = new Error(`snapshot resolution failed for ${ref} (${failures.join('; ')})`)
      // An exhausted deadline gets another budget on the next mirror. A
      // completed failed lookup is shared so mirrors do not repeat API limits.
      if (!signal?.aborted) revisions.set(ref, error)
      throw error
    }
    revisions.set(ref, revision)
  }
  url.pathname = `${prefix}${revision}/feed/manifest.json`
  return url.href
}

/**
 * Fetch the first source that answers with a manifest this installation accepts.
 *
 * A source is only believed when its document carries a signature made with
 * `verifyKey`: every mirror is equally untrusted as a *code* source, and equally
 * usable once the manifest itself is the thing being authenticated.
 */
export async function downloadManifest(sources: string[], { timeoutMs = 15000, fetchImpl = fetch, verifyKey = PINNED_MANIFEST_PUBLIC_KEY }: {
  timeoutMs?: number
  fetchImpl?: typeof fetch
  verifyKey?: string
} = {}): Promise<{ manifest: Manifest; source: string; signed: boolean }> {
  const failures: string[] = []
  const revisions = new Map<string, string | Error>()
  for (const source of sources) {
    try {
      // One deadline covers resolution, manifest headers and body for this leg.
      const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
      const snapshot = await snapshotManifestSource(source, fetchImpl, signal, revisions, Math.max(1, Math.min(3000, Math.floor(timeoutMs / 4))))
      const response = await fetchImpl(bustCdnCache(snapshot), {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) { failures.push(`${source} -> HTTP ${response.status}`); continue }
      const text = await response.text()
      if (text.length > MAX_MANIFEST_BYTES) { failures.push(`${source} -> manifest too large`); continue }
      const manifest = parseManifest(JSON.parse(text))
      if (!verifyManifestSignature(manifest, verifyKey)) {
        failures.push(`${source} -> manifest signature missing or not made with the release key`)
        continue
      }
      return { manifest, source: snapshot, signed: true }
    } catch (error: any) {
      failures.push(`${source} -> ${error?.message ?? error}`)
    }
  }
  throw new Error(`no manifest source answered (${failures.join('; ')})`)
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const STAGE_ATTEMPTS = 3
const STAGE_BACKOFF_MS = 700

/** A CN egress to the CDN drops connections regularly, and a one-shot staging
 * turned one flaky second into a whole failed upgrade. Transport-class failures
 * retry with a short backoff; integrity failures (size/digest) never do — a
 * wrong body is the trust chain refusing, not a bad hair day. */
function isTransientDownloadError(error: any): boolean {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true
  return /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|terminated|socket/i.test(String(error?.message ?? error))
}

/**
 * The URLs one file is tried from, in order.
 *
 * jsDelivr's primary edge can redirect documentation files to raw (unavailable
 * on some client networks), and both edges refuse to serve a file above their
 * own size ceiling (measured: a 65 MB vendored engine binary answered 403 while
 * every ordinary file on the same commit answered 200). Both cases fall back to
 * the *same pinned commit* on the other transport — never an arbitrary Location
 * and never a mutable branch. Size/hash checks remain outside the transport
 * fallback and cannot authorize another body.
 */
function stagedFileSources(manifestUrl: string, manifest: Manifest, relativePath: string): string[] {
  const file = fileUrlOf(manifestUrl, manifest, relativePath)
  const url = new URL(file)
  const prefix = `/gh/${REPO}@`
  const jsdelivr = url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'gcore.jsdelivr.net'
  if (url.protocol !== 'https:' || !jsdelivr || url.port
    || url.username || url.password || !url.pathname.startsWith(prefix)
    || !/^[a-f0-9]{40}\//.test(url.pathname.slice(prefix.length))) return [file]
  const sha = url.pathname.slice(prefix.length).split('/')[0]
  const rest = url.pathname.slice(prefix.length + sha.length + 1)
  const cdn = new URL(url)
  cdn.hostname = 'cdn.jsdelivr.net'
  const gcore = new URL(url)
  gcore.hostname = 'gcore.jsdelivr.net'
  const raw = `https://raw.githubusercontent.com/${REPO}/${sha}/${rest}`
  // Keep the origin that was actually asked first, then the other edge, then
  // the two raw transports at the same pinned commit.
  const others = [cdn.href, gcore.href].filter(href => href !== file)
  return [file, ...others, raw, viaRawProxy(`${REPO}/${sha}/${rest}`)]
}

export interface StageResult {
  bytes: number
  files: number
  reused: boolean
}

/**
 * Download and hash-verify the whole release into `stageDir`.
 *
 * A retry after a failure in a later phase — the backup rename, the swap — would
 * otherwise wipe a staging copy that already verified and re-download the whole
 * release, which is what "the update is stuck on loading" looks like from the
 * settings page. An existing copy is only kept when it hashes clean against
 * *this* manifest, so a stage left over from another release is wiped.
 */
export async function stageRelease({ manifest, manifestUrl, stageDir, fetchImpl = fetch, concurrency = 4, onProgress = () => {}, timeoutMs = 30000 }: {
  manifest: Manifest
  manifestUrl: string
  stageDir: string
  fetchImpl?: typeof fetch
  concurrency?: number
  onProgress?: (progress: any) => void
  timeoutMs?: number
}): Promise<StageResult> {
  try {
    verifyStaged(stageDir, manifest)
    onProgress({ phase: 'download', reused: true, done: manifest.files.length, total: manifest.files.length })
    return {
      bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
      files: manifest.files.length,
      reused: true,
    }
  } catch { /* nothing to reuse; stage from scratch below */ }
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.mkdirSync(stageDir, { recursive: true })
  let done = 0
  let bytes = 0
  let cursor = 0
  const failures: string[] = []
  const workers = Array.from({ length: Math.min(concurrency, manifest.files.length) }, async () => {
    while (cursor < manifest.files.length) {
      const file = manifest.files[cursor++]
      const target = path.join(stageDir, ...file.path.split('/'))
      const sources = stagedFileSources(manifestUrl, manifest, file.path)
      let lastError: any
      for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
        try {
          const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
          let body: Buffer | undefined
          for (let mirror = 0; mirror < sources.length; mirror++) {
            try {
              const response = await fetchImpl(bustCdnCache(sources[mirror]), { redirect: 'error', signal })
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              body = Buffer.from(await response.arrayBuffer())
              break
            } catch (error: any) {
              const status = /^HTTP (\d{3})$/.exec(String(error?.message ?? ''))?.[1]
              // A 403 is an authorization refusal, and switching hosts on it
              // would look like a way around one. The single exception is a file
              // jsDelivr structurally cannot serve: its size ceiling answers 403
              // for the vendored engine binary, so the same pinned commit's raw
              // transport is tried instead. Any other 403 still stops here.
              const oversized = status === '403' && ENGINE_BINARY.test(file.path)
              const canFallback = status
                ? /^(3\d\d|404|429|5\d\d)$/.test(status) || oversized
                : isTransientDownloadError(error)
              if (!canFallback || mirror === sources.length - 1 || signal?.aborted) throw error
            }
          }
          if (body === undefined) throw new Error('no transport answered for this file')
          if (body.length !== file.size) throw new Error(`size ${body.length} != manifest ${file.size}`)
          const digest = crypto.createHash('sha256').update(body).digest('hex')
          if (digest !== file.sha256) throw new Error('sha256 mismatch')
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, body)
          done += 1
          bytes += body.length
          onProgress({ done, total: manifest.files.length, file: file.path })
          lastError = null
          break
        } catch (error: any) {
          lastError = error
          const httpStatus = /^HTTP (\d{3})$/.exec(String(error?.message ?? ''))?.[1]
          const retryable = httpStatus ? httpStatus === '429' || httpStatus.startsWith('5') : isTransientDownloadError(error)
          if (attempt >= STAGE_ATTEMPTS || !retryable) break
          await new Promise(resolve => setTimeout(resolve, STAGE_BACKOFF_MS * attempt))
        }
      }
      if (lastError) failures.push(`${file.path}: ${lastError?.message ?? lastError}`)
    }
  })
  await Promise.all(workers)
  if (failures.length > 0) {
    // A half-written stage must never be the one a later retry hashes clean
    // against, so it is removed here rather than left for reuse.
    fs.rmSync(stageDir, { recursive: true, force: true })
    throw new Error(`staging failed: ${failures.join('; ')}`)
  }
  return { bytes, files: done, reused: false }
}

/** The staged copy is checked against the manifest before install touches anything. */
export function verifyStaged(stageDir: string, manifest: Manifest): void {
  for (const file of manifest.files) {
    const target = path.join(stageDir, ...file.path.split('/'))
    let stat: fs.Stats
    try { stat = fs.statSync(target) } catch { throw new Error(`staged file missing: ${file.path}`) }
    if (stat.size !== file.size) throw new Error(`staged size drift for ${file.path}`)
    if (sha256File(target) !== file.sha256) throw new Error(`staged hash drift for ${file.path}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'))
  if (pkg.version !== manifest.version) throw new Error(`staged package.json says ${pkg.version}, manifest says ${manifest.version}`)
}

/**
 * Top-level directories and files that belong to the repository rather than to a
 * release. An installed copy never has them; a git-clone or linked development
 * copy always does, and it is the same directory the upgrader operates on.
 * `catalog` travels with ecosystem packs rather than with a release, and
 * `worker` and vendor development sources ship for self-hosters — a sweep that
 * treats them as "files the new release dropped" would delete the pack's
 * readiness records out from under the harness's bundle validation on the first
 * in-app upgrade.
 */
const REPOSITORY_SCAFFOLDING = ['feed', 'scripts', 'docs', 'promo', 'node_modules', 'catalog', 'worker', 'vendor', 'packages', 'tsconfig.json']
// Actual published runtime assets must participate in backup and rollback,
// including when an upgrade crosses the 1.x/2.x boundary.
const VENDOR_RUNTIME_FILES = [
  'vendor/channel-pack/pack.js',
  'vendor/channel-pack/qoder-auth-wasm.wasm',
  'vendor/channel-pack/NOTICE.md',
  'vendor/channel-pack/LICENSE',
  'vendor/magpie/engine.json',
  'vendor/magpie/LICENSE',
  'vendor/magpie/NOTICE.md',
]

export interface PackageFile {
  path: string
  size: number
  sha256: string
}

/**
 * Walk a directory into relative file paths, skipping release scratch files and
 * anything that belongs to the repository rather than to the package.
 *
 * The skip matters twice over: the backup must not copy a `.git` directory, and
 * `installStaged` must not delete the development copy's test suite or feed
 * directory as "a file the new release dropped".
 */
export function listPackageFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string, rel: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.endsWith('.ofm-new') || entry.name.endsWith('.ofm-old')) continue
      if (rel === '' && (entry.name.startsWith('.') || REPOSITORY_SCAFFOLDING.includes(entry.name))) continue
      const child = path.join(current, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) visit(child, childRel)
      else if (entry.isFile()) out.push(childRel)
    }
  }
  if (fs.existsSync(dir)) visit(dir, '')
  for (const rel of VENDOR_RUNTIME_FILES) {
    const target = path.join(dir, ...rel.split('/'))
    if (fs.existsSync(target) && fs.lstatSync(target).isFile()) out.push(rel)
  }
  const engineDir = path.join(dir, 'vendor/magpie/bin')
  if (fs.existsSync(engineDir) && fs.lstatSync(engineDir).isDirectory()) {
    for (const entry of fs.readdirSync(engineDir, { withFileTypes: true })) {
      if (entry.isFile() && /^magpie-(?:win32-(?:x64|arm64)\.exe|(?:linux|darwin)-(?:x64|arm64))$/.test(entry.name)) {
        out.push(`vendor/magpie/bin/${entry.name}`)
      }
    }
  }
  return out
}

/** Windows can transiently refuse a rename while a file is scanned; retry briefly. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 60
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error: any) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'ENOENT'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, delay))
      delay *= 4
    }
  }
}

function packageSnapshot(dir: string): { files: PackageFile[] } {
  const files = listPackageFiles(dir).sort().map((rel: string) => {
    const file = path.join(dir, ...rel.split('/'))
    return { path: rel, size: fs.statSync(file).size, sha256: sha256File(file) }
  })
  if (!files.some(file => file.path === 'package.json') || !files.some(file => file.path === 'index.js')) {
    throw new Error(`no complete rollback copy in ${dir} — package.json and index.js are required`)
  }
  return { files }
}

function verifySnapshot(dir: string, snapshot: { files: PackageFile[] }): void {
  const paths = listPackageFiles(dir).sort()
  if (paths.join('\n') !== snapshot.files.map(file => file.path).sort().join('\n')) {
    throw new Error('rollback file set mismatch')
  }
  for (const file of snapshot.files) {
    const target = path.join(dir, ...file.path.split('/'))
    if (fs.statSync(target).size !== file.size || sha256File(target) !== file.sha256) {
      throw new Error(`rollback hash drift for ${file.path}`)
    }
  }
}

/**
 * Copy the current package aside so a failed swap can be undone.
 *
 * The two directory renames move a tree that was just written, which is exactly
 * what a real-time scanner or indexer holds open on Windows: they go through
 * `renameWithRetry`, so one transient EPERM does not abort a transaction that
 * has not touched the installed package yet.
 *
 * @returns files backed up
 */
export async function backupPackage(pkgDir: string, backupDir: string): Promise<number> {
  const snapshot = packageSnapshot(pkgDir)
  const pending = `${backupDir}.pending-${crypto.randomUUID()}`
  const previous = `${backupDir}.previous-${crypto.randomUUID()}`
  let movedPrevious = false
  try {
    fs.mkdirSync(pending, { recursive: true })
    for (const file of snapshot.files) {
      const target = path.join(pending, ...file.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(pkgDir, ...file.path.split('/')), target)
    }
    verifySnapshot(pending, snapshot)
    // Detect edits during backup too: the copy must describe the preimage that
    // is actually about to be replaced.
    verifySnapshot(pkgDir, snapshot)
    fs.writeFileSync(path.join(pending, '.ofm-backup.json'), JSON.stringify(snapshot))
    if (fs.existsSync(backupDir)) {
      await renameWithRetry(backupDir, previous)
      movedPrevious = true
    }
    try {
      await renameWithRetry(pending, backupDir)
    } catch (error) {
      if (movedPrevious) await renameWithRetry(previous, backupDir)
      throw error
    }
    // Failure to clean an older copy does not invalidate the new verified copy.
    if (movedPrevious) {
      try { fs.rmSync(previous, { recursive: true, force: true }) } catch { /* retain it */ }
    }
    return snapshot.files.length
  } finally {
    try { fs.rmSync(pending, { recursive: true, force: true }) } catch { /* retain it */ }
  }
}

function backupSnapshot(backupDir: string): { files: PackageFile[] } {
  if (listPackageFiles(backupDir).length === 0) {
    throw new Error(`no rollback copy in ${backupDir} — leaving the installed package untouched`)
  }
  const metadata = path.join(backupDir, '.ofm-backup.json')
  // Older releases did not leave a receipt. Keep their complete backups usable.
  if (!fs.existsSync(metadata)) return packageSnapshot(backupDir)
  const snapshot = JSON.parse(fs.readFileSync(metadata, 'utf8'))
  if (!Array.isArray(snapshot?.files) || snapshot.files.length === 0
    || snapshot.files.some((file: any) => file === null || typeof file !== 'object')
    || !snapshot.files.some((file: any) => file.path === 'package.json')
    || !snapshot.files.some((file: any) => file.path === 'index.js')
    || snapshot.files.some((file: any) => typeof file.path !== 'string' || file.path.startsWith('/')
      || file.path.includes('\\') || file.path.split('/').some((part: string) => part === '' || part === '.' || part === '..')
      || /:/.test(file.path) || !SHA_RE.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0)
    || new Set(snapshot.files.map((file: any) => file.path)).size !== snapshot.files.length) {
    throw new Error('invalid rollback receipt')
  }
  // Older development-install receipts also covered standalone products and
  // compiler caches. Keep those bytes retained, but never restore that tree.
  const runtimeSnapshot = { files: snapshot.files.filter((file: any) => file.path.split('/')[0] !== 'packages') }
  verifySnapshot(backupDir, runtimeSnapshot)
  return runtimeSnapshot
}

function copyIntoPackage(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.copyFileSync(source, target)
  } catch (error: any) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
    const stat = fs.statSync(target, { throwIfNoEntry: false })
    if (!stat?.isFile()) throw error
    try { fs.chmodSync(target, stat.mode | 0o200) } catch { throw error }
    try {
      fs.copyFileSync(source, target)
    } catch (retryError: any) {
      try { fs.chmodSync(target, stat.mode) } catch (modeError: any) {
        throw new Error(`${retryError?.message ?? retryError}; restoring file permissions failed (${modeError?.message ?? modeError})`, { cause: retryError })
      }
      throw retryError
    }
    fs.chmodSync(target, stat.mode)
  }
}

/** Put a backed-up copy back in place (used when a swap or reload fails). */
export function restoreBackup(backupDir: string, pkgDir: string): void {
  // Never let a missing rollback copy turn into a wipe: listPackageFiles
  // answers [] for a directory that does not exist, and an install that has
  // never applied an update has no rollback copy at all — walking into the
  // delete loop with nothing to put back would empty the package while the
  // running process keeps going from memory.
  const snapshot = backupSnapshot(backupDir)
  const backup = snapshot.files.map(file => file.path)
  const failures: string[] = []
  for (const rel of backup) {
    // Copy loop must survive a locked file: attempting every entry keeps the
    // restore as complete as this machine allows instead of crashing halfway.
    try {
      copyIntoPackage(path.join(backupDir, ...rel.split('/')), path.join(pkgDir, ...rel.split('/')))
    } catch (error: any) { failures.push(`${rel} (${error?.message ?? error})`) }
  }
  // Restore first. Deleting every installed file before copying made a denied
  // copy destroy files that could otherwise still have been used for recovery.
  try {
    for (const rel of listPackageFiles(pkgDir)) {
      if (backup.includes(rel)) continue
      try { fs.rmSync(path.join(pkgDir, ...rel.split('/')), { force: true }) }
      catch (error: any) { failures.push(`${rel} (${error?.message ?? error})`) }
    }
    verifySnapshot(pkgDir, snapshot)
  } catch (error: any) { failures.push(String(error?.message ?? error)) }
  if (failures.length > 0) throw new Error(`rollback incomplete: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? ` +${failures.length - 3} more` : ''}`)
}

/**
 * Move a verified staging directory into the installed package location.
 * Every file goes through a same-directory `<name>.ofm-new` so the final hop is
 * a same-volume rename; the running module graph is unaffected.
 */
export async function installStaged(stageDir: string, pkgDir: string, files: string[]): Promise<void> {
  for (const rel of files) {
    const parts = rel.split('/')
    const source = path.join(stageDir, ...parts)
    const target = path.join(pkgDir, ...parts)
    const pending = `${target}.ofm-new`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, pending)
    await renameWithRetry(pending, target)
  }
  // A file the new release dropped must not linger from the old one.
  for (const rel of listPackageFiles(pkgDir)) {
    if (files.includes(rel)) continue
    fs.rmSync(path.join(pkgDir, ...rel.split('/')), { force: true })
  }
}

/** Read back everything that was just written; one drifted byte aborts the swap. */
export function verifyInstalled(pkgDir: string, manifest: Manifest): void {
  for (const file of manifest.files) {
    const target = path.join(pkgDir, ...file.path.split('/'))
    if (!fs.existsSync(target)) throw new Error(`installed file missing: ${file.path}`)
    if (sha256File(target) !== file.sha256) throw new Error(`installed hash drift for ${file.path}`)
  }
}

function readTextFile(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8') } catch { return undefined }
}

/** True when a pnpm lockfile records a `specifier` for `name` as a dependency.
 *  A `link:` specifier is deliberately not ownership: pnpm records no version
 *  and no integrity for a link, so it owns the junction and never the bytes.
 *  Refusing there would disable the one self-upgrade shape that survives a full
 *  install — a real tree inside the profile declared as a relative `link:`. */
function lockfileDeclaresPackage(text: string, name: string): boolean {
  const lines = text.split(/\r?\n/)
  const entry = new RegExp(`^(\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = entry.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    for (let child = index + 1; child < lines.length; child += 1) {
      const line = lines[child]
      if (line.trim() === '') continue
      if (line.length - line.trimStart().length <= indent) break
      if (/^\s*"?specifier"?\s*:\s*['"]?link:/.test(line)) return false
      if (/^\s*"?specifier"?\s*:/.test(line)) return true
    }
  }
  return false
}

/** True when `node_modules/.modules.yaml` hoists `name@<specifier>`. pnpm
 *  writes this file as JSON on newer releases and as YAML on older ones, so
 *  the JSON spelling is parsed and the YAML spelling scanned by indentation. */
function modulesHoistsPackage(text: string, name: string): boolean {
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  if (parsed !== undefined) {
    const hoisted = parsed?.hoistedLocations
    if (hoisted === null || typeof hoisted !== 'object') return false
    return Object.keys(hoisted).some(key => key.startsWith(`${name}@`))
  }
  const lines = text.split(/\r?\n/)
  const header = /^(\s*)"?hoistedLocations"?\s*:/
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    for (let child = index + 1; child < lines.length; child += 1) {
      const line = lines[child]
      if (line.trim() === '') continue
      if (line.length - line.trimStart().length <= indent) break
      if (line.includes(`${name}@`)) return true
    }
  }
  return false
}

/**
 * Does a package manager own the installed copy?
 *
 * Two exact, filesystem-local records prove it, both read beside the profile
 * root (two levels above `pkgDir`): the profile's `pnpm-lock.yaml` declares this
 * package as a dependency, or `node_modules/.modules.yaml` lists it under
 * `hoistedLocations`. A `node_modules/` directory *inside* the plugin copy is
 * deliberately not a signal: under pnpm's hoisted linker a tarball dependency
 * installs without one, so that heuristic would miss exactly the installs this
 * guards.
 */
export function isPackageManagerOwned(pkgDir: string): boolean {
  const profileDir = path.dirname(path.dirname(path.resolve(pkgDir)))
  const lockfile = readTextFile(path.join(profileDir, 'pnpm-lock.yaml'))
  if (lockfile !== undefined && lockfileDeclaresPackage(lockfile, PACKAGE_NAME)) return true
  const modules = readTextFile(path.join(profileDir, 'node_modules', '.modules.yaml'))
  return modules !== undefined && modulesHoistsPackage(modules, PACKAGE_NAME)
}

/** The upgrade lifecycle. The optional activate callback lets the Host include
 * hot reload in the transaction; standalone release audits only install files. */
export class PluginUpdater {
  private pkgDir: string
  private dataDir: string
  private settings: () => { updateCheckHours?: number }
  private log: (message: string) => void
  private fetchImpl: typeof fetch
  private defaultSources: string[]
  private manifestPublicKey: string
  private runningVersion?: string
  private epoch: string
  private latest?: Manifest
  private latestContentDrift = false
  private manifestUrl = ''
  private checkedAt = 0
  private error = ''
  private applying = false
  private history: Array<Record<string, any>> = []

  get stageDir(): string { return path.join(this.dataDir, 'upgrade-stage') }
  get backupDir(): string { return path.join(this.dataDir, 'rollback') }
  get stateFile(): string { return path.join(this.dataDir, 'upgrade-state.json') }

  constructor({ pkgDir, dataDir, settings, log = () => {}, fetchImpl = fetch, defaultSources = DEFAULT_MANIFEST_SOURCES, manifestPublicKey = PINNED_MANIFEST_PUBLIC_KEY, runningVersion, processEpoch: epoch = processEpoch }: {
    pkgDir: string
    dataDir: string
    settings: () => { updateCheckHours?: number }
    log?: (message: string) => void
    fetchImpl?: typeof fetch
    defaultSources?: string[]
    manifestPublicKey?: string
    runningVersion?: string
    processEpoch?: string
  }) {
    this.pkgDir = pkgDir
    this.dataDir = dataDir
    this.settings = settings
    this.log = log
    this.fetchImpl = fetchImpl
    this.defaultSources = defaultSources
    this.manifestPublicKey = manifestPublicKey
    this.runningVersion = runningVersion
    this.epoch = epoch
    this.history = this.loadHistory()
  }

  loadUpgradeState(): any {
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      if (state === null || !['installing', 'activating', 'recovery-required', 'rolled-back', 'complete'].includes(state.phase)) {
        throw new Error('invalid transaction phase')
      }
      return state
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined
      return { phase: 'recovery-required', error: `could not read upgrade state (${error?.message ?? error})` }
    }
  }

  saveUpgradeState(state: any): void {
    fs.mkdirSync(this.dataDir, { recursive: true })
    const pending = `${this.stateFile}.tmp`
    fs.writeFileSync(pending, JSON.stringify(state), { mode: 0o600 })
    restrictPermissions(pending)
    fs.renameSync(pending, this.stateFile)
  }

  reconcileRecovery(): void {
    const state = this.loadUpgradeState()
    const restartMarker = restartRequiredVersions.get(this.pkgDir)
    if (!upgradeLocks.has(this.pkgDir) && state?.phase === 'complete' && state.restartRequired === true
      && restartMarker !== undefined && restartMarker.version === state.to && restartMarker.epoch === this.epoch
      && (this.runningVersion ?? this.currentVersion()) === state.from && this.currentVersion() === state.from) {
      restartRequiredVersions.delete(this.pkgDir)
      this.saveUpgradeState({ ...state, phase: 'rolled-back', restartRequired: false, diskRestored: true, runtimeRestored: true })
      return
    }
    if (upgradeLocks.has(this.pkgDir) || !['installing', 'activating', 'recovery-required'].includes(state?.phase)) return
    try {
      verifySnapshot(this.pkgDir, backupSnapshot(this.backupDir))
      if ((this.runningVersion ?? this.currentVersion()) !== state.from) return
      this.saveUpgradeState({ ...state, phase: 'rolled-back', error: '', diskRestored: true, runtimeRestored: true })
    } catch { /* keep the blocker until both the bytes and runtime match */ }
  }

  currentVersion(): string {
    try {
      return String(JSON.parse(fs.readFileSync(path.join(this.pkgDir, 'package.json'), 'utf8')).version ?? '')
    } catch {
      return ''
    }
  }

  loadHistory(): Array<Record<string, any>> {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'updates.json'), 'utf8'))
      return Array.isArray(parsed?.applied) ? parsed.applied : []
    } catch {
      return []
    }
  }

  recordHistory(entry: Record<string, any>): void {
    // A hot reload creates a successor before the caller finishes. Merge with
    // durable history, and let both instances read the final outcome.
    this.history = [...this.loadHistory(), entry].slice(-20)
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(path.join(this.dataDir, 'updates.json'), JSON.stringify({ applied: this.history }, undefined, 2))
    } catch (error: any) {
      this.log?.(`our-free-model: could not write update history (${error?.message ?? error})`)
    }
  }

  status() {
    const installedVersion = this.currentVersion()
    const current = this.runningVersion ?? installedVersion
    const state = this.loadUpgradeState()
    const active = upgradeLocks.has(this.pkgDir)
    const unfinished = ['installing', 'activating'].includes(state?.phase)
    const recoveryRequired = state?.phase === 'recovery-required' || (unfinished && !active)
    const restartMarker = restartRequiredVersions.get(this.pkgDir)
    const restartRequired = restartMarker !== undefined && restartMarker.epoch === this.epoch && restartMarker.version === installedVersion
    const versionOrder = this.latest === undefined ? -1 : compareVersions(this.latest.version, current)
    const available = !restartRequired && this.latest !== undefined
      && (versionOrder > 0 || (versionOrder === 0 && this.latestContentDrift))
    this.history = this.loadHistory()
    return {
      current,
      runningVersion: current,
      installedVersion,
      versionMismatch: current !== installedVersion,
      recoveryRequired,
      restartRequired,
      phase: state?.phase ?? 'idle',
      latest: this.latest?.version ?? '',
      available,
      notes: this.latest?.notes ?? '',
      publishedAt: this.latest?.publishedAt ?? 0,
      checkedAt: this.checkedAt,
      applying: active,
      error: state?.error || this.error,
      recoveryBackup: recoveryRequired ? this.backupDir : undefined,
      lastApplied: this.history[this.history.length - 1] ?? undefined,
    }
  }

  /** Manifest sources. Deliberately immune to the `feedUrl` setting: an update
   *  source is a code source, and a settings value pointing it anywhere else is
   *  the one-step path from "wrote a config field" to "executed arbitrary code
   *  in the host process". Announcements may be mirrored by their user; the
   *  update channel may not. */
  sources(): string[] {
    return this.defaultSources
  }

  /** Fetch and evaluate the latest manifest. */
  async check(): Promise<{ available: boolean; current: string; latest: string }> {
    try {
      this.reconcileRecovery()
      const { manifest, source } = await downloadManifest(this.sources(), { fetchImpl: this.fetchImpl, verifyKey: this.manifestPublicKey })
      const current = this.runningVersion ?? this.currentVersion()
      if (manifest.minSupported !== undefined && current !== '' && compareVersions(current, manifest.minSupported) < 0) {
        throw new Error(`update path requires at least ${manifest.minSupported}; ${current} is installed`)
      }
      this.latest = manifest
      this.latestContentDrift = compareVersions(manifest.version, current) === 0 && !this.installedMatches(manifest)
      this.manifestUrl = source
      this.checkedAt = Date.now()
      this.error = ''
      this.log(`our-free-model: update check via ${source} -> ${manifest.version} (installed ${current})`)
      return { available: compareVersions(manifest.version, current) > 0 || this.latestContentDrift, current, latest: manifest.version }
    } catch (error: any) {
      this.error = String(error?.message ?? error)
      throw error
    }
  }

  installedMatches(manifest: Manifest): boolean {
    try {
      verifyInstalled(this.pkgDir, manifest)
      return true
    } catch {
      return false
    }
  }

  /** Download, verify and install one manifest. Idempotent for the same version. */
  async apply({ version, onProgress = () => {}, activate }: {
    version?: string
    onProgress?: (progress: any) => void
    activate?: (result: any) => Promise<any>
  } = {}): Promise<any> {
    if (this.status().restartRequired) throw new Error('the installed version is ready; restart the host before applying another update')
    if (upgradeLocks.has(this.pkgDir)) throw new Error('an upgrade is already running')
    // A package-manager-owned copy is refused before any transaction state is
    // touched or a manifest is fetched: the in-app upgrader would be a second
    // writer on a directory pnpm replaces atomically, which corrupts the install.
    if (isPackageManagerOwned(this.pkgDir)) {
      throw Object.assign(new Error(PACKAGE_MANAGER_REFUSAL), { statusCode: 409 })
    }
    this.reconcileRecovery()
    const priorState = this.loadUpgradeState()
    if (['installing', 'activating', 'recovery-required'].includes(priorState?.phase)) {
      throw new Error(`previous upgrade requires recovery; restore the verified backup in ${this.backupDir} and restart before upgrading again`)
    }
    this.applying = true
    upgradeLocks.add(this.pkgDir)
    const previous = this.currentVersion()
    let targetVersion = version ?? this.latest?.version ?? ''
    let state: any
    let installed = false
    let activated = false
    let restartRequired = false
    try {
      // Re-check immediately before installing: the owner may have pushed a new
      // manifest since the last check, and a stale cached manifest would verify
      // downloads against hashes the repository no longer stands behind.
      await this.check()
      const manifest = this.latest
      if (manifest === undefined) throw new Error('no manifest available')
      targetVersion = manifest.version
      if (version !== undefined && manifest.version !== version) throw new Error(`manifest offers ${manifest.version}, not ${version}`)
      if (compareVersions(manifest.version, previous) < 0) throw new Error(`installed ${previous} is newer than ${manifest.version}`)

      onProgress({ phase: 'download' })
      // `check` above only accepts signed manifests, but this guard is cheap and
      // keeps `apply` honest on its own: a manifest that cannot be attributed to
      // the release key must not reach the file swap, whatever path delivered it.
      if (manifest.signature === undefined || !verifyManifestSignature(manifest, this.manifestPublicKey)) {
        throw new Error('the manifest is not signed with the pinned release key')
      }
      const staged = await stageRelease({
        manifest, manifestUrl: this.manifestUrl ?? this.sources()[0], stageDir: this.stageDir,
        fetchImpl: this.fetchImpl, onProgress,
      })
      verifyStaged(this.stageDir, manifest)

      onProgress({ phase: 'install' })
      const backedUp = await backupPackage(this.pkgDir, this.backupDir)
      state = { from: previous, to: manifest.version, at: Date.now(), phase: 'installing' }
      // Persist the intent before the first installed byte changes.
      this.saveUpgradeState(state)
      const result = { version: manifest.version, previous, files: manifest.files.length, bytes: staged.bytes }
      try {
        installed = true
        await installStaged(this.stageDir, this.pkgDir, manifest.files.map(file => file.path))
        verifyInstalled(this.pkgDir, manifest)
        if (activate !== undefined) {
          state = { ...state, phase: 'activating' }
          this.saveUpgradeState(state)
          onProgress({ phase: 'reload' })
          const activation = await activate(result)
          if (activation?.restartRequired === true) {
            // The installed files are fully verified, but this host cannot safely
            // replace its live module graph. Keep the good disk install and ask
            // for a host restart instead of rolling the package back.
            restartRequired = true
          } else if (activation?.ok !== true) {
            if (activation?.restored === true) {
              restartRequired = true
            } else {
              throw Object.assign(new Error(activation?.error ?? 'hot reload did not confirm activation'), { runtimeRestored: false })
            }
          } else if (activation.version !== manifest.version) {
            throw new Error(`activation version mismatch: expected ${manifest.version}, got ${String(activation.version ?? '(missing)')}`)
          } else {
            activated = true
          }
        }
      } catch (error: any) {
        // The installed copy is now in an unknown state: put the old one back
        // before surfacing the failure, so the next boot still works. A failed
        // restore must not mask the install failure that caused it.
        const safeToKeepInstalled = state.phase === 'activating' && error.runtimeRestored === true
        let restoreError: any = null
        if (!safeToKeepInstalled) {
          try { restoreBackup(this.backupDir, this.pkgDir) } catch (rollbackError) { restoreError = rollbackError }
        } else {
          restartRequired = true
        }
        state = {
          ...state,
          phase: safeToKeepInstalled ? 'complete' : restoreError !== null || (state.phase === 'activating' && error.runtimeRestored !== true) ? 'recovery-required' : 'rolled-back',
          diskRestored: safeToKeepInstalled || restoreError === null,
          runtimeRestored: state.phase !== 'activating' || error.runtimeRestored === true,
        }
        if (safeToKeepInstalled) {
          // Activation failed, but the old in-memory generation was restored.
          // The new signed files are verified on disk; require a restart.
        } else if (restoreError !== null) {
          throw new Error(`upgrade failed (${error?.message ?? error}); rollback also failed (${restoreError?.message ?? restoreError})`)
        }
        if (!safeToKeepInstalled) throw new Error(`upgrade failed, previous files restored (${error?.message ?? error})`)
      }
      this.saveUpgradeState({ ...state, phase: 'complete', activated, restartRequired })
      if (restartRequired) restartRequiredVersions.set(this.pkgDir, { version: manifest.version, epoch: this.epoch })
      this.latestContentDrift = false
      try { fs.rmSync(this.stageDir, { recursive: true, force: true }) } catch (error: any) { this.log?.(`our-free-model: staging cleanup failed (${error?.message ?? error})`) }
      const record = { from: previous, to: manifest.version, at: Date.now(), ok: true, files: manifest.files.length, bytes: staged.bytes, backedUp, activated, restartRequired, reused: staged.reused }
      this.recordHistory(record)
      this.checkedAt = Date.now()
      this.log(`our-free-model: upgraded ${previous} -> ${manifest.version} (${manifest.files.length} files)`)
      return activate === undefined ? result : { ...result, activated, restartRequired }
    } catch (error: any) {
      this.error = String(error?.message ?? error)
      if (state !== undefined && installed) {
        try {
          this.saveUpgradeState({ ...state, phase: activated ? 'complete' : state.phase, error: this.error, activated })
        } catch (stateError: any) {
          this.error += `; could not persist upgrade outcome (${stateError?.message ?? stateError})`
        }
      }
      const record = { from: previous, to: targetVersion, at: Date.now(), ok: false, error: this.error }
      this.recordHistory(record)
      throw new Error(this.error)
    } finally {
      this.applying = false
      upgradeLocks.delete(this.pkgDir)
    }
  }
}
