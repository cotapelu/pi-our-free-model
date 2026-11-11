/**
 * The console's chrome: the primitives every page is built from, the two
 * hand-drawn charts, and the model roster.
 *
 * The charts are hand-drawn SVG because the shell ships no plotting primitive,
 * and because a chart library would be the one dependency this console cannot
 * take (it ships inside a host it does not control). `buildHeatCells` owns the
 * 119-day window: the heatmap's span is a calendar fact, not a layout choice.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/chrome.js
 */

import { createElement as h, useMemo } from 'react'
import { kilo } from './api.js'

  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  // Several call sites already pass `disabled` (the gateway switch does, while
  // its RPC is in flight) and it was silently dropped, so a switch stayed
  // clickable through a write it could not survive. Passing it through is what
  // those call sites meant.
  disabled: props.disabled === true,
  onClick: props.onChange,

}, h('i'), props.label === undefined ? null : h('span', null, props.label))

export const Switch = (props) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  // Several call sites already pass `disabled` (the gateway switch does, while
  // its RPC is in flight) and it was silently dropped, so a switch stayed
  // clickable through a write it could not survive. Passing it through is what
  // those call sites meant.
  disabled: props.disabled === true,

export const Pill = (props) => h('span', { className: `ofm_pill${props.strong ? ' strong' : ''}` },
  props.tone === undefined ? null : h('span', { className: `ofm_dot ${props.tone}` }),
  props.children)


export const Button = props => h('button', {
  type: 'button',
  className: 'ofm_btn' + (props.kind === undefined ? '' : ' ' + props.kind),
  disabled: props.disabled,
  onClick: props.onClick,
  title: props.title,
  'aria-label': props['aria-label'],
}, props.children)


