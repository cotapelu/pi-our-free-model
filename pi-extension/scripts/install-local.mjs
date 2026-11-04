/**
 * Copy the compiled extension into `.pi/extensions/ofm-provider/`.
 *
 * This is the one thing `npm run install` does after `npm run build`: put the
 * built `dist/` where pi discovers project-local extensions, under the name
 * `ofm-provider`, so running `pi` in the repository root loads it.
 *
 * Verified against the installed pi 1.4.0 (`dist/core/extensions/loader.js`):
 *
 *   - `discoverAndLoadExtensions` walks `<cwd>/.pi/extensions/`;
 *   - for a *subdirectory* of that directory it runs `resolveExtensionEntries`,
 *     which takes `package.json`'s `pi.extensions` when present and otherwise
 *     the `index.js` sitting at the top of the directory. No recursion deeper
 *     than one level, so the rest of `dist/` (catalog.js, chains.js, …) is
 *     never mistaken for a second extension.
 *   - so a plain copy of `dist/` — which carries no package.json, because tsc
 *     emits only `.js`, `.d.ts` and `.js.map` — resolves to exactly one entry.
 *
 * Two properties come from that discovery path and are worth stating, because
 * they decide how useful this copy is:
 *
 *   1. It is read from the **current working directory only**. Running `pi`
 *      from a subdirectory of the repository finds nothing there. A
 *      user-level install (`~/.pi/agent/extensions/`) has no such restriction.
 *   2. Project resources are **trust-gated**: pi loads `.pi/extensions/` only
 *      after project trust, so the first run of every session needs
 *      `--approve` (or a saved decision in `~/.pi/agent/trust.json`).
 *
 * The copy is a snapshot. Editing a `.ts` file means running this again —
 * unlike `pi install ./pi-extension`, which resolves the live directory and
 * needs no re-copy at all.
 *
 * @module pi-extension/scripts/install-local.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `pi-extension/` — the package root, which is where npm runs scripts. */
const PKG = path.resolve(HERE, '..')
/** The compiled output. Must exist: run `npm run build` first. */
const SOURCE = path.join(PKG, 'dist')
/** The repository root — where `pi` is run, one level above the package. */
const ROOT = path.resolve(PKG, '..')
const TARGET = path.join(ROOT, '.pi', 'extensions', 'ofm-provider')

function fail(message) {
  console.error(`install-local: ${message}`)
  process.exit(1)
}

if (!fs.existsSync(SOURCE)) {
  fail(`${path.relative(process.cwd(), SOURCE)} does not exist — run \`npm run build\` first`)
}
if (!fs.statSync(SOURCE).isDirectory()) {
  fail(`${path.relative(process.cwd(), SOURCE)} is not a directory`)
}
const entry = path.join(SOURCE, 'index.js')
if (!fs.existsSync(entry)) {
  fail(`${path.relative(process.cwd(), entry)} is missing — the build is incomplete`)
}

// Replace rather than merge: a stale catalog.js or chains.js left beside a new
// index.js is two versions of one module, and pi would load whichever the
// entry point imports without noticing the other.
fs.rmSync(TARGET, { recursive: true, force: true })
fs.mkdirSync(path.dirname(TARGET), { recursive: true })
fs.cpSync(SOURCE, TARGET, { recursive: true })

const files = fs.readdirSync(TARGET).filter((name) => name.endsWith('.js'))
if (!fs.existsSync(path.join(TARGET, 'index.js'))) {
  fail('the copy landed without an index.js; nothing would load')
}

console.log(`install-local: copied ${files.length} file(s) → ${path.relative(process.cwd(), TARGET)}`)
console.log('install-local: run `pi --approve` in the repository root to load it')
console.log('install-local: project-local extensions need project trust; `pi --approve` grants it for that command')
