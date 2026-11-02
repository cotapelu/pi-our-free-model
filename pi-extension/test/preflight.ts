/**
 * Preflight shared by the integration scripts.
 *
 * They drive a real `pi` process, which is not present in every environment
 * (contributor machines without pi, minimal CI images). A missing binary must
 * read as a skipped check with the reason, not as a spawn failure that looks
 * like a broken extension — the offline suite still covers the logic.
 *
 * @module pi-extension/test/preflight.mjs
 */
import { spawnSync } from 'node:child_process'

/** Whether the `pi` binary resolves and answers. */
export function piAvailable() {
  const probe = spawnSync('pi', ['--version'], { stdio: 'ignore' })
  return probe.error === undefined && probe.status === 0
}

/**
 * Skip this script when `pi` is not on PATH.
 *
 * Exits 0 on purpose: an environment that cannot run the integration half has
 * not failed it, and the offline suite is the gate for the logic itself.
 */
export function requirePi(label) {
  if (piAvailable()) return true
  console.log(`SKIP ${label} — the \`pi\` binary is not on PATH; the offline suite covers this logic, and \`npm i -g @earendil-works/pi-coding-agent\` enables the integration checks`)
  process.exit(0)
}
