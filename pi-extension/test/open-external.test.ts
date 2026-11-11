/**
 * Unit checks for what the console may open in the user's browser.
 *
 * The port has two halves of this, and the suite pins both: `open-external.ts`
 * (the URL rules the extension shares) and the standalone's
 * `packages/standalone/open-external.ts` (the launcher with its platform
 * commands injected, so a test never spawns a browser).
 *
 * What matters is the refusal set: a URL is only opened when it is a plain
 * http(s) URL with no credentials in it, and the length cap holds *after*
 * normalization — a URL that normalizes longer than the cap was not made safe
 * by being written short.
 *
 * Runs on plain node:  node test/open-external.test.ts
 */
import assert from 'node:assert/strict'
import { externalUrl, MAX_EXTERNAL_URL_LENGTH } from '../dist/open-external.js'
import { openExternal as launchExternal } from '../dist/packages/standalone/open-external.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 1000)
function check(name: string, fn: () => void | Promise<void>) {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error) { failures++; console.log(`FAIL ${name}\n     ${(error as Error)?.message ?? error}`) }
  })
}

check('a plain http(s) URL is accepted, and the rules are the same in both halves', async () => {
  const url = 'https://example.com/authorize?client_id=fixture&state=abc'
  assert.equal(externalUrl(url), url)
  // The standalone's launcher refuses before any command is built.
  let launched = false
  const ok = await launchExternal(url, { platform: 'linux', exec: async () => { launched = true; return { stdout: '', stderr: '' } } })
  assert.equal(ok, true)
  assert.equal(launched, true)
})

check('a URL that is not http(s), or carries credentials, is refused', async () => {
  // Two different jobs, two different halves. `externalUrl` owns everything
  // that does not parse; the launcher owns the URLs that *do* parse but are not
  // openable — a `file:` link, credentials in the URL. (dsh's launcher builds
  // `new URL(value)` unguarded too: its caller is the console, which hands it a
  // URL it constructed.)
  const unopenable = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
  ]
  for (const bad of unopenable) {
    assert.equal(externalUrl(bad), null, `${bad} was accepted by the URL rule`)
    let launched = false
    const ok = await launchExternal(bad, { platform: 'linux', exec: async () => { launched = true; return { stdout: '', stderr: '' } } })
    assert.equal(ok, false, `${bad} was launched`)
    assert.equal(launched, false, `${bad} reached the command layer`)
  }
  // Garbage is refused by the rule, and never reaches a command.
  assert.equal(externalUrl('not a url'), null)
  assert.equal(externalUrl(`https://example.invalid/${'a'.repeat(4000)}`), null)
})

check('the length cap holds after normalization', () => {
  const prefix = 'https://example.invalid/'
  const atLimit = prefix + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH - prefix.length)
  assert.equal(externalUrl(atLimit), atLimit)
  assert.equal(externalUrl(`${atLimit}a`), null)
  // A percent-encoded host normalizes to something longer than what was written.
  assert.equal(externalUrl(prefix + '%C3%A9'.repeat(400)), null, 'normalization bypassed the cap')
})

check('the Windows launch hides its window and never builds a shell command line', async () => {
  let call: any[] = []
  const url = "https://example.com/a?state=a'b"
  await launchExternal(url, { platform: 'win32', systemRoot: 'C:\\Windows', exec: async (...args: any[]) => { call = args; return { stdout: '', stderr: '' } } })
  assert.match(call[0], /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
  assert.deepEqual(call[1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  // The command is a base64 utf16le payload, not an argument string: a quote in
  // the URL cannot end the parameter early.
  // The URL is normalized first (`new URL` percent-encodes the quote), and the
  // quoting doubles whatever apostrophes survive that.
  const normalized = new URL(url).href
  const script = Buffer.from(call[1][3], 'base64').toString('utf16le')
  assert.equal(script, `Start-Process -FilePath '${normalized.replaceAll("'", "''")}' -ErrorAction Stop`)
  assert.equal(call[2].windowsHide, true)
  assert.ok(call[2].timeout > 0)
})

check('darwin and linux use their own opener, and a failure is a false', async () => {
  for (const [platform, command] of [['darwin', '/usr/bin/open'], ['linux', 'xdg-open']]) {
    let call: any[] = []
    await launchExternal('https://example.com/x', { platform, exec: async (...args: any[]) => { call = args; return { stdout: '', stderr: '' } } })
    assert.equal(call[0], command)
    assert.deepEqual(call[1], ['https://example.com/x'])
  }
  const ok = await launchExternal('https://example.com/x', { platform: 'linux', exec: async () => { throw new Error('no display') } })
  assert.equal(ok, false, 'a failed launch reported success')
})

Promise.allSettled([running]).then(() => {
  clearInterval(keepAlive)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
  if (failures > 0) process.exitCode = 1
})
