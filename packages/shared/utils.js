/**
 * Shared utilities used by both console and standalone.
 * Ported from dsh's `client.js` and `packages/standalone/`.
 */
/** 1.2K / 3.4M, and nothing else: a count the console shows is rounded once. */
export function kilo(value) {
    const n = Math.round(Number(value) || 0);
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1000)
        return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
    return String(n);
}
/** "3 分钟前" / "3m ago", from the shell's own locale tag. */
export function ago(ts, locale) {
    if (!ts)
        return "—";
    const seconds = Math.max(1, Math.round((Date.now() - Number(ts || 0)) / 1000));
    const zh = String(locale ?? "")
        .toLowerCase()
        .startsWith("zh");
    if (seconds < 60)
        return zh ? `${seconds} 秒前` : `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)
        return zh ? `${hours} 小时前` : `${hours}h ago`;
    return zh
        ? `${Math.round(hours / 24)} 天前`
        : `${Math.round(hours / 24)}d ago`;
}
