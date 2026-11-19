/**
 * The generated channel bundle's surface, declared by hand.
 *
 * `business.mjs` is a *generated* file: `scripts/build-standalone-channels.mjs`
 * bundles `vendor/channel-pack/pack.js` (itself generated from
 * `vendor/channel-pack/src`) and rewrites the host imports onto this package's
 * own `contracts.mjs`. A 62k-line bundle is not a file to hand-maintain types
 * for, and it is not a file to typecheck either — so the port declares exactly
 * the surface `worker.ts` consumes and lets the generator stay a build step.
 *
 * Every name here is an export of the generated bundle; adding a consumer of a
 * new export means adding it here, and the generator's `--check` mode fails the
 * build if the bundle no longer matches its source pack.
 *
 * @module pi-extension/packages/standalone/channels/business.d.mts
 */

export declare function apply(ctx: unknown, options?: { disableOpencode?: boolean }): void
export declare function toGenerateOptions(body: unknown, signal: AbortSignal | undefined, effort: unknown, maxTokens: number | undefined, options: unknown, onDropped?: (dropped: unknown) => void): Promise<Record<string, unknown>>
export declare function toResponsesGenerateOptions(body: unknown, signal: AbortSignal | undefined, effort: unknown, maxTokens: number | undefined, options: unknown, onDropped?: (dropped: unknown) => void): Promise<Record<string, unknown>>
export declare function normalizeReasoningEffort(requested: unknown, resolved: unknown, provider: string, model: string, onNotice?: (notice: any) => void): string | undefined
export declare function responsesReasoningEffort(body: unknown): unknown
export declare function normalizeMaxTokens(requested: number, provider: string, model: string): number | undefined
export declare function responsesMaxOutputTokens(body: unknown): number | undefined
export declare function markGatewayChannel(options: Record<string, unknown>): Record<string, unknown>
export declare function collectGatewayModels(ctx: unknown, onError: (provider: string, error: unknown) => void): Promise<Array<{ provider: string; models: unknown[] }>>
export declare function collectGatewayEffortViews(ctx: unknown, groups: Array<{ provider: string; models: unknown[] }>, onError: (provider: string, error: unknown) => void): Promise<unknown>
export declare function toOpenAiModels(groups: Array<{ provider: string; models: unknown[] }>, views: unknown): any[]
export declare const Config: unknown
export declare function channelProxyBypassed(...args: unknown[]): unknown
export declare function createChannelFetch(...args: unknown[]): unknown
export declare function inject(...args: unknown[]): unknown
export declare function makeReadImage(...args: unknown[]): unknown
export declare function makeReadImageRequest(...args: unknown[]): unknown
export declare const name: string
export declare function parseWindowsProxy(...args: unknown[]): unknown
