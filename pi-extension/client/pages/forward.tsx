/**
 * The forward listener page: its address, its key, its switches.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/pages/forward.js
 */

import { createElement: h, Fragment, useEffect, useState } from 'react'
import { api, ago, copy } from '../api.js'
import { Button, Panel, Switch } from '../chrome.js'
import { useAsync } from '../hooks.js'

export function Forward(props) {
  const { settings, t, onApply, busy } = props
  const [draft, setDraft] = useState(settings.forward)
  useEffect(() => setDraft(settings.forward), [settings.forward?.enabled, settings.forward?.host, settings.forward?.port, settings.forward?.lan?.enabled, settings.forward?.lan?.port, settings.forward?.lan?.running])
  const [key, setKey] = useState('')
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState('')
  useEffect(() => {
    if (draft?.running !== true) return
    let alive = true
    api('/forward/key').then(payload => { if (alive) setKey(payload.key ?? '') }).catch(() => {})
    return () => { alive = false }
  }, [draft?.running])
  const port = draft?.actualPort ?? draft?.port ?? 0
  const base = `http://${draft?.host || '127.0.0.1'}:${port}/v1`
  const doCopy = (label, value) => copy(value, ok => {
    if (!ok) return
    setCopied(label)
    setTimeout(() => setCopied(''), 1600)
  })
  const curl = `curl ${base}/chat/completions \\\n  -H "authorization: Bearer ${shown && key !== '' ? key : '<API KEY>'}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"<model id>","messages":[{"role":"user","content":"hi"}]}'`

  // The relay is a door of its own: its own key, its own liveness, and an
  // address that only exists while it is listening.
  const lan = draft?.lan
  const [lanKey, setLanKey] = useState('')
  const [lanShown, setLanShown] = useState(false)
  useEffect(() => {
    if (lan?.running !== true) return
    let alive = true
    api('/forward/lan/key').then(payload => { if (alive) setLanKey(payload.key ?? '') }).catch(() => {})
    return () => { alive = false }
  }, [lan?.running])
  const lanPort = lan?.actualPort ?? lan?.port ?? 0
  // Which address a peer should dial is a property of this machine's
  // interfaces, and they move under the panel: a laptop that changed networks,
  // woke from sleep, or brought a VPN up holds a different set than it did a
  // minute ago — and the stale one is exactly the one the user copies to the
  // other machine. So while the relay is on this polls the addresses
  // themselves, at the same 15 s cadence the outlet's node reading uses,
  // instead of trusting the snapshot that shipped with the settings.
  const lanLive = useAsync(() => api('/forward/lan/addresses'), [lan?.running])
  const reloadLanAddresses = lanLive.reload
  useEffect(() => {
    if (lan?.running !== true) return undefined
    const timer = setInterval(() => reloadLanAddresses(), 15_000)
    return () => clearInterval(timer)
  }, [lan?.running, reloadLanAddresses])
  const lanHosts = lanLive.data?.addresses ?? lan?.addresses ?? []
  const lanHost = lanHosts[0] ?? ''
  const lanUrl = lanHost === '' ? t('forward.lanNoAddress') : `http://${lanHost}:${lanPort}/v1`
  const lanToggle = current => ({ ...current, lan: { ...(current?.lan ?? {}), enabled: !(current?.lan?.enabled === true) } })

  return h(Panel, null,
    h('div', { className: 'ofm_row' },
      h(Switch, { checked: draft?.enabled === true, label: t('forward.enabled'), onChange: () => setDraft(current => ({ ...current, enabled: !(current?.enabled === true) })) }),
      h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${draft?.running === true ? 'ok' : draft?.error ? 'err' : ''}` }), draft?.running === true ? t('forward.running') : t('forward.stopped'))),
    h('div', { className: 'ofm_row' },
      field(t('forward.host'), h('input', { className: 'ofm_input', style: { maxWidth: 150 }, value: draft?.host ?? '127.0.0.1', onChange: e => setDraft(c => ({ ...c, host: e.target.value })) })),
      field(t('forward.port'), h('input', { className: 'ofm_input', style: { maxWidth: 110 }, inputMode: 'numeric', value: draft?.port ?? '', onChange: e => setDraft(c => ({ ...c, port: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
      h(Button, { kind: 'primary', disabled: busy || draft?.enabled === undefined, onClick: () => onApply({ forward: { enabled: draft.enabled === true, host: draft.host, port: draft.port } }) }, t('forward.apply'))),
    draft?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('forward.error').replace('{message}', draft.error)) : null,
    draft?.notice ? h('div', { className: 'ofm_callout' }, t('forward.notice').replace('{message}', draft.notice)) : null,
    draft?.running === true ? h(Fragment, null,
      h('div', { className: 'ofm_row' },
        h('span', { className: 'ofm_note' }, t('forward.baseUrl')),
        h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, base),
        h(Button, { kind: 'ghost', onClick: () => doCopy('base', base) }, copied === 'base' ? t('forward.copied') : t('forward.copy'))),
      h('div', { className: 'ofm_row' },
        h('span', { className: 'ofm_note' }, t('forward.key')),
        h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: shown ? 0 : 1 } }, key === '' ? '…' : shown ? key : '•'.repeat(24)),
        h(Button, { kind: 'ghost', onClick: () => setShown(value => !value) }, shown ? t('forward.hide') : t('forward.show')),
        h(Button, { kind: 'ghost', onClick: () => doCopy('key', key) }, copied === 'key' ? t('forward.copied') : t('forward.copy')),
        h(Button, { kind: 'ghost', title: t('forward.rotateWarn'), onClick: async () => { const payload = await post('/forward/rotate'); setKey(payload.key ?? ''); setShown(true) } }, t('forward.rotate'))),
      h('div', { className: 'ofm_sec', style: { gap: 4 } }, h('span', { className: 'ofm_note' }, t('forward.example')),
        h('pre', { className: 'ofm_mono' }, curl),
        h('div', null, h(Button, { kind: 'ghost', onClick: () => doCopy('curl', curl) }, copied === 'curl' ? t('forward.copied') : t('forward.copy'))))) : null,
    h('div', { className: 'ofm_sec', style: { gap: 6, marginTop: 12 } },
      h('div', { className: 'ofm_note' }, t('forward.lanTitle')),
      h('div', { className: 'ofm_row' },
        h(Switch, { checked: lan?.enabled === true, label: t('forward.lanEnabled'), onChange: () => setDraft(lanToggle) }),
        h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${lan?.running === true ? 'ok' : lan?.error ? 'err' : ''}` }), lan?.running === true ? t('forward.lanRunning') : t('forward.lanStopped'))),
      h('div', { className: 'ofm_row' },
        field(t('forward.lanPort'), h('input', { className: 'ofm_input', style: { maxWidth: 110 }, inputMode: 'numeric', value: lan?.port ?? 0, onChange: e => setDraft(c => ({ ...c, lan: { ...(c?.lan ?? {}), port: Number(e.target.value.replace(/\D/g, '')) || 0 } })) })),
        h('span', { className: 'ofm_note' }, t('forward.lanAuto')),
        h(Button, { kind: 'primary', disabled: busy, onClick: () => onApply({ forward: { enabled: draft?.enabled === true, host: draft?.host, port: draft?.port, lan: { enabled: lan?.enabled === true, port: lan?.port ?? 0 } } }) }, t('forward.lanApply'))),
      h('div', { className: 'ofm_callout' }, t('forward.lanWarn')),
      h('div', { className: 'ofm_note' }, t('forward.lanHint')),
      lan?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('forward.lanError').replace('{message}', lan.error)) : null,
      lan?.running === true ? h(Fragment, null,
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('forward.lanUrl')),
          h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, lanUrl),
          h(Button, { kind: 'ghost', onClick: () => doCopy('lanUrl', lanUrl) }, copied === 'lanUrl' ? t('forward.copied') : t('forward.copy'))),
        lanHosts.length > 1 ? h('div', { className: 'ofm_note' }, t('forward.lanAlso').replace('{list}', lanHosts.slice(1).join('    '))) : null,
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('forward.lanKey')),
          h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: lanShown ? 0 : 1 } }, lanKey === '' ? '…' : lanShown ? lanKey : '•'.repeat(24)),
          h(Button, { kind: 'ghost', onClick: () => setLanShown(value => !value) }, lanShown ? t('forward.hide') : t('forward.show')),
          h(Button, { kind: 'ghost', onClick: () => doCopy('lanKey', lanKey) }, copied === 'lanKey' ? t('forward.copied') : t('forward.copy')),
          h(Button, { kind: 'ghost', title: t('forward.lanRotateWarn'), onClick: async () => { const payload = await post('/forward/lan/rotate'); setLanKey(payload.key ?? ''); setLanShown(true) } }, t('forward.rotate')))) : null))
}
