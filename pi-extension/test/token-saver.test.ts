/**
 * Unit checks for the token saver — the half of A1 that has no dependency on
 * pi's host packages.
 *
 * The saver sits between the user's turn and the provider, so its failure modes
 * are the ones that matter: a filter that fires on the wrong blob, a filter
 * that grows its input, a filter that blanks an error trace, and the size gate
 * that keeps small blobs (where the markers cost more than the saving) alone.
 * Every check below is a round-trip over a real tool output, because the
 * compacted shapes are a compatibility surface: the model has been trained on
 * RTK's markers, and a paraphrase would be a different instruction.
 *
 * Usage: node pi-extension/test/token-saver.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  compressRequest,
  compressText,
  describeSavings,
  type RtkStats,
} from '../dist/token-saver/index.js'
import { autoDetectFilter } from '../dist/token-saver/autodetect.js'
import { resolveFilter } from '../dist/token-saver/registry.js'
import { parseGrepOutput, splitGrepHit } from '../dist/token-saver/hitLine.js'
import { gitDiff } from '../dist/token-saver/filters/gitDiff.js'
import { gitStatus } from '../dist/token-saver/filters/gitStatus.js'
import { gitLog } from '../dist/token-saver/filters/gitLog.js'
import { ls } from '../dist/token-saver/filters/ls.js'
import { find } from '../dist/token-saver/filters/find.js'
import { grep } from '../dist/token-saver/filters/grep.js'
import { buildOutput } from '../dist/token-saver/filters/buildOutput.js'
import { dedupLog } from '../dist/token-saver/filters/dedupLog.js'
import { searchList } from '../dist/token-saver/filters/searchList.js'
import { readSaver, writeSaver, SAVER_DEFAULTS } from '../dist/saver-store.js'

let failures = 0
function check(label: string, fn: () => void) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label} — ${error instanceof Error ? error.message : String(error)}`)
    failures += 1
  }
}

const freshStats = (): RtkStats => ({ enabled: true, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] })

/**
 * Repeat a shape's own rows until the blob clears the 500-byte floor.
 *
 * A generic filler would be *rejected* by the shape filters — and rightly so:
 * `find` treats every line as a path and `grep` refuses the whole blob when
 * one row fails to parse. So each fixture repeats real-shaped lines instead.
 */
const sized = (lines: string[], times = 6) => Array.from({ length: times }, () => lines).flat().join('\n')

// ── git diff ─────────────────────────────────────────────────────────────────

/** A hunk over the 100-line cap, so the compaction *and* its marker both fire. */
const DIFF = [
  'diff --git a/src/auth.js b/src/auth.js',
  'index 1234567..89abcde 100644',
  '--- a/src/auth.js',
  '+++ b/src/auth.js',
  '@@ -10,200 +10,203 @@ class Auth {',
  '   const token = req.headers.authorization',
  '-  if (token === undefined) return null',
  ...Array.from({ length: 200 }, (_, i) => `+  renumbered ${i} of the hunk`),
  '   store(token)',
  ' }',
].join('\n')

check('a git diff keeps its files, its hunk headers and a truncated body', () => {
  const out = gitDiff(DIFF)
  assert.match(out, /src\/auth\.js/, 'the file survives')
  assert.match(out, /@@ -10,200 \+10,203 @@/, 'the hunk header survives')
  assert.match(out, /\+200 -1/, 'the change counts are reported')
  assert.match(out, /\.\.\. \(\d+ lines truncated\)/, 'the cut is named, not silent')
  assert.match(out, /\[full diff: rtk git diff --no-compact\]/, 'the model is told how to get the rest')
})

check('a hunk under the cap is not marked as truncated', () => {
  const small = [
    'diff --git a/b.js b/b.js',
    '@@ -1,2 +1,2 @@',
    '-a',
    '+b',
  ].join('\n')
  const out = gitDiff(small)
  assert.ok(!/truncated/.test(out), 'nothing was cut')
  assert.ok(!/no-compact/.test(out), 'so the recovery hint is not offered')
  assert.match(out, /\+1 -1/, 'and the counts are still reported')
})

