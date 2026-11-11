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

import { htmlToDom, parseSafeHtml } from './sanitizer.js'

export function toastHost() {
  let host = document.querySelector('.ofm_toasts')
  if (host === null) {
    host = document.createElement('div')
    host.className = 'ofm_toasts'
    document.body.appendChild(host)
  }
  return host
}

      for (const node of htmlToDom(parseSafeHtml(html))) area.appendChild(node)
      card.appendChild(area)

export function showToast({ title, body, html, tone, actions = [], holdMs = 10000 }) {
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
    if (body !== undefined && body !== '') {
      const area = document.createElement('div')
      area.className = 'ofm_toastbody'
      area.textContent = String(body)
      card.appendChild(area)
    } else if (html !== undefined) {
      const area = document.createElement('div')
      area.className = 'ofm_toastbody'
      for (const node of htmlToDom(parseSafeHtml(html))) area.appendChild(node)
      card.appendChild(area)
    }
    if (actions.length > 0) {
      const row = document.createElement('div')
      row.className = 'ofm_toastactions'
      for (const action of actions) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'ofm_btn'
        btn.textContent = action.label
        btn.addEventListener('click', () => { card.remove(); action.onClick?.() })
        row.appendChild(btn)
      }
      card.appendChild(row)
    }
    host.appendChild(card)
    while (host.children.length > 4) host.firstElementChild?.remove()
    if (holdMs > 0) {
      const timer = setTimeout(() => card.remove(), holdMs)
      timer.unref?.()
    }
    return card
  } catch { /* a toast must never break its caller */ }
  return undefined
}
export function showUrgentModal({ title, html, confirmLabel, onClose }) {
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
    head.textContent = title ?? ''
    const body = document.createElement('div')
    body.className = 'ofm_modalbody'
    for (const node of htmlToDom(parseSafeHtml(html ?? ''))) body.appendChild(node)
    const foot = document.createElement('div')
    foot.className = 'ofm_modalfoot'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'ofm_btn primary'
    ok.textContent = confirmLabel ?? 'OK'
    ok.addEventListener('click', () => { scrim.remove(); onClose?.() })
    foot.appendChild(ok)
    modal.appendChild(head)
    modal.appendChild(body)
    modal.appendChild(foot)
    scrim.appendChild(modal)
    document.body.appendChild(scrim)
  } catch { /* a modal must never break its caller */ }
}

export function osNotify(title, body) {
  try {
    if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
    new Notification(title, { body: String(body ?? '').slice(0, 200) })
  } catch { /* the in-app toast still fires */ }
}
