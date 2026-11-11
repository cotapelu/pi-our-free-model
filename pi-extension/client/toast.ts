/**
 * The console's toast and urgent-modal host.
 *
 * Vanilla DOM on purpose: a toast is also raised from the push subscription and
 * from a clipboard action, neither of which is inside the React tree, so a
 * component-hosted toast would be invisible exactly when it matters. The body
 * renders through the same allowlist parser every announcement uses — there is
 * no innerHTML sink anywhere in this file.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/toast.js
 */

import { parseSafeHtml } from './sanitizer.js'
import { htmlToDom } from './sanitizer-materialize.js'

export interface ToastAction {
  label?: string
  onClick?: () => void
}

export interface ToastInput {
  title?: string
  body?: unknown
  html?: string
  tone?: string
  actions?: ToastAction[]
  holdMs?: number
}

export function toastHost(): HTMLElement {
  let host = document.querySelector<HTMLElement>('.ofm_toasts')
  if (host === null) {
    host = document.createElement('div')
    host.className = 'ofm_toasts'
    document.body.appendChild(host)
  }
  return host
}

/** Body text, given either a plain string or the sanitized HTML the announcement parser returns. */
function toastBody(area: HTMLElement, input: ToastInput): void {
  if (input.body !== undefined && input.body !== '') {
    area.textContent = String(input.body)
    return
  }
  if (input.html !== undefined) {
    for (const node of htmlToDom(parseSafeHtml(input.html))) area.appendChild(node)
  }
}

export function showToast(input: ToastInput): HTMLElement | undefined {
  const { title, body, html, tone, actions = [], holdMs = 10000 } = input
  try {
    const host = toastHost()
    const card = document.createElement('div')
    card.className = 'ofm_toast' + (tone === undefined ? '' : ` ${tone}`)
    const head = document.createElement('div')
    head.className = 'ofm_toasttitle'
    head.appendChild(document.createTextNode(title ?? ''))
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ofm_toastclose'
    // No locale lookup in here on purpose: showToast also runs from the
    // push subscription before any `t` binding is in scope, and a throw
    // inside this try/catch would silently swallow the whole toast.
    close.setAttribute('aria-label', 'close')
    close.title = '✕'
    close.textContent = '✕'
    close.addEventListener('click', () => card.remove())
    head.appendChild(close)
    card.appendChild(head)
    if (body !== undefined && body !== '' || html !== undefined) {
      const area = document.createElement('div')
      area.className = 'ofm_toastbody'
      toastBody(area, input)
      card.appendChild(area)
    }
    if (actions.length > 0) {
      const row = document.createElement('div')
      row.className = 'ofm_toastactions'
      for (const action of actions) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'ofm_btn'
        btn.textContent = action.label ?? ''
        btn.addEventListener('click', () => { card.remove(); action.onClick?.() })
        row.appendChild(btn)
      }
      card.appendChild(row)
    }
    host.appendChild(card)
    while (host.children.length > 4) host.firstElementChild?.remove()
    if (holdMs > 0) {
      const timer = setTimeout(() => card.remove(), holdMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }
    return card
  } catch { /* a toast must never break its caller */ }
  return undefined
}

/** Urgent announcement ids already shown on this page. Both the arrival
 *  push and the boot re-check consult it, so one announcement opens one
 *  modal per page load — a replace, never a stack. */
export const urgentShownIds = new Set<string>()

/** Modal surface for `urgent` announcements; dismiss runs the ack callback.
 *
 *  `holdMs` keeps the close control locked for that long with a visible
 *  countdown: an announcement that must be read should not be dismissible
 *  by reflex. The timer is one-shot and cleared with the modal. The hint
 *  text travels in from the caller like `confirmLabel` — this function
 *  predates any `t` binding and must not grow one (same rule as
 *  showToast's comment above). */
export function showUrgentModal(input: {
  title?: string
  html?: string
  confirmLabel?: string
  onClose?: () => void
  holdMs?: number
  holdHint?: string
}): void {
  try {
    document.querySelector('.ofm_scrim[data-ofm-urgent]')?.remove()
    const scrim = document.createElement('div')
    scrim.className = 'ofm_scrim'
    scrim.setAttribute('data-ofm-urgent', 'true')
    const modal = document.createElement('div')
    modal.className = 'ofm_modal'
    modal.setAttribute('role', 'alertdialog')
    modal.setAttribute('aria-modal', 'true')
    const head = document.createElement('div')
    head.className = 'ofm_modalhead'
    head.textContent = input.title ?? ''
    const body = document.createElement('div')
    body.className = 'ofm_modalbody'
    for (const node of htmlToDom(parseSafeHtml(input.html ?? ''))) body.appendChild(node)
    const foot = document.createElement('div')
    foot.className = 'ofm_modalfoot'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'ofm_btn primary'
    ok.textContent = input.confirmLabel ?? 'OK'
    let remaining = Math.max(0, Math.round(Number(input.holdMs) || 0))
    let holdTimer: ReturnType<typeof setTimeout> | undefined
    let hint: HTMLSpanElement | undefined
    const settle = () => {
      ok.disabled = false
      ok.textContent = input.confirmLabel ?? 'OK'
      hint?.remove()
      hint = undefined
    }
    hint = remaining > 0 ? document.createElement('span') : undefined
    if (hint !== undefined) {
      hint.className = 'ofm_holdhint'
      hint.setAttribute('aria-live', 'polite')
      foot.appendChild(hint)
    }
    const tick = () => {
      if (remaining <= 0) { settle(); return }
      ok.disabled = true
      if (hint !== null && hint !== undefined) hint.textContent = String(input.holdHint ?? '').replace('{s}', String(Math.ceil(remaining / 1000)))
      holdTimer = setTimeout(() => { remaining = Math.max(0, remaining - 250); tick() }, 250)
    }
    ok.addEventListener('click', () => {
      if (ok.disabled === true) return
      scrim.remove()
      if (holdTimer !== undefined) { clearTimeout(holdTimer); holdTimer = undefined }
      input.onClose?.()
    })
    foot.appendChild(ok)
    tick()
    modal.appendChild(head)
    modal.appendChild(body)
    modal.appendChild(foot)
    scrim.appendChild(modal)
    document.body.appendChild(scrim)
  } catch { /* a modal must never break its caller */ }
}

/** OS-level notification, only when the user both opted in and granted. */
export function osNotify(title: string, body?: unknown): void {
  try {
    if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
    new Notification(title, { body: String(body ?? '').slice(0, 200) })
  } catch { /* the in-app toast still fires */ }
}
