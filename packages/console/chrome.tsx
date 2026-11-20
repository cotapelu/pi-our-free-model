/**
 * The console's chrome: the primitives every page is built from,
 * the two hand-drawn charts, and the model roster.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/chrome.js
 */

import { createElement as h, useMemo, useState, useCallback, useEffect, Fragment } from 'react'
import { kilo } from './api.js'
import { ago } from '../shared/utils.js'

/** EAC authorization component */
export function EacAuth(props: { t: any, eacAuth: any, setEacAuth: any, eacLogin: any, busy: boolean, setBusy: any }) {
  return h('div', { className: 'ofm_eac_auth' },
    h('p', { className: 'ofm_eac_status' }, eacAuth?.authorized ? '已授权' : '未授权'),
    h('button', { kind: 'primary', disabled: busy, onClick: () => eacLogin() }, eacAuth?.authorized ? '退出' : '授权')
  )
}

/** Token pool panel for co-paid lane */
export function usePool() {
  return { pool: null }
}

/** Read pool capacity */
export function poolReading(pool: any) {
  return pool ?? { total: 0, used: 0, remaining: 0 }
}

/** Format capacity text */
export function capacityText(pool: any, t: any) {
  return `${pool.total} tokens`
}

/** Star button for GitHub authorization */
export function StarButton(props: { t: any }) {
  return h('a', {
    className: 'ofm_starbtn',
    href: 'https://github.com/example/repo',
    target: '_blank',
    rel: 'noreferrer noopener',
  }, t('star.cta'))
}

/** Switch component */
export function Switch(props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) {
  return h('button', {
    type: 'button',
    className: 'ofm_switch',
    role: 'switch',
    'aria-label': props.label,
    'aria-checked': props.checked ? 'true' : 'false',
    disabled: props.disabled === true,
    onClick: props.onChange,
  }, h('i'), props.label === undefined ? null : h('span', null, props.label))
}

/** Button component */
export const Tank = (props: { label?: string; onClick?: () => void }) =>
  h('button', { className: 'ofm_tank', onClick: props.onClick },
    h('span', { className: 'ofm_tank_text' }, props.label))

/** Pill component */
export const Pill = (props: { strong?: boolean; tone?: string; children: any }) =>
  h('span', { className: `ofm_pill${props.strong ? ' strong' : ''}` },
    props.tone === undefined ? null : h('span', { className: `ofm_dot ${props.tone}` }),
    props.children)

/** Button component */
export const Button = (props: {
  kind?: string
  disabled?: boolean
  onClick?: () => void
  title?: string
  'aria-label'?: string
  children: any
}) => h('button', {
  type: 'button',
  className: 'ofm_btn' + (props.kind === undefined ? '' : ' ' + props.kind),
  disabled: props.disabled,
  onClick: props.onClick,
  title: props.title,
  'aria-label': props['aria-label'],
}, props.children)

/** Section component */
export function Section(props: { children: any; className?: string }) {
  return h('section', { className: 'ofm_sec' + (props.className ? ' ' + props.className : '') }, props.children)
}

/** Panel component */
export function Panel(props: { title?: string; hint?: string; children: any }) {
  return h('div', { className: 'ofm_panel' },
    props.title === undefined ? null : h('div', { className: 'ofm_paneltitle' }, props.title, props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
    props.children)
}

/** Section with header */
export function SectionWithHeader(props: { title: string; hint?: string; children: any }) {
  return h('section', { className: 'ofm_sec' },
    h('div', { className: 'ofm_sechead' },
      h('span', { className: 'ofm_sec_title' }, props.title),
      props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
    props.children)
}

/** PanelSkeleton for loading state */
export function PanelSkeleton() {
  return h('div', { className: 'ofm_grid', 'aria-hidden': 'true' },
    h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }))
}

/** PanelError for error state */
export function PanelError(props: { title: string; message: string; onRetry: () => void }) {
  return h('div', { className: 'ofm_callout ofm_error ofm_rise' },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('b', null, props.title),
      h('div', null, props.message)),
    h(Button, { kind: 'ghost', onClick: props.onRetry }, 'Retry'))
}

/** Panel data loader with one-shot fetch and manual reload. */
export function usePanel(fetchFn: () => Promise<any>, deps: any[]) {
  const [data, setData] = useState(undefined)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setStatus('loading'); setError('')
    try { const value = await fetchFn(); setData(value); setStatus('ready') }
    catch (err) { setError(String(err?.message ?? err)); setStatus('error') }
  }, [])
  useEffect(() => { void load() }, [load])
  const reload = useCallback(() => void load(), [load])
  return { data, status, error, reload }
}

/** Page hero header */
export function PageHero(props: { title?: string; sub?: string; children?: any }) {
  return h('header', { className: 'ofm_hero ofm_glass' },
    h('div', { className: 'ofm_pagehead' },
      h('div', { className: 'ofm_pagetitle' },
        h('h2', null, props.title),
        props.sub === undefined ? null : h('p', { className: 'ofm_pagesub' }, props.sub)),
      props.children))
}

