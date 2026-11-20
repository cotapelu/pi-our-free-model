/**
 * Pi extension entry point.
 * Re-exports the provider factory for `pi install .`
 */

export { default as createProvider } from "../../packages/provider/index.js";
export { internals } from "../../packages/provider/index.js";
