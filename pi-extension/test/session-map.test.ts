/**
 * Unit checks for the durable conversation→session map.
 *
 * The free lane accounts quota per session, so the map's whole job is that one
 * conversation keeps one upstream session — across turns, and across a restart.
 * dsh kept this in a module global plus a file in the resolved home; the port
 * takes the data directory as a parameter (the two entries must not disagree
 * about where the user's state lives), which also makes it testable without
 * mutating a global.
 *
 * Runs on plain node:  node test/session-map.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionForConversation, isCanonicalSession, canonicalizeSession, mintSessionId, mintRequestId } from '../dist/core/upstream.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 1000)
function check(name: string, fn: () => void | Promise<void>) {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${name}`) }
    catch (error) { failures++; console.log(`FAIL ${name}\n     ${(error as Error)?.message ?? error}`) }
  })
}

check('one conversation keeps one session, and it is written down', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-smap-'))
  try {
    const first = sessionForConversation('conversation-a', dir)
    assert.equal(sessionForConversation('conversation-a', dir), first)
    assert.equal(isCanonicalSession(first), true)
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'session-map.json'), 'utf8'))
    assert.equal(persisted.version, 2)
    assert.equal(persisted.sessions['conversation-a'], first)
    // A different conversation gets its own, and the first is untouched.
    const other = sessionForConversation('conversation-b', dir)
    assert.notEqual(other, first)
    assert.equal(sessionForConversation('conversation-a', dir), first)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

check('a caller that already carries a canonical id keeps it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-smap-'))
  try {
    const caller = mintSessionId()
    assert.equal(isCanonicalSession(caller), true)
    assert.equal(sessionForConversation(caller, dir), caller)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

check('a legacy hash-derived mapping is migrated once, not trusted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-smap-'))
  try {
    const legacy = canonicalizeSession('legacy')
    fs.writeFileSync(path.join(dir, 'session-map.json'), JSON.stringify({ version: 1, sessions: { legacy } }))
    const before = Date.now()
    const upgraded = sessionForConversation('legacy', dir)
    const after = Date.now()
    assert.notEqual(upgraded, legacy, 'the pseudo-timestamp id was kept')
    assert.equal(isCanonicalSession(upgraded), true)
    // The new id's time half is a real mint, inside the window it was minted in.
    // Both sides are masked to 36 bits first: the id carries 48 bits, and a
    // current ms timestamp does not fit in 36 — the comparison is of the low
    // halves, exactly as dsh's suite compares them.
    const decoded = (~BigInt(`0x${upgraded.slice(4, 16)}`) & 0xffffffffffffn) >> 12n
    assert.ok(decoded >= (BigInt(before) & 0xfffffffffn) && decoded <= (BigInt(after) & 0xfffffffffn),
      'the time half was not a real timestamp')
    const reloaded = JSON.parse(fs.readFileSync(path.join(dir, 'session-map.json'), 'utf8'))
    assert.equal(reloaded.sessions.legacy, upgraded)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

check('an absent store is not an error, and a fresh one starts empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-smap-'))
  try {
    // Nothing on disk yet: the first call writes it rather than throwing.
    const minted = sessionForConversation('fresh', dir)
    assert.equal(isCanonicalSession(minted), true)
    assert.ok(fs.existsSync(path.join(dir, 'session-map.json')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

check('mintRequestId keeps the local bookkeeping shape', () => {
  assert.match(mintRequestId(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

Promise.allSettled([running]).then(() => {
  clearInterval(keepAlive)
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
  if (failures > 0) process.exitCode = 1
})
