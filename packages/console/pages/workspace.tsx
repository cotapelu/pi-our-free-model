/**
 * Workspace page: engine tools and subscription accounts.
 *
 * Ported from dsh's `client.js` WorkspacePage, ModelWorkspace, SubscriptionsPage.
 *
 * @module pi-extension/client/pages/workspace.tsx
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, Section, Switch, PanelSkeleton, PanelError, usePanel, SUBSCRIPTION_PROVIDERS, WORKSPACE_CSS, WorkspaceIcon, post } from '../chrome.js'

/** The engine workspace iframe panel. */
export function ModelWorkspace({ t, summary }) {
  const [state, setState] = useState('starting')
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState(0)
  const frame = useRef(null)
  const anchor = useRef(null)
  const closeButton = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const [portal, setPortal] = useState(null)

  const syncTheme = () => {
    const root = anchor.current?.closest('.ofm_root') ?? document.documentElement
    const style = window.getComputedStyle(root)
    const variables = {}
    for (const token of ['label-primary', 'label-secondary', 'label-tertiary', 'label-on-accent', 'bg-layer-1', 'bg-layer-2',
      'bg-layer-3', 'border-l1', 'border-l2', 'state-business-primary', 'state-success-primary', 'state-error-primary', 'state-warning-primary']) {
      const name = `--dsw-alias-${token}`
      const value = style.getPropertyValue(name).trim()
      if (value) variables[name] = value
    }
    const themed = root.closest('[data-theme]')
      ?? document.querySelector('[data-theme]')
    const colorScheme = themed?.getAttribute('data-theme')
      ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    frame.current?.contentWindow?.postMessage({
      type: 'ofm:engine-theme', variables, fontFamily: style.fontFamily,
      colorScheme: colorScheme === 'dark' ? 'dark' : 'light', externalControls: true,
    }, window.location.origin)
  }

  useEffect(() => {
    if (state !== 'ready') return
    const observer = new MutationObserver(syncTheme)
    const root = anchor.current?.closest('.ofm_root') ?? document.documentElement
    for (let node = root; node; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', syncTheme)
    return () => { observer.disconnect(); media?.removeEventListener?.('change', syncTheme) }
  }, [state, expanded])

  useEffect(() => {
    if (!expanded) { setPortal(null); return }
    const host = document.createElement('div')
    host.setAttribute('data-ofm-workspace-root', 'true')
    document.body.appendChild(host)
    const root = anchor.current?.closest('.ofm_shell')
    const wasInert = root?.inert
    const focused = document.activeElement
    if (root) root.inert = true
    setPortal(host)
    const escape = event => {
      if (event.key === 'Escape') setExpanded(false)
    }
    let frameEscape = null
    const bindFrame = () => {
      try {
        const doc = frame.current?.contentDocument
        if (!doc || frameEscape) return
        frameEscape = doc
        doc.addEventListener('keydown', escape)
      } catch { /* cross-origin engine page: the parent listener still applies */ }
    }
    bindFrame()
    const frameTimer = setInterval(bindFrame, 400)
    const focus = event => {
      if (!host.contains(event.target)) closeButton.current?.focus()
    }
    window.addEventListener('keydown', escape)
    document.addEventListener('focusin', focus)
    return () => {
      clearInterval(frameTimer)
      window.removeEventListener('keydown', escape)
      document.removeEventListener('focusin', focus)
      try { frameEscape?.removeEventListener('keydown', escape) } catch { /* frame already gone */ }
      if (root) root.inert = wasInert
      host.remove()
      if (focused?.isConnected) focused.focus?.()
    }
  }, [expanded])

  useEffect(() => { if (portal) closeButton.current?.focus() }, [portal])

  useEffect(() => {
    const changed = event => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow
        || event.data?.type !== 'ofm:engine-changed') return
      void post('/engine/refresh', {}, 30_000).then(() => summary?.reload?.()).catch(() => {})
    }
    window.addEventListener('message', changed)
    return () => window.removeEventListener('message', changed)
  }, [summary?.reload])

  useEffect(() => {
    let alive = true
    setState('starting'); setError('')
    post('/engine/start', {}, 120_000).then(() => {
      if (alive) { setState('ready'); summary?.reload?.() }
    }).catch(() => {
      if (alive) { setState('error'); setError(t('engine.failed')) }
    })
    return () => { alive = false }
  }, [generation])

  const refresh = async () => {
    try { await post('/engine/refresh', {}, 30_000); summary?.reload?.() }
    catch { setError(t('engine.failed')) }
  }

  const engineAction = action => frame.current?.contentWindow?.postMessage({
    type: 'ofm:engine-action', action,
  }, window.location.origin)

  const toolbar = h('header', { className: 'ofm_enginebar' },
    h('h2', null, t('engine.title')),
    h('div', { className: 'ofm_enginetools', role: 'group', 'aria-label': t('engine.title') },
      h('button', { ref: closeButton, type: 'button', className: 'ofm_engineicon',
        title: expanded ? t('engine.close') : t('engine.expand'),
        'aria-label': expanded ? t('engine.close') : t('engine.expand'),
        onClick: () => setExpanded(value => !value) }, h(WorkspaceIcon, { name: expanded ? 'close' : 'expand' })),
      state === 'ready' ? h('button', { type: 'button', className: 'ofm_engineicon',
        title: t('engine.refresh'), 'aria-label': t('engine.refresh'),
        onClick: () => { engineAction('refresh'); void refresh() } }, h(WorkspaceIcon, { name: 'refresh' })) : null,
      state === 'ready' ? h('button', { type: 'button', className: 'ofm_engineicon',
        title: t('engine.settings'), 'aria-label': t('engine.settings'),
        onClick: () => engineAction('settings') }, h(WorkspaceIcon, { name: 'settings' })) : null))

  const content = h(Fragment, null,
    toolbar,
    error ? h('div', { className: 'ofm_callout ofm_error', role: 'alert' }, error) : null,
    state === 'ready'
      ? h('iframe', { ref: frame, className: 'ofm_engineframe', src: `${API}/engine/ui/?mode=window&view=providers`, title: t('engine.title'),
        allow: 'clipboard-write', referrerPolicy: 'same-origin', onLoad: event => {
          syncTheme()
          const doc = event.currentTarget.contentDocument
          if (!doc || doc.getElementById('ofm-workspace-layout')) return
          const style = doc.createElement('style')
          style.id = 'ofm-workspace-layout'
          style.textContent = WORKSPACE_CSS
          doc.head.appendChild(style)
        } })
      : h('div', { className: 'ofm_engineempty' },
        h('span', { className: state === 'starting' ? 'ofm_note ofm_enginestarting' : 'ofm_note', role: 'status' },
          state === 'starting' ? t('engine.starting') : t('engine.failed')),
        state === 'error' ? h(Button, { kind: 'primary', onClick: () => setGeneration(value => value + 1) }, t('engine.start')) : null))

  return h('div', { className: 'ofm_page ofm_engineworkspace', ref: anchor },
    expanded && portal ? ReactDOM.createPortal(
      h('div', { className: 'ofm_root ofm_engineoverlay', role: 'dialog', 'aria-modal': 'true',
        'aria-label': t('engine.title'), 'data-ofm-effects': 'off' }, content), portal) : content)
}

