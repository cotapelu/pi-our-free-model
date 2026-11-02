/**
 * Unit checks for the one-time notice the free lanes owe the user.
 *
 * The gate is the whole point: an acknowledgement from an older copy must not
 * silence the current notice, and a session with no UI must not mark it seen —
 * otherwise a print-mode run would swallow the notice the user never saw.
 *
 * Usage: node pi-extension/test/disclaimer.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NOTICE_VERSION, ackPath, noticeText, readAck, shouldNotice, writeAck } from '../disclaimer.js'

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failures += 1
  }
}

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-notice-'))

check('a first run on this machine shows the notice', () => {
  const dir = freshDir()
  assert.equal(shouldNotice(dir), true)
  assert.equal(readAck(dir), 0)
})

check('showing it once records it, and it stops showing', () => {
  const dir = freshDir()
  const written = writeAck(dir)
  assert.equal(written, NOTICE_VERSION)
  assert.equal(shouldNotice(dir), false)
  assert.equal(readAck(dir), NOTICE_VERSION)
  const stored = JSON.parse(fs.readFileSync(ackPath(dir), 'utf8'))
  assert.ok(Number.isFinite(stored.at) && stored.at > 0, 'the acknowledgement carries when it was given')
  const mode = fs.statSync(ackPath(dir)).mode & 0o777
  assert.equal(mode, 0o600, 'owner-only')
})

check('an acknowledgement from an older copy does not silence the current notice', () => {
  const dir = freshDir()
  fs.mkdirSync(path.dirname(ackPath(dir)), { recursive: true })
  fs.writeFileSync(ackPath(dir), JSON.stringify({ version: NOTICE_VERSION - 1, at: Date.now() }))
  assert.equal(readAck(dir), NOTICE_VERSION - 1)
  assert.equal(shouldNotice(dir), true, 'bumping the copy version re-shows it')
})

check('a damaged acknowledgement file reads as unseen, not as a crash', () => {
  const dir = freshDir()
  fs.mkdirSync(path.dirname(ackPath(dir)), { recursive: true })
  fs.writeFileSync(ackPath(dir), 'not json at all')
  assert.equal(readAck(dir), 0)
  assert.equal(shouldNotice(dir), true)
  const versionOnly = freshDir()
  fs.mkdirSync(path.dirname(ackPath(versionOnly)), { recursive: true })
  fs.writeFileSync(ackPath(versionOnly), JSON.stringify({ at: Date.now() }))
  assert.equal(readAck(versionOnly), 0, 'an entry with no version is not an acknowledgement')
})

check('OFM_DATA_DIR relocates the acknowledgement, like it does the chains', () => {
  const previous = process.env.OFM_DATA_DIR
  const dir = freshDir()
  process.env.OFM_DATA_DIR = dir
  try {
    assert.ok(ackPath().startsWith(dir), `the ack lives under the override dir, not the real home: ${ackPath()}`)
    assert.equal(shouldNotice(), true)
    writeAck()
    assert.equal(shouldNotice(), false)
    assert.ok(fs.existsSync(path.join(dir, 'notice-ack.json')))
  } finally {
    if (previous === undefined) delete process.env.OFM_DATA_DIR
    else process.env.OFM_DATA_DIR = previous
  }
})

check('the notice says what each lane costs, and what not to send', () => {
  const text = noticeText()
  assert.match(text, /ofm-kilo.*prompts may be logged/i, 'the Kilo logging cost is named')
  assert.match(text, /ofm-opencode.*metered per session\/IP/i, 'the OpenCode quota cost is named')
  assert.match(text, /passwords|keys|personal data/i, 'the do-not-send rule is named')
  assert.match(text, /terms are yours to follow/i, 'the terms responsibility is named')
  assert.ok(text.split('\n').length <= 6, 'short enough to be read')
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
