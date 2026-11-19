/**
 * 独立入口的进程级验证：触及插件入口或宿主模块就立即失败。
 *
 * Ported from dsh's `scripts/lib/standalone-isolation-loader.mjs`, applied as
 * a module resolve hook (`node --import`).
 *
 * @module pi-extension/scripts/lib/standalone-isolation-loader.js
 */

// The port has no host kernel to leak into: the equivalents of dsh's
// `index.js`/`adapter/kernel.js` are this package's own `dist/index.js` and
// `dist/adapter.js`, which the *extension* entry legitimately imports. What the
// standalone must still never touch is the host-facing half (index.ts mounts
// pi's extension API) and the vendored pack's own bundle.
const forbidden = [
  new URL('../../dist/index.js', import.meta.url).href,
  new URL('../../dist/adapter.js', import.meta.url).href,
  new URL('../../dist/vendor/channel-pack/pack.js', import.meta.url).href,
]

/** 独立入口的进程级验证：触及插件入口或宿主模块就立即失败。 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) throw new Error(`standalone imported a DSH dependency: ${specifier}`)
  const result = await nextResolve(specifier, context)
  if (forbidden.includes(result.url)) throw new Error(`standalone imported a host-only module: ${result.url}`)
  return result
}
