/**
 * Pull the token counts out of a relayed body, without parsing it.
 *
 * The relayed body is either SSE frames or one JSON document, and the only thing
 * this layer wants from it is the last `prompt_tokens` and `completion_tokens`
 * it carried. Parsing the whole thing would mean buffering a stream that may run
 * for minutes, so the scan is a regex over complete lines as they pass.
 *
 * Two details are load-bearing:
 *
 * - The regex matches the **quoted key**, so `completion_tokens_details` cannot
 *   pollute the completion count by matching the `completion_tokens` inside it.
 * - The **last** match wins, not the first: a relayed stream carries a per-frame
 *   usage and then a final total, and the total is the one worth recording.
 *
 * Ported from dsh's `worker/gateway-node.mjs` (`createUsageScanner`).
 *
 * @module pi-extension/worker/usage-scanner.js
 */

export interface UsageReading {
  prompt: number
  completion: number
}

export interface UsageScanner {
  push(text: string): void
  end(): void
  result(): UsageReading
}

/** A scanner that reads a body's token counts as its lines complete. */
export function createUsageScanner(): UsageScanner {
  let remainder = ''
  let prompt: number | undefined
  let completion: number | undefined

  const scan = (text: string): void => {
    // Only the quoted key form, so a key that merely *contains* this one — the
    // `*_tokens_details` block the provider nests inside it — cannot match.
    const prompts = text.match(/"prompt_tokens"\s*:\s*(\d+)/g)
    const completions = text.match(/"completion_tokens"\s*:\s*(\d+)/g)
    if (prompts !== null) prompt = Number(prompts[prompts.length - 1].match(/(\d+)/)![1])
    if (completions !== null) completion = Number(completions[completions.length - 1].match(/(\d+)/)![1])
  }

  return {
    push(text: string): void {
      remainder += text
      let at: number
      // Only complete lines, so a count split across two chunks is not missed —
      // and not guessed at either, because the tail stays in `remainder`.
      while ((at = remainder.indexOf('\n')) !== -1) {
        scan(remainder.slice(0, at))
        remainder = remainder.slice(at + 1)
      }
    },
    end(): void {
      if (remainder !== '') scan(remainder)
      remainder = ''
    },
    result(): UsageReading {
      return { prompt: prompt ?? 0, completion: completion ?? 0 }
    },
  }
}
