/**
 * The desktop shell's in-app updater: download this repository's own signed
 * installer, then hand it to the native window.
 *
 * Everything a downloaded file could get wrong is defended at the seam rather
 * than after the fact:
 * - the release list, the installer and the checksums file may only come from
 *   GitHub's official hosts, and the installer/sums URLs must match the exact
 *   paths of the selected release (a renamed asset on the same host is refused);
 * - the installer is streamed to a `.part` file, size-checked against the
 *   release record while it arrives, and its SHA-256 verified before rename —
 *   a partial or swapped file never becomes `ready.json`;
 * - only a strictly newer semver is offered, so a rollback tag cannot appear.
 *
 * `platform`/`arch` are parameters, not `process`: the Windows-only flow has to
 * be exercisable on a CI runner that is neither.
 *
 * Ported from dsh's `packages/standalone/desktop-update.mjs`.
 *
 * @module pi-extension/packages/standalone/desktop-update.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'

const REPO = 'Ebony-Vinyl/dsh-our-free-model'
const MAX_INSTALLER = 256 * 1024 * 1024
const allowedHosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const versionParts = (value: unknown) => (/^\d+\.\d+\.\d+$/.test(String(value ?? '')) ? String(value).split('.').map(Number) : null)
export function newerVersion(left: unknown, right: unknown): boolean {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}
function officialURL(value: string, asset = false): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHosts.has(url.hostname)) throw fail('更新地址不属于官方发布源')
  if (asset && (url.hostname !== 'github.com' || !url.pathname.startsWith(`/${REPO}/releases/download/`))) throw fail('安装包地址不属于本项目')
  return url.href
}
interface DesktopRelease {
  version: string
  name: string
  size: number
  installerURL: string
  sumsURL: string
  releaseURL: string
  notes: string
  publishedAt: string | null
}
export function selectDesktopRelease(releases: any[], arch = 'x64'): DesktopRelease | null {
  let selected: DesktopRelease | null = null
  for (const release of releases) {
    if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '')) continue
    const version = release.tag_name.slice(1)
    const name = `Our.Free.Model_${version}_${arch}-setup.exe`
    const installer = release.assets?.find((asset: any) => asset.name === name)
    const sums = release.assets?.find((asset: any) => asset.name === 'SHA256SUMS')
    if (!installer || !sums || !Number.isInteger(installer.size) || installer.size <= 0 || installer.size > MAX_INSTALLER) continue
    officialURL(installer.browser_download_url, true); officialURL(sums.browser_download_url, true)
    const prefix = `https://github.com/${REPO}/releases/download/${release.tag_name}/`
    if (installer.browser_download_url !== prefix + name || sums.browser_download_url !== prefix + 'SHA256SUMS') continue
    if (!selected || newerVersion(version, selected.version)) selected = { version, name, size: installer.size,
      installerURL: installer.browser_download_url, sumsURL: sums.browser_download_url,
      releaseURL: `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
      notes: String(release.body ?? '').slice(0, 32768), publishedAt: release.published_at ?? null }
  }
  return selected
}
export function installerChecksum(text: string, name: string): string {
  const values = text.split(/\r?\n/).map(line => /^([a-f\d]{64})[ \t]+\*?([^\r\n]+)$/i.exec(line))
    .filter((row): row is RegExpExecArray => row !== null && row[2] === name).map(row => row[1].toLowerCase())
  if (values.length !== 1) throw fail('官方校验文件中缺少唯一的安装包 SHA-256')
  return values[0]
}

export function createDesktopUpdater({
  dataDir, version, platform = process.platform, arch = process.arch, fetchImpl = fetch,
}: {
  dataDir: string
  version: string | undefined
  platform?: string
  arch?: string
  fetchImpl?: typeof fetch
}) {
  const supported = platform === 'win32' && arch === 'x64' && versionParts(version) !== null && typeof dataDir === 'string' && path.isAbsolute(dataDir)
  const directory = path.join(dataDir ?? '.', 'desktop-updates')
  let snapshot: any = { currentVersion: version ?? '', supported, phase: 'idle', latest: null, available: false,
    checkedAt: null, received: 0, total: 0, error: '' }
  try {
    const file = path.join(directory, 'last-install.json')
    const stat = fs.lstatSync(file)
    if (stat.isFile() && stat.size < 16384) {
      const result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (result.ok === false) snapshot = { ...snapshot, phase: 'error', error: '上次更新安装未完成，请重新检查更新。' }
    }
  } catch { /* 没有安装记录或记录不完整时，仍允许检查更新。 */ }
  let candidate: DesktopRelease | null = null
  let active: Promise<void> | null = null
  let controller: AbortController | null = null
  let closed = false
  const status = () => structuredClone(snapshot)
  const request = async (value: string): Promise<Response> => {
    let url = officialURL(value)
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.any([(controller as AbortController).signal, AbortSignal.timeout(30000)]),
        headers: { accept: url.includes('api.github.com') ? 'application/vnd.github+json' : 'application/octet-stream', 'user-agent': 'Our-Free-Model-Desktop-Updater' },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location'); await response.body?.cancel().catch(() => {})
        if (!next) throw fail('更新源返回了无效跳转')
        url = officialURL(new URL(next, url).href); continue
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail(response.status === 403 || response.status === 429 ? '官方更新源暂时限流，请稍后检查' : `更新源请求失败（HTTP ${response.status}）`) }
      return response
    }
    throw fail('更新源跳转次数过多')
  }
  const text = async (url: string, limit: number): Promise<string> => {
    const response = await request(url)
    let bytes = 0; const chunks: Uint8Array[] = []
    try {
      for await (const chunk of response.body as any) { bytes += chunk.length; if (bytes > limit) throw fail('更新信息超过大小限制'); chunks.push(chunk) }
      return Buffer.concat(chunks).toString('utf8')
    } catch (error) { await (response.body as any)?.cancel().catch(() => {}); throw error }
  }
  const begin = (phase: string, run: () => Promise<void>) => {
    if (closed) throw fail('更新管理已关闭', 503)
    if (!supported) throw fail('当前仅支持 Windows x64 桌面客户端更新')
    if (active) throw fail('已有更新操作正在进行', 409)
    controller = new AbortController()
    snapshot = { ...snapshot, phase, error: '' }
    active = Promise.resolve().then(run).catch((error: any) => {
      snapshot = { ...snapshot, phase: 'error', error: error?.name === 'AbortError' ? '更新操作已停止'
        : error?.name === 'TimeoutError' ? '更新源响应超时，请稍后重试'
          : error instanceof SyntaxError ? '官方更新信息格式无效，请稍后重试'
            : error?.code ? '无法写入更新缓存，请检查磁盘空间与目录权限'
              : error?.message === 'fetch failed' ? '无法连接官方更新源，请稍后重试' : String(error?.message ?? '更新失败') }
    }).finally(() => { active = null })
    return status()
  }
  const verifyFile = async (file: string, size: number, digest: string): Promise<boolean> => {
    try {
      const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size !== size) return false
      const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk as never)
      return hash.digest('hex') === digest
    } catch (error: any) { if (error.code === 'ENOENT') return false; throw error }
  }
  return {
    status,
    check() { return begin('checking', async () => {
      await unlink(path.join(directory, 'ready.json')).catch((error: any) => { if (error.code !== 'ENOENT') throw error })
      await unlink(path.join(directory, 'last-install.json')).catch((error: any) => { if (error.code !== 'ENOENT') throw error })
      const releases: any[] = []
      for (let page = 1; page <= 5; page++) {
        const rows = JSON.parse(await text(`https://api.github.com/repos/${REPO}/releases?per_page=20&page=${page}`, 2 * 1024 * 1024))
        if (!Array.isArray(rows)) throw fail('官方发布列表格式无效')
        releases.push(...rows); if (rows.length < 20) break
      }
      candidate = selectDesktopRelease(releases, arch)
      snapshot = { ...snapshot, phase: 'idle', latest: candidate ? { version: candidate.version, notes: candidate.notes, publishedAt: candidate.publishedAt, releaseURL: candidate.releaseURL, size: candidate.size } : null,
        checkedAt: Date.now(), available: !!candidate && newerVersion(candidate.version, version), received: 0, total: 0 }
    }) },
    download() {
      if (!candidate || !newerVersion(candidate.version, version)) throw fail('请先检查并找到可更新的桌面版本')
      const selected = candidate
      return begin('downloading', async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await unlink(path.join(directory, 'ready.json')).catch((error: any) => { if (error.code !== 'ENOENT') throw error })
        const checksum = installerChecksum(await text(selected.sumsURL, 128 * 1024), selected.name)
        const target = path.join(directory, `installer-${checksum}.exe`)
        snapshot = { ...snapshot, received: 0, total: selected.size }
        if (!await verifyFile(target, selected.size, checksum)) {
          const partial = `${target}.${crypto.randomUUID()}.part`
          let handle: any
          try {
            handle = await open(partial, 'wx', 0o600)
            const response = await request(selected.installerURL)
            const declared = response.headers.get('content-length')
            if (declared !== null && Number(declared) !== selected.size) { await response.body?.cancel().catch(() => {}); throw fail('安装包大小与官方发布记录不一致') }
            let size = 0; const digest = crypto.createHash('sha256')
            for await (const chunk of response.body as any) {
              size += chunk.length
              if (size > selected.size || size > MAX_INSTALLER) throw fail('安装包超过预期大小')
              await handle.writeFile(chunk); digest.update(chunk)
              snapshot = { ...snapshot, received: size }
            }
            if (size !== selected.size || digest.digest('hex') !== checksum) throw fail('安装包 SHA-256 校验失败，当前应用未被修改')
            await handle.sync(); await handle.close(); handle = null
            await rename(partial, target)
          } finally { await handle?.close().catch(() => {}); await unlink(partial).catch((error: any) => { if (error.code !== 'ENOENT') throw error }) }
        }
        const ready = { schemaVersion: 1, version: selected.version, size: selected.size, sha256: checksum }
        const receipt = path.join(directory, `ready-${crypto.randomUUID()}.tmp`)
        const file = await open(receipt, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(ready)); await file.sync() } finally { await file.close() }
        try { await rename(receipt, path.join(directory, 'ready.json')) }
        finally { await unlink(receipt).catch((error: any) => { if (error.code !== 'ENOENT') throw error }) }
        snapshot = { ...snapshot, phase: 'ready', received: selected.size, total: selected.size }
      })
    },
    async settled() { await active; return status() },
    close() { closed = true; controller?.abort() },
  }
}
