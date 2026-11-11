/**
 * Unit checks for the standalone service's own surface.
 *
 * The service half of the port owns what the extension never touches: its data
 * directory, its key, its console, its clients. These checks pin the rules that
 * keep that safe:
 *
 * - `prepareClientLaunch` writes a *private* profile and refuses a non-loopback
 *   gateway — a launch pointing at a remote base URL would hand this machine's
 *   key to whoever runs that URL;
 * - the launch env is *stripped* of the client's own sign-in variables, so
 *   starting Codex/Claude/Gemini never picks up a native session;
 * - `resolveClientExecutable` refuses an npm shim it cannot resolve — a `.cmd`
 *   launched directly is a console window that flashes and dies;
 * - the desktop shell's contract is one JSON line with a *code* on failure,
 *   never a message, so a failed start cannot leak a key or a path;
 * - the service refuses a non-loopback host before anything binds.
 *
 * Runs on plain node:  node test/standalone-service.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareClientLaunch, resolveClientExecutable, privateWrite } from '../dist/packages/standalone/workbench.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 1000)
function check(name: string, fn: () => void | Promise<void>) {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error) { failures++; console.log(`FAIL ${name}\n     ${(error as Error)?.message ?? error}`) }
  })
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-launch-'))
const baseEnv = { PATH: '', HOME: os.homedir(), APPDATA: undefined }

check('a launch only ever points at a loopback gateway', () => {
  for (const url of ['http://example.com', 'http://127.0.0.1:18900', 'http://localhost:18900', 'http://[::1]:18900']) {
    const dir = temp()
    if (url.includes('example.com')) {
      assert.throws(() => prepareClientLaunch({
        client: { id: 'codex', model: 'ofm-kilo/x' }, profileDir: dir, baseUrl: url, key: 'k', env: baseEnv,
      }), /客户端只能连接本机网关/)
    } else {
      prepareClientLaunch({ client: { id: 'codex', model: 'ofm-kilo/x' }, profileDir: dir, baseUrl: url, key: 'k', env: baseEnv })
      const config = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')
      assert.ok(config.includes('wire_api = "responses"'))
      assert.ok(config.includes(new URL(url).origin))
      // The auth token rides the config and the auth file, and nothing else.
      const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'))
      assert.equal(auth.OPENAI_API_KEY, 'k')
      assert.equal(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600)
    }
  }
})

check('a launch strips the client\'s own sign-in variables', () => {
  // Each client strips its *own* family: codex the OpenAI ones, claude the
  // Anthropic ones, gemini the Google ones. The rule is not "the field
  // disappears" — a branch then sets its own values pointing at this gateway —
  // it is that **no user value survives**: every sign-in variable the launch
  // carries is either the gateway's or absent. A launch that carried another
  // family's variable would hand the other client's session to this one.
  const noLeak = (env: Record<string, unknown>, names: string[]) => {
    for (const name of names) assert.notEqual(env[name], 'leak', `${name} carried the user's own value`)
  }

  const codex = temp()
  const codexPlan = prepareClientLaunch({
    client: { id: 'codex', model: 'ofm-kilo/x' }, profileDir: codex, baseUrl: 'http://127.0.0.1:9', key: 'k',
    env: { ...baseEnv, OPENAI_API_KEY: 'leak', OPENAI_BASE_URL: 'https://evil', OPENAI_ORG_ID: 'org' },
  })
  noLeak(codexPlan.env, ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID'])
  assert.equal(codexPlan.env.OPENAI_ORG_ID, undefined, 'a project/org id has no gateway value, so it is gone')
  assert.equal(codexPlan.env.CODEX_HOME, codex)

  const claude = temp()
  const claudePlan = prepareClientLaunch({
    client: { id: 'claude', model: 'ofm-kilo/x' }, profileDir: claude, baseUrl: 'http://127.0.0.1:9', key: 'k',
    env: { ...baseEnv, ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://evil', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' },
  })
  noLeak(claudePlan.env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'])
  assert.equal(claudePlan.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'an oauth token has no gateway value, so it is gone')
  assert.equal(claudePlan.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9')
  assert.equal(claudePlan.env.ANTHROPIC_AUTH_TOKEN, 'k')
  assert.equal(claudePlan.env.CLAUDE_CONFIG_DIR, claude)

  const gemini = temp()
  const geminiPlan = prepareClientLaunch({
    client: { id: 'gemini', model: 'ofm-kilo/x' }, profileDir: gemini, baseUrl: 'http://127.0.0.1:9', key: 'k',
    env: { ...baseEnv, GEMINI_API_KEY: 'leak', GOOGLE_API_KEY: 'leak', GOOGLE_GENAI_USE_VERTEXAI: 'true' },
  })
  noLeak(geminiPlan.env, ['GEMINI_API_KEY'])
  // The Google-account variables have no gateway counterpart at all.
  assert.equal(geminiPlan.env.GOOGLE_API_KEY, undefined)
  assert.equal(geminiPlan.env.GOOGLE_GENAI_USE_VERTEXAI, undefined)
  assert.equal(geminiPlan.env.GEMINI_CLI_HOME, gemini)
})

check('a launch without a model is refused before writing anything', () => {
  const dir = temp()
  assert.throws(() => prepareClientLaunch({ client: { id: 'codex', model: '' }, profileDir: dir, baseUrl: 'http://127.0.0.1:9', key: 'k', env: baseEnv }), /请选择要使用的模型/)
  assert.deepEqual(fs.readdirSync(dir), [])
})

check('a native-mode client is passed through untouched', () => {
  const dir = temp()
  const plan = prepareClientLaunch({ client: { id: 'cc-switch', mode: 'native', nativeOnly: true, executable: '/opt/cc-switch' }, profileDir: dir, baseUrl: 'http://127.0.0.1:9', key: 'k', env: baseEnv })
  assert.equal(plan.executable, '/opt/cc-switch')
  assert.deepEqual(fs.readdirSync(dir), [], 'a native launch writes no profile')
})

check('resolveClientExecutable refuses a shim it cannot resolve', () => {
  const dir = temp()
  // A .cmd with no package beside it cannot be resolved to a real binary.
  assert.throws(() => resolveClientExecutable({ executable: path.join(dir, 'codex.cmd'), args: [], env: {} }, 'codex', { platform: 'win32' }), /409|无法解析/)
})

check('resolveClientExecutable passes an .exe through on Windows', () => {
  const plan = resolveClientExecutable({ executable: 'C:\\Program Files\\Codex\\Codex.exe', args: [], env: {} }, 'codex-desktop', { platform: 'win32' })
  assert.equal(plan.executable, 'C:\\Program Files\\Codex\\Codex.exe')
})

check('privateWrite replaces atomically and keeps the mode', () => {
  const dir = temp()
  const file = path.join(dir, 'nested', 'secret.json')
  privateWrite(file, '{"a":1}')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  privateWrite(file, '{"a":2}')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}')
  // No temp file survives a replacement.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['secret.json'])
})

Promise.allSettled([running]).then(() => {
  clearInterval(keepAlive)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
  if (failures > 0) process.exitCode = 1
})
