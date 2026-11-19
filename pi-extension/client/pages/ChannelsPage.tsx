/**
 * The EAC router channels page: per-provider account management, model toggles,
 * credit balances, daily claim, and auto-checkin.
 *
 * Ported from dsh's `client.js` ChannelsPage function.
 *
 * @module pi-extension/client/pages/ChannelsPage.tsx
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, Section } from '../chrome.js'
import { Switch } from '../chrome.js'
import { CHANNEL_PROVIDERS, CHANNEL_CREDITS, CHANNEL_ICONS } from '../chrome.js'
import { channelTransport, sameChannelTransport } from '../chrome.js'
import { post } from '../api.js'

const ZCODE_PROVIDER_KEY = 'ofm:zcode:login-provider'

function closeLoginPopup(popup) {
  try { if (popup && !popup.closed) popup.close() } catch { /* best effort */ }
}

/** Human text for a millisecond timestamp, or the long-lived marker. */
function expiryText(entry, t) {
  if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= 0) return t('chan.expires.never')
  return ago(entry.expiresAt, t.locale)
}

export function useChannelRpc(ctx) {
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const readTransport = useCallback(() => {
    const current = ctxRef.current
    let connection
    try { connection = current?.connection } catch { /* service not provided yet */ }
    if (connection === undefined || connection === null) {
      try { connection = current?.get?.('connection') } catch { /* service not provided yet */ }
    }
    try {
      const call = connection?.rpc?.call
      return typeof call === 'function' ? { connection, call } : null
    } catch { return null }
  }, [])
  const [transport, setTransport] = useState(readTransport)
  useEffect(() => {
    let alive = true
    const check = () => {
      if (!alive) return
      const next = readTransport()
      setTransport(previous => sameChannelTransport(previous, next) ? previous : next)
    }
    check()
    const timer = setInterval(check, 500)
    return () => { alive = false; clearInterval(timer) }
  }, [readTransport])
  const rpc = useCallback(async (method, payload, timeoutMs = 60_000) => {
    const latest = readTransport()
    if (latest === null) throw new Error('no-connection')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const result = await latest.call.call(latest.connection.rpc, '/api', 'channel-pack', { method, payload }, controller.signal)
      if (result?.ok === true) return result.value
      if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
      return result
    } finally { clearTimeout(timer) }
  }, [readTransport, transport])
  rpc.transport = readTransport
  return { available: transport !== null, rpc }
}

