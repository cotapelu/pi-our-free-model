/**
 * Shared utilities used by both console and standalone.
 * Ported from dsh's `client.js` and `packages/standalone/`.
 */
/** 1.2K / 3.4M, and nothing else: a count the console shows is rounded once. */
export declare function kilo(value: unknown): string;
/** "3 分钟前" / "3m ago", from the shell's own locale tag. */
export declare function ago(ts: unknown, locale?: string): string;