// ── git status ───────────────────────────────────────────────────────────────

check('git status porcelain is counted, not listed', () => {
  const input = sized([
    '## main...origin/main',
    'M  src/auth.js',
    ' M src/http.js',
    '?? new-file.txt',
    '?? another.txt',
  ])
  const out = gitStatus(input)
  assert.match(out, /\* main/, 'the branch survives')
  assert.match(out, /\+ Staged: 6 files/, 'staged is counted across the repeats')
  assert.match(out, /~ Modified: 6 files/, 'worktree-modified is counted')
  assert.match(out, /\? Untracked: 12 files/, 'untracked is counted')
})

check('git status long form is not read as clean', () => {
  const input = sized(['On branch main', 'Changes not staged for commit:', '  modified:   src/app.js'])
  const out = gitStatus(input)
  assert.match(out, /~ Modified: 6 files/, 'long-form modified is counted')
  assert.ok(!/clean/.test(out), 'a dirty tree must not read as clean')
})

check('an empty git status says so in words', () => {
  assert.match(gitStatus('On branch main\nnothing to commit'), /clean/)
})

// ── git log ──────────────────────────────────────────────────────────────────

check('git log keeps the header, drops the body', () => {
  const input = [
    'commit 0123456789abcdef0123456789abcdef01234567',
    'Author: Dev <dev@example.com>',
    'Date:   Mon Jan 1 00:00:00 2026 +0000',
    '',
    '    fix: guard an empty token',
    '',
    '    This is a long explanation the model does not need for a one-line fix.',
    '    It goes on for several lines.',
    '',
    ' 2 files changed, 10 insertions(+), 4 deletions(-)',
  ].join('\n')
  const out = gitLog(input)
  assert.match(out, /commit 0123456/, 'the sha survives')
  assert.match(out, /Author:/, 'the author survives')
  assert.match(out, /Subject: fix: guard an empty token/, 'the subject survives')
  assert.match(out, /2 files changed/, 'the diffstat survives')
  assert.ok(!/long explanation/.test(out), 'the commit body is dropped')
})

check('git log --oneline keeps its rows', () => {
  const input = [
    '0123456 fix: guard an empty token',
    '89abcde feat: add a second lane',
    'fed4321 chore: bump',
  ].join('\n')
  const out = gitLog(input)
  assert.match(out, /0123456 fix: guard an empty token/)
  assert.match(out, /fed4321 chore: bump/)
})

// ── ls ───────────────────────────────────────────────────────────────────────

check('ls -la keeps the names and the sizes, drops the columns', () => {
  const input = sized([
    'total 24',
    'drwxr-xr-x  5 dev dev 4096 Jan  1 10:00 .',
    'drwxr-xr-x 18 dev dev 4096 Jan  1 09:00 ..',
    '-rw-r--r--  1 dev dev  220 Jan  1 10:00 src',
    '-rw-r--r--  1 dev dev 1204 Jan  1 10:00 package.json',
    'drwxr-xr-x  2 dev dev 4096 Jan  1 10:00 tests',
  ])
  const out = ls(input)
  assert.match(out, /^tests\/$/m, 'directories are marked')
  assert.match(out, /package\.json\s+1\.2K/, 'names carry a size, not a column block')
  assert.match(out, /Summary: 12 files, 6 dirs/, 'the summary reports the counts')
})

check('ls drops the noise directories a model learns nothing from', () => {
  const input = sized([
    'total 8',
    'drwxr-xr-x  2 dev dev 4096 Jan  1 10:00 node_modules',
    'drwxr-xr-x  2 dev dev 4096 Jan  1 10:00 dist',
    '-rw-r--r--  1 dev dev   40 Jan  1 10:00 README.md',
  ])
  const out = ls(input)
  assert.ok(!/node_modules\/$/m.test(out), 'node_modules is one line, not 40 000')
  assert.ok(!/dist\/$/m.test(out), 'dist is dropped')
  assert.match(out, /README\.md/, 'a real file survives')
})

