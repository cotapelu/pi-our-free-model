/**
 * Deployment self-check for the EAC gateway.
 *
 * Run this **after** the gateway is up, from the machine that holds the lane's
 * private credential file:
 *
 *     node worker/verify.js <gateway-base ending in /v1> <private-json>
 *
 * It signs the same two routes the plugin speaks — the listing and one tiny turn
 * — with the plugin's own signing code, and prints one verdict per step. Secrets
 * stay in the private file and are never printed.
 *
 * Three of the steps exist because each was a deployment that verified clean and
 * then failed in use:
 *
 *   1. the **unsigned** request must be refused — a gateway that answers an
 *      unsigned turn has its trust fence off, whatever the other steps say;
 *   2. the stream must reach `[DONE]` — a relay that stops mid-frame looks fine
 *      on a listing and drops every real turn;
 *   3. the reader is **cancelled and awaited** before the verdict prints — an
 *      un-awaited release crashed process exit on Windows with a libuv assertion,
 *      after the operator had already read "ok".
 *
 * Ported from dsh's `worker/verify-deployment.mjs`.
 *
 * @module pi-extension/worker/verify.js
 */

import fs from 'node:fs'
import { signSealedRequest } from '../eac.js'

export interface Step {
  ok: boolean
  detail?: string
}

/** Sign one request with the lane's own code, exactly as the plugin does. */
function signer(gatewayBase: string, signingSecret: string, kill: AbortController) {
  return (method: string, suffix: string, body = ''): RequestInit => {
    // The signature covers the full URL pathname — '/v1/models',
    // '/v1/chat/completions' — which is what the gateway recomputes on its side.
    const path = new URL(gatewayBase + suffix).pathname
    return {
      method,
      headers: {
        'content-type': 'application/json',
        'accept': method === 'POST' ? 'text/event-stream' : 'application/json',
        ...signSealedRequest(signingSecret, { method, path, body }),
      },
      body: body === '' ? undefined : body,
      signal: kill.signal,
    }
  }
}

export interface VerifyOptions {
  argv?: string[]
  out?: (line: string) => void
  err?: (line: string) => void
}

/**
 * The whole self-check, as a function so a test can drive it without spawning a
 * process and without a network it does not have.
 */
export async function verifyDeployment(
  gatewayBaseRaw: string,
  privateFile: string,
  { out = (line: string) => console.log(line), err = (line: string) => console.error(line) }: VerifyOptions = {},
  sign?: (method: string, suffix: string, body?: string) => RequestInit,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<number> {
  const gatewayBase = String(gatewayBaseRaw ?? '').replace(/\/+$/, '')
  // Production gateways are https; a loopback http address is allowed so a
  // pre-deployment drill can verify the exact same files locally.
  const schemeOk = /^https:\/\//.test(gatewayBase) || /^http:\/\/(127\.0\.0\.1|localhost)/.test(gatewayBase)
  if (!schemeOk || privateFile === undefined) {
    err('usage: node worker/verify.js <gateway-base ending in /v1> <private-json>')
    return 1
  }
  let signingSecret: string
  try {
    const credential = JSON.parse(fs.readFileSync(privateFile, 'utf8'))
    signingSecret = String(credential?.signingSecret ?? '')
  } catch (error) {
    err(`the private file could not be read: ${String((error as Error)?.message ?? error)}`)
    return 1
  }
  if (signingSecret.length < 32) {
    err('the private file has no signingSecret — mint/deploy needs it (see worker/README.md)')
    return 1
  }

  let failures = 0
  // Closed before exit: undici's keep-alive sockets otherwise race process
  // teardown on Windows and trip a libuv assertion after the verdict prints.
  const kill = new AbortController()
  const step = async (name: string, fn: () => Promise<Step>): Promise<void> => {
    const started = now()
    try {
      const verdict = await fn()
      out(`${verdict.ok === true ? 'ok  ' : 'FAIL'} ${name} (${now() - started} ms)${verdict.detail === undefined ? '' : ` — ${verdict.detail}`}`)
      if (verdict.ok !== true) failures += 1
    } catch (error) {
      failures += 1
      out(`FAIL ${name} (${now() - started} ms) — ${String((error as Error)?.message ?? error).slice(0, 200)}`)
    }
  }

  const signed = sign ?? signer(gatewayBase, signingSecret, kill)

  let rosterId: string | undefined
  await step('signed listing round', async () => {
    const response = await fetchImpl(`${gatewayBase}/models`, signed('GET', '/models'))
    if (response.status !== 200) {
      return { ok: false, detail: `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}` }
    }
    const payload = await response.json() as any
    const ids = (payload.data ?? payload.models ?? []).map((row: any) => row?.id).filter(Boolean)
    if (ids.length === 0) return { ok: false, detail: 'listing carried no model ids' }
    rosterId = ids[0]
    return { ok: true, detail: `${ids.length} models, first: ${rosterId}` }
  })

  if (rosterId !== undefined) {
    await step('signed streaming turn', async () => {
      const body = JSON.stringify({
        model: rosterId,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        stream: true,
        max_tokens: 64,
      })
      const response = await fetchImpl(`${gatewayBase}/chat/completions`, signed('POST', '/chat/completions', body))
      if (response.status !== 200) {
        return { ok: false, detail: `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}` }
      }
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      let sawDone = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true) break
        text += decoder.decode(value, { stream: true })
        if (text.includes('[DONE]')) { sawDone = true; break }
      }
      // Awaited: an un-awaited release has crashed process exit on Windows (a
      // libuv async-handle assertion) *after* the verdict printed.
      await reader.cancel().catch(() => {})
      if (sawDone !== true) {
        return { ok: false, detail: `stream ended without [DONE]; head: ${text.slice(0, 120)}` }
      }
      return { ok: true, detail: 'SSE reached [DONE]' }
    })
  }

  await step('unsigned request refused', async () => {
    const response = await fetchImpl(`${gatewayBase}/models`, { signal: kill.signal })
    return response.status === 401
      ? { ok: true, detail: `HTTP ${response.status}` }
      : { ok: false, detail: `expected 401, got HTTP ${response.status}` }
  })

  kill.abort()
  out(failures === 0
    ? '\ngateway verified — put its /v1 address into the private file (workerBase) and re-mint.'
    : `\n${failures} step(s) failed — see worker/README.md for troubleshooting.`)
  return failures === 0 ? 0 : 1
}

/** CLI entry: `node worker/verify.js <base> <private-json>`. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const failures = await verifyDeployment(argv[0] ?? '', argv[1] ?? '', {
    out: line => console.log(line),
    err: line => console.error(line),
  })
  // Let the process exit naturally once the aborted sockets drain: a hard exit
  // here trips a libuv teardown assertion on Windows.
  if (failures > 0) setTimeout(() => process.exit(failures), 100).unref?.()
  return failures
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('worker/verify.js')) {
  void main()
}
