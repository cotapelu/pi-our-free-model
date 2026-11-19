/**
 * The egress outlet page: the outlet this install dials through.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/pages/egress.js
 */

import { createElement: h, useEffect, useState } from 'react'
import { api, copy } from '../api.js'
import { Button, Panel, Switch } from '../chrome.js'
import { useAsync } from '../hooks.js'

export function Egress(props) {
  const { settings, t, onApply, busy } = props
  const [draft, setDraft] = useState(settings.egress ?? {})
  useEffect(() => setDraft(settings.egress ?? {}), [settings.egress?.enabled, settings.egress?.mode, settings.egress?.urlLabel, settings.egress?.hasUrl, settings.egress?.active, settings.egress?.error])
  const [urlShown, setUrlShown] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [copied, setCopied] = useState('')
  const readUrl = () => api('/egress/url').then(payload => String(payload?.url ?? '')).catch(() => '')
  // Which node url-test is carrying traffic on, and what the last gateway
  // round trip cost. mihomo re-ranks on its own schedule, so while the outlet
  // is on this polls instead of trusting the snapshot that shipped with the
  // settings. `/outlet` reads the controller, so it is only worth calling
  // when an outlet is actually running.
  const live = useAsync(() => api('/outlet'), [settings.egress?.enabled, settings.egress?.active])
  const reloadOutlet = live.reload
  const running = settings.egress?.active === true
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => reloadOutlet(), 15_000)
    return () => clearInterval(timer)
  }, [running, reloadOutlet])
  const status = running && live.data ? live.data : draft
  const node = typeof status?.node === 'string' ? status.node : ''
  const nodeDelayMs = Number(status?.nodeDelayMs ?? 0)
  const latencyMs = Number(status?.latencyMs ?? 0)
  const subscription = draft?.mode !== 'client'
  const statusLine = text => h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, text)
  // The stored address is never in the payload this panel was rendered
  // from, so "see it" and "copy it" both cost one on-demand fetch, and the
  // masked form is all this page holds the rest of the time.
  const revealUrl = async () => {
    if (urlShown) { setUrlShown(false); return }
    setUrlValue(await readUrl())
    setUrlShown(true)
  }
  const copyUrl = async () => {
    const value = await readUrl()
    if (value === '') return
    copy(value, ok => {
      if (!ok) return
      setCopied('egressUrl')
      setTimeout(() => setCopied(''), 1600)
    })
  }
  const urlMask = draft?.hasUrl === true ? `${draft?.urlLabel ?? ''}/…` : t('egress.urlNone')
  const apply = () => {
    const patch = { enabled: draft?.enabled === true, mode: subscription ? 'subscription' : 'client', mihomoPath: String(draft?.mihomoPath ?? '') }
    // Empty means "keep the stored address": this panel never received it,
    // so it has nothing to send back, and an empty string would read as
    // "clear it" on the receiving end.
    if (String(draft?.url ?? '') !== '') patch.url = String(draft.url)
    onApply({ egress: patch })
  }
  return h(Panel, null,
    h('div', { className: 'ofm_row' },
      h(Switch, { checked: draft?.enabled === true, label: t('egress.enabled'), onChange: () => setDraft(c => ({ ...c, enabled: !(c?.enabled === true) })) }),
      h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${draft?.active === true ? 'ok' : draft?.error ? 'err' : ''}` }), draft?.active === true ? t('egress.active') : t('egress.inactive'))),
    h('div', { className: 'ofm_row' },
      h(Switch, { checked: subscription, label: t('egress.modeSubscription'), onChange: () => setDraft(c => ({ ...c, mode: subscription ? 'client' : 'subscription' })) })),
    h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note' }, t('egress.url')),
      h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: urlShown ? 0 : 1 } },
        urlShown ? (urlValue === '' ? t('egress.urlNone') : urlValue) : urlMask),
      h(Button, { kind: 'ghost', onClick: revealUrl }, urlShown ? t('forward.hide') : t('forward.show')),
      h(Button, { kind: 'ghost', onClick: copyUrl }, copied === 'egressUrl' ? t('forward.copied') : t('forward.copy')),
      // Deleting the address is still a thing the owner may want, and the
      // panel cannot express it by sending back a field it never held — so
      // it says so outright, and the outlet goes down with the credential.
      h(Button, { kind: 'ghost', title: t('egress.urlClearWarn'), disabled: draft?.hasUrl !== true || busy, onClick: () => {
        setUrlShown(false)
        setUrlValue('')
        onApply({ egress: { enabled: false, mode: subscription ? 'subscription' : 'client', mihomoPath: String(draft?.mihomoPath ?? ''), url: '' } })
      } }, t('egress.urlClear'))),
    h('div', { className: 'ofm_row' },
      field(t('egress.urlNew'), h('input', { className: 'ofm_input', style: { flex: 1, minWidth: 260 }, value: draft?.url ?? '', placeholder: t('egress.urlPlaceholder'), onChange: e => setDraft(c => ({ ...c, url: e.target.value })) })),
      h(Button, { kind: 'primary', disabled: busy, onClick: apply }, t('egress.apply'))),
    subscription ? h('div', { className: 'ofm_row' },
      field(t('egress.mihomoPath'), h('input', { className: 'ofm_input', style: { flex: 1, minWidth: 260 }, value: draft?.mihomoPath ?? '', placeholder: 'auto', onChange: e => setDraft(c => ({ ...c, mihomoPath: e.target.value })) })),
      h('span', { className: 'ofm_note' }, t('egress.mihomoHint'))) : null,
    draft?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('egress.error').replace('{message}', draft.error)) : null,
    h('div', { className: 'ofm_note' }, t('egress.direct')),
    running ? h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note' }, t('egress.outlet')),
      statusLine(`${draft.outlet ?? ''} · ${draft.mode ?? ''}`)) : null,
    running ? h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note' }, t('egress.node')),
      statusLine(node === '' ? t('egress.measuring') : nodeDelayMs > 0 ? `${node} · ${nodeDelayMs}ms` : node)) : null,
    running ? h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note' }, t('egress.latency')),
      statusLine(latencyMs > 0 ? `${(latencyMs / 1000).toFixed(2)}s` : t('egress.measuring'))) : null)
}
