/**
 * The console's HTTP helper: one base, one timeout, one body reader.
 *
 * The base is the standalone console's mount (`/api/management`), set by the
 * entry before the first call. The 8s timeout is the part that keeps a hung
 * route from taking the whole console with it: every `api()` call used to wait
 * forever, so one unresponsive endpoint blocked onboarding and held the
 * connection pool. Slow routes widen it through `options.timeout` — a bench that
 * waits for a real generation, an upgrade that downloads a whole package.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/api.js
 */

/** The console's mount prefix; the entry sets it before the first call. */
export let apiBase = '/api/management'
export function setApiBase(value: string) { apiBase = value }

export async function api(path, options) {
  // 8 秒超时兜底：后端路由未注册/挂起时 fetch 不再永久挂起——此前全部 api 调用
  // （onboarding /announcement、设置页 /announcements /update/status、面板 /summary /stats
  // /forward/key 等）无任何超时，一个不响应端点即可阻塞 settings.onboarding 协调流程
  // 并长期占用同源连接池。超时按 AbortError 抛给调用方，走各自 .catch 降级路径。
  // 慢路由按需放宽（options.timeout，毫秒）：/bench 要等一整段真实生成（本车道
  // 首帧动辄数十秒），/update/apply 要下载+校验+安装整包，/refresh /reprobe 要
  // 跑完一整轮探测——8 秒兜底套在它们身上只会“前端报失败、后端继续烧”，
  // 测速按钮因此几乎必失败而配额照付。
  const { timeout = 8000, ...fetchOptions } = options ?? {}
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const response = await fetch(`${API}${path}`, { ...fetchOptions, redirect: 'error', signal: ctrl.signal })
    const text = await response.text()
    let payload
    try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
    if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
    return payload
  } finally {
    clearTimeout(timer)
  }
}

/** 1.2K / 3.4M, and nothing else: a count the console shows is rounded once. */
export function kilo(value) {
  const n = Math.round(Number(value) || 0)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return String(n)
}

/** "3 分钟前" / "3m ago", from the shell's own locale tag. */
export function ago(ts, locale) {
  if (!ts) return '—'
  const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000))
  const zh = String(locale ?? '').toLowerCase().startsWith('zh')
  if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
  return zh ? `${Math.round(hours / 24)} 天前` : `${Math.round(hours / 24)}d ago`
}

/** Clipboard, with the execCommand fallback a non-secure context still needs. */
export function copy(text, done) {
  const finish = ok => done(ok)
  if (navigator?.clipboard?.writeText !== undefined) {
    navigator.clipboard.writeText(text).then(() => finish(true), () => finish(legacy(text)))
    return
  }
  finish(legacy(text))
}
function legacy(text) {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch { return false }
}
