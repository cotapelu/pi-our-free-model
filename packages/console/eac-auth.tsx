/**
 * The co-paid lane's GitHub authorization surface: sign in, star-check, log out.
 *
 * The login is a two-device dance — the console shows a link and a QR-ish code,
 * the user authorizes on GitHub, and the poll returns the identity — so the
 * hook owns the poll and the *cached* identity the whole console reads: an
 * unauthorized install touches no upstream until the user asks it to.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/eac-auth.js
 */

import { createElement: h, useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { Button, Pill, Panel, Section } from './chrome.js'

export function StarButton(props) {
  const { t, repo = POOL_REPO_URL } = props
  const label = t('star.cta')
  return h('a', {
    className: 'ofm_starbtn',
    href: `https://github.com/${repo.replace(/^https?:\/\/github\.com\//, '')}`,
    target: '_blank',
    rel: 'noreferrer noopener',
    title: `${t('star.title')} · ${repo}`,
  }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('path', { d: STAR_GLYPH })),
    label)
}

export function useEacLogin({ t, summary, onAuth }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(restoreEacLogin)
  const [copied, setCopied] = useState(false)
  const starting = useRef(false)
  const cancelling = useRef(false)
  const attempt = useRef(0)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const updatePending = value => {
    pendingRef.current = value
    rememberEacLogin(value)
    setPending(value)
  }
  const refresh = useCallback(() => {
    api('/eac/status', { timeout: 20_000 }).then(onAuth).catch(() => onAuth({ available: true, authorized: false, login: '', unverified: true }))
  }, [onAuth])
  const latest = useRef(summary)
  latest.current = summary
  const latestT = useRef(t)
  latestT.current = t

  // Schedule only after completion: slow gateway responses must not create
  // overlapping collectors. The link survives settings-page remounts.
  useEffect(() => {
    if (pending === null) return undefined
    let alive = true
    let timer
    const poll = async () => {
      const t = latestT.current
      if (!alive || cancelling.current) return
      if (Date.now() - pending.startedAt >= EAC_LOGIN_TTL) {
        updatePending(null); setNotice(t('eac.expired')); return
      }
      try {
        const result = await api(`/eac/login/poll?link=${encodeURIComponent(pending.link)}`, { timeout: 22_000 })
        if (!alive || cancelling.current || pendingRef.current?.link !== pending.link) return
        if (result.status === 'ok') {
          updatePending(null)
          setNotice(t('eac.done').replace('{login}', result.login ?? ''))
          refresh(); latest.current?.reload?.()
          return
        }
        if (result.status === 'expired') {
          updatePending(null); setNotice(t('eac.sessionExpired')); return
        }
        if (result.status === 'unstarred') setNotice(t('eac.needStar').replace('{login}', result.login ?? ''))
        else setNotice('')
      } catch (error) {
        if (!alive || cancelling.current || pendingRef.current?.link !== pending.link) return
        const reason = String(error?.message ?? '')
        if (reason === 'cancelled') { updatePending(null); setNotice(''); return }
        // Never render response HTML, URL or credentials as diagnostics.
        const safe = /^gateway-http-\d{3}$/.test(reason) ? `HTTP ${reason.slice(-3)}`
          : ['unreachable', 'malformed', 'not-writable', 'cancelled', 'no-lane', 'bad-link', 'timeout'].includes(reason) ? reason : 'unreachable'
        setNotice(reason === 'not-writable' ? t('eac.saveFailed') : t('eac.pollFailed').replace('{reason}', safe))
      }
      if (alive && pendingRef.current?.link === pending.link) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2500)
    return () => { alive = false; clearTimeout(timer) }
  }, [pending, refresh])

  const cancel = async () => {
    const currentPending = pendingRef.current
    if (currentPending === null || cancelling.current) return
    cancelling.current = true
    attempt.current++; setBusy(true)
    try {
      const result = await post(`/eac/login/cancel?link=${encodeURIComponent(currentPending.link)}`)
      if (result.ok !== true && result.status !== 'ok') throw new Error('cancellation unconfirmed')
      updatePending(null)
      if (result.status === 'ok') {
        setNotice(latestT.current('eac.done').replace('{login}', result.login ?? ''))
        refresh(); latest.current?.reload?.()
      } else setNotice('')
    } catch {
      const t = latestT.current
      setNotice(t('eac.cancelFailed'))
      // A failed cancellation must retain the link and restart the serial
      // loop. The Host may already have saved it or accepted cancellation.
      updatePending({ ...currentPending })
    } finally { cancelling.current = false; setBusy(false) }
  }
  const login = async () => {
    if (starting.current || cancelling.current || pendingRef.current !== null) return
    starting.current = true
    const current = ++attempt.current
    setBusy(true); setNotice('')
    try {
      const started = await post('/eac/login/start', undefined, 30_000)
      if (current !== attempt.current) return
      if (started?.error !== undefined) { setNotice(t('eac.startFailed').replace('{reason}', started.error)); return }
      updatePending({ link: started.link, url: started.url, startedAt: Date.now() })
      if (started.opened !== true) setNotice(t('eac.openManually'))
    } catch (error) {
      if (current === attempt.current) setNotice(t('eac.startFailed').replace('{reason}', 'unreachable'))
    } finally { starting.current = false; setBusy(false) }
  }
  const logout = async () => {
    attempt.current++; updatePending(null); setBusy(true)
    try {
      await post('/eac/logout')
      refresh(); latest.current?.reload?.()
    } catch { setNotice(t('eac.startFailed').replace('{reason}', 'unreachable')) } finally { setBusy(false) }
  }
  return { busy, notice, pending, copied, setCopied, refresh, login, logout, cancel }
}

