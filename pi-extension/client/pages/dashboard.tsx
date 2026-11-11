/**
 * The dashboard: what the lane did recently.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/pages/dashboard.js
 */

import { createElement: h, Fragment, useMemo, useEffect, useState } from 'react'
import { api, kilo } from '../api.js'
import { Panel, Heatmap, TrendChart } from '../chrome.js'

export function Dashboard(props) {
  const { stats, t } = props
  const days = useMemo(() => [...stats.days].sort((a, b) => a.day.localeCompare(b.day)), [stats.days])
  const recent = [...(stats.samples ?? [])].slice(-40)
  // 「最近一回合」跟着一个轻量轮询走（#26）：看板其余部分仍是页面加载时的
  // 快照，这一行单独刷新，让「刚发完一条消息」的用户不用整页重载就能看到
  // 这一回合的 token 去向。聊天窗属于宿主内核，插件无法在对话流里注入，
  // 这是插件表面能做到的最接近实时的位置。
  const [fresh, setFresh] = useState(null)
  useEffect(() => {
    let alive = true
    const timer = setInterval(() => api('/stats').then(data => { if (alive) setFresh(data) }).catch(() => {}), 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  // The host already dropped the windows it could not measure and took out of
  // the numerator the tokens it never streamed. Averaging per-call rates
  // instead let one 1 ms window publish 63 000 tok/s and carry the whole card
  // to 2 493.
  const streamed = recent.filter(sample => sample.decodeMs > 0 && sample.tps !== null)
  const streamMs = streamed.reduce((sum, sample) => sum + sample.decodeMs, 0)
  const weightedTps = streamMs > 0
    ? streamed.reduce((sum, sample) => sum + (sample.decodeTokens ?? 0), 0) / (streamMs / 1000)
    : null
  const latencies = recent.filter(sample => sample.ttftMs !== null && sample.ttftMs !== undefined)
  const models = stats.models ?? []
  const [mode, setMode] = useState('tokens')
  const [metric, setMetric] = useState('total')

  const cumulative = useMemo(() => {
    let tokenRun = 0
    let requestRun = 0
    return days.map(row => {
      tokenRun += row.total
      requestRun += row.models.reduce((sum, m) => sum + m.calls, 0)
      return { ...row, total: mode === 'requests' ? requestRun : tokenRun }
    })
  }, [days, mode])

  const active = metric === 'total' ? undefined : models.find(m => m.model === metric)
  const color = metric === 'total'
    ? 'var(--dsw-alias-state-business-primary)'
    : SEASON[Math.max(0, models.findIndex(m => m.model === metric)) % SEASON.length]

  const headline = h('div', { className: 'ofm_stats' },
    stat(kilo(stats.grand.input + stats.grand.output), t('curve.tokens')),
    stat(kilo(stats.grand.output), t('stat.output')),
    stat(kilo(stats.grand.reasoning), t('stat.reasoning')),
    stat(String(stats.requests ?? 0), t('speed.calls')),
    stat(String(stats.requestFailures ?? stats.grand.failed ?? 0), t('speed.failed')),
    stat(String(stats.turns ?? stats.grand.turns ?? 0), t('speed.turns')),
    stat(String(stats.failedTurns ?? stats.grand.failedTurns ?? 0), t('speed.turnFailed')),
    stat(String(stats.recoveredTurns ?? stats.grand.recoveredTurns ?? 0), t('speed.recovered')))

  const heatmap = h(Panel, { title: t('heat.title') }, h(Heatmap, { days, t }))

  const legend = h('div', { className: 'ofm_chips' },
    chip(t('curve.total'), metric === 'total', SEASON[0], () => setMetric('total')),
    models.map((m, index) => chip(m.name, metric === m.model, SEASON[index % SEASON.length], () => setMetric(m.model))))

  const curve = h(Panel, { title: t('curve.title') },
    h('div', { className: 'ofm_row' },
      h('div', { className: 'ofm_seg' },
        segButton(t('curve.tokens'), mode === 'tokens', () => setMode('tokens')),
        segButton(t('curve.requests'), mode === 'requests', () => setMode('requests'))),
      legend),
    h(TrendChart, { series: cumulative, mode, metric, color }),
    active === undefined ? null : h('p', { className: 'ofm_note' },
      active.name, ' · ', String(active.calls), ' ', t('speed.calls'),
      active.tps === null || active.tps === undefined ? null : ' · ',
      active.tps === null || active.tps === undefined ? null : `${active.tps} ${t('unit.tokPerSec')}`))

  // 最近一回合（#26）：取最新一条调用样本，输入/输出 token、首帧、速度，
  // 失败的调用也如实标出。数据源优先用轮询到的新快照，退回页面加载时的。
  const lastSample = (fresh?.samples ?? stats.samples ?? []).slice(-1)[0] ?? null
  const nameOfModel = id => models.find(m => m.model === id)?.name ?? id
  const agoOf = at => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (seconds < 60) return t('last.justNow')
    if (seconds < 3600) return t('last.minAgo').replace('{n}', String(Math.floor(seconds / 60)))
    if (seconds < 86400) return t('last.hourAgo').replace('{n}', String(Math.floor(seconds / 3600)))
    return t('last.dayAgo').replace('{n}', String(Math.floor(seconds / 86400)))
  }
  const originOf = value => ({ chat: t('last.originChat'), harness: t('last.originHarness'), forward: t('last.originForward'), bench: t('last.originBench') })[value] ?? String(value ?? '')
  const lastTurnStrip = lastSample === null ? null : h('div',
    { className: 'ofm_row', style: { flexWrap: 'wrap', gap: 14, alignItems: 'baseline', paddingBottom: 10, marginBottom: 12, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
    h('b', { style: { fontSize: 13 } }, t('last.title')),
    h('b', { style: { fontSize: 13 } }, nameOfModel(lastSample.model)),
    h('span', { className: 'ofm_note' },
      `${originOf(lastSample.origin)} · ${t('last.input')} ${kilo(lastSample.input)} · ${t('col.output')} ${kilo(lastSample.output)} tok`
      + (lastSample.ttftMs != null ? ` · ${t('speed.ttft')} ${Math.round(lastSample.ttftMs)} ${t('unit.ms')}` : '')
      + (lastSample.tps != null ? ` · ${t('speed.tps')} ${Math.round(lastSample.tps)} ${t('unit.tokPerSec')}` : '')
      + (lastSample.ok === false ? ` · ${t('speed.failed')}` : '')),
    h('span', { className: 'ofm_note', style: { marginLeft: 'auto' } }, agoOf(lastSample.at)))

  const speed = h(Panel, { title: t('speed.title'), hint: recent.length + ' ' + t('speed.calls') },
    recent.length === 0
      ? h('p', { className: 'ofm_note' }, t('speed.none'))
      : h(Fragment, null,
        lastTurnStrip,
        h('div', { className: 'ofm_row', style: { gap: 24 } },
          sparkCell(t('speed.tps'), streamed.map(s => s.tps), SEASON[0], value => Math.round(value) + ' ' + t('unit.tokPerSec'), t, weightedTps),
          sparkCell(t('speed.ttft'), latencies.map(s => s.ttftMs), SEASON[2], value => Math.round(value) + ' ' + t('unit.ms'), t),
          sparkCell(t('stat.output'), recent.map(s => s.output), SEASON[1], value => kilo(value) + ' tok', t)),
        h('p', { className: 'ofm_note' }, t('speed.note')
          .replace('{n}', String(streamed.length))
          .replace('{total}', String(recent.length)))))

  const table = models.length === 0 ? null : h(Panel, { title: t('speed.model') },
    h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
      h('thead', null, h('tr', null,
        h('th', null, t('speed.model')),
        num(t('speed.calls')), num(t('speed.turns')), num(t('speed.recovered')),
        num(t('speed.tps')), num(t('speed.ttft')), num(t('col.reason')),
        num(t('col.output')), num(t('speed.failed')), num(t('speed.turnFailed')))),
      h('tbody', null, [...models].sort((a, b) => b.output - a.output).map(m => h('tr', { key: m.model },
        h('td', { title: m.model }, m.name),
        numTd(m.calls),
        numTd(m.turns),
        numTd(m.recoveredTurns === 0 ? '—' : m.recoveredTurns),
        numTd(m.tps),
        numTd(m.avgTtftMs === null || m.avgTtftMs === undefined ? null : Math.round(m.avgTtftMs)),
        numTd(kilo(m.reasoning)),
        numTd(kilo(m.output)),
        numTd(m.failed === 0 ? '—' : m.failed),
        numTd(m.failedTurns === 0 ? '—' : m.failedTurns)))))))

  const historyNote = stats.logicalEstimated || stats.requestFailuresEstimated
    ? h('p', { className: 'ofm_note' }, t('speed.estimated'))
    : null
  return h(Fragment, null, headline, h('p', { className: 'ofm_note' }, t('speed.scope')), historyNote,
    h('div', { className: 'ofm_two' }, heatmap, curve), speed, table)
}
