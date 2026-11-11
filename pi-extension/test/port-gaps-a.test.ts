/**
 * Checks for the gaps the upstream audit turned up, one behaviour each.
 *
 * These are not "the function exists" checks — each one pins a decision the port
 * got wrong or left out on its first pass, and that a rename could undo quietly:
 *
 * - a Chat tool name split across deltas used to be folded per fragment, so a
 *   gateway that split `rea` + `d` produced a call named `rea` (a ghost tool the
 *   harness executes and then poisons the session with);
 * - `profileDirOf` used to count two parents, so a scoped install
 *   (`@scope/name`) pointed the pnpm ownership probe at the `@scope` directory,
 *   found no lockfile, and called a package-manager-owned copy "bare";
 * - the announcement `holdSeconds` used to be dropped, so an announcement that
 *   asked for a 5-second read lock was instantly dismissible;
 * - the auto-checkin tick used to exist only on start, so a service that stayed
 *   up past midnight never checked in again.
 *
 * Runs on plain node:  node test/port-gaps-a.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BlockSink } from '../dist/stream.js'
import { profileDirOf } from '../dist/updater.js'
import { parseFeed } from '../dist/feed.js'

let failures = 0
let running = Promise.resolve()
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

/** One Chat SSE frame carrying one tool-call delta. */
function chatFrame(call: any): string {
  return JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })
}

/** Drain one sink built from the frames, and hand back its emitted chunks. */
function consume(frames: string[], renameMap = new Map<string, string>()): any[] {
  const out: any[] = []
  const sink = new BlockSink((chunk: any) => out.push(chunk), 0, 100_000, undefined, renameMap)
  for (const frame of frames) {
    const payload = JSON.parse(frame)
    for (const choice of payload.choices ?? []) {
      for (const call of choice.delta?.tool_calls ?? []) {
        const key = sink.toolKey(call)
        const name = call.function?.name
        if (typeof name === 'string' && name !== '') sink.toolNameFragment(key, call.id ?? '', name)
        else if (call.id) sink.toolStart(key, call.id, '')
        if (call.function?.arguments) sink.toolArgs(key, call.function.arguments)
      }
    }
  }
  sink.closeAll()
  return out
}

// ── tool name buffering ──────────────────────────────────────────────────────

check('a tool name split across deltas resolves once, whole', () => {
  const out = consume([
    chatFrame({ index: 0, id: 'call_1', function: { name: 'rea', arguments: '' } }),
    chatFrame({ index: 0, function: { name: 'd', arguments: '{}' } }),
  ])
  const end = out.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(end.block.name, 'read')
})

check('a repeated whole name is not doubled', () => {
  // Real servers repeat the complete name on every delta. Extending on a repeat
  // is what makes that shape work; concatenating would give `readread`.
  const out = consume([
    chatFrame({ index: 0, id: 'call_1', function: { name: 'read', arguments: '' } }),
    chatFrame({ index: 0, function: { name: 'read', arguments: '{}' } }),
  ])
  const end = out.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(end.block.name, 'read')
})

check('a split name that grows is extended, not concatenated', () => {
  const out = consume([
    chatFrame({ index: 0, id: 'call_1', function: { name: 'wr', arguments: '' } }),
    chatFrame({ index: 0, function: { name: 'ite', arguments: '' } }),
    chatFrame({ index: 0, function: { name: 'file', arguments: '{}' } }),
  ])
  const end = out.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(end.block.name, 'writefile')
})

check('a buffered wire name is restored through the rename map', () => {
  // The rename map is the fingerprint's spelling -> the caller's spelling. A
  // split wire name must be restored as a whole, not fragment by fragment.
  const renames = new Map([['clint_abc', 'my_tool']])
  const out = consume([
    chatFrame({ index: 0, id: 'call_1', function: { name: 'clint_', arguments: '' } }),
    chatFrame({ index: 0, function: { name: 'abc', arguments: '{}' } }),
  ], renames)
  const end = out.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(end.block.name, 'my_tool')
})

check('deltas carry no name until the call has one', () => {
  // Arguments can legitimately arrive before the name does; the harness's
  // lossless-JSON snapshot rejects an own `undefined` field, so an unknown name
  // is omitted from the delta rather than sent as undefined.
  const out = consume([
    chatFrame({ index: 0, id: 'call_1', function: { name: '', arguments: '{"a":' } }),
  ])
  const delta = out.find(chunk => chunk.type === 'tool-call-delta')
  assert.equal('name' in delta, false)
  assert.equal(delta.argumentsDelta, '{"a":')
})

// ── profileDirOf ─────────────────────────────────────────────────────────────

check('profileDirOf walks to node_modules for a bare install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-profile-'))
  const pkg = path.join(root, 'node_modules', 'our-free-model')
  fs.mkdirSync(pkg, { recursive: true })
  assert.equal(profileDirOf(pkg), root)
  assert.equal(profileDirOf(path.join(root, 'node_modules', 'our-free-model', 'dist')), root)
})

check('profileDirOf skips the scope directory for a scoped install', () => {
  // The two-parents version returned `<root>/node_modules/@scope` here, where
  // pnpm writes no lockfile — so an owned install looked bare.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-profile-'))
  const pkg = path.join(root, 'node_modules', '@earendil-works', 'pi-our-free-model')
  fs.mkdirSync(pkg, { recursive: true })
  assert.equal(profileDirOf(pkg), root)
})

check('profileDirOf survives a package with no node_modules above it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-profile-'))
  const pkg = path.join(root, 'bare', 'our-free-model')
  fs.mkdirSync(pkg, { recursive: true })
  // No node_modules on the path: the walk ends at the filesystem root and the
  // answer is its parent, never a value derived from a fixed depth.
  assert.equal(profileDirOf(pkg), path.parse(path.resolve(pkg)).root)
})

// ── announcement holdSeconds ─────────────────────────────────────────────────

check('an in-range holdSeconds survives parsing', () => {
  const feed = parseFeed({ announcements: [{ id: 'a', title: 'T', html: '<p>b</p>', createdAt: '2026-11-01T00:00:00Z', holdSeconds: 5 }] })
  assert.equal(feed.announcements[0].holdSeconds, 5)
})

check('an out-of-range holdSeconds locks nothing', () => {
  for (const value of [-5, 2.5, 31, '5', null, {}]) {
    const feed = parseFeed({ announcements: [{ id: 'a', title: 'T', html: '<p>b</p>', createdAt: '2026-11-01T00:00:00Z', holdSeconds: value }] })
    assert.equal(feed.announcements[0].holdSeconds, undefined, `holdSeconds=${JSON.stringify(value)} must lock nothing`)
  }
})

check('a zero holdSeconds is not carried at all', () => {
  // `...(hold > 0 ? ... : {})` rather than `holdSeconds: 0`: a console that reads
  // `holdSeconds !== undefined` would lock for zero seconds, which is not the
  // same thing as not locking.
  const feed = parseFeed({ announcements: [{ id: 'a', title: 'T', html: '<p>b</p>', createdAt: '2026-11-01T00:00:00Z', holdSeconds: 0 }] })
  assert.equal('holdSeconds' in feed.announcements[0], false)
})

running.then(() => {
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
})
