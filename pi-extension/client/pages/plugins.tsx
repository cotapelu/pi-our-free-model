/**
 * OFM Extensions platform page: registry browsing, manifest verification, and install flow.
 *
 * New in v2.8.3 - ported from dsh's `client.js` plugins section.
 *
 * @module pi-extension/client/pages/plugins.tsx
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, Section, Switch } from '../chrome.js'
import { post } from '../api.js'

export function ExtensionsPage({ t, onChanged }) {
  const [state, setState] = useState({ status: 'loading' })
  const [busyId, setBusyId] = useState('')
  const [detail, setDetail] = useState(undefined)
  const [tab, setTab] = useState('discover')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [sortKey, setSortKey] = useState('curated')
  const [updatingAll, setUpdatingAll] = useState(false)
  const [autoUpdateBusy, setAutoUpdateBusy] = useState(false)
  const [tagFilter, setTagFilter] = useState('')
  const [updateProgress, setUpdateProgress] = useState(null)
  const [selfTests, setSelfTests] = useState({})
  const searchRef = useRef(null)
  const load = useCallback(() => {
    setState(current => ({ ...current, status: 'loading' }))
    api('/extensions', { timeout: 20_000 })
      .then(payload => setState({ status: 'ready', ...payload }))
      .catch(error => setState(current => ({ ...current, status: 'error', error: String(error?.message ?? error) })))
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onKey = event => {
      if (event.key !== '/' || event.defaultPrevented === true) return
      const target = event.target
      const tag = target !== null && typeof target === 'object' ? String(target.tagName ?? '').toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true) return
      const input = searchRef.current
      if (input === null || input === undefined) return
      event.preventDefault()
      input.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const patchRegistryRow = (id, patch) => setState(current => {
    const registry = current.registry
    if (registry === null || registry === undefined) return current
    return { ...current, registry: { ...registry, plugins: registry.plugins.map(row => row.id === id ? { ...row, ...patch } : row) } }
  })
  const act = async (path, body, refresh = true) => {
    setBusyId(body?.id ?? path)
    try {
      const payload = await post(path, body, 120_000)
      if (refresh) setState(current => ({ ...current, ...payload, status: 'ready' }))
      else load()
      if (path === '/extensions/install' && payload?.record !== undefined) {
        patchRegistryRow(payload.record.id, {
          installed: true, installedVersion: payload.record.version, updateAvailable: false,
          enabled: payload.record.enabled === true, state: payload.record.state,
        })
      } else if (path === '/extensions/uninstall' && typeof body?.id === 'string') {
        patchRegistryRow(body.id, { installed: false, enabled: false, updateAvailable: false, state: 'stopped' })
      } else if (path === '/extensions/toggle' && payload?.record !== undefined) {
        patchRegistryRow(payload.record.id, { enabled: payload.record.enabled === true, state: payload.record.state })
      }
      onChanged?.()
      return payload
    } catch (error) {
      showToast({ title: t('ext.failed'), body: String(error?.message ?? error), tone: 'warn' })
      throw error
    } finally { setBusyId('') }
  }
  const installFromDetail = async id => {
    try { await act('/extensions/install', { id }); setDetail(undefined) } catch { /* the toast already said why */ }
  }
  const installed = state.installed ?? []
  const registry = state.registry
  const registryById = new Map((registry?.plugins ?? []).map(plugin => [plugin.id, plugin]))
  const needle = query.trim().toLowerCase()
  const discover = (registry?.plugins ?? []).filter(plugin => {
    if (typeFilter !== 'all' && plugin.type !== typeFilter) return false
    if (needle !== '' && !`${plugin.name} ${plugin.id} ${plugin.summary ?? ''} ${(plugin.tags ?? []).join(' ')}`.toLowerCase().includes(needle)) return false
    if (tagFilter !== '' && !(plugin.tags ?? []).includes(tagFilter)) return false
    return true
  })
  if (sortKey === 'newest') discover.sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')))
  else if (sortKey === 'name') discover.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
  const indexRows = registry?.plugins ?? []
  const channelCount = indexRows.filter(plugin => plugin.type === 'channel').length
  const updates = installed.filter(record => registryById.get(record.id)?.updateAvailable === true)
  const installedSorted = [...installed].sort((a, b) => {
    const ua = registryById.get(a.id)?.updateAvailable === true ? 0 : 1
    const ub = registryById.get(b.id)?.updateAvailable === true ? 0 : 1
    if (ua !== ub) return ua - ub
    return String(b.installedAt ?? '').localeCompare(String(a.installedAt ?? ''))
  })
  const updatesById = new Map((state.updates ?? []).map(update => [update.id, update]))
  const soakHint = plugin => {
    const update = updatesById.get(plugin.id)
    if (update === undefined) return ''
    if (update.ready === true) return t('ext.soakReady')
    return t('ext.soakWaiting').replace('{h}', String(Math.max(1, Math.ceil(update.soakRemainingMs / 3_600_000))))
  }
  const auditLabel = action => ({ install: t('ext.auditInstall'), 'install-local': t('ext.auditInstallLocal'), uninstall: t('ext.auditUninstall'), 'set-enabled': t('ext.auditEnabled'), config: t('ext.auditConfig'), secret: t('ext.auditSecret'), 'self-test': t('ext.selfTest'), 'auto-update': t('ext.auditAutoUpdate'), 'registry-refresh': t('ext.auditRegistry') })[action] ?? action
  const sourceLabel = meta => {
    if (meta?.source === 'bundled') return t('ext.sourceBundled')
    const source = String(meta?.source ?? '')
    if (source === '') return ''
    try { return `${new URL(source).hostname}（缓存）` } catch { return source }
  }

  const updateAll = async () => {
    if (updatingAll === true || updates.length === 0) return
    setUpdatingAll(true)
    setUpdateProgress({ done: 0, total: updates.length })
    try {
      let done = 0
      for (const record of updates) {
        try { await act('/extensions/install', { id: record.id }) } catch { /* one refusal must not strand the rest */ }
        done += 1
        setUpdateProgress({ done, total: updates.length })
      }
    } finally { setUpdatingAll(false); setUpdateProgress(null) }
  }
  const toggleAutoUpdate = async () => {
    if (autoUpdateBusy === true) return
    setAutoUpdateBusy(true)
    try {
      const next = state.autoUpdate !== true
      await post('/settings', { autoUpdateExtensions: next }, 15_000)
      setState(current => ({ ...current, autoUpdate: next }))
    } catch (error) {
      showToast({ title: t('ext.failed'), body: String(error?.message ?? error), tone: 'warn' })
    } finally { setAutoUpdateBusy(false) }
  }
  const exportShelf = () => {
    const rows = state.installed ?? []
    if (rows.length === 0) return
    const shelf = {
      version: 1, exportedAt: new Date().toISOString(),
      plugins: rows.map(record => ({ id: record.id, version: record.version, enabled: record.enabled === true, config: record.values ?? {} })),
    }
    const blob = new Blob([JSON.stringify(shelf, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ofm-extensions-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    showToast({ title: t('ext.exportDone'), holdMs: 6000 })
  }
  const importShelf = async file => {
    let shelf
    try { shelf = JSON.parse(await file.text()) } catch { shelf = null }
    const entries = shelf !== null && typeof shelf === 'object' && Array.isArray(shelf?.plugins)
      ? shelf.plugins.filter(row => row !== null && typeof row === 'object' && typeof row.id === 'string')
      : []
    if (entries.length === 0) { showToast({ title: t('ext.importInvalid'), tone: 'warn' }); return }
    let restored = 0
    let failed = 0
    for (const entry of entries) {
      try {
        await post('/extensions/install', { id: entry.id }, 120_000)
        if (entry.config !== null && typeof entry.config === 'object' && !Array.isArray(entry.config)) {
          await post('/extensions/config', { id: entry.id, values: entry.config }, 30_000)
        }
        if (entry.enabled === true) await post('/extensions/toggle', { id: entry.id, enabled: true }, 60_000)
        restored += 1
      } catch { failed += 1 }
    }
    await load()
    showToast({ title: t('ext.importDone').replace('{ok}', String(restored)).replace('{fail}', failed > 0 ? t('ext.importFail').replace('{n}', String(failed)) : ''), tone: failed > 0 ? 'warn' : undefined, holdMs: 8000 })
  }

  const runSelfTest = async id => {
    setSelfTests(current => ({ ...current, [id]: { busy: true } }))
    try {
      const verdict = await post('/extensions/self-test', { id }, 20_000)
      setSelfTests(current => ({ ...current, [id]: { ok: verdict?.ok === true, message: verdict?.message ?? '' } }))
    } catch (error) {
      setSelfTests(current => ({ ...current, [id]: { ok: false, message: String(error?.message ?? error) } }))
    }
  }
  const cardFor = (plugin, index = 0, filterable = false) => {
    const record = installed.find(row => row.id === plugin.id)
    const busy = busyId === plugin.id
    const modelCount = plugin.models?.length ?? plugin.modelCount
    const hasCover = plugin.cover !== null && plugin.cover !== undefined
    const head = h('div', { className: 'ofm_exthead' },
      extensionAvatar(plugin),
      h('div', { className: 'ofm_exttitle' },
        h('div', { className: 'ofm_cardhead' },
          h('span', { className: 'ofm_cardname', title: plugin.name }, plugin.name),
          h('span', { className: 'ofm_badge ok', title: t('ext.verifiedTitle') }, t('ext.verified')),
          plugin.updateAvailable === true ? h('span', { className: 'ofm_hottag' }, t('ext.updateAvailable')) : null),
        h('div', { className: 'ofm_id' }, `${plugin.id} · v${plugin.version} · ${plugin.author || '—'}`)))
    const blurb = h('p', { className: 'ofm_note ofm_extblurb' }, plugin.summary || plugin.description || '')
    const hostGate = plugin.installable === false
    const hostHint = t('ext.requiresHost').replace('{v}', plugin.minHost ?? '')
    const tagRow = h('div', { className: 'ofm_tags' },
      h('span', { className: 'ofm_chantag' }, plugin.type === 'channel' ? t('ext.channel') : t('ext.enhancement')),
      plugin.replaces ? h('span', { className: 'ofm_replacetag', title: t('ext.replaces').replace('{name}', plugin.replaces) }, t('ext.replaces').replace('{name}', plugin.replaces)) : null,
      (plugin.tags ?? []).slice(0, 3).map(tag => filterable
        ? h('button', { className: 'ofm_tag ofm_tagbtn', key: tag, type: 'button', title: t('ext.filterTag'), onClick: () => { setTab('discover'); setTagFilter(tag) } }, tag)
        : h('span', { className: 'ofm_tag', key: tag }, tag)),
      typeof modelCount === 'number' && modelCount > 0 ? h('span', { className: 'ofm_badge' }, t('ext.modelCount').replace('{n}', String(modelCount))) : null)
    const acquire = label => h(Button, {
      kind: 'primary', disabled: busy || hostGate, busy,
      title: hostGate ? hostHint : undefined,
      onClick: () => act('/extensions/install', { id: plugin.id }),
    }, busy ? t('ext.installing') : label)
    const action = record === undefined
      ? hostGate
        ? h('span', { className: 'ofm_badge throttled', title: hostHint }, hostHint)
        : acquire(t('ext.install'))
      : plugin.updateAvailable === true
        ? acquire(t('ext.update'))
        : h('span', { className: 'ofm_badge ok' }, t('ext.installed'))
    const actions = h('div', { className: 'ofm_extfoot' },
      h(Button, { onClick: () => setDetail(plugin) }, t('ext.detail')),
      action)
    if (record === undefined) {
      return h('article', {
        className: `ofm_card ofm_extcard ${plugin.type === 'channel' ? 'channel' : 'enhancement'}${hasCover ? ' hascover' : ''}`,
        key: plugin.id, style: { '--i': String(index) },
      }, h(ExtensionCover, { plugin }), head, blurb, tagRow, actions)
    }
    const fields = []
    for (const field of record.config) {
      if (field.type === 'toggle') {
        fields.push(h('div', { className: 'ofm_row', key: field.key, style: { gap: 8 } },
          h('span', { className: 'ofm_note', style: { minWidth: 90 } }, field.label),
          h(Switch, {
            checked: record.values?.[field.key] === true, label: field.label,
            onChange: () => act('/extensions/config', { id: plugin.id, values: { [field.key]: !(record.values?.[field.key] === true) } }),
          })))
      } else if (field.type === 'select') {
        const options = field.options ?? []
        const current = String(record.values?.[field.key] ?? (options.includes(String(field.default)) ? field.default : options[0] ?? ''))
        fields.push(h('div', { className: 'ofm_row', key: field.key, style: { gap: 8 } },
          h('span', { className: 'ofm_note', style: { minWidth: 90 } }, field.label),
          h('select', {
            className: 'ofm_input', value: current, style: { minWidth: 140 },
            onChange: event => {
              if (event.target.value !== current) act('/extensions/config', { id: plugin.id, values: { [field.key]: event.target.value } })
            },
          }, options.map(option => h('option', { key: option, value: option }, option)))))
      } else {
        const numeric = field.type === 'number'
        fields.push(h('div', { className: 'ofm_row', key: field.key, style: { gap: 8 } },
          h('span', { className: 'ofm_note', style: { minWidth: 90 } }, field.label),
          h('input', {
            className: 'ofm_input', type: field.type === 'password' ? 'password' : numeric ? 'number' : 'text', style: { minWidth: 140 },
            defaultValue: record.values?.[field.key] ?? '', placeholder: field.type === 'password' ? t('ext.secretPlaceholder') : '',
            onBlur: event => {
              const raw = event.target.value
              if (numeric && raw === '') return
              const next = numeric ? Number(raw) : raw
              if (next !== (record.values?.[field.key] ?? '')) {
                act('/extensions/config', { id: plugin.id, values: { [field.key]: next } })
              }
            },
          })))
      }
    }
    for (const key of record.permissions.secrets) {
      const hint = record.secrets.find(row => row.key === key)?.hint ?? ''
      fields.push(h('div', { className: 'ofm_row', key, style: { gap: 8 } },
        h('span', { className: 'ofm_note', style: { minWidth: 90 } }, key),
        h('input', {
          className: 'ofm_input', type: 'password', style: { minWidth: 140 }, placeholder: t('ext.secretPlaceholder'),
          onBlur: event => {
            if (event.target.value !== '') {
              act('/extensions/secret', { id: plugin.id, key, value: event.target.value })
              event.target.value = ''
            }
          },
        ),
        h('span', { className: 'ofm_note' }, hint)))
    }
    const selfTest = selfTests[plugin.id]
    const controls = h('div', { className: 'ofm_row' },
      record.selfTestAvailable === true
        ? h(Button, { disabled: busy || selfTest?.busy === true, busy: selfTest?.busy === true, onClick: () => runSelfTest(plugin.id) }, t('ext.selfTest'))
        : null,
      h(Button, { disabled: busy, busy, onClick: () => act('/extensions/toggle', { id: plugin.id, enabled: !(record.enabled === true) }) },
        record.enabled === true ? t('ext.disable') : t('ext.enable')),
      h(Button, {
        danger: true, disabled: busy, busy,
        onClick: () => { if (window.confirm(t('ext.confirmRemove').replace('{name}', plugin.name))) act('/extensions/uninstall', { id: plugin.id }) },
      }, t('ext.uninstall')),
      record.state !== 'ready' && record.enabled === true
        ? h('span', { className: 'ofm_badge throttled', title: record.error }, t('ext.notRunning'))
        : null,
      selfTest !== undefined && selfTest.busy !== true
        ? selfTest.ok === true
          ? h('span', { className: 'ofm_badge ok', title: selfTest.message }, t('ext.selfTestOk'))
          : h('span', { className: 'ofm_badge throttled', title: selfTest.message }, t('ext.selfTestFail'))
        : null)
    return h('article', {
      className: `ofm_card ofm_extcard ${plugin.type === 'channel' ? 'channel' : 'enhancement'}${hasCover ? ' hascover' : ''}`,
      key: plugin.id, style: { '--i': String(index) },
    },
      h(ExtensionCover, { plugin }), head, blurb, tagRow, actions,
      plugin.updateAvailable === true
        ? h('p', { className: 'ofm_soakline' }, [
          (plugin.changelog ?? [])[0] ?? '',
          (plugin.changelog ?? []).length > 0 ? ' · ' : '',
          soakHint(plugin),
        ].join('')) : null,
      fields.length > 0 ? h('div', { className: 'ofm_sec', style: { gap: 4 } }, fields) : null,
      controls)
  }
  return h('div', { className: 'ofm_page' },
    h('header', { className: 'ofm_hero ofm_glass' },
      h('div', { className: 'ofm_pagehead' },
        h('div', { className: 'ofm_pagetitle' },
          h('h2', null, t('ext.title')),
          h('p', { className: 'ofm_pagesub' }, t('ext.sub'))),
        h('div', { className: 'ofm_pills' },
          h(Pill, { strong: true }, t('ext.count').replace('{n}', String(indexRows.length))),
          h(Pill, null, t('ext.countByType').replace('{c}', String(channelCount)).replace('{e}', String(indexRows.length - channelCount))),
          h(Button, {
            disabled: busyId === '/extensions/registry/refresh', busy: busyId === '/extensions/registry/refresh',
            onClick: () => act('/extensions/registry/refresh', undefined, false),
          }, t('ext.refresh')))),
      h('div', { className: 'ofm_seg', role: 'group', style: { alignSelf: 'flex-start' } },
        [['discover', t('ext.tabDiscover')], ['installed', t('ext.tabInstalled')], ['security', t('ext.tabSecurity')]].map(([key, label]) =>
          h('button', { key, type: 'button', 'aria-pressed': tab === key ? 'true' : 'false', onClick: () => setTab(key) }, label)))),
    state.status === 'error' ? h('div', { className: 'ofm_callout ofm_error' }, h('div', null, h('b', null, t('ext.empty')), h('div', null, state.error))) : null,
    tab === 'discover' ? h(Fragment, null,
      h('div', { className: 'ofm_row ofm_exttoolbar' },
        h('div', { className: 'ofm_extsearch' },
          h('input', {
            ref: searchRef, className: 'ofm_input', type: 'search', placeholder: t('ext.search'),
            value: query, 'aria-keyshortcuts': '/', onChange: event => setQuery(event.target.value),
          }),
          h('kbd', { className: 'ofm_kbd', title: t('ext.searchHint'), 'aria-hidden': 'true' }, '/')),
        h('div', { className: 'ofm_seg', role: 'group', 'aria-label': t('ext.type') },
          [['all', t('ext.all'), indexRows.length], ['channel', t('ext.channel'), channelCount], ['enhancement', t('ext.enhancement'), indexRows.length - channelCount]].map(([key, label, count]) =>
            h('button', { key, type: 'button', 'aria-pressed': typeFilter === key ? 'true' : 'false', onClick: () => setTypeFilter(key) },
              label, h('span', { className: 'ofm_segcount' }, String(count))))),
        h('div', { className: 'ofm_seg', role: 'group', 'aria-label': t('ext.sort') },
          [['curated', t('ext.sortCurated')], ['newest', t('ext.sortNewest')], ['name', t('ext.sortName')]].map(([key, label]) =>
            h('button', { key, type: 'button', 'aria-pressed': sortKey === key ? 'true' : 'false', onClick: () => setSortKey(key) }, label)))),
      h('div', { className: 'ofm_row ofm_exttoolbar' },
        h('span', { className: 'ofm_inlinehint', title: t('ext.autoUpdateHint').replace('{h}', String(state.registryMeta?.soakHours ?? 2)) },
          h(Switch, {
            label: t('ext.autoUpdate'), checked: state.autoUpdate === true, disabled: autoUpdateBusy,
            onChange: () => { void toggleAutoUpdate() },
          })),
        sourceLabel(state.registryMeta) !== ''
          ? h('span', { className: 'ofm_extsource', title: `${t('ext.source')}: ${state.registryMeta?.source ?? ''}` },
            `${t('ext.source')} · ${sourceLabel(state.registryMeta)}`) : null,
        tagFilter !== '' ? h('span', { className: 'ofm_note' }, `${t('ext.filterTag')}:`) : null,
        tagFilter !== '' ? h('span', { className: 'ofm_tag' }, tagFilter) : null,
        tagFilter !== '' ? h(Button, { onClick: () => setTagFilter('') }, t('ext.clearSearch')) : null),
      !registry && state.status === 'ready' ? h('div', { className: 'ofm_callout' },
        h('div', null,
          h('b', null, t('ext.empty')),
          h('div', null, state.registryError !== undefined && state.registryError !== '' ? state.registryError : t('ext.indexHint')))) : null,
      !registry && state.status === 'loading'
        ? h('div', { className: 'ofm_grid ofm_extgrid' },
          [0, 1, 2, 3, 4, 5].map(index => h('div', {
            className: 'ofm_extskel', key: String(index), 'aria-hidden': 'true', style: { '--i': String(index) },
          }, h('i', { style: { width: '42%' } }), h('i', { style: { width: '68%' } }),
            h('i', { style: { width: '86%' } }), h('i', { style: { width: '55%' } }))))
        : h('div', { className: 'ofm_grid ofm_extgrid' }, discover.map((plugin, index) => cardFor(plugin, index, true))),
      discover.length === 0 && registry !== null && state.status === 'ready' ? h('div', { className: 'ofm_extempty' },
        h('p', { className: 'ofm_note' }, t('ext.discoverEmpty')),
        (query.trim() !== '' || typeFilter !== 'all' || tagFilter !== '')
          ? h(Button, { onClick: () => { setQuery(''); setTypeFilter('all'); setTagFilter(''); searchRef.current?.focus?.() } }, t('ext.clearSearch'))
          : h('a', { className: 'ofm_linkbtn', href: 'https://github.com/Ebony-Vinyl/ofm-extensions', target: '_blank', rel: 'noopener noreferrer' }, t('ext.openRepo'))) : null)
    : tab === 'installed' ? h(Fragment, null,
      h('div', { className: 'ofm_row ofm_exttoolbar' },
        updates.length > 0 ? h('span', { className: 'ofm_badge region-blocked' }, t('ext.updateCount').replace('{n}', String(updates.length))) : null,
        updates.length > 0 ? h(Button, { kind: 'primary', disabled: updatingAll, busy: updatingAll, onClick: updateAll },
          updatingAll && updateProgress !== null
            ? t('ext.updateProgress').replace('{i}', String(updateProgress.done)).replace('{n}', String(updateProgress.total))
            : t('ext.updateAll')) : null,
        h(Button, { onClick: exportShelf, disabled: installed.length === 0, title: t('ext.shelfTitle') }, t('ext.exportShelf')),
        h('label', { className: 'ofm_importlabel', title: t('ext.shelfTitle') },
          h('input', {
            type: 'file', accept: 'application/json,.json', hidden: true,
            onChange: event => { const file = event.target.files?.[0]; if (file !== undefined) void importShelf(file); event.target.value = '' },
          }),
          h(Button, { disabled: busyId !== '' }, t('ext.importShelf')))),
      installed.length === 0 ? h('p', { className: 'ofm_note' }, t('ext.installedEmpty'))
        : h('div', { className: 'ofm_grid ofm_extgrid' }, installedSorted.map((record, index) => cardFor({
          ...record, summary: record.description,
          tags: registryById.get(record.id)?.tags ?? [],
          publishedAt: registryById.get(record.id)?.publishedAt ?? record.installedAt,
          updateAvailable: registryById.get(record.id)?.updateAvailable === true,
          changelog: registryById.get(record.id)?.changelog ?? [],
          cover: registryById.get(record.id)?.cover,
          installed: true,
        }, index))),
      installed.length > 0 ? h(Section, { title: t('ext.auditTitle') },
        (state.audit ?? []).length > 0
          ? h('div', { className: 'ofm_audrows' },
            state.audit.slice().reverse().slice(0, 12).map((entry, index) => h('div', { className: 'ofm_audrow', key: `${entry.at}-${index}` },
              h('span', { className: 'ofm_audat' }, new Date(entry.at).toLocaleString(t.locale)),
              h('b', null, auditLabel(entry.action)),
              h('code', null, entry.id),
              entry.version !== undefined ? h('span', { className: 'ofm_note' }, `v${entry.version}`) : null,
              entry.enabled !== undefined ? h('span', { className: 'ofm_note' }, entry.enabled === true ? t('ext.enable') : t('ext.disable')) : null))) : null)
        : null)
    : h('div', { className: 'ofm_panel' },
      h('div', { className: 'ofm_paneltitle' }, t('ext.security')),
      h('p', { className: 'ofm_note', style: { lineHeight: 1.7 } }, t('ext.securityBody')),
      h('p', { className: 'ofm_note', style: { lineHeight: 1.7 } }, t('ext.securityBody2')),
      typeof state.registry?.generatedAt === 'string' && state.registry.generatedAt !== ''
        ? h('p', { className: 'ofm_note', style: { lineHeight: 1.7 } }, t('ext.indexFresh').replace('{at}', new Date(state.registry.generatedAt).toLocaleString(t.locale)))
        : null,
      h('div', { className: 'ofm_row' },
        h('a', { className: 'ofm_linkbtn', href: `https://github.com/${'Ebony-Vinyl'}/ofm-extensions`, target: '_blank', rel: 'noopener noreferrer' }, t('ext.openRepo')))),
    detail !== undefined ? h(ExtensionDetail, { t, detail, busy: busyId === detail.id, onInstall: installFromDetail, onClose: () => setDetail(undefined) }) : null)
}

/** A type-tinted letter avatar stands in for the manifest's (still optional) icon. */
export function extensionAvatar(plugin) {
  const initial = String(plugin?.name ?? plugin?.id ?? '?').trim().charAt(0).toUpperCase()
  return h('span', {
    className: `ofm_extavatar ${plugin?.type === 'channel' ? 'channel' : 'enhancement'}`,
    'aria-hidden': 'true',
  }, initial === '' ? '·' : initial)
}

/** The card's cover banner. Bytes ride the host's own /extensions/cover route. */
export function ExtensionCover({ plugin }) {
  const [failed, setFailed] = useState(false)
  if (plugin?.cover === null || plugin?.cover === undefined || failed) return null
  return h('div', { className: 'ofm_extcover' },
    h('img', {
      src: `${API}/extensions/cover?id=${encodeURIComponent(plugin.id)}`,
      alt: '', loading: 'lazy', decoding: 'async',
      onLoad: event => event.currentTarget.classList.add('ofm_loaded'),
      onError: () => setFailed(true),
    }))
}

/** The detail drawer portals to BODY. */
export function ExtensionDetail({ t, detail, busy, onInstall, onClose }) {
  const host = useMemo(() => {
    const node = document.createElement('div')
    node.setAttribute('data-ofm-extension-detail-root', 'true')
    document.body.appendChild(node)
    return node
  }, [])
  useEffect(() => () => { if (host.parentNode !== null) host.parentNode.removeChild(host) }, [host])
  const dialogRef = useRef(null)
  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const origins = detail.permissions?.network ?? []
  const modelCount = detail.models?.length ?? detail.modelCount
  const repositoryHost = (() => {
    try { return new URL(detail.repository).host } catch { return '' }
  })()
  const meta = [
    [t('ext.type'), detail.type === 'channel' ? t('ext.channel') : t('ext.enhancement')],
    [t('ext.license'), detail.license || '—'],
    [t('ext.published'), String(detail.publishedAt ?? '').slice(0, 10) || '—'],
    [t('ext.models'), typeof modelCount === 'number' && modelCount > 0 ? String(modelCount) : '—'],
    ...(repositoryHost !== '' ? [[t('ext.repository'), repositoryHost]] : []),
  ]
  const canAcquire = (detail.installed !== true || detail.updateAvailable === true) && detail.installable !== false
  return ReactDOM.createPortal(h('div', { className: 'ofm_scrim', onClick: onClose },
    h('div', {
      className: 'ofm_ann ofm_extdetail', role: 'dialog', 'aria-modal': 'true', 'aria-label': detail.name,
      tabIndex: -1, ref: dialogRef, onClick: event => event.stopPropagation(),
    },
      h(ExtensionCover, { plugin: detail }),
      h('div', { className: 'ofm_annhead ofm_exthead' },
        extensionAvatar(detail),
        h('div', { className: 'ofm_exttitle' },
          h('h3', { className: 'ofm_anntitle' }, detail.name),
          h('p', { className: 'ofm_annsub' }, `${detail.id} · v${detail.version} · ${detail.author || ''}`))),
      h('div', { className: 'ofm_annbody' },
        h('p', null, detail.summary || detail.description || ''),
        (detail.tags ?? []).length > 0 ? h('div', { className: 'ofm_tags' }, detail.tags.map(tag => h('span', { className: 'ofm_tag', key: tag }, tag))) : null,
        detail.replaces ? h('div', { className: 'ofm_tags' }, h('span', { className: 'ofm_replacetag' }, t('ext.replaces').replace('{name}', detail.replaces))) : null,
        detail.installed !== true ? h('p', { className: 'ofm_note' }, t('ext.notInstalledHint')) : null,
        detail.installable === false ? h('p', { className: 'ofm_note' }, t('ext.requiresHost').replace('{v}', detail.minHost ?? '')) : null,
        (detail.hooks ?? []).length > 0 ? h('div', { className: 'ofm_row', style: { gap: 6, alignItems: 'center' } },
          h('span', { className: 'ofm_note' }, t('ext.hooks')),
          detail.hooks.map(hookName => h('code', { key: hookName }, hookName))) : null,
        h('div', { className: 'ofm_kv' }, meta.map(([label, value]) => h('div', { className: 'ofm_kvc', key: label },
          h('b', null, value), h('span', null, label)))),
        (detail.models ?? []).length > 0 ? h('div', { className: 'ofm_modelshelf' },
          detail.models.slice(0, 14).map(model => h('span', {
            className: 'ofm_modelchip', key: model.id, title: `${model.id}${model.wire ? ` · ${model.wire}` : ''}`,
          }, model.name ?? model.id)),
          detail.models.length > 14 ? h('span', { className: 'ofm_note' }, `+${detail.models.length - 14}`) : null) : null,
        (detail.changelog ?? []).length > 0 ? h('div', { className: 'ofm_sec' },
          h('b', { style: { fontSize: 12.5 } }, t('ext.changelog')),
          h('ul', { className: 'ofm_changelog' }, detail.changelog.map((row, index) =>
            h('li', { key: index }, row)))) : null,
        h('div', { className: 'ofm_sec' },
          h('b', { style: { fontSize: 12.5 } }, t('ext.permissions')),
          h('p', { className: 'ofm_note' }, t('ext.permNetwork').replace('{n}', String(origins.length))),
          origins.length > 0
            ? h('div', { className: 'ofm_extorigins' }, origins.map(origin => h('code', { key: origin }, origin)))
            : h('p', { className: 'ofm_note' }, t('ext.originEmpty')),
          h('p', { className: 'ofm_note' }, t('ext.permSecrets').replace('{n}', String(detail.permissions?.secrets?.length ?? 0))),
          h('p', { className: 'ofm_note' }, `${t('ext.storage')}: ${detail.permissions?.storage === true ? t('ext.storageOn') : t('ext.storageOff')}`))),
      h('div', { className: 'ofm_annfoot' },
        detail.installed === true && detail.updateAvailable !== true ? h('span', { className: 'ofm_badge available' }, t('ext.installed')) : null,
        h('span', { className: 'spacer' }),
        typeof detail.sourceUrl === 'string' && detail.sourceUrl !== '' ? h('a', { className: 'ofm_linkbtn', href: detail.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, t('ext.viewSource')) : null,
        detail.homepage ? h('a', { className: 'ofm_linkbtn', href: detail.homepage, target: '_blank', rel: 'noopener noreferrer' }, t('ext.openHomepage')) : null,
        detail.repository && detail.repository !== detail.homepage ? h('a', { className: 'ofm_linkbtn', href: detail.repository, target: '_blank', rel: 'noopener noreferrer' }, t('ext.openRepository')) : null,
        canAcquire ? h(Button, {
          kind: 'primary', disabled: busy === true, busy: busy === true,
          onClick: () => onInstall?.(detail.id),
        }, busy === true ? t('ext.installing') : detail.installed === true ? t('ext.update') : t('ext.install')) : null,
        h(Button, { onClick: onClose }, t('ext.close'))))), host)
}

import { API } from '../api.js'
import ReactDOM from 'react-dom'