export function ChannelsPage(props) {
  const { t, ctx, summary } = props
  const { available, rpc } = useChannelRpc(ctx)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [auto, setAuto] = useState(undefined)
  const loadAuto = useCallback(async () => {
    if (!available) return
    try { const value = await rpc('usage.autoCheckin', {}, 30_000); setAuto(value?.autoCheckin ?? null) } catch { setAuto(null) }
  }, [available, rpc])
  useEffect(() => { void loadAuto() }, [loadAuto])
  const toggleAuto = async () => {
    try { const value = await rpc('usage.autoCheckin', { enabled: auto?.enabled !== true }, 60_000); setAuto(value?.autoCheckin ?? null) } catch { /* the status refresh tells */ }
  }
  const [statuses, setStatuses] = useState(undefined)
  const [error, setError] = useState('')
  const pack = summary?.channels ?? { state: 'pending', error: '' }
  const [ready, setReady] = useState(pack.state === 'ready')

  const statusGeneration = useRef(0)
  const statusRetry = useRef(null)
  const statusRequest = useRef(0)
  const statusApplied = useRef(0)
  const loadStatus = useCallback(async (attempt = 0, generation = statusGeneration.current) => {
    if (attempt === 0) { clearTimeout(statusRetry.current); statusRetry.current = null }
    if (!available) return
    const request = ++statusRequest.current
    const transport = channelTransport(rpc)
    const current = () => generation === statusGeneration.current && request >= statusApplied.current
      && sameChannelTransport(transport, channelTransport(rpc))
    try {
      const value = await rpc('provider.status', { providers: CHANNEL_PROVIDERS.map(row => row.id) })
      if (!current()) return
      statusApplied.current = request
      setStatuses(value?.statuses ?? {})
      setReady(true)
      setError('')
    } catch (err) {
      if (!current()) return
      if (attempt < 4) {
        clearTimeout(statusRetry.current)
        statusRetry.current = setTimeout(() => { if (current()) void loadStatus(attempt + 1, generation) }, 4000)
        return
      }
      setError(String(err?.message ?? err))
    }
  }, [available, rpc])

  useEffect(() => {
    void loadStatus()
    return () => { statusGeneration.current++; clearTimeout(statusRetry.current); statusRetry.current = null }
  }, [loadStatus])
  useEffect(() => {
    if (!available) return undefined
    const timer = setInterval(() => { void loadStatus() }, 45_000)
    return () => clearInterval(timer)
  }, [available, loadStatus])

  const filteredProviders = CHANNEL_PROVIDERS.filter(channel => {
    if (filter !== '' && channel.id !== filter) return false
    if (query.trim() !== '' && !`${channel.name} ${channel.id} ${channel.note}`.toLowerCase().includes(query.trim().toLowerCase())) return false
    return true
  })

  if (!ready) {
    return h('div', { className: 'ofm_page' },
      h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, t('chan.title')),
            h('p', { className: 'ofm_pagesub' }, t('chan.sub'))),
          h('div', { className: 'ofm_pills' },
            h(Pill, null, `${t('chan.meta.providers')} ${CHANNEL_PROVIDERS.length}`),
            h(Pill, null, t('chan.state.loading')))),
      h('div', { className: 'ofm_chanwrap' },
        [0, 1, 2, 3, 4].map(i => h('div', { className: 'ofm_skel', key: i, style: { minHeight: 120 } }))))
  }

  if (error !== '') {
    return h('div', { className: 'ofm_page' },
      h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, t('chan.title')),
            h('p', { className: 'ofm_pagesub' }, t('chan.sub'))),
          h('div', { className: 'ofm_pills' },
            h(Pill, { tone: 'err' }, t('chan.error')))),
        h('p', { className: 'ofm_note' }, error),
        h(Button, { onClick: () => void loadStatus() }, t('retry')))
  }

  return h('div', { className: 'ofm_page' },
    h('header', { className: 'ofm_hero ofm_glass' },
      h('div', { className: 'ofm_pagehead' },
        h('div', { className: 'ofm_pagetitle' },
          h('h2', null, t('chan.title')),
          h('p', { className: 'ofm_pagesub' }, t('chan.sub'))),
        h('div', { className: 'ofm_pills' },
          h(Pill, null, `${t('chan.meta.providers')} ${CHANNEL_PROVIDERS.length}`),
          h(Pill, null, `${t('chan.meta.enabled')} ${CHANNEL_PROVIDERS.filter(id => statuses?.[id]?.closed !== true).length}`))),
      h('div', { className: 'ofm_row ofm_exttoolbar' },
        h('div', { className: 'ofm_extsearch' },
          h('input', {
            className: 'ofm_input', type: 'search', placeholder: t('chan.search'),
            value: query, onChange: event => setQuery(event.target.value),
          })),
        h('div', { className: 'ofm_seg', role: 'group', 'aria-label': t('chan.filter') },
          [['', t('chan.all')].concat(CHANNEL_PROVIDERS.map(c => [c.id, c.name])).map(([key, label]) =>
            h('button', { key, type: 'button', 'aria-pressed': filter === key ? 'true' : 'false', onClick: () => setFilter(key) }, label)))),
      auto !== undefined ? h('div', { className: 'ofm_row' },
        h(Switch, {
          checked: auto.enabled === true, label: t('chan.autoCheckin'),
          onChange: toggleAuto, disabled: !available,
        }),
        h('span', { className: 'ofm_note' }, auto.nextAt ? t('chan.autoCheckin.next').replace('{at}', new Date(auto.nextAt).toLocaleString(t.locale)) : '')) : null),
    h('div', { className: 'ofm_chanwrap' }, filteredProviders.map(channel => {
      const status = statuses?.[channel.id] ?? {}
      return h(ChannelCard, { key: channel.id, channel, status, rpc, t, onError: setError, onChanged: loadStatus })
    })))
}