/** Subscription accounts management page. */
export function SubscriptionsPage({ t, summary }) {
  const panel = usePanel(() => api('/subscriptions'), [])
  const [editor, setEditor] = useState(null)
  const [candidates, setCandidates] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)

  const mutate = async (action, body) => {
    if (pending.current) return false
    pending.current = true
    setBusy(`${action}:${body.id ?? ''}`); setError('')
    try {
      const result = await post(`/subscriptions/${action}`, body, action === 'quota' ? 120_000 : 15_000)
      if (!Array.isArray(result.accounts)) throw new Error()
      panel.patch({ accounts: result.accounts })
      if (action !== 'quota') summary?.reload?.()
      return true
    } catch {
      setError(t('sub.operationFailed'))
      return false
    } finally { pending.current = false; setBusy('') }
  }

  const discover = async () => {
    if (pending.current) return
    pending.current = true
    setBusy('discover'); setError('')
    try {
      const result = await api('/subscriptions/discover', { timeout: 15_000 })
      const rows = result.accounts ?? result.candidates
      if (!Array.isArray(rows)) throw new Error()
      setCandidates(rows.filter(row => ['codex', 'claude', 'gemini'].includes(row.provider))
        .map(row => ({ id: row.id, provider: row.provider })))
    } catch { setError(t('sub.operationFailed')) }
    finally { pending.current = false; setBusy('') }
  }

  const accounts = panel.data?.accounts ?? []

  return h('div', { className: 'ofm_page ofm_subscriptions' },
    h('header', { className: 'ofm_directoryhero' },
      h('div', { className: 'ofm_pagehead' },
        h('div', { className: 'ofm_pagetitle' }, h('h2', null, t('sub.title'))),
        h(Pill, null, t('sub.accounts').replace('{n}', String(accounts.length)))),
      h('div', { className: 'ofm_row' },
        h(Button, { kind: 'primary', disabled: !!busy || panel.status !== 'ready',
          onClick: () => { setEditor({}); setError('') } }, t('sub.add')),
        h(Button, { disabled: !!busy || panel.status !== 'ready', onClick: discover },
          busy === 'discover' ? t('sub.working') : t('sub.discover')))),
    panel.status === 'loading' ? h(PanelSkeleton) : null,
    panel.error ? h(PanelError, { t, title: t('sub.loadFailed'), message: t('sub.operationFailed'), onRetry: panel.reload }) : null,
    error ? h('div', { className: 'ofm_callout ofm_error', role: 'alert' }, error) : null,
    editor ? h(SubscriptionImport, {
      key: editor.provider ?? 'manual', t, localProvider: editor.provider, busy: !!busy,
      onImport: mutate, onCancel: () => setEditor(null),
    }) : null,
    candidates !== null ? h('section', { className: 'ofm_subcandidates', 'aria-label': t('sub.candidates') },
      h('b', null, t('sub.candidates')),
      candidates.length === 0 ? h('span', { className: 'ofm_note' }, t('sub.noCandidates'))
        : candidates.map(row => h('div', { key: row.id, className: 'ofm_directoryactions' },
          h('span', null, SUBSCRIPTION_PROVIDERS[row.provider]),
          h(Button, { disabled: !!busy, onClick: () => { setEditor({ provider: row.provider }); setError('') } }, t('sub.review'))))) : null,
    panel.status === 'ready' ? accounts.length
      ? accounts.map(account => h(SubscriptionAccount, { key: account.id, t, account, busy, mutate }))
      : h('p', { className: 'ofm_note' }, t('sub.empty')) : null)
}

