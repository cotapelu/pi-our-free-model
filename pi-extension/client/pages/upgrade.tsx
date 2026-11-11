/**
 * The in-app upgrade surface: check, download, apply, and the honest answer at each step.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/upgrade.js
 */

import { createElement: h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, PageHero, Panel, Section, PanelSkeleton, PanelError } from '../chrome.js'

export function UpgradePanel(props) {
  const { t, settings, onApply, busy } = props
  const control = useRef({ managed: false, generation: 0, phase: '', ready: false })
  const status = useUpgradeStatus(control)
  const [phase, setPhase] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const data = status.data
  const managed = data?.managed === true
  syncUpgradeOwner(control, data)
  control.current.data = data
  control.current.ready = status.status === 'ready'
  useEffect(() => {
    setPhase(''); setMessage(''); setError('')
  }, [managed])
  useEffect(() => {
    const handler = event => {
      control.current.generation += 1
      control.current.phase = ''
      const version = event.detail?.version ?? ''
      setPhase(''); setError('')
      setMessage(control.current.managed || version === '' ? '' : event.detail?.restartRequired === true
       ? t('upgrade.restart').replace('{version}', version) : t('upgrade.done').replace('{version}', version))
      void status.reload()
    }
    window.addEventListener('ofm:upgraded', handler)
    return () => window.removeEventListener('ofm:upgraded', handler)
  }, [status.reload, t])
  const begin = next => {
    const snapshot = control.current.data
    if (control.current.managed || !control.current.ready || control.current.phase !== '' || snapshot?.applying === true) return null
    if (next !== 'checking' && snapshot?.recoveryRequired === true) return null
    if (next === 'applying' && snapshot?.available !== true) return null
    control.current.phase = next
    const token = ++control.current.generation
    setPhase(next); setError(''); setMessage('')
    return token
  }
  const current = token => token === control.current.generation && !control.current.managed
  const finish = token => {
    if (!current(token)) return false
    control.current.phase = ''; setPhase('')
    return true
  }
  const check = async () => {
    const token = begin('checking')
    if (token === null) return
    try {
      await post('/update/check', undefined, 60_000)
      if (finish(token)) void status.reload()
    } catch (err) {
      if (!finish(token)) return
      await status.reload()
      if (current(token)) setError(String(err?.message ?? err))
    }
  }
  const applyUpgrade = async () => {
    const token = begin('applying')
    if (token === null) return
    setMessage(t('upgrade.phase.download'))
    try {
      const result = await post('/update/apply', {}, 600_000)
      // The response releases controls even when hot reload closes SSE.
      if (!finish(token)) return
      setMessage(result?.version === undefined ? t('upgrade.phase.install') : result.restartRequired === true
        ? t('upgrade.restart').replace('{version}', result.version) : t('upgrade.doneRefresh').replace('{version}', result.version))
      void status.reload()
    } catch (err) {
      if (!finish(token)) return
      setMessage('')
      await status.reload()
      if (current(token)) setError(String(err?.message ?? err))
    }
  }
  const reload = async () => {
    const token = begin('reloading')
    if (token === null) return
    setMessage(t('upgrade.phase.reload'))
    try { await post('/reload') } catch (err) {
      if (!current(token)) return
      setMessage('')
      await status.reload()
      if (current(token)) setError(String(err?.message ?? err))
    } finally { finish(token) }
  }
  const notes = useMemo(() => parseSafeHtml(data?.notes ?? ''), [data?.notes])
  const upToDate = !managed && status.status === 'ready' && data !== undefined && data.latest !== '' && data.available === false
    && data.applying !== true && data.recoveryRequired !== true && data.versionMismatch !== true
  return h(Panel, null,
    h('div', { className: 'ofm_upgradecards' },
      h('span', { className: 'ofm_pill strong' }, `${t('upgrade.current')}: ${data?.current || '…'}`),
      data?.installedVersion !== undefined ? h('span', { className: 'ofm_pill' }, `${t('upgrade.installed')}: ${data.installedVersion || '…'}`) : null,
      data?.latest !== undefined && data.latest !== '' ? h('span', { className: 'ofm_pill' }, `${t('upgrade.latest')}: ${data.latest}`) : null,
      !managed && data?.available === true ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot warn' }), t('upgrade.available').replace('{version}', data.latest)) : null,
      upToDate ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot ok' }), t('upgrade.upToDate')) : null,
      h('span', { className: 'ofm_pill' }, `${t('upgrade.checkedAt')}: ${data?.checkedAt ? ago(data.checkedAt, t.locale) : t('upgrade.never')}`)),
    data?.hotReloadAvailable === false || data?.restartRequired === true ? h('div', { className: 'ofm_callout', role: 'status' }, t('upgrade.restartHint')) : null,
     h('div', { className: 'ofm_row' },
      h(Button, { disabled: managed || phase !== '' || status.status !== 'ready' || data?.applying === true, onClick: check }, !managed && phase === 'checking' ? t('upgrade.checking') : t('upgrade.check')),
      data?.available === true ? h(Button, { kind: 'primary', disabled: managed || status.status !== 'ready' || phase !== '' || data.applying === true || data.recoveryRequired === true, onClick: applyUpgrade }, !managed && phase === 'applying' ? t('upgrade.applying') : t('upgrade.apply')) : null,
      h('a', {
        className: 'ofm_btn ofm_starlink',
        href: 'https://github.com/Ebony-Vinyl/dsh-our-free-model',
        target: '_blank',
        rel: 'noopener noreferrer',
      }, h('span', { 'aria-hidden': 'true' }, '\u2606'), t('upgrade.star'))),
    managed ? h('div', { className: 'ofm_callout', role: 'status' }, t('upgrade.managed')) : null,
    status.status === 'error' ? h('div', { className: 'ofm_callout ofm_error' }, t('loadFailed'), ' ', status.error) : null,
    !managed && phase === 'applying' ? h('div', { className: 'ofm_prog', role: 'progressbar', 'aria-label': t('upgrade.applying') }, h('i')) : null,
    !managed && data?.recoveryRequired === true ? h('div', { className: 'ofm_callout ofm_error' },
      h('div', null, t('upgrade.recovery'),
        data.recoveryBackup ? h('p', { className: 'ofm_note' }, `${t('upgrade.backup')}: ${data.recoveryBackup}`) : null)) : null,
    !managed && data?.versionMismatch === true ? h('div', { className: 'ofm_callout' }, t('upgrade.mismatch')) : null,
    !managed && message !== '' ? h('p', { className: 'ofm_note' }, message) : null,
    !managed && (error || data?.error) ? h('div', { className: 'ofm_callout ofm_error' }, t('upgrade.failed').replace('{message}', error || data.error)) : null,
    notes.length > 0 ? h('div', { className: 'ofm_sec', style: { gap: 4 } },
      h('span', { className: 'ofm_note' }, t('upgrade.notes')),
      h('div', { className: 'ofm_upnotes ofm_newsbody' }, ...htmlToReact(notes))) : null,
    data?.lastApplied !== undefined ? h('p', { className: 'ofm_note' },
      `${t('upgrade.history')}: ${data.lastApplied.ok === true ? '✓' : '✗'} `,
      t('upgrade.from').replace('{from}', data.lastApplied.from ?? '?'),
      ` → ${data.lastApplied.to ?? '?'} · ${ago(data.lastApplied.at, t.locale)}`,
      data.lastApplied.ok === false && data.lastApplied.error ? ` — ${data.lastApplied.error}` : '') : null,
    !managed ? h('p', { className: 'ofm_note' }, (settings.updateCheckHours ?? 0) > 0 ? t('upgrade.auto').replace('{n}', String(settings.updateCheckHours)) : t('upgrade.autoOff')) : null,
    h('div', { className: 'ofm_row' },
      h(Button, { disabled: managed || data?.hotReloadAvailable === false || data?.restartRequired === true || status.status !== 'ready' || phase !== '' || data?.applying === true || data?.recoveryRequired === true, onClick: reload }, phase === 'reloading' && !managed ? t('reload.reloading') : t('reload.now')),
      h(Switch, { checked: !managed && data?.autoReloadWatch === true, disabled: managed || data?.hotReloadAvailable === false || status.status !== 'ready' || phase !== '' || busy, label: t('reload.auto'), onChange: () => { if (!control.current.managed && control.current.ready && control.current.data?.hotReloadAvailable !== false && control.current.phase === '' && !busy) onApply({ autoReloadWatch: !(control.current.data?.autoReloadWatch === true) }) } }),
      managed ? null : h('span', { className: 'ofm_note' }, t('reload.done').replace('{n}', String(settings.reloadCount ?? 0)))))
}

export function UpgradePage(props) {
  const { t, settings, onApply, busy } = props
  return h('div', { className: 'ofm_page' },
    h(PageHero, { title: t('section.upgrade'), sub: t('section.upgradeHint') }),
    h(UpgradePanel, { t, settings, onApply, busy }))
}
