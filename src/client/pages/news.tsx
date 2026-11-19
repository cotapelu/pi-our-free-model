/**
 * The announcement centre: what this machine has been told.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/news.js
 */

import { createElement: h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, PageHero, Panel, Section, PanelSkeleton, PanelError } from '../chrome.js'

export function NewsPanel(props) {
  const { t } = props
  const news = useAsync(() => api('/announcements'), [])
  const [busy, setBusy] = useState(false)
  const [osError, setOsError] = useState('')
  // Collapsed by default: the header row carries the status, and the body
  // opens only while there is something unread to read.
  const [open, setOpen] = useState(false)
  const items = news.data?.items ?? []
  const unread = news.data?.unread ?? 0
  useEffect(() => {
    if (unread > 0) setOpen(true)
  }, [unread])
  // Live refresh: the push subscription broadcasts to window on arrival.
  useEffect(() => {
    const handler = () => news.reload()
    window.addEventListener('ofm:announcements', handler)
    return () => window.removeEventListener('ofm:announcements', handler)
  }, [news.reload])
  const notifyOs = news.data?.notifyOs === true
  const ack = async payload => {
    setBusy(true)
    try { await post('/announcements/ack', payload); news.reload() } finally { setBusy(false) }
  }
  const refresh = async () => {
    setBusy(true)
    try { await post('/announcements/refresh', undefined, 60_000); news.reload() } finally { setBusy(false) }
  }
  const enableOs = async () => {
    setOsError('')
    if (typeof Notification === 'undefined') { setOsError(t('news.osDenied')); return }
    let permission = 'default'
    try { permission = await Notification.requestPermission() } catch { permission = Notification.permission }
    if (permission !== 'granted') { setOsError(t('news.osDenied')); return }
    try { await post('/settings', { notifyOs: true }) } catch { /* server state lags; permission is the gate */ }
    news.reload()
  }
  return h(Panel, null,
    h('div', { className: 'ofm_row' },
      unread > 0 ? h('span', { className: 'ofm_pill strong' }, t('news.unread').replace('{n}', String(unread))) : null,
      news.data?.error ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot warn' }), t('news.fetchFailed')) : null,
      h('span', { className: 'ofm_pill' }, `${t('news.lastFetch')}: ${ago(news.data?.fetchedAt, t.locale)}`),
      h('span', { className: 'spacer', style: { marginLeft: 'auto' } }),
      h(Button, { kind: 'ghost', onClick: () => setOpen(value => !value) }, open ? t('news.collapse') : t('news.expand')),
      h(Button, { disabled: busy || news.status !== 'ready', onClick: refresh }, busy ? t('news.refreshing') : t('news.refresh'))),
    open ? h(Fragment, null,
      h('div', { className: 'ofm_row' },
        notifyOs
          ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot ok' }), t('news.osOn'))
          : h(Button, { onClick: enableOs }, t('news.osEnable')),
        osError !== '' ? h('span', { className: 'ofm_note' }, osError)
          : notifyOs ? null : h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot' }), t('news.osOff')),
        unread > 0 ? h('span', { style: { marginLeft: 'auto' } }, h(Button, { kind: 'ghost', disabled: busy, onClick: () => ack({ all: true }) }, t('news.allRead'))) : null),
      news.status === 'loading' && news.data === undefined ? h('p', { className: 'ofm_note' }, t('loading')) : null,
      news.status === 'error' ? h('p', { className: 'ofm_note' }, news.error) : null,
      news.status === 'ready' && items.length === 0 ? h('p', { className: 'ofm_note' }, t('news.empty'), ' ', h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('news.emptyHint'))) : null,
      h('div', { className: 'ofm_news' }, items.map(item => h(NewsItem, {
        key: item.id, item, t, locale: t.locale, busy,
        onAck: () => ack({ id: item.id }),
      })))) : null)
}

export function NewsItem(props) {
  const { item, t, locale, busy, onAck } = props
  const body = useMemo(() => parseSafeHtml(item.html ?? ''), [item.html])
  const acknowledged = item.acked === true
  return h('article', { className: 'ofm_newsitem' + (acknowledged ? '' : ' unread') },
    acknowledged ? null : h('span', { className: 'ofm_newsdot', 'aria-hidden': 'true' }),
    h('div', { className: 'ofm_newshead' },
      h('span', { className: 'ofm_level ' + item.level }, t(LEVEL_KEY[item.level] ?? 'level.info')),
      h('span', { className: 'ofm_newstitle' }, item.title),
      acknowledged ? null : h(Button, { kind: 'ghost', disabled: busy, onClick: onAck }, t('news.markRead'))),
    h('div', { className: 'ofm_newsmeta' },
      h('span', null, item.createdAt > 0 ? new Date(item.createdAt).toLocaleDateString() : ''),
      h('span', null, ago(item.createdAt, locale)),
      item.pinned === true ? h('span', null, '📌') : null),
    h('div', { className: 'ofm_newsbody' }, ...htmlToReact(body)),
    item.link?.url ? h('div', null, h('a', { href: item.link.url, target: '_blank', rel: 'noopener noreferrer' }, item.link.label || t('news.link'))) : null)
}
