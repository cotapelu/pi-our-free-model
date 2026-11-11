/**
 * The channel service contract.
 *
 * The standalone product's channel layer speaks a *structural* adapter contract
 * rather than importing a base class — the same discipline `src/adapter.js` used
 * so the plugin could mount on more than one kernel line. A base class that
 * throws on unimplemented methods is the other half: a channel that forgets one
 * fails loudly at the call, instead of silently answering nothing.
 *
 * This module also carries the vocabulary the lane already speaks
 * (`CONTEXT_WINDOW_EXCEEDED`, `EMPTY_RESPONSE`, `QUOTA_EXCEEDED`), so the
 * standalone's channels classify a failure the way the plugin's router does
 * rather than re-inventing codes that only one side understands.
 *
 * Ported from dsh's `packages/standalone/channels/contracts.mjs`.
 *
 * @module pi-extension/channels/contracts.js
 */

import { randomUUID } from 'node:crypto'

/**
 * The platform a channel service holds.
 *
 * Deliberately narrow: the channel layer names what it needs (`provide`) rather
 * than the whole host, so a test can supply a stub and the standalone can supply
 * its own.
 */
export interface ChannelPlatform {
  provide(name: string, value: unknown): void
}

/** One service registered under a name on the platform. */
export class Service {
  ctx: ChannelPlatform
  constructor(platform: ChannelPlatform, name: string) {
    this.ctx = platform
    platform.provide(name, this)
  }
}

/**
 * A channel's model surface. Unimplemented members throw with a message that
 * names what is missing, rather than returning `undefined` and becoming a turn
 * that fails three layers later with no reason attached.
 */
export class LlmAdapter {
  listProviders(): any { throw new Error('渠道未实现供应商目录') }
  listModels(): any { throw new Error('渠道未实现模型目录') }
  resolveModel(): any { throw new Error('渠道未实现模型解析') }
  stream(): any { throw new Error('渠道未实现流式调用') }
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<any> {
    return {
      // The base class throws on the unimplemented members; an override answers.
      // The casts keep that call shape without the base signature hiding it.
      model: await (this as any).resolveModel(provider, model, signal),
      stream: (options: any) => (this as any).stream(options),
    }
  }
}

/** A classified lane failure, in the vocabulary the router already speaks. */
export class LlmError extends Error {
  code?: string
  constructor(message: string, code?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LlmError'
    this.code = code
  }
}

/** The opaque reference types a channel carries between its own halves. */
export const credentialRef = (value: string): string => value
export const ReasoningEffortId = (value: string): string => value
export const ToolCallId = (value: string): string => value

export const createUserMessage = (value: Record<string, unknown>): any => ({ id: randomUUID(), role: 'user', ...value })
export const createToolResultMessage = ({
  callId, content, isError,
}: {
  callId: string
  content: unknown
  isError: boolean
}): any => ({
  id: randomUUID(), role: 'tool', toolCallId: callId, content, isError,
  source: { kind: 'tool', callId },
})

/** The attribution header every channel request carries. */
export const attributionHeaders = (): Record<string, string> => ({ 'user-agent': 'our-free-model-standalone' })

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'

export const isContextWindowExceededError = (error: any): boolean => error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = (error: any): boolean => error?.code === QUOTA_EXCEEDED_CODE
