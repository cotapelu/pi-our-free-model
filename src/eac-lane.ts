/**
 * The co-paid EAC lane, as a pi provider.
 *
 * Unlike the two keyless lanes, this one carries a real credential. It exists
 * only where the host gate opens the seal (`unlockSealedLane`), and it exists
 * only while the credential stays accepted — the gateway revokes it server-side.
 * Everywhere else the lane is dark: no roster entry, no request, no ciphertext
 * work. That is the whole security model, and it is why the provider returns
 * `null` rather than an empty roster when the host has no lane.
 *
 * The wire is the OpenAI Chat Completions dialect, so this module borrows pi's
 * own implementation the way the two keyless lanes do and rewrites only what
 * the lane actually changes:
 *
 *  - the credential is opened per call frame and dropped with it — `direct`
 *    mode sends one bearer, `worker` mode sends no secret at all, only an HMAC
 *    over the exact body bytes;
 *  - the URL is rebuilt from the seal rather than trusted from the model
 *    config, because the gateway moves when the gateway owner says so;
 *  - the transport guard reads a mislabelled or non-SSE 200 body by shape,
 *    because this relay is observed answering both.
 *
 * There is no `Authorization` header to strip and no fingerprint to apply: the
 * gateway's gate is the credential, not a client identity.
 *
 * @module pi-extension/eac-lane.js
 */
import { openAICompletionsApi, type Api, type Model, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai/compat'
import { postSealedStreamed } from './eac.js'
import { unlockSealedLane as openCredential } from './vault.js'

/** Provider id, also the pi model prefix: `ofm-eac/<model>`. */
export const PROVIDER_ID = 'ofm-eac'

/** The co-paid pacing hint: one line so a reasoning model does not sit silent. */
const PACING_HINT = 'Avoid overthinking: keep your reasoning brief and proportionate to the task.'

/** The credential this host can open right now, or `null`. */
export function sealedCredential(profileName?: string) {
  return openCredential(profileName === undefined ? {} : { profileName })
}

/** Does this host have the lane at all? */
export function eacAvailable(profileName?: string): boolean {
  return sealedCredential(profileName) !== null
}

/**
 * One turn on the co-paid lane.
 *
 * The credential is opened inside the request builder, not at registration:
 * a host whose seal closed between the two (the host changed, or the shard
 * files were replaced) fails the turn with `LANE_LOCKED` rather than dialing
 * an endpoint it has no key for. The plaintext lives for the length of the
 * build and is never logged, cached, or named in an error.
 */
export function streamEac(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const credential = sealedCredential()

  const inner = openAICompletionsApi().streamSimple(
    { ...model, baseUrl: credential?.base ?? model.baseUrl ?? '', api: 'openai-completions' },
    context,
    {
      ...options,
      fetch: eacFetch(credential),
      onPayload: async (params: any, current: any) => {
        const replaced = await options?.onPayload?.(params, current)
        const payload: any = replaced ?? params
        // The pacing hint is appended, never replacing the caller's own system
        // turn: a caller that asked for a format gets to keep it.
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        const system = messages.find((message: any) => message?.role === 'system' && typeof message.content === 'string')
        if (system !== undefined) {
          system.content = system.content === '' ? PACING_HINT : `${system.content}\n\n${PACING_HINT}`
        } else {
          payload.messages = [{ role: 'system', content: PACING_HINT }, ...messages]
        }
        return payload
      },
    },
  )
  return inner
}

/**
 * The lane's own `fetch`, shaped the way pi-ai calls it.
 *
 * The URL pi-ai hands over points at the model's own baseUrl, which for this
 * lane is whatever the seal said at registration. The path it appends is the
 * OpenAI one, which is also what the gateway serves, so only the host is
 * re-derived — from the credential, per call.
 */
function eacFetch(credential: { base: string; mode: string; apiKey?: string; signingSecret?: string } | null) {
  return async (input: any, init?: any): Promise<Response> => {
    const live = credential ?? sealedCredential()
    if (live === null) {
      throw Object.assign(new Error('the co-paid lane is not available on this host'), { code: 'LANE_LOCKED' })
    }
    const method = String(init?.method ?? 'GET').toUpperCase()
    const url = new URL(typeof input === 'string' ? input : input.url)
    const target = new URL(`${live.base}${url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`}`)
    const bodyText = typeof init?.body === 'string' ? init.body : ''

    // The body must reach the gateway byte-for-byte as signed, so it is
    // serialized once and posted over the lane's own transport — which is a
    // node:http(s) request, not the swappable global fetch (issue #50).
    const frames: string[] = []
    await postSealedStreamed({
      credential: live,
      body: bodyText === '' ? {} : JSON.parse(bodyText),
      signal: init?.signal,
      onData: (payload: string) => frames.push(`data: ${payload}\n\n`),
    }).catch((error: any) => {
      // A classified refusal has to reach pi-ai's error path as a fetch
      // failure, not as a resolved turn.
      throw error
    })

    // The frames are re-emitted as one SSE body. A turn's tokens are held until
    // the lane's poster settles; the lane is request/response per turn today,
    // and a streaming poster is the next step rather than a claimed feature.
    const sse = `${frames.join('')}data: [DONE]\n\n`
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    void method, target
  }
}

/**
 * The roster this host can see, or `[]` when it has none.
 *
 * A listing failure is not an empty roster either: the last one the gateway
 * served is remembered by the catalog layer, so a transient 5xx must not make
 * a desktop user lose their EAC models for the rest of the process.
 */
export async function eacModels({ signal, profileName }: { signal?: AbortSignal; profileName?: string } = {}): Promise<Model<Api>[]> {
  const credential = sealedCredential(profileName)
  if (credential === null) return []
  // The listing is fetched through the lane's own transport, so the seam and
  // the signing are the same code the turn path uses.
  const { fetchSealedListing } = await import('./eac.js')
  try {
    const listing = await fetchSealedListing(credential, { signal })
    const rows = Array.isArray(listing?.data) ? listing.data : []
    return rows
      .filter((row: any) => typeof row?.id === 'string' && row.id.trim() !== '')
      .map((row: any) => ({
        id: safeId(String(row.id)),
        name: typeof row.name === 'string' && row.name !== '' ? row.name : String(row.id),
        reasoning: true,
        input: ['text'] as string[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number.isFinite(row.context_window) && row.context_window > 0 ? row.context_window : 131072,
        maxTokens: Number.isFinite(row.max_output_tokens) && row.max_output_tokens > 0 ? row.max_output_tokens : 32768,
      }))
  } catch {
    // The lane is dark for this process: a refused credential and an
    // unreachable gateway both produce no roster rather than a stale one.
    return []
  }
}

/** `/` and `:` are pi's provider separator and nothing else. */
export function safeId(id: string): string {
  return String(id).replace(/[:/]/g, '-')
}

/**
 * Registration payload for `pi.registerProvider`, or `null` when the host has
 * no lane. Returning `null` — rather than an empty roster — is what keeps the
 * provider out of `pi --list-models` on a machine the gate refuses, so a user
 * on a CLI never sees a lane that would fail every turn with `LANE_LOCKED`.
 */
export function eacProvider({ models, profileName }: { models: Model<Api>[]; profileName?: string }) {
  if (!eacAvailable(profileName)) return null
  const credential = sealedCredential(profileName)
  return {
    name: 'Our Free Model · EAC (co-paid)',
    baseUrl: credential?.base ?? '',
    api: 'ofm-free-api',
    apiKey: 'public',
    models,
    refreshModels: async (context: { signal?: AbortSignal }) => eacModels({ signal: context?.signal, profileName }),
    streamSimple: streamEac,
  }
}
