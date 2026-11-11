/**
 * Stage the built service into the desktop shell's resource directory, and
 * fetch the Node license the installer has to ship beside it.
 *
 * Two halves with one rule between them: the Rust shell decides *where* files
 * live, and this script decides *which* files go there. The shell's paths are
 * constants of the compiled binary (`lib.rs` spawns
 * `resources/service/packages/desktop/service-host.mjs` and embeds
 * `ui/titlebar.js` with `include_str!`), so the staged tree mirrors the
 * package's own layout and renames nothing: a `.js` in `dist/` is staged as the
 * `.mjs` the shell and the service file itself expect, because the shell's
 * spawn command spells it that way and Node treats the two identically under
 * `"type": "module"`.
 *
 * Staging is explicitly allowed to run without an engine binary (a workspace
 * build without one still stages a service that runs, minus the model
 * workspace); *packaging* an installer is not — a shipped installer whose
 * workspace can never start is a broken product, so `prepareDesktop` requires
 * it.
 *
 * Ported from dsh's `scripts/prepare-desktop.mjs`.
 *
 * @module pi-extension/scripts/prepare-desktop.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '../../..')
export const resourceDirectory = path.join(repositoryRoot, 'packages/desktop/src-tauri/resources')

/** `dist/`, the compiled tree everything else here is staged out of. */
const dist = path.join(repositoryRoot, 'pi-extension', 'dist')

/**
 * Walk the compiled import graph from the service's entry and return every
 * module it reaches, as paths relative to `dist/`.
 *
 * A hand-written list of "the files the service needs" is wrong the moment a
 * module gains an import — and wrong in the direction that ships broken: the
 * staged tree starts, then fails on the first missing module in a user's face.
 * The graph walk is the same discipline the audit used to prove the service is
 * self-contained: read what the entry actually loads, not what it used to.
 */
function serviceGraph(entry) {
  const seen = new Set()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let text
    try { text = fs.readFileSync(path.join(dist, file), 'utf8') } catch { continue }
    for (const match of text.matchAll(/from ['"]([^'"]+)['"]/g)) {
      const spec = match[1]
      if (!spec.startsWith('.')) continue
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
      let resolved = path.posix.normalize(dir === '' ? spec : `${dir}/${spec}`)
      if (!/\.(js|mjs|json)$/.test(resolved)) resolved += '.js'
      pending.push(resolved)
    }
  }
  return [...seen].sort()
}

