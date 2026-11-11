/**
 * Wire protocol helpers for the standalone API gateway.
 *
 * Everything here is the *caller-facing* half of the gateway: reading a bounded
 * JSON body, generating and comparing the gateway key in constant time, and
 * shaping a refusal into the spelling each client dialect expects. No routing,
 * no upstream call — that lives in `dispatch.ts` and `server.ts`.
 *
 * The gateway is a network-facing door with no session behind it, exactly like
 * dsh's forward listener (src/forward.js): every request must present an issued
 * key, and every comparison is constant-time so a caller cannot learn the key
 * byte by byte from timing.
 *
 * @module pi-extension/gateway/protocol.js
 */

import crypto from 'node:crypto'

/** The largest completion request body accepted; 8 MB mirrors dsh's forward listener. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Header an outside caller may use to carry the key. */
export const REQUEST_ID_HEADER = 'x-ofm-request-id'

/** Mint a gateway key. Not derived from anything user-visible. */
export function generateKey(): string {
  return `ofm-${crypto.randomBytes(24).toString('base64url')}`
}

/**
 * Constant-time comparison of a presented token against the issued key.
 *
 * Both are hashed first so the comparison length never leaks the key's length,
 * and `timingSafeEqual` refuses unequal lengths outright — the caller checks.
 */
export function keyMatches(presented: unknown, expected: unknown): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  if (presented === '' || expected === '') return false
  const a = crypto.createHash('sha256').update(presented).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

/** The bearer token a caller sent, from `Authorization: Bearer …` or `x-api-key`. */
export function bearerOf(req: { headers: Record<string, string | string[] | undefined> }): string {
  const header = String(req.headers.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const key = req.headers['x-api-key']
  return typeof key === 'string' ? key.trim() : ''
}

/** An error carrying the HTTP status the caller should see, so a 4xx is not a 500. */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

/** Read one bounded JSON body; anything else is a caller error, not a server fault. */
export async function readBody(req: AsyncIterable<Uint8Array>): Promise<Record<string, any>> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'request body is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'request body must be a JSON object')
  }
  return value as Record<string, any>
}

/** One CORS allowlist shared by every reply; the gateway is a local tool's endpoint. */
export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
    'access-control-max-age': '600',
  }
}

/** The OpenAI error envelope every OpenAI client parses. */
export function openAiErrorBody(message: string, type: string, code: string | null = null) {
  return { error: { message, type, param: null, code } }
}

/** The Anthropic error envelope, whose server type is spelled `api_error`. */
export function anthropicErrorBody(message: string, type: string, code: string | null = null) {
  return { type: 'error', error: { message, type, ...(code === null ? {} : { code }) } }
}