/** Provider display names for subscription accounts. */
export const SUBSCRIPTION_PROVIDERS = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
  kilo: 'Kilo',
}

/** Injected CSS for the embedded engine workspace iframe. */
export const WORKSPACE_CSS = `
  body { margin: 0; padding: 0; font-family: inherit; }
  .engine-root { height: 100vh; display: flex; flex-direction: column; }
  .engine-toolbar { padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
  .engine-content { flex: 1; overflow: auto; padding: 12px; }
  .provider-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px; margin-bottom: 8px; }
  .provider-card h3 { margin: 0 0 8px; font-size: 14px; }
  .provider-card .models { display: flex; flex-wrap: wrap; gap: 4px; }
  .provider-card .model-tag { font-size: 12px; padding: 2px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); }
`

/** A fresh per-request project id, exposed for callers that want to pin the same id across a retried turn. */
export function randomProjectId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Decide if a content list needs an image-capable model. */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Harness tool schemas -> the shape each provider expects. */
export function toToolDefs(tools: any[], style: 'chat' | 'claude' | 'flat' = 'chat'): any[] {
  const list: any[] = []
  for (const tool of tools ?? []) {
    const source = tool && typeof tool.function === 'object' && tool.function !== null && !Array.isArray(tool.function)
      ? tool.function
      : tool
    const name = String(source?.name ?? '').trim()
    if (!name) continue
    const parameters = source.parameters && typeof source.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters
      : { type: 'object', properties: {} }
    const description = typeof source.description === 'string' ? source.description : ''
    if (style === 'claude') list.push({ name: name.slice(0, 128), description, input_schema: parameters })
    else if (style === 'flat') list.push({ type: 'function', name: name.slice(0, 128), description, parameters })
    else list.push({ type: 'function', function: { name: name.slice(0, 128), description, parameters } })
  return list
}

/** Heatmap cells for an 119-day window. */
export function buildHeatCells(days: any[], span = 119) {
  if (days.length === 0) return []
  const byDay = new Map(days.map(row => [row.day, row]))
  const end = new Date()
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

/** Heatmap component. */
export function Heatmap(props: { days: any[], t: any }) {
  const cells = useMemo(() => buildHeatCells(days), [days])
  const peak = cells.reduce((max, cell) => Math.max(max, cell.total), 0)
  if (cells.length === 0) return h('p', { className: 'ofm_note' }, t('heat.empty'))
  const level = value => value === 0 ? '' : peak === 0 ? '' : value / peak > 0.66 ? 'l4' : value / peak > 0.4 ? 'l3' : value / peak > 0.16 ? 'l2' : 'l1'
  return h('div', { className: 'ofm_heat', role: 'img', 'aria-label': t('heat.title') },
    cells.map((cell, index) => h('div', {
      key: `${cell.day}-${index}`,
      className: `ofm_cell ${level(cell.total)}`,
      title: `${cell.day} · ${cell.total.toLocaleString()} tokens${cell.models.length ? ` · ${cell.models.join(', ')}` : ''}`,
    })),
    h('div', { className: 'ofm_scale' }, t('heat.legend'),
      ['l1', 'l2', 'l3', 'l4'].map(cls => h('span', { key: cls, className: `ofm_cell ${cls}` })),
      t('heat.legendMore')))
}

/** TrendChart component */
export function TrendChart(props: { series: any[], model: string, mode: string, color?: string }) {
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
  const color = props.color ?? 'var(--dsw-alias-state-business-primary)'
  const ticks = [0, 0.5, 1].map(frac => ({ y: pad.top + frac * (height - pad.top - pad.bottom), label: kilo(peak * (1 - frac)) }))
  return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', style: { height } },
    h('defs', null, h('linearGradient', { id: 'ofmFill', x1: '0', y1: '0', x2: '0', y2: '1' },
      h('stop', { offset: '0%', 'stop-color': color, 'stopOpacity': '0.32' }),
      h('stop', { offset: '100%', 'stop-color': color, 'stopOpacity': '0.02' }))),
    ticks.map(tick => h('g', { key: tick.y },
      h('line', { x1: pad.left, x2: width - pad.right, y1: tick.y, y2: tick.y, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1, strokeDasharray: tick.label === '0' ? undefined : '3 4' }),
      h('text', { x: pad.left - 6, y: tick.y + 3.5, textAnchor: 'end', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)' }, tick.label))),
    h('path', { d: area, fill: 'url(#ofmFill)' }),
    h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.9, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),
    rows.length > 1 ? [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].map((row, i) => h('text', {
      key: `x${i}`,
      x: points[Math.min(points.length - 1, Math.round((i === 0 ? 0 : i === 1 ? (rows.length - 1) / 2 : rows.length - 1)))].x,
      y: height - 4, textAnchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)',
    }, row.day.slice(5))) : null)
}

/** Sparkline component */
export function Sparkline(props: { values: any[], color?: string }) {
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

/** ModelCard component */
export function ModelCard(props: { model: any, t: any, onBack: any, busy?: boolean, benches?: any, setBusy?: any, eacAuth?: any, setEacAuth?: any, eacLogin?: any, stats?: any }) {
  const { model: entry, t, ctx, summary, stats, eacAuth, setEacAuth, eacLogin, busy, setBusy, apply, benches } = props
  const data = summary?.data
  if (!data) return null
  const model = data.catalog?.find(m => m.id === entry.id) || data.entries?.find(m => m.id === entry.id)
  if (!model) return null
  const locked = eacAuth && eacAuth.available && !eacAuth.authorized
  const lockedOrBusy = locked || benches[model.id]?.running
  const sessionKey = model.id
  const windowStats = stats?.days?.find(d => d.day === summary?.days?.[stats.days.length - 1]?.day)
  const dailyTokens = windowStats?.tokens ?? 0
  const dailyTokensFormatted = kilo(dailyTokens)
  const counts = freePoolView(data).counts
  const modelCounts = counts[model.id] || { total: 0, success: 0, failed: 0 }
  const successRate = modelCounts.total > 0 ? (modelCounts.success / modelCounts.total * 100).toFixed(1) : 0
  const fillColor = successRate >= 80 ? '#10b981' : successRate >= 50 ? '#f59e0b' : '#ef4444'
  return h('div', { className: 'ofm_card' + (locked || busy ? ' ofm_disabled' : '') },
    h('div', { className: 'ofm_card_header' },
      h('h3', { className: 'ofm_model_name' }, model.name),
      h('span', { className: `ofm_model_tag ${model.region === 'region-blocked' ? 'region-blocked' : 'available'}` }, model.region === 'region-blocked' ? t('state.region-blocked') : t('state.available')),
      locked ? h('span', { className: 'ofm_urgent_tag' }, t('eac.locked')) : null),
    h('div', { className: 'ofm_card_stats' },
      h('div', { className: 'ofm_stat' }, h('div', { className: 'ofm_stat_value' }, kilo(modelCounts.total)), h('div', { className: 'ofm_stat_label' }, t('stats.total'))),
      h('div', { className: 'ofm_stat' }, h('div', { className: 'ofm_stat_value' }, successRate + '%'), h('div', { className: 'ofm_stat_label' }, t('stats.success_rate'))),
      h('div', { className: 'ofm_stat' }, h('div', { className: 'ofm_stat_value' }, dailyTokensFormatted), h('div', { className: 'ofm_stat_label' }, t('stats.daily_tokens'))),
    h('div', { className: 'ofm_stat' }, h('div', { className: 'ofm_stat_value' }, kilo(model.daily_tokens ?? 0)), h('div', { className: 'ofm_stat_label' }, t('stats.daily_tokens_cap'))),
  h('div', { className: 'ofm_card_body' },
    h('div', { className: 'ofm_model_desc' }, model.description ?? t('models.no_description')),
    h('div', { className: 'ofm_model_tags' },
      (model.tags ?? []).map(tag => h('span', { className: 'ofm_model_tag', key: tag }, tag))),
    h('div', { className: 'ofm_card_actions' },
      h(Button, { kind: 'primary', disabled: locked || busy, onClick: () => onBench(model) },
        busy?.running === model.id ? t('bench.running') : t('bench.run')),
      locked ? h('button', { className: 'ofm_btn ofm_btn_secondary', disabled: true }, t('eac.locked')) : null),
    h('div', { className: 'ofm_card_footer' },
      h('span', { className: 'ofm_model_id' }, model.id),
      h('span', { className: 'ofm_region' }, model.region ?? 'global'),
    )
  )
}

/** Roster component - list of model cards */
export function Roster(props: { models: any[], t: any, onBench: any, busy?: boolean, benches?: any, eacAuth?: any, setEacAuth?: any, eacLogin?: any, stats?: any, apply?: any }) {
  return h('div', { className: 'ofm_roster' },
    models.map(model => h(ModelCard, {
      key: model.id,
      model: model,
      t: t,
      onBench: onBench,
      busy: busy,
      benches: benches,
      eacAuth: eacAuth,
      setEacAuth: setEacAuth,
      eacLogin: eacLogin,
      onApply: onApply,
      stats: stats,
    }))
  )
}

/** Brand icon for the shell header. */
export const BRAND_ICON = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2V3aWR0PSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xOSA0SDUuNWMtMS4xIDAtMiAxLjUtMiAydjE2YzAgMS4xIDEuNSAyIDIgMmgxMmMxLjEgMCAyLTEuNSAyLTJ2LTE2YzAtMS4xLTEuNS0yLTItMiIvPjwvc3ZnPg=='

/** Channel provider labels for the EAC channel router. */
export const CHANNEL_PROVIDERS = [
  { id: 'kilo', label: 'Kilo AI', state: 'available' },
  { id: 'opencode', label: 'OpenCode', state: 'available' },
  { id: 'eac', label: 'EAC', state: 'available' },
]

/** Channel transport selector for EAC channels. */
export function channelTransport() {
  return 'channel-pack'
}

/** Check if two transports are the same channel type. */
export function sameChannelTransport(a: any, b: any) {
  return a === b
}

/** Sponsor banner component */
export function SponsorBanner() {
  return h('div', { className: 'ofm_sponsor' })
}