/** 明确选择应用资源，排除用户目录、工具索引、依赖及构建缓存。 */
export function stageDesktopService(destination, { requireWorkspace = false } = {}) {
  if (!fs.existsSync(dist)) throw new Error('dist/ chưa build; chạy npm --prefix pi-extension run build trước')
  // `from` is either a path relative to dist/ or an absolute one (the vendor
  // trees the staging reads straight from the source checkout).
  const stage = (from, to) => {
    const source = path.isAbsolute(from) ? from : path.join(dist, from)
    if (!fs.lstatSync(source).isFile()) throw new Error(`不是普通资源文件：${from}`)
    const output = path.join(destination, to)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.copyFileSync(source, output)
  }
  const tree = (relative, allowed) => {
    for (const entry of fs.readdirSync(path.join(dist, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) tree(child, allowed)
      else if (entry.isFile() && allowed(child)) stage(child, child)
    }
  }
  // The staged tree keeps the compiled `.js` names: the import graph between the
  // modules spells them, and Node resolves only those. The Rust shell's spawn
  // path is the one exception — it literally spells `service-host.mjs`, so that
  // file gets a second copy under the name the shell knows.
  // The channels worker is a second entry: the runtime spawns it by *path*
  // (`new URL('./worker.js', import.meta.url)`), which no `from` clause names,
  // so the graph walk alone never reaches it — and the module it pulls in
  // (`contracts.js`, the generated `business.mjs`'s own target) with it.
  for (const entry of ['packages/desktop/service-host.js', 'packages/standalone/channels/worker.js']) {
    for (const file of serviceGraph(entry)) stage(file, file)
  }
  fs.copyFileSync(path.join(destination, 'packages/desktop/service-host.js'),
    path.join(destination, 'packages/desktop/service-host.mjs'))
  // Assets read with `node:fs` from beside the module that reads them: no import
  // statement names them, so the graph walk cannot see them. They are the same
  // list `scripts/copy-registry.mjs` carries into dist — an omission here is an
  // import-time ENOENT in a clean build, not a runtime error.
  stage('providers/registry.json', 'providers/registry.json')
  stage('packages/standalone/package.json', 'packages/standalone/package.json')
  tree('packages/standalone/channels', file => file.endsWith('.mjs'))
  const web = 'packages/standalone/web'
  const assets = JSON.parse(fs.readFileSync(path.join(dist, web, 'assets.json'), 'utf8'))
  if (!Array.isArray(assets) || assets.length === 0
    || assets.some(name => typeof name !== 'string' || !/^[\w-]+\.(js|css)$/.test(name))
    || new Set(assets).size !== assets.length) {
    throw new Error('桌面端资源清单无效')
  }
  for (const name of ['index.html', 'splash.html', 'assets.json', ...assets]) stage(`${web}/${name}`, `${web}/${name}`)
  const engines = fs.existsSync(path.join(dist, 'vendor/magpie/engine.json'))
    ? path.join(dist, 'vendor/magpie')
    : path.join(repositoryRoot, 'vendor/magpie')
  const pack = fs.existsSync(path.join(dist, 'vendor/channel-pack/qoder-auth-wasm.wasm'))
    ? path.join(dist, 'vendor/channel-pack')
    : path.join(repositoryRoot, 'vendor/channel-pack')
  for (const name of ['qoder-auth-wasm.wasm', 'LICENSE', 'NOTICE.md']) {
    if (fs.existsSync(path.join(pack, name))) stage(path.join(pack, name), `vendor/channel-pack/${name}`)
  }
  if (fs.existsSync(path.join(pack, 'locale'))) {
    const locales = fs.readdirSync(path.join(pack, 'locale')).filter(name => name.endsWith('.json'))
    for (const name of locales) {
      const output = path.join(destination, 'vendor/channel-pack/locale', name)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.copyFileSync(path.join(pack, 'locale', name), output)
    }
  }
  // The model workspace runs the same pinned engine the extension ships, so the
  // desktop build carries that binary and its manifest.
  for (const name of ['engine.json', 'LICENSE', 'NOTICE.md']) {
    const source = path.join(engines, name)
    if (fs.existsSync(source)) stage(source, `vendor/magpie/${name}`)
  }
  const target = `${process.platform}-${process.arch}`
  const binaries = JSON.parse(fs.readFileSync(path.join(engines, 'engine.json'), 'utf8')).binaries ?? {}
  const binary = binaries[target]
  if (binary && typeof binary.path === 'string' && fs.existsSync(path.join(engines, binary.path))) {
    stage(path.join(engines, binary.path), `vendor/magpie/${binary.path}`)
  } else if (requireWorkspace) {
    throw new Error(`模型工作台需要 ${target} 的引擎二进制；先 chạy scripts/build-magpie-engine.mjs (G11)`)
  } else {
    console.log(`提示：${target} 没有引擎二进制，本次只生成不含模型工作台的服务资源`)
  }
  fs.copyFileSync(path.join(repositoryRoot, 'icon.svg'), path.join(destination, 'icon.svg'))
  fs.copyFileSync(path.join(repositoryRoot, 'LICENSE'), path.join(destination, 'LICENSE'))
  const notices = path.join(repositoryRoot, 'pi-extension/scripts/standalone-third-party.txt')
  if (fs.existsSync(notices)) fs.copyFileSync(notices, path.join(destination, 'THIRD_PARTY_NOTICES.txt'))
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
}

export async function prepareDesktop({ nodeExecutable = process.execPath, nodeLicense = process.env.OFM_DESKTOP_NODE_LICENSE } = {}) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('当前桌面安装包只支持 Windows 与 macOS')
  const cleanEnv = { ...process.env }
  delete cleanEnv.NODE_OPTIONS
  delete cleanEnv.NODE_PATH
  const runtime = JSON.parse(execFileSync(nodeExecutable, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { env: cleanEnv, encoding: 'utf8', timeout: 10000 }))
  const [major, minor] = runtime.version.slice(1).split('.').map(Number)
  if ((runtime.platform !== 'win32' && runtime.platform !== 'darwin') || runtime.arch !== process.arch || !(major === 22 && minor >= 19 || major >= 24)) {
    throw new Error('Node 运行时必须匹配本机架构，且为 22.19+ 或 24+')
  }
  const cache = path.join(repositoryRoot, 'packages/desktop/src-tauri/.node-license-cache', `${runtime.version}.txt`)
  let license
  if (nodeLicense) license = fs.readFileSync(nodeLicense)
  else if (fs.existsSync(cache)) license = fs.readFileSync(cache)
  else {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${runtime.version}/LICENSE`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error('无法取得 Node 完整许可证，请设置 OFM_DESKTOP_NODE_LICENSE')
    license = Buffer.from(await response.arrayBuffer())
  }
  if (!license.toString().startsWith('Node.js is licensed for use as follows:') || license.length < 20000) {
    throw new Error('必须提供此 Node 版本包含第三方声明的完整 LICENSE')
  }
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  fs.writeFileSync(cache, license)
  // 只清理固定生成目录，绝不触及用户数据目录。
  fs.rmSync(resourceDirectory, { recursive: true, force: true })
  // Packaging an installer: the workspace has to work, so the engine is required.
  stageDesktopService(path.join(resourceDirectory, 'service'), { requireWorkspace: true })
  fs.mkdirSync(path.join(resourceDirectory, 'runtime'), { recursive: true })
  fs.copyFileSync(nodeExecutable, path.join(resourceDirectory, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))
  fs.writeFileSync(path.join(resourceDirectory, 'runtime/LICENSE'), license)
  fs.writeFileSync(path.join(resourceDirectory, 'runtime/version.json'), JSON.stringify(runtime) + '\n')
  console.log(`桌面资源已生成：完整独立服务及 Node ${runtime.version} ${runtime.arch}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await prepareDesktop() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
