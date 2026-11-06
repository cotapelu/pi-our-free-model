/**
 * Chain walking for the gateway: one selectable model name that is really an
 * ordered list of physical models, walked inside a single turn.
 *
 * This is the part a gateway must own that `pi` owns for the pi extension. Pi
 * routes once per request and applies its own retry policy — and that policy
 * deliberately treats a quota wall (`FreeUsageLimitError`) as *non*-retryable,
 * because retrying a spent quota spends it three times. A gateway caller gets
 * one response and no second attempt, so the failover has to happen here.
 *
 * The commit rule is the whole design, and it is dsh's (src/adapter.js's
 * `runCombo`): chunks are held until the first *answer-bearing* frame, so a
 * candidate that fails before that point is discarded whole and the switch is
 * invisible to the caller. Reasoning deltas deliberately do **not** commit —
 * "thought for a minute, then hit a quota wall" is the single most valuable case
 * to fail over, and the held thinking is dropped with the rest of the discarded
 * try. Once an answer delta has been handed over, the answer belongs to the
 * caller and a later failure ends the turn the normal way.
 *
 * @module pi-extension/gateway/chain.js
 */

import type { Api, Model } from '@earendil-works/pi-ai/compat'
import { CHAIN_PREFIX } from '../chains.js'
import { rewriteSseFrames } from './response-stream.js'
import { classifyFailure, describeVerdict, shouldAdvance } from './classify.js'
import { friendlyMessage } from '../transport.js'
import { pickBestLink } from '../chains.js'
import type { QuotaReading } from './probe.js'
import type { Resolved } from './dispatch.js'

export interface ChainRow {
  id: string
  name: string
  models: string[]
  strategy: string
  stickyLimit: number
  enabled?: boolean
}

export interface ChainAttempt {
  response: Response
  aliases: Map<string, string>
  scrub: boolean
}

export interface ChainOutcome {
  status: number
  body: ReadableStream<Uint8Array> | Uint8Array
  headers: Record<string, string>
  /** Which link answered, for the `model` field the caller reads. */
  answeredBy: string
  /** Every link that was tried and failed, in order, with the reason. */
  tried: string[]
}

/** Whether one SSE frame carries an answer the caller would have to un-see. */
export function frameCarriesAnswer(frame: string): boolean {
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    if (colon < 0 || line.slice(0, colon) !== 'data') continue
    const payload = line.slice(colon + 1).replace(/^ /, '')
    if (payload.trim() === '' || payload.trim() === '[DONE]') continue
    let parsed: any
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (parsed?.error !== undefined && parsed.error !== null) return false
    for (const choice of parsed?.choices ?? []) {
      const delta = choice?.delta ?? {}
      if (typeof delta.content === 'string' && delta.content.trim() !== '') return true
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim() !== '') continue
    }
  }
  return false
}

/** Whether one SSE frame is the upstream naming a refusal inside a 200 stream. */
export function frameCarriesFailure(frame: string): string | undefined {
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    if (colon < 0 || line.slice(0, colon) !== 'data') continue
    const payload = line.slice(colon + 1).replace(/^ /, '')
    if (payload.trim() === '' || payload.trim() === '[DONE]') continue
    let parsed: any
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (parsed?.error !== undefined && parsed.error !== null) {
      const message = typeof parsed.error === 'string' ? parsed.error : String(parsed.error?.message ?? 'upstream error')
      return message
    }
  }
  return undefined
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Read frames off one candidate until it either answers or runs out.
 *
 * Returns the committed body (buffered frames first, then the still-live reader)
 * or `undefined` when the candidate produced no answer — the shape the walker
 * needs to decide whether to move on without the caller having seen a byte.
 */
