/**
 * Unit checks for the prompt families — the half of A2 with no dependency on
 * pi's host packages.
 *
 * The texts are a compatibility surface: a model that has been trained on one
 * wording answers differently to another, so the checks pin every level's exact
 * length and a couple of its markers. A paraphrase that slipped in unnoticed
 * would be a different instruction, not a better one. The version-gate check is
 * the safety one: a stored typo must never silently become "no prompt", because
 * that reads as the family being off when the settings say otherwise.
 *
 * Usage: node pi-extension/test/prompt-saver.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  activePrompts,
  cavemanPrompt,
  ponytailPrompt,
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
  OFF,
} from '../dist/token-saver/prompts.js'
import { readSaver, writeSaver, normalizeSaver, SAVER_DEFAULTS } from '../dist/saver-store.js'

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

// The lengths are the ported contract: every shared boundary line is present in
// every level, so a level that lost one is shorter by exactly that line, and
// these numbers are what the upstream skill texts measure in this port.
const CAVEMAN_LENGTHS: Record<string, number> = {
  lite: 1736,
  full: 1834,
  ultra: 1678,
  'wenyan-lite': 1704,
  wenyan: 1795,
  'wenyan-ultra': 1705,
}
const PONYTAIL_LENGTHS: Record<string, number> = {
  lite: 1560,
  full: 1566,
  ultra: 1610,
}

check('every caveman level is present and exactly its ported length', () => {
  for (const [level, expected] of Object.entries(CAVEMAN_LENGTHS)) {
    const text = cavemanPrompt(level)
    assert.ok(text !== null, `${level} must resolve to a prompt`)
    assert.equal((text as string).length, expected, `${level} is ${(text as string).length} bytes, expected ${expected}`)
  }
})

check('every ponytail level is present and exactly its ported length', () => {
  for (const [level, expected] of Object.entries(PONYTAIL_LENGTHS)) {
    const text = ponytailPrompt(level)
    assert.ok(text !== null, `${level} must resolve to a prompt`)
    assert.equal((text as string).length, expected, `${level} is ${(text as string).length} bytes, expected ${expected}`)
  }
})

check('off and an unknown level both resolve to null, never to an empty string', () => {
  assert.equal(cavemanPrompt(OFF), null)
  assert.equal(ponytailPrompt(OFF), null)
  assert.equal(cavemanPrompt(undefined), null)
  assert.equal(cavemanPrompt('not-a-level'), null, 'an unknown level is not silently injectable')
  assert.equal(ponytailPrompt('full-ish'), null)
})

check('every level carries the safety boundaries it must not drop', () => {
  for (const level of CAVEMAN_LEVELS) {
    const text = cavemanPrompt(level)
    if (text === null) continue
    assert.match(text, /Code blocks, file paths, commands, errors, URLs: keep exact/, `${level} keeps the exactness boundary`)
    assert.match(text, /Security warnings, irreversible action confirmations/, `${level} drops the terse register for safety`)
    assert.match(text, /No self-reference/, `${level} never names the style`)
  }
  for (const level of PONYTAIL_LEVELS) {
    const text = ponytailPrompt(level)
    if (text === null) continue
    assert.match(text, /Never simplify away: input validation at trust boundaries/, `${level} never deletes the guard rails`)
    assert.match(text, /The best code is the code never written/, `${level} keeps the persona`)
  }
})

check('activePrompts returns caveman first, then ponytail, and nothing for off', () => {
  assert.deepEqual(activePrompts({ caveman: OFF, ponytail: OFF }), [])
  assert.deepEqual(activePrompts({}).map((entry) => entry.id), [])
  assert.deepEqual(activePrompts({ caveman: 'lite', ponytail: 'full' }).map((entry) => entry.id), ['caveman', 'ponytail'])
  assert.deepEqual(activePrompts({ caveman: 'lite' }).map((entry) => entry.id), ['caveman'], 'a half-filled selection is normal')
  assert.deepEqual(activePrompts({ ponytail: 'full' }).map((entry) => entry.id), ['ponytail'])
  const unknown = activePrompts({ caveman: 'ultra-extreme-detailed' })
  assert.deepEqual(unknown, [], 'an unknown level contributes nothing')
})

check('activePrompts carries the level it was asked for', () => {
  const [entry] = activePrompts({ caveman: 'full' })
  assert.equal(entry.level, 'full')
  assert.equal(entry.id, 'caveman')
  assert.equal(entry.text, cavemanPrompt('full'))
})

// ── the stored switches ─────────────────────────────────────────────────────

check('a fresh machine starts with every level off', () => {
  assert.equal(readSaver().rtk, false)
  assert.equal(readSaver().caveman, OFF)
  assert.equal(readSaver().ponytail, OFF)
  assert.deepEqual({ ...SAVER_DEFAULTS }, { rtk: false, caveman: 'off', ponytail: 'off' })
})

check('a stored level that is not a level falls back to off, never to a typo', () => {
  assert.deepEqual(normalizeSaver({ rtk: true, caveman: 'lite-ish', ponytail: 'FULL' }), {
    rtk: true,
    caveman: 'off',
    ponytail: 'off',
  })
  assert.deepEqual(normalizeSaver({ rtk: 'yes', caveman: 7 }), {
    rtk: false,
    caveman: 'off',
    ponytail: 'off',
  })
  assert.deepEqual(normalizeSaver(null), { rtk: false, caveman: 'off', ponytail: 'off' }, 'a non-object reads as the defaults')
})

check('the levels round-trip through disk and survive a damaged file', () => {
  const previous = process.env.OFM_DATA_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-saver-levels-'))
  process.env.OFM_DATA_DIR = dir
  try {
    writeSaver({ rtk: true, caveman: 'full', ponytail: 'lite' })
    const back = readSaver()
    assert.equal(back.caveman, 'full')
    assert.equal(back.ponytail, 'lite')
    assert.equal(back.rtk, true)
    // An absent field keeps what is on disk.
    assert.equal(writeSaver({ caveman: 'off' }).ponytail, 'lite')
    // A damaged file reads as the defaults, not as a crash.
    fs.writeFileSync(path.join(dir, 'saver.json'), '{ truncated')
    assert.equal(readSaver().caveman, OFF)
  } finally {
    if (previous === undefined) delete process.env.OFM_DATA_DIR
    else process.env.OFM_DATA_DIR = previous
  }
})

check('the saver file is owner-only, like the chains file', () => {
  const previous = process.env.OFM_DATA_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-saver-mode-'))
  process.env.OFM_DATA_DIR = dir
  try {
    writeSaver({ rtk: true })
    const mode = fs.statSync(path.join(dir, 'saver.json')).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    if (previous === undefined) delete process.env.OFM_DATA_DIR
    else process.env.OFM_DATA_DIR = previous
  }
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
