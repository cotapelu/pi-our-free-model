/**
 * Subscription channel catalog adapter. Filters a subscription runtime's
 * catalog into catalog rows the picker and router understand.
 *
 * Simplified port of dsh's `src/subscription-adapter.js`.
 *
 * @module pi-extension/subscription-adapter.js
 */

export const isSubscriptionEntry = (entry: any): boolean =>
  entry?.channel === 'subscription'

/**
 * Build virtual catalog rows for every enabled subscription.
 *
 * @param runtime - object with `catalog()` and `complete()` functions
 */
export function subscriptionCatalog(runtime: any): any[] {
  if (typeof runtime?.catalog !== 'function' || typeof runtime?.complete !== 'function') return []
  const capacity = (value: any, fallback: number): number =>
    Number.isSafeInteger(value) && value > 0 ? value : fallback
  const wires: Record<string, string> = {
    chat: 'chat', responses: 'responses', messages: 'messages',
    'openai-chat': 'chat', 'openai-responses': 'responses', 'anthropic-messages': 'messages',
    'gemini-code-assist': 'chat',
  }
  const providerWire: Record<string, string> = { codex: 'responses', claude: 'messages' }
  return runtime.catalog().filter((row: any) => typeof row?.id === 'string' && row.id.startsWith('subscription:'))
    .map((row: any) => ({
      id: row.id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
      channel: 'subscription',
      subscriptionId: row.subscriptionId,
      subscriptionProvider: row.subscriptionProvider,
      contextWindow: capacity(row.contextWindow, 131072),
      maxOutput: capacity(row.maxOutput, 8192),
      wire: wires[row.wire as keyof typeof wires] ?? providerWire[row.subscriptionProvider] ?? 'chat',
      vision: row.vision === true,
      reasoning: row.reasoning === true,
      ...(Array.isArray(row.efforts) && row.efforts.length ? {
        efforts: [...new Set(row.efforts.filter((level: any) => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)))],
      } : {}),
    }))
}
