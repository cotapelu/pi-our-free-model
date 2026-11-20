/**
 * The console's HTTP helper: one base, one timeout, one body reader.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/api.js
 */

/** The console's mount prefix; the entry sets it before the first call. */
export let apiBase = "/api/management";
export function setApiBase(value: string) {
  apiBase = value;
}

export async function api(path: string, options: Record<string, any> = {}) {
  const { timeout = 8000, ...fetchOptions } = options ?? {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...fetchOptions,
      redirect: "error",
      signal: ctrl.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text === "" ? {} : JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 200) };
    }
    if (!response.ok)
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/** 1.2K / 3.4M, and nothing else: a count the console shows is rounded once. */
export function kilo(value: unknown): string {
  const n = Math.round(Number(value) || 0);
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

/** "3 分钟前" / "3m ago", from the shell's own locale tag. */
export function ago(ts: unknown, locale?: string): string {
  if (!ts) return "—";
  const seconds = Math.max(
    1,
    Math.round((Date.now() - Number(ts || 0)) / 1000),
  );
  const zh = String(locale ?? "")
    .toLowerCase()
    .startsWith("zh");
  if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  return zh
    ? `${Math.round(hours / 24)} 天前`
    : `${Math.round(hours / 24)}d ago`;
}

/** POST helper with the same timeout semantics. */
export async function post(
  path: string,
  body: any,
  timeoutMs = 30_000,
): Promise<any> {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeout: timeoutMs,
  });
}
