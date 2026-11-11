/**
 * A fixed-window rate limiter.
 *
 * The window is per key and it does not sweep on a timer: a key's row is reset
 * the next time it is seen after its window expired, which keeps an idle limiter
 * free rather than paying for a cleanup interval. The one cost is a bounded growth
 * of rows for keys that stopped arriving, so a key whose window has passed is
 * dropped whenever the map grows past its ceiling — and the drop happens on the
 * way **in**, where the request that triggered it pays for it.
 *
 * Ported from dsh's `worker/gateway-node.mjs` (`buildRateLimiter`).
 *
 * @module pi-extension/worker/rate-limiter.js
 */

export interface RateVerdict {
  success: boolean
}

export interface RateLimiter {
  limit({ key }: { key: string }): Promise<RateVerdict>
}

/** Above this many keys, expired rows are dropped on the way in rather than swept. */
const MAX_KEYS = 10_000

/**
 * A limiter that admits at most `perWindow` calls per key per `windowMs`.
 *
 * A non-positive `perWindow`, or a non-finite one, means **off** — the caller
 * gets `undefined` and skips the check, which is what an explicit `0` in the
 * configuration asks for. A caller that wanted "refuse everything" would say so
 * with a different value.
 */
export function buildRateLimiter(perWindow: number, windowMs: number): RateLimiter | undefined {
  if (!Number.isFinite(perWindow) || perWindow <= 0) return undefined
  const seen = new Map<string, { windowStart: number; count: number }>()
  return {
    async limit({ key }): Promise<RateVerdict> {
      const now = Date.now()
      const row = seen.get(key)
      if (row === undefined || now - row.windowStart >= windowMs) {
        // Bounded growth: only rows whose window has actually passed are dropped,
        // so a live key is never evicted to make room.
        if (seen.size > MAX_KEYS) {
          for (const [candidate, value] of seen) {
            if (now - value.windowStart >= windowMs) seen.delete(candidate)
          }
        }
        seen.set(key, { windowStart: now, count: 1 })
        return { success: true }
      }
      row.count += 1
      return { success: row.count <= perWindow }
    },
  }
}