export function EacAuth(props) {
  const { t, auth, eacLogin } = props
  const { busy, notice, pending, copied, setCopied, refresh, login, logout, cancel } = eacLogin

  if (auth === undefined) return h('p', { className: 'ofm_note' }, t('loading'))
  if (auth.available !== true) return h('p', { className: 'ofm_note' }, t('eac.noLane'))
  const repo = auth.repo !== undefined && auth.repo !== '' ? auth.repo : 'Ebony-Vinyl/dsh-our-free-model'
  return h(Fragment, null,
    h('div', { className: 'ofm_row' },
      auth.authorized === true
        ? h(Pill, { strong: true, tone: 'ok' }, t('eac.pillOk'))
        : h(Pill, { strong: true, tone: 'warn' }, t('eac.pillLocked')),
      auth.required === true ? h(Pill, { tone: 'err' }, t('eac.pillRequired')) : h(Pill, null, auth.required === false ? t('eac.pillCompat') : t('eac.pillUnknown')),
      auth.unverified === true ? h(Pill, { tone: 'warn' }, t('eac.pillUnverified')) : null),
    h('p', { className: 'ofm_note' }, t('eac.intro').replace('{repo}', repo)),
    auth.authorized === true
      ? h('div', { className: 'ofm_row' },
        h('span', { className: 'ofm_note' }, t('eac.loggedIn').replace('{login}', auth.login !== '' && auth.login !== undefined ? auth.login : '—').replace('{when}', ago(auth.lastCheck, t.locale))),
        h(Button, { disabled: busy, onClick: refresh }, t('eac.recheck')),
        h(Button, { disabled: busy, onClick: logout }, t('eac.logout')))
      : h('div', { className: 'ofm_row' },
        h(Button, { kind: 'primary', disabled: busy || pending !== null, onClick: login }, busy ? t('eac.starting') : t('eac.login')),
        h(StarButton, { t, repo })),
    pending !== null
      ? h('div', { className: 'ofm_callout' },
        h('div', null,
          h('div', null, t('eac.waiting')),
          h(Button, { kind: 'ghost', disabled: busy, onClick: cancel }, t('eac.cancel')),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
            h('a', { href: pending.url, target: '_blank', rel: 'noreferrer noopener', className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, pending.url),
            h(Button, { kind: 'ghost', onClick: () => copy(pending.url, ok => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1600) } }) }, copied ? t('eac.copied') : t('eac.copy')))))
      : null,
    notice !== '' ? h('p', { className: 'ofm_note' }, notice) : null)
}
