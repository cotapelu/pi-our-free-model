/**
 * The aggregate-channels page: the third-party providers the user keyed.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/aggregate.js
 */

import { createElement: h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, PageHero, Panel, Section, PanelSkeleton, PanelError, ModelCard, Roster, Heatmap, TrendChart, Sparkline } from '../chrome.js'

export function AggregatePage(props) {
  const { t, summary } = props
  const panel = usePanel(() => api('/providers'), [])
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [filter, setFilter] = useState('')
  const catalog = summary?.data?.catalog ?? []
  const registry = panel.data?.registry ?? []
  const configured = panel.data?.configured?.providers ?? {}
  const categories = AGG_CATEGORY(t)

  const afterWrite = (aggregate, provider, isNew) => {
    if (aggregate !== undefined && aggregate !== null) panel.patch({ configured: aggregate })
    if (isNew) { setAdding(false); setDraft(null) }
    summary?.reload?.()
    showToast({ title: t('agg.saved'), body: t('agg.savedBody').replace('{name}', provider.name), holdMs: 3600 })
  }
  const afterRemove = (aggregate, provider) => {
    if (aggregate !== undefined && aggregate !== null) panel.patch({ configured: aggregate })
    if (draft?.id === provider.id) setDraft(null)
    summary?.reload?.()
    showToast({ title: t('agg.saved'), body: t('agg.removedBody').replace('{name}', provider.name), holdMs: 3600 })
  }
  const afterDiscover = () => { panel.reload(); summary?.reload?.() }

  const needle = query.trim().toLowerCase()
  const configuredCount = registry.filter(provider => configured[provider.id] !== undefined).length
  const rows = registry
    .map(provider => ({ id: provider.id, provider, state: configured[provider.id] }))
    .filter(row => category === '' || row.provider.category === category)
    .filter(row => filter === '' || (filter === 'unconfigured' ? row.state === undefined
      : filter === 'disabled' ? row.state?.enabled === false : row.state !== undefined))
    .filter(row => needle === '' || `${row.id} ${row.provider.name}`.toLowerCase().includes(needle))

  return h('div', { className: 'ofm_page' },
    h('header', { className: 'ofm_directoryhero' },
      h('div', { className: 'ofm_pagehead' },
        h('div', { className: 'ofm_pagetitle' }, h('h2', null, t('agg.title')), h('p', { className: 'ofm_pagesub' }, t('agg.sub'))),
      h('div', { className: 'ofm_pills' },
        h(Pill, null, t('agg.registryCount').replace('{n}', String(registry.length))),
        h(Pill, { strong: true }, t('agg.configuredCount').replace('{n}', String(configuredCount))))),
      h(Button, {
        kind: adding ? 'ghost' : 'primary',
        onClick: () => { setAdding(value => !value); setDraft(null) },
      }, adding ? t('agg.cancel') : t('agg.addProvider'))),
    panel.status === 'loading' ? h(PanelSkeleton) : null,
    panel.status === 'error'
      ? h(PanelError, { t, title: t('agg.loadFailed'), message: panel.error, onRetry: panel.reload })
      : null,
    panel.status === 'ready'
      ? h(Fragment, null,
        draft !== null
          ? h('div', { className: 'ofm_panel ofm_rise' },
            h('div', { className: 'ofm_paneltitle' }, draft.name, h('span', { className: 'ofm_sec_hint' }, draft.id)),
            h(ProviderEditor, {
              key: draft.id, t, provider: draft, state: configured[draft.id], contributions: contributedBy(catalog, draft.id),
              onSaved: afterWrite, onRemoved: afterRemove, onChanged: afterDiscover,
            }))
          : adding
            ? h(ProviderPicker, { t, registry, onPick: setDraft })
            : null,
        h(Section, { title: t('agg.configuredTitle'), hint: t('agg.configuredHint') },
          h('div', { className: 'ofm_directorytools' },
            h('label', null, t('agg.search'),
              h('input', { className: 'ofm_input', type: 'search', value: query, placeholder: t('agg.search'), onChange: event => setQuery(event.target.value) })),
            h('label', null, t('agg.filterCategory'),
              h('select', { className: 'ofm_input', 'aria-label': t('agg.filterCategory'), value: category, onChange: event => setCategory(event.target.value) },
                h('option', { value: '' }, t('agg.filterAll')),
                Object.keys(categories).map(id => h('option', { key: id, value: id }, categories[id])))),
            h('label', null, t('chan.filterStatus'),
              h('select', { className: 'ofm_input', 'aria-label': t('chan.filterStatus'), value: filter, onChange: event => setFilter(event.target.value) },
                h('option', { value: '' }, t('agg.filterAll')),
                h('option', { value: 'configured' }, t('agg.configured')),
                h('option', { value: 'unconfigured' }, t('agg.unconfigured')),
                h('option', { value: 'disabled' }, t('agg.disabled'))))),
          h('div', { className: 'ofm_directorycount', role: 'status' },
            t('agg.showing').replace('{shown}', String(rows.length)).replace('{total}', String(registry.length))),
          registry.length === 0
            ? h('div', { className: 'ofm_panel' },
              h('div', { className: 'ofm_paneltitle' }, t('agg.empty')),
              h('p', { className: 'ofm_note' }, t('agg.emptyHint')))
            : rows.length === 0
              ? h('p', { className: 'ofm_note' }, t('agg.filterEmpty'))
              : h('div', { className: 'ofm_directory' }, rows.map(row => h(ProviderCard, {
                key: row.id, t, provider: row.provider, state: row.state,
                contributions: contributedBy(catalog, row.id),
                onSaved: afterWrite, onRemoved: afterRemove, onChanged: afterDiscover,
              })))))
      : null)
}
