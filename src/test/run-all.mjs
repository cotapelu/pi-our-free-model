#!/usr/bin/env node
/**
 * The extension's test runner.
 *
 * One file, run with plain node:  node test/run-all.mjs [--only <substr>]
 *
 * Why a runner rather than a `&&` chain in package.json: a single failing check
 * echoes `process.exit(1)` and a `&&` chain stops right there. Measured here,
 * that silently dropped every suite after the first failure — the new P6/P12
 * suites never ran at all and the suite count looked frozen. A runner runs
 * every suite, reports each one, and still fails the whole run at the end.
 *
 * Each suite is spawned as its own process, so a suite that throws on import
 * (or calls process.exit) cannot take the runner with it.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const only = process.argv.includes('--only')
  ? String(process.argv[process.argv.indexOf('--only') + 1] ?? '')
  : ''

/** Every `.test.ts` in this directory, in a stable order. */
function suites() {
  return fs.readdirSync(here)
    .filter(name => name.endsWith('.test.ts'))
    .filter(name => only === '' || name.includes(only))
    .sort()
}

/**
 * Offline suites: they never touch a network and never spend quota.
 * `integration` and `acceptance-live` dial the real upstream, so they are
 * opt-in through `--live` — a contributor run must not spend a quota wall.
 */
const LIVE = new Set([
  'fingerprint-integration.ts', 'saver-integration.ts', 'prompt-saver-integration.ts',
  'kilo-integration.ts', 'chain-integration.ts', 'acceptance-live.ts',
])
const wantLive = process.argv.includes('--live')

async function run(name) {
  const started = Date.now()
  const child = spawn(process.execPath, [path.join(here, name)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  let out = ''
  let checks = 0
  let failures = []
  child.stdout.on('data', chunk => {
    out += String(chunk)
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('ok ')) checks += 1
      else if (line.startsWith('FAIL ')) failures.push(line.slice(5))
    }
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise(resolve => child.on('close', resolve))
  if (LIVE.has(name) && !wantLive) {
    return { name, code: 0, checks, failures, ms: Date.now() - started, skipped: true, stderr }
  }
  return { name, code, checks, failures, ms: Date.now() - started, stderr }
}

const list = suites()
if (list.length === 0) {
  console.error('no suites found')
  process.exit(2)
}

console.log(`running ${list.length} suites${wantLive ? '' : ' (pass --live to dial the upstream)'}\n`)
const results = []
for (const name of list) {
  const result = await run(name)
  results.push(result)
  if (result.skipped) {
    console.log(`skip ${name} (live suite; pass --live to run it)`)
    continue
  }
  const label = result.code === 0 ? 'ok  ' : 'FAIL'
  console.log(`${label} ${name} — ${result.checks} check(s), ${result.failures.length} fail, ${result.ms}ms`)
  for (const failure of result.failures) console.log(`       ${failure}`)
  if (result.code !== 0 && result.stderr !== '') console.log(result.stderr.trim().split('\n').map(l => `       ! ${l}`).join('\n'))
}

const ran = results.filter(result => !result.skipped)
const passed = ran.filter(result => result.code === 0)
const failed = ran.filter(result => result.code !== 0)
const skipped = results.filter(result => result.skipped)
const totalChecks = ran.reduce((sum, result) => sum + result.checks, 0)
const totalFailures = ran.reduce((sum, result) => sum + result.failures.length, 0)

console.log(`\n${'─'.repeat(72)}`)
console.log(`${String(passed.length).padStart(3)} suites passed · ${String(failed.length).padStart(3)} failed · ${String(skipped.length).padStart(3)} skipped`)
console.log(`${String(totalChecks).padStart(3)} checks passed · ${String(totalFailures).padStart(3)} failed`)
if (failed.length > 0) {
  console.log('\nfailing suites:')
  for (const result of failed) console.log(`  ${result.name}`)
}
process.exit(failed.length > 0 ? 1 : 0)