check('ls passes a blob that is not a listing through untouched', () => {
  const input = 'not a listing at all, just prose lines.\nIt has no permission rows to anchor on.\nSo nothing parses here.'
  assert.equal(ls(input), input)
})

// ── find ─────────────────────────────────────────────────────────────────────

check('find groups by directory and keeps the basenames', () => {
  const input = sized([
    '/repo/src/auth.js',
    '/repo/src/http.js',
    '/repo/src/kilo.js',
    '/repo/tests/auth.test.js',
  ])
  const out = find(input)
  assert.match(out, /^24 files in 2 dirs:/m, 'the counts lead')
  assert.match(out, /\/repo\/src\/  \(18\)/, 'the directory carries its count')
  assert.match(out, /^  auth\.js$/m, 'basenames, not full paths')
})

check('find caps the directories it shows', () => {
  const input = sized(Array.from({ length: 25 }, (_, i) => `/repo/dir${i}/file${i}.js`), 1)
  const out = find(input)
  assert.match(out, /^25 files in 25 dirs:/m, 'the real counts lead')
  assert.match(out, /\+5 more dirs/, 'the cap is named, not silent')
})

// ── grep ─────────────────────────────────────────────────────────────────────

check('grep groups by file and caps the per-file matches', () => {
  const input = [
    'src/auth.js:10:const token = req.headers.authorization',
    'src/auth.js:24:if (!token) return null',
    'src/http.js:88:const token = parse(raw)',
    ...Array.from({ length: 12 }, (_, i) => `src/auth.js:${200 + i}:token ${i}`),
  ].join('\n')
  const out = grep(input)
  assert.match(out, /^15 matches in 2F:/m, 'the totals lead')
  assert.match(out, /\[file\] src\/auth\.js \(14\):/, 'per-file counts are reported')
  assert.match(out, /^  \+4$/m, 'the dropped count is named, not silent')
})

check('grep refuses a blob it cannot fully parse', () => {
  const input = 'src/auth.js:10:match\nthis line is not a hit'
  assert.equal(grep(input), input, 'one unparsed row preserves the whole blob')
})

check('grep handles filenames with spaces (parseGrepOutput does not reject)', () => {
  const input = [
    'my docs/read me.md:12:the answer',
    'my docs/read me.md:20:another answer',
  ].join('\n')
  const hits = parseGrepOutput(input)
  assert.ok(hits !== null && hits.length === 2, 'spaces in the file field survive')
  assert.equal(hits?.[0]?.file, 'my docs/read me.md')
})

// ── build output ─────────────────────────────────────────────────────────────

check('build output keeps the errors and counts the progress', () => {
  const input = [
    ...Array.from({ length: 40 }, (_, i) => `   Compiling crate-${i} v0.1.0`),
    'warning: unused import',
    'error[E0308]: mismatched types',
    ' --> src/lib.rs:42:9',
    '  |',
    '42 |     let x: u32 = "no";',
    '  = note: expected `u32`, found `&str`',
    ...Array.from({ length: 8 }, (_, i) => `npm warn deprecated pkg-${i}@1.0.0`),
    'added 128 packages in 3s',
  ].join('\n')
  const out = buildOutput(input)
  assert.match(out, /Compiled 40 packages/, 'progress is counted, not listed')
  assert.match(out, /error\[E0308\]: mismatched types/, 'the error survives')
  assert.match(out, /--> src\/lib\.rs:42:9/, 'the cargo continuation survives')
  assert.match(out, /added 128 packages in 3s/, 'the summary survives')
})

// ── autodetect ───────────────────────────────────────────────────────────────

