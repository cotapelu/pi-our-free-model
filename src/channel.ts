/**
 * A single-producer / single-consumer channel bridging a callback source (the
 * SSE reader hands us one payload per invocation) to an async iterable consumer
 * (the chunk parser).
 *
 * `push` never blocks the producer: unclaimed values queue, which is safe here
 * because a provider stream is bounded by its own turn. `next` suspends the
 * consumer instead of polling, so an idle stream costs nothing.
 *
 * Ported from dsh's `src/channel.js`.
 *
 * @module pi-extension/channel.js
 */

export function createChannel() {
  /** @type {Array<string | undefined | Error>} */
  const queue: Array<string | undefined | Error> = []
  /** @type {Array<(v: string | undefined | Error) => void>} */
  const waiting: Array<(v: string | undefined | Error) => void> = []
  let ended = false

  return {
    /** @param {string | undefined | Error} value - payload; `undefined` ends; `Error` fails */
    push(value: string | undefined | Error) {
      if (ended) return
      const resolve = waiting.shift()
      if (resolve !== undefined) resolve(value)
      else queue.push(value)
      if (value === undefined || value instanceof Error) ended = true
    },
    async * read() {
      while (true) {
        const next: string | undefined | Error = queue.length > 0
          ? queue.shift()
          : await new Promise(resolve => waiting.push(resolve))
        if (next instanceof Error) throw next
        if (next === undefined) return
        yield next
      }
    },
  }
}
