/**
 * Disclaimer modal.
 *
 * Ported from dsh's `client.js` Disclaimer function.
 *
 * @module pi-extension/client/pages/disclaimer.tsx
 */

import { createElement as h, useEffect, useRef, useState, Fragment } from 'react'
import { post } from '../api.js'
import { Button } from '../chrome.js'

function announcementPortalHost() {
  let host = document.querySelector('[data-ofm-announcement-root]')
  if (host === null) {
    host = document.createElement('div')
    host.setAttribute('data-ofm-announcement-root', 'true')
    document.body.appendChild(host)
  }
  return host
}

export function Disclaimer(props) {
  const { t, onClose } = props
  const [busy, setBusy] = useState(false)
  const copy = props.copy
  const dismiss = async () => {
    if (busy) return
    setBusy(true)
    try { await post('/disclaimer/ack') } catch { /* ack is best effort */ }
    onClose()
  }
  const host = announcementPortalHost()
  useEffect(() => () => {
    if (host.parentNode !== null) host.parentNode.removeChild(host)
  }, [host])
  return ReactDOM.createPortal(h('div', { className: 'ofm_scrim' },
    h('div', { className: 'ofm_ann ofm_disclaimer', role: 'dialog', 'aria-modal': 'true', 'aria-label': copy.title },
      h('div', { className: 'ofm_annhead' },
        h('h2', { className: 'ofm_anntitle' }, copy.title),
        h('p', { className: 'ofm_annsub' }, copy.subtitle)),
      h('div', { className: 'ofm_annbody' },
        h('p', null, copy.intro),
        copy.sections.map(section => h('section', { key: section.id, className: 'ofm_disclaimersec' },
          h('h3', null, section.heading),
          h('p', null, section.body)))),
      h('div', { className: 'ofm_annfoot' },
        h('span', { className: 'ofm_note' }, t('disclaimer.version').replace('{n}', copy.version)),
        h('span', { className: 'spacer' }),
        h(Button, { kind: 'primary', disabled: busy, onClick: dismiss }, busy ? t('disclaimer.saving') : copy.accept)))), host)
}

import ReactDOM from 'react-dom'