// The autodetector has no size gate of its own (that lives in compressText), so
// a handful of real-shaped rows is enough to route a blob.
check('the autodetector routes each shape to its own filter', () => {
  assert.equal(autoDetectFilter('diff --git a/x b/x')?.filterName, 'git-diff')
  assert.equal(autoDetectFilter('@@ -1 +1 @@')?.filterName, 'git-diff')
  assert.equal(autoDetectFilter('On branch main\nnothing to commit')?.filterName, 'git-status')
  assert.equal(autoDetectFilter('M  a.js\n M b.js\n?? c.js')?.filterName, 'git-status', 'porcelain-only is read by density')
  assert.equal(autoDetectFilter('commit 0123456789abcdef0123456789abcdef01234567')?.filterName, 'git-log')
  assert.equal(autoDetectFilter('/repo/src/a.js\n/repo/src/b.js\n/repo/t/c.js')?.filterName, 'find')
  assert.equal(autoDetectFilter('   Compiling foo v0.1.0')?.filterName, 'build-output')
  assert.equal(autoDetectFilter("Result of search in 'src' (total 3 files):\n- a.js")?.filterName, 'search-list')
})

check('build output is detected before porcelain (cargo must not read as status)', () => {
  const cargo = '   Compiling serde v1.0.0\n   Compiling tokio v1.0.0'
  assert.equal(autoDetectFilter(cargo)?.filterName, 'build-output')
})

check('a blob matching nothing passes through untouched', () => {
  const prose = 'Meeting notes: we discussed the plan.\nAction: send the deck.\nOwner: dev.'
  assert.equal(autoDetectFilter(prose), null, 'too few rows for any filter to claim')
})

// ── the safety rules ─────────────────────────────────────────────────────────

check('a small blob is never asked for a filter it cannot win', () => {
  const short = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b'
  assert.equal(autoDetectFilter(short)?.filterName, 'git-diff', 'autodetect itself has no size gate')
  const stats = freshStats()
  assert.equal(compressText(short, stats, 'openai-tool'), short, 'but compressText leaves it below the floor')
})

// ── the safety rules ─────────────────────────────────────────────────────────

check('a blob below the size floor is never compacted', () => {
  const stats = freshStats()
  const small = 'diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y'
  assert.equal(compressText(small, stats, 'openai-tool'), small, 'unchanged')
  assert.equal(stats.hits.length, 0, 'and it is not counted as a hit')
})

check('a filter answer larger than its input is rejected', () => {
  const stats = freshStats()
  // A grep-shaped blob whose grouped form is longer than the raw lines: two
  // matches in one file cost four framing lines before any content arrives.
  const input = ['a/b.js:1:x', 'a/b.js:2:y'].join('\n')
  const out = compressText(input, stats, 'openai-tool')
  assert.equal(out.length <= input.length, true, 'the compacted form never grows the request')
})

check('an error tool result is the model\'s only evidence and is preserved', () => {
  const stats = freshStats()
  const trace = [
    'error: EACCES: permission denied, open \'/etc/shadow\'',
    '  at Object.openSync (node:fs)',
    '  at read (tool.ts:12)',
  ].join('\n')
  assert.equal(compressText(trace, stats, 'openai-tool'), trace)
})

check('a pass with nothing to compact still reports honestly', () => {
  const line = describeSavings(freshStats())
  assert.match(line ?? '', /\(0%\) — no tool output compacted/)
})

check('describeSavings names the filters that fired', () => {
  const stats = freshStats()
  compressText(DIFF, stats, 'openai-tool')
  const line = describeSavings(stats)
  assert.match(line ?? '', /git-diff/)
  assert.match(line ?? '', /\d+ blocks/)
})

// ── the request-level walk (the wire pi actually builds) ─────────────────────

check('compressRequest compacts chat tool results and leaves everything else', () => {
  const body = {
    model: 'beam-free',
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'what changed?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"git diff"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: DIFF },
    ],
  }
  const before = body.messages[3].content.length
  const { payload, stats } = compressRequest(body, 'chat', { enabled: true })
  const after = (payload as typeof body).messages[3].content
  assert.ok(after.length < before, `the tool result shrank: ${before} -> ${after.length}`)
  assert.match(after, /\[full diff: rtk git diff --no-compact\]/, 'the recovery hint rides the compacted diff')
  // The assistant's own tool_calls arguments are the model's *input* to the tool.
  assert.equal((payload as typeof body).messages[2].tool_calls[0].function.arguments, '{"command":"git diff"}',
    'tool_calls arguments are not rewritten')
  assert.equal((payload as typeof body).messages[0].content, 'You are a coding agent.', 'the system prompt is not touched')
  assert.equal((payload as typeof body).messages[1].content, 'what changed?', 'the user turn is not touched')
  assert.equal(stats.saved, before - after.length)
  assert.equal(stats.hits[0].filter, 'git-diff', 'the hit names the filter that fired')
})

