/**
 * Upstream wire for the免密 free lane.
 *
 * Every fact encoded here was verified against the live gateway: the public pooled
 * credential, the client fingerprint headers, the per-model endpoint split, the
 * free-tier tool-fingerprint gate, the per-session quota accounting, and the regional gate.
 *
 * Ported from dsh's `src/upstream.js`.
 *
 * @module pi-extension/upstream.js
 */

import crypto from 'node:crypto'

export const MAX_TOOL_NAME_LEN = 128
export const ANTHROPIC_API_VERSION = '2023-06-01'

/**
 * Strip a trailing "(level)" thinking suffix so lookups hit the base id.
 */
export function baseModelId(model: string | undefined): string {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

/** Restore the caller's tool spelling in a streaming delta or a final payload. */
export function restoreToolName(name: string | undefined, map?: Map<string, string>): string {
  if (!map || map.size === 0 || !name) return name ?? ''
  return map.get(name) ?? name
}

/**
 * Harness tool schemas -> the shape each provider expects.
 */
export function toToolDefs(tools: any[], style: 'chat' | 'claude' | 'flat' = 'chat'): any[] {
  const list: any[] = []
  for (const tool of tools ?? []) {
    // Both spellings have to work here. The harness hands over flat
    // `{name, description, parameters}` defs, but a caller that already speaks
    // OpenAI — the forward listener's own caller, or anything re-feeding this
    // with `{type:'function', function:{…}}` — used to lose every tool to the
    // `if (!name) continue` below, silently: the request went upstream with an
    // empty tool list and only the fingerprint gate's placeholders came back.
    const source = tool && typeof tool.function === 'object' && tool.function !== null && !Array.isArray(tool.function)
      ? tool.function
      : tool
    const name = String(source?.name ?? '').trim()
    if (!name) continue
    const parameters = source.parameters && typeof source.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters
      : { type: 'object', properties: {} }
    const description = typeof source.description === 'string' ? source.description : ''
    if (style === 'claude') list.push({ name: name.slice(0, MAX_TOOL_NAME_LEN), description, input_schema: parameters })
    else if (style === 'flat') list.push({ type: 'function', name: name.slice(0, MAX_TOOL_NAME_LEN), description, parameters })
    else list.push({ type: 'function', function: { name: name.slice(0, MAX_TOOL_NAME_LEN), description, parameters } })
  }
  return list
}

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}
