#!/usr/bin/env node
/**
 * Copy the JSON assets the emitted modules read next to themselves.
 *
 * `providers/index.ts` parses `registry.json` with `node:fs` from its own
 * directory rather than an import attribute, because the assertion keyword
 * changed between the Node lines this package supports (`assert` → `with`).
 * `tsc` emits only `.js`/`.d.ts`, so the JSON stayed behind in `providers/`
 * and every module that imported the registry crashed at *import* time — with
 * ENOENT, in a build that reported "clean". One command in the build closes
 * that, and it is idempotent.
 *
 * Usage: node scripts/copy-registry.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..')

/**
 * `source relative to pkg` → `destination relative to dist`.
 *
 * The worker's dashboard and sidebar-injection script are browser assets read
 * with `node:fs` from beside the compiled host (`worker/asset()`), so they have to
 * travel with `dist/` for exactly the reason `registry.json` does.
 *
 * The standalone console adds two of the same kind: `web/` is the built React
 * bundle the management API serves by reading it off disk next to its own
 * compiled file (never by request path — an asset map decides what may be
 * read), and `channels/business.mjs` is the generated channel bundle the worker
 * thread loads with a literal `./business.mjs` specifier, which `tsc` does not
 * emit because it is JavaScript, not TypeScript source.
 */
const ASSETS = [
  ['providers/registry.json', 'dist/providers/registry.json'],
  ['worker/dashboard.html', 'dist/worker/dashboard.html'],
  ['worker/entry.js', 'dist/worker/entry.js'],
  ['worker/wrangler.toml', 'dist/worker/wrangler.toml'],
  ['vendor/channel-pack/locale/en.json', 'dist/vendor/channel-pack/locale/en.json'],
  ['vendor/channel-pack/locale/zh.json', 'dist/vendor/channel-pack/locale/zh.json'],
  // The Qoder auth WASM: the channels worker loads it beside itself by URL.
  ['vendor/channel-pack/qoder-auth-wasm.wasm', 'dist/vendor/channel-pack/qoder-auth-wasm.wasm'],
  ['vendor/channel-pack/LICENSE', 'dist/vendor/channel-pack/LICENSE'],
  ['vendor/channel-pack/NOTICE.md', 'dist/vendor/channel-pack/NOTICE.md'],
  ['packages/standalone/channels/business.mjs', 'dist/packages/standalone/channels/business.mjs'],
  // The free lane's two captured official assets. `o2a/asset-source.ts` reads
  // them with `node:fs` from a URL resolved next to its *compiled* file, so the
  // same rule `registry.json` already follows applies to them: without the copy
  // the shipped `dist/` silently degrades the whole fingerprint — no official
  // prompt, no official tool definitions, and every caller tool renamed to an
  // opaque `clint_` name with nothing official appended. Nothing throws, which
  // is what makes it the worst shape of the same bug (dsh pins the identical
  // hazard for `registry.json` in AGENTS.md §7).
  ['o2a/assets/opencode_prompt_v2.txt', 'dist/o2a/assets/opencode_prompt_v2.txt'],
  ['o2a/assets/opencode_tools.json', 'dist/o2a/assets/opencode_tools.json'],
  // The service reads its own version from beside itself, exactly as dsh's does.
  ['packages/standalone/package.json', 'dist/packages/standalone/package.json'],
]

/** Trees copied wholesale, used for the console's built assets. */
const TREES = [
  ['packages/standalone/web', 'dist/packages/standalone/web'],
]

let copied = 0
for (const [source, destination] of ASSETS) {
  const from = path.join(pkg, source)
  const to = path.join(pkg, destination)
  if (!fs.existsSync(from)) {
    console.error(`[copy-assets] missing source: ${source}`)
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  copied += 1
  console.log(`[copy-assets] ${source} → ${destination}`)
}
/** Walk one asset tree, preserving relative paths. Missing trees are an error: a
 *  console that serves half its bundle fails at a route nobody walks in CI. */
for (const [source, destination] of TREES) {
  const from = path.join(pkg, source)
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
    console.error(`[copy-assets] missing tree: ${source}`)
    process.exit(1)
  }
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(child); continue }
      if (!entry.isFile()) continue
      const relative = path.relative(from, child)
      const to = path.join(pkg, destination, relative)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(child, to)
      copied += 1
    }
  }
  walk(from)
  console.log(`[copy-assets] ${source}/ → ${destination}/ (${copied} file(s) so far)`)
}
if (copied === 0) console.log('[copy-assets] nothing to copy')