/** Import form for subscription accounts. */
function SubscriptionImport(props) {
  const { t, localProvider, busy, onImport, onCancel } = props
  const [provider, setProvider] = useState(localProvider ?? 'codex')
  const [mode, setMode] = useState('manual')
  const [session, setSession] = useState('')
  const [token, setToken] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [scope, setScope] = useState('')
  const [headers, setHeaders] = useState('')

  const providers = ['codex', 'claude', 'gemini', 'kilo']
  const manualFields = mode === 'manual' ? h(Fragment, null,
    h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note', style: { minWidth: 100 } }, t('sub.field.session')),
      h('input', { className: 'ofm_input', value: session, onChange: e => setSession(e.target.value), placeholder: t('sub.placeholder.session') })),
    h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note', style: { minWidth: 100 } }, t('sub.field.token')),
      h('input', { className: 'ofm_input', type: 'password', value: token, onChange: e => setToken(e.target.value), placeholder: t('sub.placeholder.token') })),
    h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note', style: { minWidth: 100 } }, t('sub.field.endpoint')),
      h('input', { className: 'ofm_input', value: endpoint, onChange: e => setEndpoint(e.target.value), placeholder: t('sub.placeholder.endpoint') })),
    h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note', style: { minWidth: 100 } }, t('sub.field.scope')),
      h('input', { className: 'ofm_input', value: scope, onChange: e => setScope(e.target.value), placeholder: t('sub.placeholder.scope') })),
    h('div', { className: 'ofm_row' },
      h('span', { className: 'ofm_note', style: { minWidth: 100 } }, t('sub.field.headers')),
      h('textarea', { className: 'ofm_input', value: headers, onChange: e => setHeaders(e.target.value), placeholder: t('sub.placeholder.headers'), style: { minHeight: 60 } })) : null

  const submit = async () => {
    const body = { provider, mode }
    if (mode === 'manual') { body.session = session; body.token = token; body.endpoint = endpoint; body.scope = scope; body.headers = headers }
    else { body.session = session }
    const ok = await onImport('add', body)
    if (ok) onCancel()
  }

  return h('div', { className: 'ofm_page ofm_subimport' },
    h('header', { className: 'ofm_directoryhero' },
      h('div', { className: 'ofm_pagehead' },
        h('div', { className: 'ofm_pagetitle' }, h('h2', null, t('sub.import'))),
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'ghost', onClick: onCancel }, t('sub.cancel')),
          h(Button, { kind: 'primary', disabled: busy, onClick: submit }, t('sub.import'))))),
    h('div', { className: 'ofm_panel' },
      h('div', { className: 'ofm_row' },
        h('span', { className: 'ofm_note', style: { minWidth: 100 } }, t('sub.provider')),
        h('select', { className: 'ofm_input', value: provider, onChange: e => setProvider(e.target.value), style: { minWidth: 140 } },
          providers.map(p => h('option', { key: p, value: p }, SUBSCRIPTION_PROVIDERS[p])))),
      h('div', { className: 'ofm_row' },
        h('span', { className: 'ofm_note', style: { minWidth: 100 } }, t('sub.mode')),
        h('div', { className: 'ofm_seg', role: 'group' },
          h('button', { type: 'button', 'aria-pressed': mode === 'manual' ? 'true' : 'false', onClick: () => { setMode('manual'); setSession('') } }, t('sub.mode.manual')),
          h('button', { type: 'button', 'aria-pressed': mode === 'oauth' ? 'true' : 'false', onClick: () => { setMode('oauth'); setSession('') } }, t('sub.mode.oauth')))),
      manualFields,
      mode === 'oauth' ? h('div', { className: 'ofm_row' },
        h('span', { className: 'ofm_note', style: { minWidth: 100 } }, t('sub.field.session')),
        h('input', { className: 'ofm_input', value: session, onChange: e => setSession(e.target.value), placeholder: t('sub.placeholder.session') })) : null)
}