check('compressRequest with the saver off leaves the payload untouched', () => {
  const body = { messages: [{ role: 'tool', tool_call_id: 'c1', content: DIFF }] }
  const before = body.messages[0].content.length
  const { payload, stats } = compressRequest(body, 'chat', { enabled: false })
  assert.equal((payload as typeof body).messages[0].content.length, before)
  assert.equal(stats.enabled, false)
  assert.deepEqual(stats.hits, [])
})

check('an unrecognised wire compacts nothing rather than guessing', () => {
  const body = { messages: [{ role: 'tool', content: DIFF }] }
  const { stats } = compressRequest(body, 'messages', { enabled: true })
  assert.equal(stats.bytesBefore, 0, 'no shape is claimed on a wire this extension never builds')
})

check('compressRequest survives a frozen body', () => {
  const body = Object.freeze({ messages: [Object.freeze({ role: 'tool', content: DIFF })] })
  const { stats } = compressRequest(body, 'chat', { enabled: true })
  // The walk throws on a frozen body; the books are put back in order, not lost.
  assert.equal(stats.bytesBefore - stats.bytesAfter, stats.hits.reduce((sum, hit) => sum + hit.saved, 0))
})

// ── the helpers the registry exposes ────────────────────────────────────────

check('splitGrepHit is drive-aware and tolerates trailing colons', () => {
  assert.deepEqual(splitGrepHit('C:\\repo\\a.js:10:content'), { file: 'C:\\repo\\a.js', line: '10', content: 'content' })
  assert.equal(splitGrepHit('no colons here'), null)
  assert.equal(splitGrepHit('one:colon'), null)
})

check('resolveFilter reads the Rust aliases', () => {
  assert.equal(resolveFilter('rg')?.filterName, 'grep')
  assert.equal(resolveFilter('fd')?.filterName, 'find')
  assert.equal(resolveFilter('no-such-filter'), null)
})

// ── the on-disk switch ──────────────────────────────────────────────────────

check('the saver defaults to off and round-trips through disk', () => {
  const previous = process.env.OFM_DATA_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-saver-'))
  process.env.OFM_DATA_DIR = dir
  try {
    assert.equal(readSaver().rtk, SAVER_DEFAULTS.rtk, 'a fresh machine starts off')
    const on = writeSaver({ rtk: true })
    assert.equal(on.rtk, true)
    assert.equal(readSaver().rtk, true, 'the switch survives a read')
    const off = writeSaver({})
    assert.equal(off.rtk, true, 'an absent field keeps the stored value')
    writeSaver({ rtk: false })
    assert.equal(readSaver().rtk, false)
    const mode = fs.statSync(path.join(dir, 'saver.json')).mode & 0o777
    assert.equal(mode, 0o600, 'owner-only, like the chains file')
  } finally {
    if (previous === undefined) delete process.env.OFM_DATA_DIR
    else process.env.OFM_DATA_DIR = previous
  }
})

check('a damaged saver file reads as the defaults, not as a crash', () => {
  const previous = process.env.OFM_DATA_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-saver-bad-'))
  fs.writeFileSync(path.join(dir, 'saver.json'), 'not json at all')
  process.env.OFM_DATA_DIR = dir
  try {
    assert.equal(readSaver().rtk, SAVER_DEFAULTS.rtk)
  } finally {
    if (previous === undefined) delete process.env.OFM_DATA_DIR
    else process.env.OFM_DATA_DIR = previous
  }
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
