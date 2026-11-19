/**
 * A fetch-shaped transport over `node:https`/`node:http`.
 *
 * This exists because of a measurement, not a preference: on the live gateway
 * host the global `fetch` (undici) fails every GitHub call with
 * `UND_ERR_CONNECT_TIMEOUT` while `https.get` to the same endpoint answers in
 * milliseconds. That host's egress path is one undici's connection setup does not
 * survive, and the gate's whole flow — code exchange, `/user`, the starred check,
 * the twelve-hour rechecks — depends on those calls.
 *
 * The lane's own client already speaks `node:https` for a different reason (#50, a
 * swappable global fetch). The gate speaks it because on this class of host it is
 * the only transport that reaches GitHub at all.
 *
 * The response is deliberately fetch-*shaped* rather than a real `Response`, so
 * the callers below read exactly like fetch-based code and a future host can swap
 * the transport for the global `fetch` without touching them. GitHub's answers
 * here are small JSON documents, so buffering is fine; `signal` is honoured by
 * destroying the request.
 *
 * Ported from dsh's `worker/auth-github.mjs` (`nodeFetch`).
 *
 * @module pi-extension/worker/github-transport.js
 */

import http from 'node:http'
import https from 'node:https'

/** A fetch-shaped response: `ok`, `status`, `headers.get`, `text()`, `json()`. */
export interface TransportResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<any>
}

export type FetchLike = (url: string, init?: any) => Promise<TransportResponse>

/** The default transport: `node:https` rather than the global `fetch`. */
export const nodeFetch: FetchLike = (url, { method = 'GET', headers = {}, body = undefined, signal } = {}) =>
  new Promise<TransportResponse>((resolve, reject) => {
    // An already-aborted signal fires no event for a listener added after the
    // fact, so the check has to come first — fetch behaves the same way.
    if (signal?.aborted === true) {
      reject(new Error('The operation was aborted'))
      return
    }
    const target = new URL(url)
    const transport = target.protocol === 'http:' ? http : https
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method,
      headers: body !== undefined
        ? { ...headers, 'content-length': Buffer.byteLength(body, 'utf8') }
        : headers,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          status: response.statusCode ?? 0,
          // Node joins a repeated header into an array; `Headers.get` does not,
          // so the transport reduces it here rather than letting each caller
          // discover the difference.
          headers: { get: name => { const raw = response.headers[String(name).toLowerCase()]; return Array.isArray(raw) ? raw.join(', ') : raw ?? null } },
          async text() { return text },
          async json() { return JSON.parse(text) },
        })
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    const abort = () => request.destroy(new Error('The operation was aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => signal?.removeEventListener?.('abort', abort))
    if (body !== undefined) request.write(body, 'utf8')
    request.end()
  })