/** Individual subscription account card. */
function SubscriptionAccount(props) {
  const { t, account, busy, mutate } = props
  const [expanded, setExpanded] = useState(false)
  const isBusy = busy.startsWith(`toggle:${account.id}`) || busy.startsWith(`quota:${account.id}`) || busy.startsWith(`del:${account.id}`)
  const providerLabel = SUBSCRIPTION_PROVIDERS[account.provider] ?? account.provider

  return h('article', { className: 'ofm_card ofm_subcard' + (expanded ? ' expanded' : ''), key: account.id },
    h('div', { className: 'ofm_subhead' },
      h('div', { className: 'ofm_subtitle' },
        h('span', { className: 'ofm_chantag' }, providerLabel),
        h('b', null, account.nickname ?? account.id),
        h('span', { className: 'ofm_id' }, account.id)),
      h('div', { className: 'ofm_submeta' },
        h('span', null, account.enabled === false ? t('sub.disabled') : t('sub.enabled')),
        account.expiresAt && Number.isFinite(account.expiresAt) ? h('span', null, ago(account.expiresAt, t.locale)) : null,
        account.quota && Number.isFinite(account.quota.used) ? h('span', { className: 'ofm_creditbadge' },
          t('sub.quota').replace('{used}', kilo(account.quota.used)).replace('{total}', kilo(account.quota.total))) : null)),
    h('div', { className: 'ofm_subacts' },
      h('button', { type: 'button', className: 'ofm_minibtn', disabled: isBusy,
        onClick: () => mutate('toggle', { id: account.id, enabled: account.enabled === false }) },
        account.enabled === false ? t('sub.enable') : t('sub.disable')),
      account.provider !== 'kilo' ? h('button', { type: 'button', className: 'ofm_minibtn', disabled: isBusy,
        onClick: () => mutate('quota', { id: account.id }) }, t('sub.refreshQuota')) : null,
      h('button', { type: 'button', className: 'ofm_minibtn', disabled: isBusy, onClick: () => setExpanded(!expanded) }, expanded ? t('sub.collapse') : t('sub.expand')),
      h('button', { type: 'button', className: 'ofm_minibtn danger', disabled: isBusy,
        onClick: () => { if (window.confirm(t('sub.confirmDelete').replace('{name}', account.nickname ?? account.id))) mutate('delete', { id: account.id }) } }, t('sub.delete'))),
    expanded ? h('div', { className: 'ofm_subdetail' },
      h('div', { className: 'ofm_kv' },
        h('div', { className: 'ofm_kvc' }, h('b', null, account.provider), h('span', null, t('sub.field.provider'))),
        h('div', { className: 'ofm_kvc' }, h('b', null, account.id), h('span', null, t('sub.field.id'))),
        account.endpoint ? h('div', { className: 'ofm_kvc' }, h('b', null, account.endpoint), h('span', null, t('sub.field.endpoint'))) : null,
        account.scope ? h('div', { className: 'ofm_kvc' }, h('b', null, account.scope), h('span', null, t('sub.field.scope'))) : null,
        account.headers && Object.keys(account.headers).length > 0 ? h('div', { className: 'ofm_kvc' }, h('b', null, JSON.stringify(account.headers)), h('span', null, t('sub.field.headers'))) : null,
        account.token ? h('div', { className: 'ofm_kvc' }, h('b', null, '••••'), h('span', null, t('sub.field.token'))) : null,
        account.session ? h('div', { className: 'ofm_kvc' }, h('b', null, '••••'), h('span', null, t('sub.field.session'))) : null))
      : null)
}

