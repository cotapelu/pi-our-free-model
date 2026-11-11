/**
 * The client workbench: launch the user's own coding agents pointed at this
 * machine's gateway.
 *
 * Every launch gets its *own* configuration directory — a native sign-in is
 * never touched, and two clients never share a profile — and the private-write
 * helper is what keeps that directory from being a credential left world
 * readable: mode on the temp inode before the rename, so a permission failure
 * leaves the old file untouched rather than a new one half-protected.
 *
 * `findExecutable` searches PATH only for CLI rows. A desktop row that resolved
 * through PATH would let `codex.exe` masquerade as Codex Desktop, which is a
 * different program with a different account.
 *
 * Ported from dsh's `packages/standalone/workbench.mjs`.
 *
 * @module pi-extension/packages/standalone/workbench.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { launchClientTerminal } from './client-terminal.js'
import { restrictPermissions } from '../../gateway/store.js'

const CLIENTS = [
  { id: 'codex', name: 'Codex CLI', kind: 'cli', command: 'codex' },
  { id: 'claude', name: 'Claude Code', kind: 'cli', command: 'claude' },
  { id: 'gemini', name: 'Gemini CLI', kind: 'cli', command: 'gemini' },
  { id: 'codex-desktop', name: 'Codex Desktop', kind: 'desktop', command: 'Codex' },
  { id: 'cc-switch', name: 'CC Switch', kind: 'desktop', command: 'cc-switch', nativeOnly: true },
  { id: 'codex-plus-plus', name: 'Codex++', kind: 'desktop', command: 'codex-plus-plus', nativeOnly: true },
]
const error = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const regular = (file: string) => { try { return fs.statSync(file).isFile() } catch { return false } }
const directory = (file: string) => { try { return fs.statSync(file).isDirectory() } catch { return false } }
const runFile = promisify(execFile)
let packagedCodex = { at: 0, executable: '' }

function packagedCodexExecutable(env: NodeJS.ProcessEnv): string {
  if (Date.now() - packagedCodex.at < 60_000) return packagedCodex.executable
  let executable = ''
  try {
    const powershell = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const locations = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-AppxPackage -Name 'OpenAI.Codex'; Get-AppxPackage -Name 'OpenAI.ChatGPT-Desktop') | Select-Object -ExpandProperty InstallLocation | ConvertTo-Json -Compress",
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }))
    const roots = Array.isArray(locations) ? locations : [locations]
    executable = roots.filter(root => typeof root === 'string').flatMap(root =>
      ['app/ChatGPT.exe', 'app/Codex.exe', 'ChatGPT.exe', 'Codex.exe'].map(name => path.join(root, name))).find(regular) ?? ''
  } catch { /* Packaged app detection is optional; explicit paths still work. */ }
  packagedCodex = { at: Date.now(), executable }
  return executable
}

export function privateWrite(file: string, value: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
    // Apply the final mode to the temporary inode before replacement. If the
    // permission operation fails, the old file remains untouched. chmodSync is
    // the POSIX path (and the seam the tests inject failures through);
    // restrictPermissions is what makes the promise hold on Windows.
    fs.chmodSync(temporary, 0o600)
    restrictPermissions(temporary)
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch (failure: any) { if (failure.code !== 'ENOENT') throw failure }
  }
}

function findExecutable(client: any, env: NodeJS.ProcessEnv, platform: string, home: string): string {
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const paths = String(env.PATH ?? (env as any).Path ?? '').split(path.delimiter).filter(Boolean)
  // A desktop row must resolve to an application bundle/package. PATH is only
  // searched for CLI rows; otherwise codex.exe can masquerade as Codex Desktop.
  const candidates: string[] = client.kind === 'desktop'
    ? []
    : paths.flatMap(root => suffixes.map(suffix => path.join(root.replace(/^"|"$/g, ''), client.command + suffix)))
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    const programs = path.join(local, 'Programs')
    const root = env.ProgramFiles ?? 'C:\\Program Files'
    if (client.id === 'codex-desktop') {
      candidates.unshift(path.join(programs, 'Codex', 'Codex.exe'), path.join(local, 'Codex', 'Codex.exe'),
        path.join(programs, 'ChatGPT', 'ChatGPT.exe'), path.join(local, 'OpenAI', 'Codex', 'Codex.exe'))
      if (process.platform === 'win32' && env === process.env) candidates.unshift(packagedCodexExecutable(env))
    } else if (client.id === 'cc-switch') {
      candidates.unshift(path.join(programs, 'CC Switch', 'CC Switch.exe'), path.join(programs, 'CC Switch', 'cc-switch.exe'),
        path.join(root, 'CC Switch', 'CC Switch.exe'), path.join(root, 'CC Switch', 'cc-switch.exe'))
    } else if (client.id === 'codex-plus-plus') {
      candidates.unshift(path.join(programs, 'Codex++', 'codex-plus-plus.exe'), path.join(root, 'Codex++', 'codex-plus-plus.exe'))
    }
    if (client.kind === 'cli') candidates.push(path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm', `${client.command}.cmd`))
  } else if (platform === 'darwin' && client.kind === 'desktop') {
    const app = client.id === 'codex-desktop' ? 'Codex' : client.id === 'cc-switch' ? 'CC Switch' : 'Codex++'
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      for (const binary of [app, client.command]) candidates.unshift(path.join(root, `${app}.app`, 'Contents', 'MacOS', binary))
    }
  }
  return candidates.find(regular) ?? ''
}

