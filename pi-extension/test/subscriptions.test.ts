/**
 * Unit checks for the private subscription store.
 *
 * A subscription is the user's own account credential for a channel, and the
 * store's one job is to keep it private and durable:
 *
 *   1. **0600, written atomically** — a crash mid-write must never leave a
 *      half-token, and an account credential must not be world-readable;
 *   2. **a damaged or absent file reads as `null`**, never a throw and never a
 *      half-parsed record;
 *   3. **validation is total on the way in** — a stored subscription is user
 *      input that survived a JSON file, so every field is treated as untrusted.
 *
 * Every check runs against a throwaway `OFM_DATA_DIR`, so no check ever touches
 * the real home.
 *
 * Runs on plain node:  node test/subscriptions.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ENDPOINTS, GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET, MAX_BYTES, NATIVE, PROVIDERS,
  listSubscriptions, readSubscription, removeSubscription, subscriptionPath, writeSubscription,
} from '../dist/subscriptions.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

let counter = 0
function scratchDir(): string {
  const dir = path.join(os.tmpdir(), `ofm-subs-${process.pid}-${Date.now()}-${counter++}`)
  fs.mkdirSync(dir, { recursive: true })
  process.env.OFM_DATA_DIR = dir
  return dir
}

// ── the registry constants ──────────────────────────────────────────────────
check('the registry names the providers and formats the lane can drive', () => {
  assert.deepEqual(PROVIDERS, ['codex', 'claude', 'gemini', 'api'])
  // `api` is the OpenAI-shaped catch-all; the other three are native accounts.
  assert.equal(NATIVE.codex.length, 2)
  assert.equal(NATIVE.claude.length, 2)
  assert.equal(NATIVE.gemini.length, 2)
  assert.equal(NATIVE.api, undefined)
})

check('every declared endpoint is an https URL or a bare path suffix', () => {
  for (const [name, url] of Object.entries(ENDPOINTS)) {
    assert.match(String(url), /^(https:\/\/[^\s]+|\/[^\s]*)$/, `endpoint ${name} is not a URL: ${url}`)
  }
})

check('the Gemini client id is published, its secret is an installed-app one', () => {
  // Not a user secret: the Gemini CLI publishes both for installed apps.
  assert.match(GEMINI_CLIENT_ID, /\.apps\.googleusercontent\.com$/)
  assert.match(GEMINI_CLIENT_SECRET, /^GOCSPX-/)
})

check('the body ceiling is the one the readers enforce', () => {
  assert.equal(MAX_BYTES, 4 * 1024 * 1024)
})

// ── the store ───────────────────────────────────────────────────────────────
check('the file lands under the plugin data dir with its own name', () => {
  const dir = scratchDir()
  assert.equal(subscriptionPath('codex-main'), path.join(dir, 'subscriptions', 'codex-main'))
})

check('an absent subscription reads as null', () => {
  scratchDir()
  assert.equal(readSubscription('never-existed'), null)
})

check('a written subscription reads back verbatim', () => {
  scratchDir()
  const record = { id: 'codex-main', provider: 'codex', models: ['gpt-5'], enabled: true }
  assert.equal(writeSubscription('codex-main', record), true)
  const read = readSubscription('codex-main')
  assert.deepEqual(read, record)
})

check('the file lands 0600 — an account credential must not be world-readable', () => {
  scratchDir()
  writeSubscription('claude-main', { id: 'claude-main', provider: 'claude' })
  const mode = fs.statSync(subscriptionPath('claude-main')).mode & 0o777
  if (process.platform === 'win32') {
    assert.ok(fs.statSync(subscriptionPath('claude-main')).isFile())
  } else {
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
  }
})

check('a truncated document reads as null and the file is kept', () => {
  scratchDir()
  fs.mkdirSync(path.dirname(subscriptionPath('cut')), { recursive: true })
  fs.writeFileSync(subscriptionPath('cut'), '{"id":"cut","provider"')
  assert.equal(readSubscription('cut'), null, 'a truncated document was parsed')
  assert.ok(fs.existsSync(subscriptionPath('cut')), 'the damaged file was rewritten over')
})

check('a document that is not an object reads as null', () => {
  scratchDir()
  for (const raw of ['"a string"', '[1,2,3]', '42', 'null']) {
    fs.mkdirSync(path.dirname(subscriptionPath('bad')), { recursive: true })
    fs.writeFileSync(subscriptionPath('bad'), raw)
    assert.equal(readSubscription('bad'), null, `${raw} was parsed as a record`)
  }
})

check('a directory in the place of the file reads as null, not a throw', () => {
  scratchDir()
  fs.mkdirSync(subscriptionPath('a-directory'), { recursive: true })
  assert.equal(readSubscription('a-directory'), null)
})

check('a non-object record is refused on the way in', () => {
  scratchDir()
  assert.equal(writeSubscription('bad', 'not an object' as any), false)
  assert.equal(writeSubscription('bad', null as any), false)
  assert.equal(writeSubscription('bad', [1, 2] as any), false)
  assert.equal(readSubscription('bad'), null)
})

check('a name that would escape the store is refused, not written outside it', () => {
  scratchDir()
  const store = path.dirname(subscriptionPath('x'))
  // A separator or a dot-segment resolves outside the store, so every entry
  // point refuses it rather than trusting the caller to have sanitised it.
  for (const name of ['../escaped', '../../escaped', '/etc/cron.d/x', 'a/b', '.', '..', '-', '']) {
    assert.equal(writeSubscription(name, { id: 'x' }), false, `"${name}" was accepted`)
    assert.equal(readSubscription(name), null, `"${name}" was read`)
    assert.equal(removeSubscription(name), false, `"${name}" was removed`)
  }
  // Nothing landed outside the store's own directory.
  const inside = fs.readdirSync(path.dirname(store))
  assert.deepEqual(inside.filter(entry => entry !== 'subscriptions'), [])
})

check('a plain filename still lands inside the store', () => {
  scratchDir()
  assert.equal(writeSubscription('codex-main', { id: 'codex-main' }), true)
  assert.ok(readSubscription('codex-main') !== null)
  assert.deepEqual(listSubscriptions(), ['codex-main'])
})

check('a subsequent write replaces the record entirely', () => {
  scratchDir()
  writeSubscription('main', { id: 'main', provider: 'codex', token: 'first' })
  writeSubscription('main', { id: 'main', provider: 'codex', token: 'second' })
  assert.equal(readSubscription('main')!.token, 'second')
})

check('removeSubscription forgets one record and leaves the others', () => {
  scratchDir()
  writeSubscription('a', { id: 'a' })
  writeSubscription('b', { id: 'b' })
  assert.equal(removeSubscription('a'), true)
  assert.equal(readSubscription('a'), null)
  assert.ok(readSubscription('b') !== null)
  // A second remove is not an error.
  assert.equal(removeSubscription('a'), true)
})

check('listSubscriptions names only the records in the store', () => {
  scratchDir()
  assert.deepEqual(listSubscriptions(), [])
  writeSubscription('one', { id: 'one' })
  writeSubscription('two', { id: 'two' })
  assert.deepEqual(listSubscriptions().sort(), ['one', 'two'])
})

check('listSubscriptions answers [] when the store was never created', () => {
  const dir = scratchDir()
  assert.deepEqual(listSubscriptions(), [])
  assert.ok(typeof dir === 'string')
})

check('an explicit data dir is honoured per call', () => {
  // OFM_DATA_DIR is read at call time, so a caller can relocate the store.
  const first = scratchDir()
  writeSubscription('in-first', { id: 'in-first' })
  assert.deepEqual(readSubscription('in-first'), { id: 'in-first' })
  assert.ok(subscriptionPath('in-first').startsWith(first))

  const second = scratchDir()
  assert.equal(readSubscription('in-first'), null, 'the first store leaked into the second')
  assert.ok(subscriptionPath('x').startsWith(second))
})

check('a read-only data dir refuses the write rather than lying', () => {
  const dir = scratchDir()
  if (process.platform === 'win32') return // chmod semantics differ on Windows.
  fs.chmodSync(dir, 0o500)
  try {
    assert.equal(writeSubscription('ro', { id: 'ro' }), false, 'a write to a read-only home claimed success')
  } finally {
    fs.chmodSync(dir, 0o700)
  }
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 200)