export function WorkspacePage({ t, summary, section, onSelect }) {
  const [visited, setVisited] = useState(() => new Set([section]))
  useEffect(() => {
    try { window.localStorage?.setItem('ofm.workspace.section', section) } catch { /* current page still toggles */ }
  }, [section])
  const sections = [['tools', t('engine.tools')], ['accounts', t('sub.title')]]
  const select = next => { onSelect(next); setVisited(previous => new Set([...previous, next])) }
  return h('div', { className: 'ofm_page ofm_modelworkspace' },
    h('div', { className: 'ofm_workspacetabs', role: 'tablist', 'aria-label': t('engine.title'),
      onKeyDown: event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'tools' : event.key === 'End' ? 'accounts'
          : section === 'tools' ? 'accounts' : 'tools'
        select(next)
        event.currentTarget.querySelector(`#ofm-workspace-tab-${next}`)?.focus()
      } },
      sections.map(([id, label]) => h('button', { key: id, type: 'button',
        className: 'ofm_workspacetab', role: 'tab', id: `ofm-workspace-tab-${id}`,
        'aria-controls': `ofm-workspace-view-${id}`, 'aria-selected': section === id ? 'true' : 'false',
        tabIndex: section === id ? 0 : -1, onClick: () => select(id) }, label))),
    sections.filter(([id]) => visited.has(id)).map(([id]) => h('div', {
      key: id, className: 'ofm_workspaceview', hidden: section !== id, role: 'tabpanel',
      id: `ofm-workspace-view-${id}`, 'aria-labelledby': `ofm-workspace-tab-${id}`,
    }, id === 'tools' ? h(ModelWorkspace, { t, summary }) : h(SubscriptionsPage, { t, summary }))))
}

import { API } from '../api.js'
import ReactDOM from 'react-dom'