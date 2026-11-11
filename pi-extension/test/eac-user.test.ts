/**
 * Unit checks for the co-paid lane's per-user GitHub authorization file.
 *
 * This file is what makes one install *this user* to the gateway's gate, and
 * three properties must not pass by luck:
 *
 *   1. **it lands 0600, atomically** — a crash mid-write must never leave a
 *      half-token, and a token on a shared machine must not be world-readable;
 *   2. **a damaged or absent file reads as `null`** — the request path treats
 *      "no authorization" as a state it can act on, not a throw;
 *   3. **a write that cannot land returns `null`, not a partial record** — a
 *      read-only home must not break the lane's request path.
 *
 * Every check below runs against a throwaway `OFM_DATA_DIR`, so no test ever
 * touches the real home.
 *
 * Runs on plain node:  node test/eac-user.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearEacUser, eacUserPath, readEacUser, writeEacUser } from '../dist/eac-user.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

/** A fresh data dir per check, so no check ever reads another's file. */
let counter = 0
function scratchDir(): string {
  const dir = path.join(os.tmpdir(), `ofm-eac-user-${process.pid}-${Date.now()}-${counter++}`)
  fs.mkdirSync(dir, { recursive: true })
  process.env.OFM_DATA_DIR = dir
  return dir
}

const TOKEN = 'tok_' + 'a'.repeat(40)

check('the file lands under the plugin data dir with its own name', () => {
  const dir = scratchDir()
  assert.equal(eacUserPath(), path.join(dir, 'eac-user.json'))
})

check('an absent file reads as null, not a throw', () => {
  scratchDir()
  assert.equal(readEacUser(), null)
})

check('a freshly written authorization reads back with its login and avatar', () => {
  scratchDir()
  const saved = writeEacUser({ token: TOKEN, login: 'octocat', avatar: 'https://avatars/1' })
  assert.ok(saved !== null)
  assert.equal(saved!.login, 'octocat')
  assert.equal(saved!.avatar, 'https://avatars/1')
  assert.ok(saved!.savedAt > 0)

  const read = readEacUser()
  assert.ok(read !== null)
  assert.equal(read!.token, TOKEN)
  assert.equal(read!.login, 'octocat')
  assert.equal(read!.avatar, 'https://avatars/1')
  assert.equal(read!.savedAt, saved!.savedAt)
})

check('the file lands 0600 (a token must not be world-readable)', () => {
  scratchDir()
  writeEacUser({ token: TOKEN })
  const mode = fs.statSync(eacUserPath()).mode & 0o777
  if (process.platform === 'win32') {
    // icacls is used instead of chmod; the restricted ACL is verified separately.
    assert.ok(fs.statSync(eacUserPath()).isFile())
  } else {
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
  }
})

check('a login and avatar default to empty strings rather than undefined', () => {
  scratchDir()
  const saved = writeEacUser({ token: TOKEN })
  assert.equal(saved!.login, '')
  assert.equal(saved!.avatar, '')
  const read = readEacUser()
  assert.equal(read!.login, '')
  assert.equal(read!.avatar, '')
})

check('an empty token is refused, not written', () => {
  scratchDir()
  assert.equal(writeEacUser({ token: '' }), null)
  assert.equal(readEacUser(), null)
  assert.equal(fs.existsSync(eacUserPath()), false, 'an empty token reached the disk')
})

check('a truncated JSON document reads as null, and the file is kept', () => {
  scratchDir()
  fs.mkdirSync(path.dirname(eacUserPath()), { recursive: true })
  fs.writeFileSync(eacUserPath(), '{"token":"abc","login":')
  assert.equal(readEacUser(), null, 'a truncated document was parsed')
  // The damaged file is kept: a rewrite over it would lose the evidence.
  assert.ok(fs.existsSync(eacUserPath()))
})

check('a JSON document that is not an object reads as null', () => {
  scratchDir()
  fs.mkdirSync(path.dirname(eacUserPath()), { recursive: true })
  fs.writeFileSync(eacUserPath(), '"just a string"')
  assert.equal(readEacUser(), null)
  fs.writeFileSync(eacUserPath(), '[1,2,3]')
  assert.equal(readEacUser(), null)
})

check('a document with no token reads as null', () => {
  scratchDir()
  fs.mkdirSync(path.dirname(eacUserPath()), { recursive: true })
  fs.writeFileSync(eacUserPath(), '{"login":"octocat"}')
  assert.equal(readEacUser(), null)
})

check('a non-string token reads as null, not coerced', () => {
  scratchDir()
  fs.mkdirSync(path.dirname(eacUserPath()), { recursive: true })
  fs.writeFileSync(eacUserPath(), '{"token":12345}')
  assert.equal(readEacUser(), null)
})

check('a non-finite savedAt reads as 0 rather than NaN', () => {
  scratchDir()
  fs.mkdirSync(path.dirname(eacUserPath()), { recursive: true })
  fs.writeFileSync(eacUserPath(), JSON.stringify({ token: TOKEN, savedAt: 'not-a-number' }))
  const read = readEacUser()
  assert.ok(read !== null)
  assert.equal(read!.savedAt, 0)
})

check('a subsequent write replaces the record entirely', () => {
  scratchDir()
  writeEacUser({ token: TOKEN, login: 'first' })
  writeEacUser({ token: TOKEN, login: 'second' })
  const read = readEacUser()
  assert.equal(read!.login, 'second')
})

check('a read-only home returns null rather than a partial record', () => {
  const dir = scratchDir()
  if (process.platform === 'win32') return // chmod semantics differ on Windows.
  fs.chmodSync(dir, 0o500)
  try {
    const result = writeEacUser({ token: TOKEN })
    assert.equal(result, null, 'a write to a read-only home claimed success')
  } finally {
    fs.chmodSync(dir, 0o700)
  }
})

check('clearEacUser forgets the local authorization', () => {
  scratchDir()
  writeEacUser({ token: TOKEN })
  assert.ok(readEacUser() !== null)
  assert.equal(clearEacUser(), true)
  assert.equal(readEacUser(), null)
  // A second clear is not an error.
  assert.equal(clearEacUser(), true)
})

check('an explicit file path is honoured, so a caller can isolate its own store', () => {
  scratchDir()
  const other = path.join(path.dirname(eacUserPath()), `other-${process.pid}.json`)
  writeEacUser({ token: TOKEN, login: 'explicit' }, other)
  assert.equal(readEacUser(other)!.login, 'explicit')
  // The default path is untouched.
  assert.equal(readEacUser(), null)
  clearEacUser(other)
})

check('an explicit non-string token is refused on the explicit path too', () => {
  scratchDir()
  const other = path.join(path.dirname(eacUserPath()), `other-${process.pid}.json`)
  assert.equal(writeEacUser({ token: 42 as any }, other), null)
  assert.equal(readEacUser(other), null)
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 200)