async function commitBody(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array> | undefined> {
  const reader = stream.getReader()
  let buffer = ''
  const held: Uint8Array[] = []
  for (;;) {
    const row = await reader.read()
    if (row.done === true) break
    const text = decoder.decode(row.value, { stream: true })
    buffer += text
    let at = buffer.indexOf('\n\n')
    while (at !== -1) {
      const frame = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      at = buffer.indexOf('\n\n')
      if (frame === '') continue
      held.push(encoder.encode(`${frame}\n\n`))
      if (frameCarriesAnswer(frame)) {
        // The frames still sitting in the read buffer after the one that
        // committed must ride along, or a single-chunk body loses its tail.
        if (buffer !== '') held.push(encoder.encode(buffer))
        return replay(reader, held)
      }
      const failure = frameCarriesFailure(frame)
      if (failure !== undefined) return returnUndefined(reader)
    }
  }
  return returnUndefined(reader)
}

function replay(reader: ReadableStreamDefaultReader<Uint8Array>, held: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of held) controller.enqueue(chunk)
    },
    async pull(controller) {
      const row = await reader.read()
      if (row.done === true) {
        controller.close()
        return
      }
      controller.enqueue(row.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

async function returnUndefined(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<undefined> {
  await reader.cancel().catch(() => {})
  return undefined
}

/**
 * The link order a strategy asks for.
 *
 * `fallback` keeps the declared order; `round-robin` rotates per sticky window;
 * and `smart`/`usage`/`pace` score from the quota readings the prober gathered —
 * with no reading for a link, that link is *unevidenced* rather than exhausted, so
 * an unscored set keeps its declared order instead of being shuffled by a guess.
 */
export function orderLinks(chain: ChainRow, links: Resolved[], state: { cursor: number; windowTurn: number }, readings?: Map<string, QuotaReading>): { links: Resolved[]; state: { cursor: number; windowTurn: number } } {
  if (links.length <= 1 || chain.strategy === 'fallback') return { links, state }
  if (chain.strategy === 'round-robin') {
    const cursor = ((state.cursor % links.length) + links.length) % links.length
    const ordered = [...links.slice(cursor), ...links.slice(0, cursor)]
    const windowTurn = state.windowTurn + 1
    const full = windowTurn >= chain.stickyLimit
    return { links: ordered, state: { cursor: full ? cursor + 1 : cursor, windowTurn: full ? 0 : windowTurn } }
  }
  if (chain.strategy === 'smart' || chain.strategy === 'usage' || chain.strategy === 'pace') {
    if (readings === undefined || readings.size === 0) return { links, state }
    const quota: Record<string, any> = {}
    for (const link of links) {
      const reading = readings.get(`${link.provider}/${link.model.id}`)
      if (reading !== undefined) quota[`${link.provider}/${link.model.id}`] = reading
    }
    if (Object.keys(quota).length === 0) return { links, state }
    const best = pickBestLink({ strategy: chain.strategy }, links, { reason: 'user', quota, usage: {} })
    if (!Number.isInteger(best) || best < 0 || best >= links.length) return { links, state }
    return { links: [...links.slice(best), ...links.slice(0, best)], state }
  }
  return { links, state }
}

/**
 * Walk the chain for one turn.
 *
 * `attempt` performs the upstream call for one candidate; it is supplied by the
 * caller because only the caller knows which dialect the answer must be
 * translated into, and the commit rule has to run on the *upstream* frames where
 * "did the model answer" is knowable.
 */
export async function runChain(options: {
  chain: ChainRow
  links: Resolved[]
  attempt: (resolved: Resolved) => Promise<ChainAttempt>
  toResult: (body: ReadableStream<Uint8Array>, answeredBy: string) => ChainOutcome
  fold?: (body: ReadableStream<Uint8Array>) => Promise<Uint8Array>
  onAdvance?: (from: string, reason: string) => void
  /** Quota readings per `provider/model`, for the strategies that score from them. */
  readings?: Map<string, QuotaReading>
}): Promise<ChainOutcome> {
  const { chain, links, attempt, toResult, fold } = options
  const tried: string[] = []
  const rotation = { cursor: 0, windowTurn: 0 }
  const ordered = orderLinks(chain, links, rotation, options.readings).links
  const limit = Math.max(1, links.length - 1)

  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index]
    const address = `${candidate.provider}/${candidate.model.id}`
    let call: ChainAttempt
    try {
      call = await attempt(candidate)
    } catch (error) {
      const failure = error as { statusCode?: number; message?: string }
      const verdict = classifyFailure({ status: failure?.statusCode, message: failure?.message })
      tried.push(`${address} (${describeVerdict(verdict)})`)
      if (!shouldAdvance(verdict)) throw error
      options.onAdvance?.(address, `${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!call.response.ok || call.response.body === null) {
      const verdict = classifyFailure({ status: call.response.ok ? undefined : call.response.status })
      tried.push(`${address} (${describeVerdict(verdict)})`)
      if (!shouldAdvance(verdict)) {
        const text = await call.response.text().catch(() => '')
        const detail = text === '' ? `HTTP ${call.response.status}` : text.slice(0, 400)
        throw Object.assign(new Error(friendlyMessage(`${call.response.status} ${detail}`) ?? detail), { statusCode: call.response.status })
      }
      options.onAdvance?.(address, call.response.ok ? 'no body' : `HTTP ${call.response.status}`)
      continue
    }
    const rewritten = rewriteSseFrames(call.response.body, call.aliases, call.scrub)
    const committed = await commitBody(rewritten)
    if (committed !== undefined) {
      if (fold !== undefined) {
        const folded = await fold(committed)
        return { status: 200, body: folded, headers: {}, answeredBy: address, tried }
      }
      return toResult(committed, address)
    }
    tried.push(`${address} (no answer)`)
    options.onAdvance?.(address, 'no answer')
    if (tried.length > limit && index + 1 < ordered.length) break
  }

  return exhausted(chain, tried)
}

function exhausted(chain: ChainRow, tried: string[]): ChainOutcome {
  const message = `the chain "${chain.name}" exhausted every candidate: ${tried.join('; ')}`
  return {
    status: 502,
    body: encoder.encode(JSON.stringify({ error: { message, type: 'server_error', code: 'ofm_chain_exhausted' } })),
    headers: { 'content-type': 'application/json' },
    answeredBy: '',
    tried,
  }
}



/** A chain row a stored list yields, or undefined when the address names no chain. */
export function chainRowOf(chains: ChainRow[], addressed: string): ChainRow | undefined {
  const wanted = String(addressed ?? '').trim()
  if (wanted === '') return undefined
  return chains.find((chain) => chain.id === wanted || chain.id === chainIdOf(wanted) || chain.name === wanted)
}

function chainIdOf(name: string): string {
  const normalized = String(name ?? '').trim().toLowerCase()
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `${CHAIN_PREFIX}${slug}`
}


