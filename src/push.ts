/**
 * Server-push channel: one Server-Sent-Events route that every open surface
 * subscribes to.
 *
 * The pattern is taken from the kernel's own client-HMR plugin: a held-open
 * `text/event-stream` response, a comment heartbeat to defeat idle timeouts, and
 * per-client removal on close. `webServer` explicitly allows a handler to hold
 * its response open, and its gzip layer skips event streams, so nothing
 * special-cases it.
 *
 * Events are fire-and-forget snapshots, not a queue: a client that connects
 * after an announcement arrived learns about it from the first `hello` payload
 * rather than from history, which keeps this hub stateless. That is deliberate —
 * a replay queue grows without bound across restarts and answers a question the
 * client can already answer by reading the resource.
 *
 * Ported from dsh's `src/push.js`.
 *
 * @module pi-extension/push.js
 */

/** Default heartbeat: below the 30 s an idle-proxy timeout is usually set to. */
export const HEARTBEAT_MS = 25_000

export interface PushHub {
  /** How many surfaces are currently attached. */
  readonly size: number
  /**
   * Adopt one request as a live event stream. The route handler has already
   * passed the trust fence; this takes ownership of the response.
   */
  attach(req: any, res: any, hello?: unknown): void
  /** Send one event to one client. */
  sendTo(res: any, event: string, data: unknown): void
  /** Broadcast one event to every attached surface. */
  emit(event: string, data: unknown): void
  /** Close every stream; from a dispose, so a hot reload never leaves one open. */
  dispose(): void
}

export function createPushHub({
  logger = console,
  heartbeatMs = HEARTBEAT_MS,
}: {
  logger?: any
  heartbeatMs?: number
} = {}): PushHub {
  /** Every open response. A `Set` on purpose: attach/drop order is irrelevant. */
  const clients = new Set<any>()
  let heartbeat: NodeJS.Timeout | undefined

  function startHeartbeat(): void {
    // One timer for the whole hub, and only while somebody is listening: a hub
    // with no clients running an interval is a permanent wakeup for nothing.
    if (heartbeat !== undefined || clients.size === 0) return
    heartbeat = setInterval(() => {
      for (const res of [...clients]) {
        if (res.writableEnded === true || res.destroyed === true) { clients.delete(res); continue }
        // A comment line, not an event: a client must be able to ignore it
        // entirely. Anything else would be a synthetic notification.
        try { res.write(': ping\n\n') } catch { clients.delete(res) }
      }
      if (clients.size === 0) stopHeartbeat()
    }, heartbeatMs)
    heartbeat.unref?.()
  }

  function stopHeartbeat(): void {
    if (heartbeat === undefined) return
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  /** Whether this response is still worth writing to. */
  const live = (res: any): boolean => res.writableEnded !== true && res.destroyed !== true

  return {
    get size() { return clients.size },

    attach(req: any, res: any, hello?: unknown): void {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Tells a buffering proxy (nginx) not to sit on the frames. Without it a
        // reverse proxy holds every event until its buffer fills.
        'x-accel-buffering': 'no',
      })
      // The connect comment is written through the same guard as every later
      // frame. A client that hung up between the request arriving and this
      // handler running is the ordinary case, not an exotic one; an unguarded
      // write turns that race into a 500 in the route handler.
      if (!live(res)) return
      try { res.write(': connected\n\n') } catch (error: any) {
        clients.delete(res)
        logger.debug?.(`our-free-model push: dropped client on attach (${error?.message ?? error})`)
        return
      }
      // The hello snapshot is what makes this stateless: whatever the client
      // would have missed arrives with the connection, not on a later poll.
      if (hello !== undefined) this.sendTo(res, 'hello', hello)
      clients.add(res)
      startHeartbeat()
      const drop = () => {
        clients.delete(res)
        if (clients.size === 0) stopHeartbeat()
      }
      req.on('close', drop)
      res.on('close', drop)
    },

    sendTo(res: any, event: string, data: unknown): void {
      if (!live(res)) { clients.delete(res); return }
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`)
      } catch (error: any) {
        // A socket that throws on write is gone; drop it rather than let every
        // later emit keep hitting the same dead peer.
        clients.delete(res)
        logger.debug?.(`our-free-model push: dropped client (${error?.message ?? error})`)
      }
    },

    emit(event: string, data: unknown): void {
      // Iterated over a copy: a client dropped mid-broadcast mutates the set.
      for (const res of [...clients]) this.sendTo(res, event, data)
    },

    dispose(): void {
      for (const res of [...clients]) {
        try { res.end() } catch { /* already gone */ }
      }
      clients.clear()
      stopHeartbeat()
    },
  }
}