export function ChannelCard(props) {
  const { channel, status, rpc, t, onError, onChanged, compact = false, pending = false } = props
  const [open, setOpen] = useState(null)
  const [accounts, setAccounts] = useState(undefined)
  const [models, setModels] = useState(undefined)
  const [credits, setCredits] = useState(undefined)
  const [balances, setBalances] = useState(undefined)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [login, setLogin] = useState(null)
  const modelBatchPending = useRef(false)
  const [balanceError, setBalanceError] = useState('')
  const [balanceLoading, setBalanceLoading] = useState(false)
  const balancePending = useRef(null)
  const balanceGeneration = useRef(0)
  const claimPending = useRef(false)
  const creditCapability = CHANNEL_CREDITS[channel.id]
  const [zcodeProvider, setZcodeProvider] = useState(() => {
    try { return window.localStorage?.getItem(ZCODE_PROVIDER_KEY) === 'zai' ? 'zai' : 'bigmodel' } catch { return 'bigmodel' }
  })
  const loginAttempt = useRef(null)
  const chooseZcodeProvider = value => {
    if (value !== 'bigmodel' && value !== 'zai') return
    setZcodeProvider(value)
    try { window.localStorage?.setItem(ZCODE_PROVIDER_KEY, value) } catch { /* preference still applies this session */ }
  }
  const balanceLabel = creditCapability?.unit === 'tokens' ? t('chan.credits.tokens')
    : creditCapability?.unit === 'dollars' ? t('chan.credits.dollars')
      : creditCapability?.quota ? t('chan.credits.quota') : t('chan.credits.left')

  const accountsCount = status?.accounts?.total ?? 0
  const enabledCount = status?.accounts?.enabled ?? 0
  const modelsTotal = status?.models?.total ?? 0
  const modelsOff = status?.models?.disabled ?? 0
  const connected = status?.closed !== true && enabledCount > 0
  const chanState = status?.closed === true ? 'off' : connected ? 'on' : 'idle'
  const stateText = pending ? t('chan.state.loading') : status?.closed === true ? t('chan.state.closed') : connected ? t('chan.state.on') : t('chan.state.off')

  const loadAccounts = useCallback(async () => {
    try {
      const value = await rpc('account.list', { provider: channel.id })
      setAccounts(value?.accounts ?? [])
    } catch (error) { setAccounts([]); onError(channel, error) }
  }, [rpc, channel.id, onError])
  const loadModels = useCallback(async () => {
    try {
      const value = await rpc('model.list', { provider: channel.id })
      setModels(value?.models ?? [])
    } catch (error) { setModels([]); onError(channel, error) }
  }, [rpc, channel.id, onError])
  const loadCredits = useCallback(async () => {
    if (!CHANNEL_CREDITS[channel.id]?.status) return
    try {
      const value = await rpc('credits.status', { provider: channel.id })
      setCredits(value?.accounts ?? [])
    } catch { setCredits([]) }
  }, [rpc, channel.id])
  const loadBalances = useCallback((afterWrite = false) => {
    if (!CHANNEL_CREDITS[channel.id] || !rpc) return Promise.resolve()
    const pending = balancePending.current
    if (!afterWrite && pending?.provider === channel.id && pending.rpc === rpc) return pending.promise
    const generation = ++balanceGeneration.current
    const request = { provider: channel.id, rpc }
    balancePending.current = request
    setBalanceLoading(true); setBalanceError('')
    request.promise = (async () => {
      try {
        const value = await rpc('credits.balances', { provider: channel.id, ...afterWrite ? { force: true } : {} }, 90_000)
        if (generation === balanceGeneration.current) setBalances(value?.accounts ?? [])
      } catch (error) {
        if (generation === balanceGeneration.current) {
          setBalances([])
          setBalanceError(String(error?.message ?? error))
        }
      } finally {
        if (generation === balanceGeneration.current) setBalanceLoading(false)
        if (balancePending.current === request) balancePending.current = null
      }
    })()
    return request.promise
  }, [rpc, channel.id])
  useEffect(() => {
    setBalances(undefined); setBalanceError('')
    void loadBalances()
    return () => { balanceGeneration.current++; balancePending.current = null }
  }, [loadBalances])
  useEffect(() => {
    if (!CHANNEL_CREDITS[channel.id]) return undefined
    const timer = setInterval(() => { void loadBalances() }, 90_000)
    return () => clearInterval(timer)
  }, [channel.id, loadBalances])
  const balanceOf = accountId => {
    const row = (balances ?? []).find(entry => entry.accountId === accountId)
    return row?.balance === null || row?.balance === undefined ? null : row.balance
  }
  const balancesTotal = (balances ?? []).reduce((sum, row) => sum + (Number.isFinite(row.balance?.total) ? row.balance.total : 0), 0)
  const balancesKnown = (balances ?? []).some(row => Number.isFinite(row.balance?.total))
  const balanceFailures = (balances ?? []).filter(row => row.error || !Number.isFinite(row.balance?.total)).length

  useEffect(() => {
    const onEvent = () => {
      if (open === 'accounts') { void loadAccounts(); void loadCredits() }
      if (open === 'models') void loadModels()
      void loadBalances()
    }
    window.addEventListener('ofm:channels', onEvent)
    return () => window.removeEventListener('ofm:channels', onEvent)
  }, [open, loadAccounts, loadModels, loadCredits, loadBalances])

  const toggle = async fold => {
    if (open === fold) { setOpen(null); return }
    setOpen(fold)
    if (fold === 'accounts') { setAccounts(undefined); await loadAccounts(); void loadCredits(); void loadBalances() }
    if (fold === 'models') { setModels(undefined); await loadModels() }
  }

  useEffect(() => {
    if (loginAttempt.current?.cancelled) {
      loginAttempt.current = null
      setBusy(value => value === 'add' ? '' : value)
    }
    return () => {
      const attempt = loginAttempt.current
      if (attempt) { attempt.cancelled = true; closeLoginPopup(attempt.popup) }
    }
  }, [channel.id])
  useEffect(() => {
    const attempt = loginAttempt.current
    if (!attempt || sameChannelTransport(attempt.transport, channelTransport(rpc))) return
    attempt.cancelled = true
    closeLoginPopup(attempt.popup)
    loginAttempt.current = null
    setBusy(value => value === 'add' ? '' : value)
  }, [rpc])
  const startLogin = async () => {
    if (loginAttempt.current && !loginAttempt.current.cancelled) return
    const attempt = { popup: null, cancelled: false, transport: channelTransport(rpc) }
    const current = () => !attempt.cancelled && sameChannelTransport(attempt.transport, channelTransport(rpc))
    loginAttempt.current = attempt
    setBusy('add'); setNotice('')
    try {
      attempt.popup = window.open('about:blank', '_blank')
      if (attempt.popup) attempt.popup.opener = null
    } catch { closeLoginPopup(attempt.popup); attempt.popup = null }
    try {
      const value = await rpc('account.create', {
        provider: channel.id,
        ...channel.id === 'zcode' ? { zcodeProvider } : {},
      }, 90_000)
      if (!current()) { attempt.cancelled = true; closeLoginPopup(attempt.popup); return }
      const accountId = value?.accountId
      const url = value?.loginUrl
      if (typeof accountId !== 'string' || accountId === '') throw new Error('bad-answer')
      if (typeof url === 'string' && url !== '') {
        const target = new URL(url)
        if (url.length > 2048 || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('bad-login-url')
        let opened = false
        try {
          if (attempt.popup && !attempt.popup.closed) {
            attempt.popup.location.replace(url)
            opened = true
            attempt.popup = null
          }
        } catch { /* the host can open it instead */ }
        closeLoginPopup(attempt.popup); attempt.popup = null
        if (!current()) { attempt.cancelled = true; return }
        if (!opened) {
          try { opened = (await post('/open-external', { url }, 15_000))?.opened === true } catch { /* manual link remains available */ }
        }
        if (!current()) { attempt.cancelled = true; return }
        if (!opened) {
          try { window.open(url, '_blank', 'noopener') } catch { /* the modal offers the link too */ }
        }
      } else { closeLoginPopup(attempt.popup); attempt.popup = null }
      setLogin({ accountId, url: typeof url === 'string' ? url : '', startedAt: Date.now() })
      setOpen('accounts')
    } catch (error) {
      closeLoginPopup(attempt.popup)
      if (current()) onError(channel, error)
    } finally {
      if (loginAttempt.current === attempt && !attempt.cancelled) {
        loginAttempt.current = null
        setBusy('')
      }
    }
  }

  useEffect(() => {
    if (login === null) return undefined
    let alive = true
    const timer = setInterval(async () => {
      if (Date.now() - login.startedAt > 10 * 60_000) {
        if (alive) { setLogin(null); setNotice(t('chan.login.expired')) }
        return
      }
      try {
        const value = await rpc('login.poll', { accountId: login.accountId, provider: channel.id })
        if (!alive) return
        if (value?.done === true) {
          setLogin(null)
          if (value.success === false) {
            setNotice(t('chan.login.failed').replace('{reason}', value.error ?? '未知原因'))
          } else {
            setNotice(t('chan.login.done').replace('{login}', value.login ?? ''))
            onChanged()
            void loadAccounts()
            void loadCredits()
            void loadBalances(true)
          }
        } else if (typeof value?.error === 'string' && value.error !== '') {
          setLogin(null)
          setNotice(t('chan.login.failed').replace('{reason}', value.error))
        }
      } catch { /* the link may still complete; keep polling */ }
    }, 3000)
    return () => { alive = false; clearInterval(timer) }
  }, [login, rpc, channel.id, t, onChanged, loadAccounts, loadCredits, loadBalances])

  const accountAction = async (key, accountId, fn) => {
    setBusy(key); setNotice('')
    try { await fn() } catch (error) { onError(channel, error) } finally { setBusy('') }
  }

  const setAllModels = async disabled => {
    if (busy !== '' || modelBatchPending.current || !rpc || !models?.length) return
    modelBatchPending.current = true
    try {
      await accountAction(disabled ? 'models:hide' : 'models:show', '', async () => {
        await rpc('model.setAllDisabled', { provider: channel.id, disabled })
        await loadModels()
        onChanged()
      })
    } finally { modelBatchPending.current = false }
  }

  const removeAccount = async accountId => {
    const entry = (accounts ?? []).find(row => row.id === accountId)
    if (typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm(t('chan.confirm.delete').replace('{name}', entry?.nickname ?? accountId))) return
    await accountAction('del:' + accountId, accountId, async () => {
      await rpc('account.delete', { accountId })
      onChanged(); await loadAccounts(); void loadBalances(true)
    })
  }

  const claim = async () => {
    if (!creditCapability?.claim || busy !== '' || claimPending.current) return
    claimPending.current = true
    setBusy('claim'); setNotice('')
    try {
      const value = await rpc('credits.claimAll', { provider: channel.id }, 180_000)
      const summary = value?.summary ?? value
      const claimed = Number(summary?.claimed ?? 0)
      const credit = Number(summary?.totalCredit ?? 0)
      const failed = (value?.results ?? []).filter(row => row.outcome?.kind === 'failed')
      const successText = t('chan.claim.result').replace('{count}', String(claimed)).replace('{credit}', String(credit))
      const failureText = t('chan.claim.failed').replace('{reason}', failed.map(row => row.outcome.message).join('；'))
      setNotice(failed.length > 0 ? claimed > 0 ? `${successText}；${failureText}` : failureText
        : claimed > 0 ? successText : t('chan.claim.none'))
      void loadCredits(); void loadBalances(true)
    } catch (error) { onError(channel, error) } finally { claimPending.current = false; setBusy('') }
  }

  const creditFor = accountId => (credits ?? []).find(row => row.accountId === accountId)?.status ?? null
  const [expanded, setExpanded] = useState(false)

  const card = h('article', {
    className: `ofm_chan ${compact ? 'compact' : 'ofm_glass'}${status?.closed === true ? ' off' : ''}`,
    'data-state': chanState,
    'data-channel': channel.id,
    style: { '--chan-accent': channel.accent },
  },
    h('div', { className: 'ofm_chanhead' },
      h('span', { className: 'ofm_chanlogo', 'aria-hidden': 'true' },
        CHANNEL_ICONS[channel.id] !== undefined
          ? h('img', { src: CHANNEL_ICONS[channel.id], alt: '' })
          : channel.name.slice(0, 2).toUpperCase()),
      h('span', { className: 'ofm_chanid' },
        h('b', null, channel.name),
        h('span', null, channel.org)),
      h('span', { className: 'ofm_chanstate' },
        h('span', { className: `ofm_dot ${connected ? 'ok' : status?.closed === true ? 'err' : ''}` }),
        stateText)),
    h('p', { className: 'ofm_note' }, channel.note),
    h('div', { className: 'ofm_chanmeta' },
      h('span', null, `${t('chan.meta.accounts')} `, h('b', null, `${enabledCount}/${accountsCount}`)),
      h('span', null, `${t('chan.meta.models')} `, h('b', null, modelsTotal === 0 ? '—' : `${modelsTotal - modelsOff}/${modelsTotal}`)),
      creditCapability ? h('span', { className: 'ofm_credittotal' },
        `${balanceLabel} `,
        h('b', null, balanceLoading ? '…' : balancesKnown
          ? creditCapability.quota ? t('chan.credits.loaded').replace('{count}', String((balances ?? []).filter(row => Number.isFinite(row.balance?.total)).length)) : kilo(balancesTotal)
          : balances === undefined ? '…' : '—')) : null),
    compact ? h('div', { className: 'ofm_directoryactions' },
      h('span', { className: 'ofm_id' }, channel.id),
      h('button', {
        type: 'button', className: `ofm_btn ${accountsCount > 0 || expanded ? 'ghost' : 'primary'}`,
        disabled: !rpc || busy !== '', 'aria-expanded': expanded,
        'aria-controls': `ofm-channel-${channel.id}`,
        onClick: () => {
          if (expanded) { setExpanded(false); return }
          setExpanded(true)
          if (accountsCount > 0) { if (open !== 'accounts') void toggle('accounts') }
          else void startLogin()
        },
      }, expanded ? t('chan.collapse') : accountsCount > 0 ? t('chan.manage') : t('chan.connect'))) : null,
    !compact || expanded ? h('div', {
      className: compact ? 'ofm_directorydetail' : undefined, id: `ofm-channel-${channel.id}`,
    },
    h('div', { className: 'ofm_chanacts' },
      channel.id === 'zcode' ? h('div', { className: 'ofm_seg', role: 'group', 'aria-label': t('chan.zcode.provider') },
        h('button', {
          type: 'button', disabled: busy !== '' || !rpc,
          'aria-pressed': zcodeProvider === 'bigmodel',
          onClick: () => chooseZcodeProvider('bigmodel'),
        }, t('chan.zcode.bigmodel')),
        h('button', {
          type: 'button', disabled: busy !== '' || !rpc,
          'aria-pressed': zcodeProvider === 'zai',
          onClick: () => chooseZcodeProvider('zai'),
        }, t('chan.zcode.zai'))) : null,
      h('button', { type: 'button', className: 'ofm_btn', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'add' ? 'true' : undefined, onClick: startLogin }, busy === 'add' ? '…' : t('chan.act.add')),
      accountsCount > 0 ? h('button', {
        type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'refreshAll' ? 'true' : undefined,
        onClick: () => accountAction('refreshAll', '', async () => {
          for (const row of accounts ?? await rpc('account.list', { provider: channel.id }).then(v => v?.accounts ?? [])) {
            try { await rpc('account.refresh', { accountId: row.id }, 90_000) } catch (error) { onError(channel, error) }
          }
          onChanged(); await loadAccounts(); void loadBalances(true)
        }),
      }, busy === 'refreshAll' ? '…' : t('chan.act.refresh')) : null,
      creditCapability ? h('button', {
        type: 'button', className: 'ofm_btn ghost', disabled: balanceLoading || busy !== '' || !rpc,
        'aria-busy': balanceLoading ? 'true' : undefined, onClick: () => void loadBalances(true),
      }, balanceLoading ? t('chan.credits.loading') : t('chan.credits.refresh')) : null,
      creditCapability?.claim ? h('button', {
        type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'claim' ? 'true' : undefined,
        onClick: claim,
      }, busy === 'claim' ? '…' : t('chan.act.claim')) : null,
      h('button', { type: 'button', className: 'ofm_foldtoggle', disabled: !rpc, 'data-open': open === 'accounts' ? 'true' : 'false', onClick: () => void toggle('accounts') },
        h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
        t('chan.fold.accounts'), accounts === undefined ? null : ` (${accounts.length})`),
      h('button', { type: 'button', className: 'ofm_foldtoggle', disabled: !rpc, 'data-open': open === 'models' ? 'true' : 'false', onClick: () => void toggle('models') },
        h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
        t('chan.fold.models'), models === undefined ? null : ` (${models.length})`)),
    notice !== '' ? h('p', { className: 'ofm_note' }, notice) : null,
    balanceError !== '' ? h('p', { className: 'ofm_balanceerror', role: 'alert' },
      t('chan.credits.failed').replace('{reason}', balanceError))
      : balanceFailures > 0 ? h('p', { className: 'ofm_balanceerror', role: 'status' },
        t('chan.credits.partial').replace('{count}', String(balanceFailures))) : null,
    open === 'accounts' ? h('div', { className: 'ofm_chanfold' },
      accounts === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
        : accounts.length === 0 ? h('p', { className: 'ofm_note' }, t('chan.noAccount'))
          : h('div', { className: 'ofm_acctlist' }, accounts.map(row => {
            const credit = creditFor(row.id)
            const pending = row.refreshable !== true && !Number.isFinite(row.expiresAt)
            return h('div', { className: 'ofm_acct' + (pending ? ' pending' : ''), key: row.id },
              h('span', { className: 'ofm_acctname', title: row.nickname ?? row.id }, row.nickname ?? row.id),
              h('span', { className: 'ofm_acctmeta' }, row.enabled === false ? t('chan.disabled') : t('chan.enabled'), ' · ', expiryText(row, t)),
              credit?.todayCheckedIn === true && Number.isFinite(credit.todayCredit) ? h('span', { className: 'ofm_creditbadge' },
                t('chan.credit.today').replace('{credit}', String(credit.todayCredit))) : null,
              (() => {
                const balance = balanceOf(row.id)
                if (!creditCapability) return null
                if (balanceLoading) return h('span', { className: 'ofm_note' }, t('chan.credits.loading'))
                const result = (balances ?? []).find(entry => entry.accountId === row.id)
                if (balance === null || !Number.isFinite(balance.total)) return h('span', { className: 'ofm_balanceerror' },
                  balanceError ? t('chan.credits.failed').replace('{reason}', balanceError)
                    : result?.error || t('chan.credits.unavailable'))
                const reading = creditCapability.quota
                  ? (balance.packages ?? []).map(pkg => `${pkg.name} ${pkg.remaining}%`).join(' · ') || '—'
                  : kilo(balance.total)
                return h('span', { className: 'ofm_creditbadge strong', title: balanceLabel },
                  `${balanceLabel} ${reading}`)
              })(),
              h('span', { className: 'ofm_acctacts' },
                h('button', {
                  type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                  onClick: () => accountAction('test:' + row.id, row.id, async () => {
                    const value = await rpc('account.test', { accountId: row.id }, 90_000)
                    setNotice(value?.ok === false
                      ? t('chan.test.failed').replace('{reason}', value?.error ?? value?.message ?? '')
                      : t('chan.test.ok').replace('{ms}', String(value?.ms ?? value?.latencyMs ?? '—')))
                  }),
                }, t('chan.act.test')),
                h('button', {
                  type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                  onClick: () => accountAction('refresh:' + row.id, row.id, async () => {
                    await rpc('account.refresh', { accountId: row.id }, 90_000)
                    onChanged(); await loadAccounts(); void loadBalances(true)
                  }),
                }, t('chan.act.refresh')),
                h('button', {
                  type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                  onClick: () => accountAction('toggle:' + row.id, row.id, async () => {
                    await rpc('account.update', { accountId: row.id, patch: { enabled: row.enabled === false } })
                    onChanged(); await loadAccounts()
                  }),
                }, row.enabled === false ? t('chan.act.enable') : t('chan.act.disable')),
                h('button', {
                  type: 'button', className: 'ofm_minibtn danger', disabled: busy !== '' || !rpc,
                  onClick: () => void removeAccount(row.id),
                }, t('chan.act.delete'))))
          }))) : null,
    open === 'models' ? h('div', { className: 'ofm_chanfold' },
      models === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
        : models.length === 0 ? h('p', { className: 'ofm_note' }, '—')
          : h(Fragment, null,
            h('div', { className: 'ofm_row' },
              h('span', { className: 'ofm_note' }, t('chan.model.enabledCount')
                .replace('{enabled}', String(models.filter(model => model.disabled !== true).length))
                .replace('{total}', String(models.length))),
              h('button', {
                type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc,
                title: t('chan.model.allScope'), 'aria-busy': busy === 'models:show' ? 'true' : undefined,
                onClick: () => void setAllModels(false),
              }, t('chan.model.enableAll')),
              h('button', {
                type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc,
                title: t('chan.model.allScope'), 'aria-busy': busy === 'models:hide' ? 'true' : undefined,
                onClick: () => void setAllModels(true),
              }, t('chan.model.disableAll'))),
            h('div', { className: 'ofm_modellist' }, models.map(model => h('div', {
            className: 'ofm_modelrow' + (model.disabled === true ? ' off' : ''),
            key: model.id,
          },
          h('span', { className: 'ofm_id', title: model.id }, model.name ?? model.id),
          model.isFree === true ? h('span', { className: 'ofm_tagpill free' }, t('chan.model.free')) : null,
          model.dead === true ? h('span', { className: 'ofm_tagpill dead' }, t('chan.model.dead')) : null,
          model.disabled === true ? h('span', { className: 'ofm_tagpill' }, t('chan.model.hidden')) : null,
          h('button', {
            type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
            onClick: () => accountAction('model:' + model.id, '', async () => {
              if (model.dead === true) await rpc('model.clearDead', { provider: channel.id, modelId: model.id })
              else await rpc('model.setDisabled', { provider: channel.id, modelId: model.id, disabled: model.disabled !== true })
              await loadModels(); onChanged()
            }),
          }, model.dead === true ? t('chan.model.restore') : model.disabled === true ? t('chan.model.on') : t('chan.model.off'))))))) : null) : null)

  const modal = login === null ? null : h('div', { className: 'ofm_scrim' },
    h('div', { className: 'ofm_modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('chan.login.title').replace('{name}', channel.name) },
      h('div', { className: 'ofm_modalhead' }, t('chan.login.title').replace('{name}', channel.name)),
      h('div', { className: 'ofm_modalbody ofm_loginbody' },
        h('div', { className: 'ofm_loginstep' }, h('b', null, '1'), h('span', null, t('chan.login.step1'))),
        h('div', { className: 'ofm_loginstep' }, h('b', null, '2'), h('span', null, t('chan.login.step2'))),
        login.url === '' ? null : h('code', { className: 'ofm_mono', style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, login.url),
        h('p', { className: 'ofm_note ofm_scanline' }, t('chan.login.waiting'))),
      h('div', { className: 'ofm_modalfoot' },
        login.url === '' ? null : h('a', { className: 'ofm_btn primary', href: login.url, target: '_blank', rel: 'noreferrer noopener' }, t('chan.login.open')),
        h('button', { type: 'button', className: 'ofm_btn ghost', onClick: () => setLogin(null) }, t('chan.login.cancel')))))

  return h(Fragment, null, card, modal)
}