/** Every API launch gets its own configuration and never edits native sign-ins. */
export function prepareClientLaunch({ client, profileDir, baseUrl, key, env = process.env }: any) {
  const launchEnv: NodeJS.ProcessEnv = { ...env }
  const args: string[] = []
  if (client.mode === 'native' || client.nativeOnly) return { executable: client.executable, args, env: launchEnv, cwd: client.cwd }
  if (!client.model) throw error('请选择要使用的模型')
  const base = new URL(baseUrl)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw error('客户端只能连接本机网关')
  const endpoint = base.origin
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  if (client.id === 'codex' || client.id === 'codex-desktop') {
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) delete launchEnv[name]
    launchEnv.CODEX_HOME = profileDir
    launchEnv.CODEX_SQLITE_HOME = path.join(profileDir, 'sqlite')
    const config = [
      `model = ${JSON.stringify(client.model)}`,
      'model_provider = "eac_router"',
      '',
      '[model_providers.eac_router]',
      'name = "EAC router"',
      `base_url = ${JSON.stringify(`${endpoint}/v1`)}`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      `experimental_bearer_token = ${JSON.stringify(key)}`,
      '',
    ].join('\n')
    privateWrite(path.join(profileDir, 'config.toml'), config)
    privateWrite(path.join(profileDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key }) + '\n')
    if (client.id === 'codex-desktop') args.push(`--user-data-dir=${path.join(profileDir, 'app')}`)
  } else if (client.id === 'claude') {
    for (const name of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'AWS_BEDROCK_REGION',
    ]) delete launchEnv[name]
    Object.assign(launchEnv, {
      CLAUDE_CONFIG_DIR: profileDir, ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: key, ANTHROPIC_MODEL: client.model,
    })
    privateWrite(path.join(profileDir, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: client.model },
    }, null, 2) + '\n')
    const stateFile = path.join(profileDir, '.claude.json')
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
    privateWrite(stateFile, JSON.stringify({ ...state, hasCompletedOnboarding: true }) + '\n')
    args.push('--model', client.model)
  } else if (client.id === 'gemini') {
    for (const name of ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_MODEL']) delete launchEnv[name]
    Object.assign(launchEnv, {
      GEMINI_CLI_HOME: profileDir, GEMINI_API_KEY: key, GOOGLE_GEMINI_BASE_URL: endpoint, GEMINI_MODEL: client.model,
    })
    const geminiSettingsFile = path.join(profileDir, '.gemini', 'settings.json')
    let existingGeminiSettings: any = {}
    if (fs.existsSync(geminiSettingsFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(geminiSettingsFile, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existingGeminiSettings = parsed
      } catch { /* Regenerate only when the managed file is malformed. */ }
    }
    privateWrite(geminiSettingsFile, JSON.stringify({
      ...existingGeminiSettings,
      security: { ...(existingGeminiSettings.security ?? {}), auth: { ...(existingGeminiSettings.security?.auth ?? {}), selectedType: 'gemini-api-key' } },
      model: { ...(existingGeminiSettings.model ?? {}), name: client.model },
      modelConfigs: {
        ...(existingGeminiSettings.modelConfigs ?? {}),
        customAliases: {
          ...(existingGeminiSettings.modelConfigs?.customAliases ?? {}),
          base: { ...(existingGeminiSettings.modelConfigs?.customAliases?.base ?? {}), modelConfig: { generateContentConfig: { temperature: 0 } } },
          'chat-base': { ...(existingGeminiSettings.modelConfigs?.customAliases?.['chat-base'] ?? {}), modelConfig: { generateContentConfig: { temperature: 1, thinkingConfig: { includeThoughts: true } } } },
        },
      },
    }, null, 2) + '\n')
    args.push('--model', client.model)
  }
  return { executable: client.executable, args, env: launchEnv, cwd: client.cwd }
}

export function resolveClientExecutable(plan: any, id: string, { platform = process.platform, nodePath = process.execPath }: { platform?: string; nodePath?: string } = {}) {
  if (platform !== 'win32' || /\.exe$/i.test(plan.executable)) return plan
  const packageName = ({ codex: '@openai/codex', claude: '@anthropic-ai/claude-code', gemini: '@google/gemini-cli' } as Record<string, string>)[id]
  if (!packageName || !/\.(cmd|bat)$/i.test(plan.executable)) throw error('此客户端需要 EXE 或受支持的 npm 启动器')
  const shimDirectory = path.dirname(plan.executable)
  for (const packageRoot of [path.join(shimDirectory, 'node_modules', packageName), path.resolve(shimDirectory, '..', packageName)]) {
    const manifest = path.join(packageRoot, 'package.json')
    if (!regular(manifest)) continue
    let pkg: any
    try { pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) } catch { continue }
    const target = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[id]
    if (typeof target !== 'string' || path.isAbsolute(target)) continue
    const file = path.resolve(packageRoot, target)
    const relative = path.relative(packageRoot, file)
    if (relative.startsWith('..') || path.isAbsolute(relative) || !regular(file)) continue
    const canonical = fs.realpathSync(file)
    const canonicalRoot = fs.realpathSync(packageRoot)
    const resolved = path.relative(canonicalRoot, canonical)
    if (resolved.startsWith('..') || path.isAbsolute(resolved)) continue
    if (/\.exe$/i.test(file)) return { ...plan, executable: file }
    if (/\.(?:js|mjs|cjs)$/i.test(file)) return { ...plan, executable: nodePath, args: [file, ...plan.args] }
  }
  throw error('无法解析 npm 启动器，请选择对应客户端的可执行文件', 409)
}