export function Section(props) {
  return h('section', { className: 'ofm_sec' },
    h('div', { className: 'ofm_sechead' },
      h('span', { className: 'ofm_sec_title' }, props.title),
      props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
    props.children)
}


export function Panel(props) {
  return h('div', { className: 'ofm_panel' },
    props.title === undefined ? null : h('div', { className: 'ofm_paneltitle' }, props.title, props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
    props.children)
}

// ── charts (hand-drawn SVG; the shell ships no plotting primitive) ────────

export function buildHeatCells(days, span = 119) {
  if (days.length === 0) return []
  const byDay = new Map(days.map(row => [row.day, row]))
  const end = new Date()
  // Noon avoids midnight DST transitions shifting subsequent dates to 01:00.
  end.setHours(12, 0, 0, 0)
  const cells = []
  const start = new Date(end)
  start.setDate(start.getDate() - end.getDay() - (Math.ceil(span / 7) - 1) * 7)
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    const row = byDay.get(key)
    cells.push({ day: key, total: row?.total ?? 0, models: (row?.models ?? []).filter(m => m.output > 0).map(m => m.model) })
  }
  return cells
}

export function Heatmap(props) {
  const { days, t } = props
  const cells = useMemo(() => buildHeatCells(days), [days])
  const peak = cells.reduce((max, cell) => Math.max(max, cell.total), 0)
  if (cells.length === 0) return h('p', { className: 'ofm_note' }, t('heat.empty'))
  const level = value => value === 0 ? '' : peak === 0 ? '' : value / peak > 0.66 ? 'l4' : value / peak > 0.4 ? 'l3' : value / peak > 0.16 ? 'l2' : 'l1'
  return h(Fragment, null,
    h('div', { className: 'ofm_heat', role: 'img', 'aria-label': t('heat.title') },
      cells.map((cell, index) => h('div', {
        key: `${cell.day}-${index}`,
        className: 'ofm_cell ' + level(cell.total),
        title: `${cell.day} · ${cell.total.toLocaleString()} tokens${cell.models.length ? ` · ${cell.models.join(', ')}` : ''}`,
      }))),
    h('div', { className: 'ofm_scale' }, t('heat.legend'),
      ['l1', 'l2', 'l3', 'l4'].map(cls => h('span', { key: cls, className: `ofm_cell ${cls}` })),
      t('heat.legendMore')))
}

export function TrendChart(props) {
  const { series, metric, mode } = props
  const width = 900
  const height = 168
  const pad = { top: 12, right: 8, bottom: 18, left: 40 }
  const rows = series.length === 0 ? [{ day: '', total: 0 }] : series
  const valueOf = row => mode === 'requests'
    ? row.models.reduce((sum, m) => sum + m.calls, 0)
    : metric === 'total' ? row.total : (row.models.find(m => m.model === metric)?.output ?? 0)
  const points = rows.map((row, index) => ({ x: rows.length === 1 ? width / 2 : pad.left + (index / (rows.length - 1)) * (width - pad.left - pad.right), y: 0, value: valueOf(row), day: row.day }))
  const peak = Math.max(1, ...points.map(p => p.value))
  for (const point of points) point.y = pad.top + (1 - point.value / peak) * (height - pad.top - pad.bottom)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `${line} L${points[points.length - 1].x.toFixed(1)},${height - pad.bottom} L${points[0].x.toFixed(1)},${height - pad.bottom} Z`
  const color = metric === 'total' ? 'var(--dsw-alias-state-business-primary)' : (props.color ?? 'var(--dsw-alias-state-business-primary)')
  const ticks = [0, 0.5, 1].map(frac => ({ y: pad.top + frac * (height - pad.top - pad.bottom), label: kilo(peak * (1 - frac)) }))
  return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' },
    h('defs', null, h('linearGradient', { id: 'ofmFill', x1: '0', y1: '0', x2: '0', y2: '1' },
      h('stop', { offset: '0%', 'stop-color': color, 'stopOpacity': '0.32' }),
      h('stop', { offset: '100%', 'stop-color': color, 'stopOpacity': '0.02' }))),
    ticks.map(tick => h('g', { key: tick.y },
      h('line', { x1: pad.left, x2: width - pad.right, y1: tick.y, y2: tick.y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1, strokeDasharray: tick.label === '0' ? undefined : '3 4' }),
      h('text', { x: pad.left - 6, y: tick.y + 3.5, textAnchor: 'end', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)' }, tick.label))),
    h('path', { d: area, fill: 'url(#ofmFill)' }),
    h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.9, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),
    rows.length > 1 ? [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].map((row, i) => h('text', {
      key: `x${i}`,
      x: points[Math.min(points.length - 1, Math.round((i === 0 ? 0 : i === 1 ? (rows.length - 1) / 2 : rows.length - 1)))].x,
      y: height - 4, textAnchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)',
    }, row.day.slice(5))) : null)
}

export function Sparkline(props) {
  const values = props.values
  if (values.length < 2) return h('span', { className: 'ofm_note' }, props.t('speed.none'))
  const width = 150
  const height = 30
  const peak = Math.max(...values, 1)
  const floor = Math.min(...values, 0)
  const span = Math.max(1e-6, peak - floor)
  const line = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${(index / (values.length - 1) * width).toFixed(1)},${(height - ((value - floor) / span) * (height - 4) - 2).toFixed(1)}`).join(' ')
  return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', style: { height } },
    h('path', { d: line, fill: 'none', stroke: props.color ?? 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.6, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }))
}

export function ModelCard(props) {
  const { model: m, t, onBench, bench, locked, eacLogin, onVisibility, busy } = props
  const listed = m.availabilitySource === 'listing'
  const manual = m.availabilitySource === 'manual'
  const stateKey = `state.${m.availability}`
  const dim = !listed && m.availability !== 'available'
  const rung = (m.budgets ?? []).find(row => row.isDefault === true)
  // A model that declares its own thinking levels shows them beside the
  // ceiling tag, so the card names what the composer's Effort menu offers.
  // Each id is looked up with a literal call so the dictionary lint can see
  // the key, and an id with no translation falls back to the id itself.
  const levelName = id => id === 'disabled' || id === 'none' ? t('effort.off')
    : id === 'minimal' ? t('effort.minimal')
      : id === 'low' ? t('effort.low')
        : id === 'medium' ? t('effort.medium')
          : id === 'high' ? t('effort.high')
            : id === 'xhigh' ? t('effort.xhigh')
              : id === 'max' ? t('effort.max') : id
  const levels = Array.isArray(m.efforts) && m.efforts.length > 0
    ? m.efforts.map(levelName).join(' / ')
    : undefined
  return h('article', { className: 'ofm_card' + (dim ? ' dim' : '') + (m.pinned === true ? ' pinned' : '') },
    h('div', { className: 'ofm_cardhead' },
      m.channel === 'eac' ? h('span', { className: 'ofm_chantag', title: t('tag.eacChannel') }, 'EAC') : null,
      m.channel === 'eac' && locked === true ? h('span', { className: 'ofm_chantag', title: t('eac.lockedTitle') }, '🔒') : null,
      m.channel === 'kilo' ? h('span', { className: 'ofm_chantag', title: t('tag.kiloChannel') }, 'Kilo') : null,
      h('span', { className: 'ofm_cardname', title: m.name }, m.name),
      m.isNew === true ? h('span', { className: 'ofm_newtag', title: t('tag.newTitle') }, t('tag.new')) : null,
      m.hot === true ? h('span', { className: 'ofm_hottag', title: t('tag.hotTitle') }, t('tag.hot')) : null,
      h('span', { className: 'ofm_badge ' + (listed ? 'unknown' : m.availability), title: listed ? t('hint.listed') : undefined }, listed ? t('state.listed') : t(stateKey))),
    h('div', { className: 'ofm_id', title: m.id }, m.label ?? m.id),
    h('div', { className: 'ofm_tags' },
      m.hiddenByUser === true ? h('span', { className: 'ofm_tag' }, t('visibility.hidden')) : null,
      m.fast === true ? h('span', { className: 'ofm_tag fast', title: t('tag.fastTitle') }, t('tag.fast')) : null,
      h('span', { className: 'ofm_tag' }, m.vision ? t('tag.vision') : t('tag.text')),
      m.reasoning ? h('span', { className: 'ofm_tag' }, m.canDisableThinking === false ? t('tag.thinkingShared') : t('tag.thinking')) : null,
      h('span', { className: 'ofm_tag' }, `${t('tag.context')} ${kilo(m.contextWindow)}`),
      h('span', { className: 'ofm_tag' }, `${t('tag.output')} ${kilo(m.maxOutput)}`),
      rung === undefined ? null
        : h('span', { className: 'ofm_tag', title: t('tag.rungTitle').replace('{ladder}', m.budgets.map(row => `${row.name} ${kilo(row.tokens)}`).join(' · ')) },
          `${t('tag.rung')} ${kilo(rung.tokens)}`),
      levels === undefined ? null
        : h('span', { className: 'ofm_tag', title: t('tag.levelsTitle') }, `${t('tag.levels')} ${levels}`)),
    m.channel === 'eac' && locked === true
      ? h(Fragment, null,
        h('p', { className: 'ofm_note' }, t('eac.lockedNote')),
        eacLogin === undefined ? null : h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: eacLogin.busy || eacLogin.pending !== null, onClick: eacLogin.login },
            eacLogin.busy ? t('eac.starting') : t('eac.login'))))
      : null,
    listed ? h('p', { className: 'ofm_note' }, t('hint.listed'))
      : manual && m.availability !== 'available' ? h('p', { className: 'ofm_note' }, m.detail || t(stateKey))
      : m.availability === 'region-blocked' ? h('p', { className: 'ofm_note' }, t('hint.region'))
      : m.availability === 'unknown' ? h('p', { className: 'ofm_note' }, t('hint.unknown'))
        : m.availability === 'unavailable' ? h('p', { className: 'ofm_note', title: m.detail ?? '' }, t('hint.hidden'))
          : h('div', { className: 'ofm_metrics' },
            m.ttftMs === undefined || m.ttftMs === 0 ? null : h('span', null, t('tag.latency'), ' ', h('b', null, Math.round(m.ttftMs)), ' ms'),
            h('span', null, manual ? t('pref.measuredAt') : t('pref.probedAt'), ' ', h('b', null, ago(m.probedAt, t.locale)))),
    m.canDisableThinking === false ? h('p', { className: 'ofm_note' }, t('hint.sharedBudget')) : null,
    onVisibility === undefined ? null : h('div', { className: 'ofm_sec' },
      h(Switch, { checked: m.hiddenByUser !== true, label: t('visibility.showModel'),
        disabled: busy || m.hiddenByGroup === true, onChange: () => onVisibility(m) }),
      m.hiddenByGroup === true ? h('p', { className: 'ofm_note' }, t('visibility.groupHidden')) : null),
    onBench === undefined ? null : h('div', { className: 'ofm_row' },
      h(Button, { disabled: bench?.running === true, onClick: () => onBench(m) }, bench?.running === true ? t('bench.running') : t('bench.run')),
      bench?.result === undefined ? null : h('span', { className: 'ofm_note' }, bench.result)))
}

export function Roster(props) {
  const { summary, t, onBench, benches = {}, auth, eacLogin, only, onApply, busy } = props
  // 免费页与水位采用相同范围：匿名免费模型和 Kilo；其他付费来源留在各自页面。
  const roster = only === undefined ? summary.catalog
    : only === 'eac' ? summary.catalog.filter(m => m.channel === 'eac')
      : summary.catalog.filter(isFreePoolModel)
  // Featured rows lead their group: the pinned flag rides the catalog row, so
  // the order is the same on the EAC page and in the onboarding roster, and a
  // row that is not featured keeps its upstream order.
  const lead = list => [...list].sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0))
  const available = lead(roster.filter(m => m.route === 'our-free-model'))
  const limited = lead(roster.filter(m => m.route === 'our-free-model-region'))
  const unlisted = lead(roster.filter(m => m.route !== 'our-free-model' && m.route !== 'our-free-model-region'))
  const toggleModel = onApply === undefined ? undefined : model => {
    const ids = summary.settings.hiddenModelIds ?? []
    return onApply({ hiddenModelIds: ids.includes(model.id) ? ids.filter(id => id !== model.id) : [...ids, model.id] })
  }
  // 只有拿到过明确判定（网关答过 /eac/status）且未授权时才上锁：状态未知
  // 不该显示一把凭空的锁，网关不可达时本地记录仍算已授权。
  const locked = auth !== undefined && auth.available === true && auth.authorized !== true
  const group = (title, list, hint) => list.length === 0 ? null
    : h('div', { className: 'ofm_sec', style: { gap: 8 } },
      h('div', { className: 'ofm_row' }, h('span', { className: 'ofm_sec_title', style: { fontSize: 12.5 } }, title),
        hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, hint)),
      h('div', { className: 'ofm_grid' }, list.map(m => h(ModelCard, {
        key: m.id, model: m, t, onBench, locked: m.channel === 'eac' && locked, eacLogin,
        onVisibility: toggleModel, busy,
        bench: { running: benches[m.id]?.running === true, ...benches[m.id]?.result === undefined ? {} : { result: benches[m.id].result } },
      }))))
  // The lane closed at the gate is the one "no EAC models" case the page can
  // explain without a log (issue #60): on a host the kernel gave no profile,
  // the group never renders and nothing else on the page names the reason.
  const laneNote = summary.laneAvailable === false && !summary.catalog.some(m => m.channel === 'eac')
    ? h('p', { className: 'ofm_note' }, t('roster.noLane')) : null
  return h(Fragment, null,
    laneNote,
    onApply === undefined ? null : h('div', { className: 'ofm_sec' },
      h('p', { className: 'ofm_note' }, t('visibility.hint')),
      h(Switch, { checked: summary.settings.hideFreeModels === true, disabled: busy,
        label: t('pref.hideFreeModels'), onChange: () => onApply({ hideFreeModels: summary.settings.hideFreeModels !== true }) }),
      h(Switch, { checked: summary.settings.hideEacModels === true, disabled: busy,
        label: t('pref.hideEacModels'), onChange: () => onApply({ hideEacModels: summary.settings.hideEacModels !== true }) })),
    group(t('roster.selectable'), available),
    group(t('state.region-blocked'), limited, t('hint.region')),
    group(t('visibility.unlisted'), unlisted))
}

export function PageHero(props) {
  const { title, sub, children } = props
  return h('header', { className: 'ofm_hero ofm_glass' },
    h('div', { className: 'ofm_pagehead' },
      h('div', { className: 'ofm_pagetitle' },
        h('h2', null, title),
        h('p', { className: 'ofm_pagesub' }, sub)),
      children))
}

export function PanelSkeleton() {
  return h('div', { className: 'ofm_grid', 'aria-hidden': 'true' },
    h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }))
}

export function PanelError(props) {
  const { t, title, message, onRetry } = props
  return h('div', { className: 'ofm_callout ofm_error ofm_rise' },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('b', null, title),
      h('div', null, message)),
    h(Button, { kind: 'ghost', onClick: onRetry }, t('retry')))
}