export function createWorkbench({
  dataDir, info, modelRows, key, home = os.homedir(), env = process.env, platform = process.platform,
  spawnImpl = spawn, terminalLaunch = launchClientTerminal,
}: any) {
  const file = path.join(dataDir, 'workbench.json')
  let settings: Record<string, any> = {}
  if (fs.existsSync(file)) {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('客户端配置文件无效')
  }
  const owned = new Map<string, any>()
  const launching = new Set<string>()
  const history = new Map<string, any>()
  const terminalChecks = new Map<string, NodeJS.Timeout>()
  const launchControllers = new Map<string, AbortController>()
  let disposed = false
  let library: any
  const definition = (id: string) => CLIENTS.find(client => client.id === id)
  const clientFor = (id: string) => {
    const source = definition(id)
    if (!source) throw error('未知客户端')
    const configured = settings[id] ?? {}
    const executable = configured.executable || findExecutable(source, env, platform, home)
    return {
      ...source, executable, installed: Boolean(executable && regular(executable)),
      cwd: configured.cwd ?? home, model: configured.model ?? '',
      mode: source.nativeOnly ? 'native' : configured.mode ?? 'gateway',
      running: owned.has(id), ...history.get(id),
    }
  }
  function clients() { return CLIENTS.map(row => clientFor(row.id)) }
  function validatedPatch(patch: any) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw error('客户端设置无效')
    const previous = clientFor(patch.id)
    if (owned.has(patch.id) || launching.has(patch.id)) throw error('请先关闭此客户端再修改配置', 409)
    const next = { ...settings[patch.id] }
    for (const name of Object.keys(patch)) {
      if (!['id', 'executable', 'cwd', 'model', 'mode'].includes(name)) throw error('不支持的客户端设置')
    }
    for (const field of ['executable', 'cwd', 'model']) {
      if (patch[field] === undefined) continue
      if (typeof patch[field] !== 'string' || patch[field].length > 4096 || /[\0\r\n]/.test(patch[field])) throw error('客户端设置无效')
      next[field] = patch[field].trim()
    }
    if (patch.mode !== undefined) {
      if (!['native', 'gateway'].includes(patch.mode)) throw error('请选择有效的启动模式')
      if (previous.nativeOnly && patch.mode !== 'native') throw error('此管理器使用自身配置启动')
      next.mode = patch.mode
    }
    if (next.executable && (!path.isAbsolute(next.executable) || !regular(next.executable))) throw error('可执行文件不存在，请填写绝对路径')
    if (platform === 'win32' && next.executable && !/\.(exe|cmd|bat)$/i.test(next.executable)) throw error('请选择 EXE 或命令启动器')
    if (next.cwd && (!path.isAbsolute(next.cwd) || !directory(next.cwd))) throw error('工作目录不存在，请填写绝对路径')
    return next
  }
  function saveBatch(patches: any[]) {
    if (!Array.isArray(patches) || patches.length > CLIENTS.length || patches.some(row => !row || typeof row !== 'object')
      || new Set(patches.map(row => row.id)).size !== patches.length) throw error('客户端配置批次无效')
    const updated = { ...settings }
    for (const patch of patches) updated[patch.id] = validatedPatch(patch)
    privateWrite(file, JSON.stringify(updated, null, 2) + '\n')
    settings = updated
    return clients()
  }
  function save(patch: any) {
    saveBatch([patch])
    return clientFor(patch.id)
  }
  async function launch({ id }: { id: string }) {
    if (disposed) throw error('工作台正在停止', 503)
    if (launching.has(id) || owned.has(id)) throw error('客户端已经启动', 409)
    const client = clientFor(id)
    if (!client.installed) throw error('尚未找到客户端，请先安装或设置可执行文件路径', 409)
    if (!directory(client.cwd)) throw error('工作目录不存在', 409)
    if (client.mode === 'gateway') {
      if (info().enabled === false) throw error('本地推理服务已暂停', 409)
      if (!modelRows().some((row: any) => row.id === client.model)) throw error('所选模型当前不可用，请重新选择', 409)
    }
    launching.add(id)
    const launchController = new AbortController()
    launchControllers.set(id, launchController)
    try {
      const plan = prepareClientLaunch({
        client, profileDir: path.join(dataDir, 'clients', id), baseUrl: info().baseUrl, key: key(), env,
      })
      if (library && client.mode === 'gateway' && !client.nativeOnly) {
        const resources = library.materialize({ clientId: id, profileDir: path.join(dataDir, 'clients', id) })
        if (resources.codexConfigFragment) {
          const configFile = path.join(dataDir, 'clients', id, 'config.toml')
          privateWrite(configFile, fs.readFileSync(configFile, 'utf8') + '\n' + resources.codexConfigFragment)
        }
      }
      if (client.kind === 'cli') {
        const handle = await terminalLaunch(resolveClientExecutable(plan, id, { platform }), {
          platform, env, profileDir: path.join(dataDir, 'clients', id), signal: launchController.signal,
        })
        if (disposed) { await handle.dispose(); throw error('工作台正在停止', 503) }
        const ownedTerminal = { terminal: handle, pid: handle.pid }
        owned.set(id, ownedTerminal)
        history.set(id, { lastLaunchedAt: Date.now() })
        let checking = false
        const timer = setInterval(() => {
          if (checking) return
          checking = true
          void handle.isRunning().then((running: boolean) => {
            if (!running && owned.get(id) === ownedTerminal) {
              owned.delete(id)
              clearInterval(timer)
              terminalChecks.delete(id)
            }
          }).catch(() => {}).finally(() => { checking = false })
        }, 1500)
        timer.unref?.()
        terminalChecks.set(id, timer)
        return { ok: true, pid: handle.pid, message: `已启动 ${client.name}` }
      }
      const child = spawnImpl(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env, windowsHide: true, shell: false, stdio: 'ignore' })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      owned.set(id, child)
      history.set(id, { lastLaunchedAt: Date.now() })
      const release = () => { if (owned.get(id) === child) owned.delete(id) }
      child.once('exit', release)
      child.once('error', release)
      child.unref?.()
      return { ok: true, pid: child.pid, message: `已启动 ${client.name}` }
    } catch (failure: any) {
      history.set(id, { error: '启动失败，请检查客户端路径与安装状态' })
      throw failure.statusCode ? failure : error('启动失败，请检查客户端路径与安装状态', 500)
    } finally { launching.delete(id); launchControllers.delete(id) }
  }
  async function stop({ id }: { id: string }) {
    clientFor(id)
    const child = owned.get(id)
    if (!child) throw error('该客户端没有由本工作台启动的进程', 409)
    if (child.terminal) {
      await child.terminal.stop()
      if (owned.get(id) === child) owned.delete(id)
      clearInterval(terminalChecks.get(id))
      terminalChecks.delete(id)
      return { ok: true }
    }
    if (platform === 'win32' && spawnImpl === spawn) {
      const taskkill = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
      try { await runFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, windowsHide: true }) }
      catch { if (owned.get(id) === child) throw error('无法停止客户端，请检查进程状态', 500) }
    } else child.kill()
    return { ok: true }
  }
  return { clients, save, saveBatch, launch, stop, setLibrary(value: any) { library = value }, async dispose() {
    disposed = true
    for (const controller of launchControllers.values()) controller.abort()
    launchControllers.clear()
    for (const timer of terminalChecks.values()) clearInterval(timer)
    terminalChecks.clear()
    const terminals = [...owned.values()].filter(child => child.terminal)
    owned.clear()
    await Promise.all(terminals.map((child: any) => child.terminal.dispose()))
  } }
}
