/**
 * The ledger, the run log and the gateway settings page.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/ledger.js
 */

import { createElement: h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, PageHero, Panel, Section, PanelSkeleton, PanelError, ModelCard, Roster, Heatmap, TrendChart, Sparkline } from '../chrome.js'

export function LedgerPage(props) {
  const { t, ctx } = props
  const ledger = useLedger(props)
  const [scope, setScope] = useState('today')
  const loaded = ledger.status === 'ready'
  // 今日 = the pack's live snapshot (its in-memory day tree); 全部 = the
  // persisted day aggregation, merged back into one tree. The grand
  // cumulative number always reads the history total — even on 今日 —
  // because "累计" that resets at midnight is a lie.
  const channels = scope === 'today'
    ? (ledger.snapshot?.channels ?? [])
    : mergedHistoryChannels(ledger.history)
  const totals = scope === 'today'
    ? mergeLedgerRows([ledger.snapshot?.totals ?? {}])
    : mergeLedgerRows((ledger.history ?? []).map(day => day.totals ?? {}))
  const cumulative = ledger.totals ?? ledger.snapshot?.totals ?? {}
  const accounts = ledgerAccountRows(channels)
  const models = ledgerModelRows(channels).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
  // The pack's ring is already newest-first (`token-ledger.ts`: "最近明细
  // （最新在前）", built with `unshift`), so it is used as served. Reversing it
  // here put the oldest request at the top of the table — and, behind the log
  // page's pagination, the request the user just made on the last page.
  const entries = ledger.snapshot?.entries ?? []
  const tokenTotal = totals.inputTokens + totals.outputTokens
  const cacheBase = totals.inputTokens + totals.cacheReadTokens

  if (ledger.status === 'unavailable') {
    return h('div', { className: 'ofm_page' },
      h(PageHero, { title: t('dash.title'), sub: t('dash.sub') }),
      h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))))
  }
  return h('div', { className: 'ofm_page' },
    h(PageHero, { t, titleKey: 'dash.title', subKey: 'dash.sub' },
      h('div', { className: 'ofm_seg', role: 'tablist' },
        ['today', 'all'].map(key => h('button', {
          key, type: 'button', 'aria-pressed': scope === key ? 'true' : 'false',
          onClick: () => setScope(key),
        }, key === 'today' ? t('dash.today') : t('dash.all')))),
      h(Button, { onClick: () => void ledger.reload() }, t('dash.refresh'))),
    !loaded ? h('div', { className: 'ofm_chanwrap' }, [0, 1, 2].map(i => h('div', { className: 'ofm_skel', key: i, style: { minHeight: 120 } }))) : null,
    loaded ? h('div', { className: 'ofm_kpis' },
      h(KpiCard, { label: scope === 'today' ? t('dash.kpiToday') : t('dash.kpiScopeAll'), value: fmtInt(tokenTotal), sub: `${t('dash.input')} ${fmtInt(totals.inputTokens)} · ${t('dash.output')} ${fmtInt(totals.outputTokens)} · ${t('dash.reasoning')} ${fmtInt(totals.reasoningTokens)}` }),
      h(KpiCard, { label: t('dash.kpiCumulative'), value: fmtInt((cumulative.inputTokens ?? 0) + (cumulative.outputTokens ?? 0)), sub: `${t('dash.input')} ${fmtInt(cumulative.inputTokens)} · ${t('dash.output')} ${fmtInt(cumulative.outputTokens)} · ${t('dash.reasoning')} ${fmtInt(cumulative.reasoningTokens)}` }),
      h(KpiCard, { label: t('dash.kpiSpeed'), value: fmtTps(totals.avgTps), sub: `${t('dash.ttft')} ${fmtMs(totals.avgTtftMs)}` }),
      h(KpiCard, { label: t('dash.kpiCache'), value: fmtPct(totals.cacheReadTokens, cacheBase), sub: `${t('dash.cacheTokens')} ${fmtInt(totals.cacheReadTokens)}` }),
      h(KpiCard, { label: t('dash.kpiRequests'), value: fmtInt(totals.requests), sub: `${t('dash.successRate')} ${fmtPct(totals.requests - totals.errors, totals.requests)} · ${t('dash.failed')} ${fmtInt(totals.errors)}`, tone: totals.errors > 0 ? 'warn' : '' })) : null,
    loaded ? h(Section, { title: t('dash.recentTitle'), hint: t('dash.recentHint') },
      entries.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
        : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
            h('thead', null, h('tr', null,
            h('th', { key: 'time' }, t('log.time')),
            h('th', { key: 'chan' }, t('chan.titleSingle')),
            h('th', { key: 'model' }, t('log.model')),
            h('th', { key: 'account' }, t('log.account')),
            h('th', { key: 'via' }, t('log.via')),
            h('th', { key: 'result' }, t('log.result')),
            h('th', { key: 'duration' }, t('log.duration')),
            h('th', { key: 'ttft' }, t('log.ttft')),
            h('th', { key: 'speed' }, t('log.speed')),
            h('th', { key: 'input' }, t('log.input')),
            h('th', { key: 'output' }, t('log.output')),
            h('th', { key: 'reasoning' }, t('log.reasoning')),
            h('th', { key: 'cache' }, t('log.cache')),
            h('th', { key: 'total' }, t('log.total')))),
          h('tbody', null, entries.slice(0, 12).map((entry, index) => h('tr', { key: index },
            h('td', null, new Date(entry.ts).toLocaleString()),
            h('td', null, entry.provider),
            h('td', null, entry.model),
            h('td', null, entry.accountId || '—'),
            h('td', null, entry.channel === 'gateway' ? t('log.viaGateway') : t('log.viaDirect')),
            h('td', null, entry.error ? h('span', { className: 'ofm_badge unavailable', title: entry.error }, t('log.failed')) : h('span', { className: 'ofm_badge available' }, t('log.ok'))),
            h('td', { className: 'ofm_num' }, fmtMs(entry.durationMs)),
            h('td', { className: 'ofm_num' }, fmtMs(entry.ttftMs)),
            h('td', { className: 'ofm_num' }, fmtTps(entry.tps)),
            h('td', { className: 'ofm_num' }, fmtInt(entry.inputTokens)),
            h('td', { className: 'ofm_num' }, fmtInt(entry.outputTokens)),
            h('td', { className: 'ofm_num' }, Number.isFinite(entry.reasoningTokens) ? fmtInt(entry.reasoningTokens) : '—'),
            h('td', { className: 'ofm_num' }, Number.isFinite(entry.cacheReadTokens) ? fmtInt(entry.cacheReadTokens) : '—'),
            h('td', { className: 'ofm_num' }, h('b', null, fmtInt(entry.inputTokens + entry.outputTokens))))))))) : null,
    loaded ? h(Section, { title: t('dash.accountsTitle'), hint: t('dash.accountsHint') },
      accounts.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
        : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
          h('thead', null, h('tr', null,
            h('th', { key: 'account' }, t('log.account')),
            h('th', { key: 'chan' }, t('chan.titleSingle')),
            h('th', { key: 'requests' }, t('log.requests')),
            h('th', { key: 'total' }, t('log.total')),
            h('th', { key: 'input' }, t('log.input')),
            h('th', { key: 'output' }, t('log.output')),
            h('th', { key: 'reasoning' }, t('log.reasoning')),
            h('th', { key: 'cache' }, t('log.cache')),
            h('th', { key: 'mix' }, t('log.modelMix')))),
          h('tbody', null, accounts.sort((a, b) => b.requests - a.requests).map((row, index) => h('tr', { key: index },
            h('td', null, h('b', null, row.accountId || t('log.unattributed'))),
            h('td', null, row.provider),
            h('td', { className: 'ofm_num' }, fmtInt(row.requests)),
            h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens + row.outputTokens)),
            h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens)),
            h('td', { className: 'ofm_num' }, fmtInt(row.outputTokens)),
            h('td', { className: 'ofm_num' }, fmtInt(row.reasoningTokens)),
            h('td', { className: 'ofm_num' }, fmtInt(row.cacheReadTokens)),
            h('td', null, (row.models ?? []).slice().sort((a, b) => ((b.inputTokens ?? 0) + (b.outputTokens ?? 0)) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0))).slice(0, 2).map(model => `${model.model} · ${fmtInt((model.inputTokens ?? 0) + (model.outputTokens ?? 0))}`).join('，') || '—'))))))) : null,
    loaded ? h(Section, { title: t('dash.modelsTitle'), hint: t('dash.modelsHint') },
      models.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
        : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
          h('thead', null, h('tr', null,
            h('th', { key: 'model' }, t('log.model')),
            h('th', { key: 'chan' }, t('chan.titleSingle')),
            h('th', { key: 'requests' }, t('log.requests')),
            h('th', { key: 'failed' }, t('log.failed')),
            h('th', { key: 'total' }, t('log.total')),
            h('th', { key: 'slash' }, t('log.inputSlash')),
            h('th', { key: 'ttft' }, t('log.ttft')),
            h('th', { key: 'speed' }, t('log.speed')),
            h('th', { key: 'hit' }, t('log.cacheHit')),
            h('th', { key: 'share' }, t('log.share')))),
          h('tbody', null, models.map(row => h('tr', { key: row.model },
            h('td', null, h('b', null, row.model)),
            h('td', null, row.providers.join('，')),
            h('td', { className: 'ofm_num' }, fmtInt(row.requests)),
            h('td', { className: 'ofm_num' }, row.errors > 0 ? h('span', { className: 'ofm_badge unavailable' }, fmtInt(row.errors)) : fmtInt(0)),
            h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens + row.outputTokens)),
            h('td', { className: 'ofm_num' }, `${fmtInt(row.inputTokens)} / ${fmtInt(row.outputTokens)} / ${fmtInt(row.reasoningTokens)}`),
            h('td', { className: 'ofm_num' }, fmtMs(row.avgTtftMs)),
            h('td', { className: 'ofm_num' }, fmtTps(row.avgTps)),
            h('td', { className: 'ofm_num' }, fmtPct(row.cacheReadTokens, row.inputTokens + row.cacheReadTokens)),
            h('td', { className: 'ofm_num' }, `${fmtPct(row.inputTokens + row.outputTokens, tokenTotal)}`))))))) : null)
}

export function LogsPage(props) {
  const { t, ctx } = props
  const ledger = useLedger(props)
  const [pageSize, setPageSize] = useState(20)
  const [auto, setAuto] = useState(false)
  const reload = ledger.reload
  useEffect(() => {
    if (auto !== true) return undefined
    const timer = setInterval(() => { void reload() }, 10_000)
    return () => clearInterval(timer)
  }, [auto, reload])
  // Newest first, as the pack serves it — see the note in LedgerPage.
  const entries = ledger.snapshot?.entries ?? []
  const pages = Math.max(1, Math.ceil(entries.length / pageSize))
  const [page, setPage] = useState(1)
  const safePage = Math.min(page, pages)
  const rows = entries.slice((safePage - 1) * pageSize, safePage * pageSize)
  return h('div', { className: 'ofm_page' },
    h(PageHero, { title: t('logs.title'), sub: t('logs.sub') },
      h('div', { className: 'ofm_seg' }, [10, 20, 50, 100].map(size => h('button', {
        key: size, type: 'button', 'aria-pressed': pageSize === size ? 'true' : 'false',
        onClick: () => { setPageSize(size); setPage(1) },
      }, String(size)))),
      h(Switch, { checked: auto, label: t('logs.auto'), onChange: () => setAuto(value => !value) }),
      h(Button, { onClick: () => void reload() }, t('dash.refresh'))),
    ledger.status === 'unavailable' ? h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))) : null,
    ledger.status === 'loading' ? h('div', { className: 'ofm_skel', style: { minHeight: 200 } }) : null,
    ledger.status === 'ready' ? h(Section, {
      title: t('logs.title'),
      hint: t('logs.count').replace('{shown}', String(rows.length)).replace('{total}', String(entries.length)),
    },
      entries.length === 0 ? h('p', { className: 'ofm_note' }, t('logs.empty'))
        : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
          h('thead', null, h('tr', null,
            h('th', { key: 'time' }, t('log.time')),
            h('th', { key: 'chan' }, t('chan.titleSingle')),
            h('th', { key: 'model' }, t('log.model')),
            h('th', { key: 'account' }, t('log.account')),
            h('th', { key: 'via' }, t('log.via')),
            h('th', { key: 'result' }, t('log.result')),
            h('th', { key: 'duration' }, t('log.duration')),
            h('th', { key: 'ttft' }, t('log.ttft')),
            h('th', { key: 'speed' }, t('log.speed')),
            h('th', { key: 'input' }, t('log.input')),
            h('th', { key: 'output' }, t('log.output')),
            h('th', { key: 'reasoning' }, t('log.reasoning')),
            h('th', { key: 'cache' }, t('log.cache')),
            h('th', { key: 'total' }, t('log.total')))),
          h('tbody', null, rows.map((entry, index) => h('tr', { key: index, className: entry.error ? 'ofm_logfailed' : '' },
            h('td', null, new Date(entry.ts).toLocaleString()),
            h('td', null, entry.provider),
            h('td', null, entry.model),
            h('td', null, entry.accountId || '—'),
            h('td', null, entry.channel === 'gateway' ? t('log.viaGateway') : t('log.viaDirect')),
            h('td', null, entry.error ? h('span', { className: 'ofm_badge unavailable', title: entry.error }, t('log.failed')) : h('span', { className: 'ofm_badge available' }, t('log.ok'))),
            h('td', { className: 'ofm_num' }, fmtMs(entry.durationMs)),
            h('td', { className: 'ofm_num' }, fmtMs(entry.ttftMs)),
            h('td', { className: 'ofm_num' }, fmtTps(entry.tps)),
            h('td', { className: 'ofm_num' }, fmtInt(entry.inputTokens)),
            h('td', { className: 'ofm_num' }, fmtInt(entry.outputTokens)),
            h('td', { className: 'ofm_num' }, Number.isFinite(entry.reasoningTokens) ? fmtInt(entry.reasoningTokens) : '—'),
            h('td', { className: 'ofm_num' }, Number.isFinite(entry.cacheReadTokens) ? fmtInt(entry.cacheReadTokens) : '—'),
            h('td', { className: 'ofm_num' }, h('b', null, fmtInt(entry.inputTokens + entry.outputTokens)))))))),
      pages > 1 ? h('div', { className: 'ofm_row' },
        h(Button, { kind: 'ghost', disabled: safePage <= 1, onClick: () => setPage(value => Math.max(1, value - 1)) }, '‹'),
        h('span', { className: 'ofm_note' }, t('logs.page').replace('{page}', String(safePage)).replace('{pages}', String(pages))),
        h(Button, { kind: 'ghost', disabled: safePage >= pages, onClick: () => setPage(value => Math.min(pages, value + 1)) }, '›')) : null,
      h('p', { className: 'ofm_note' }, t('logs.windowNote'))) : null)
}

export function GatewayPage(props) {
  const { t, ctx } = props
  const { available, rpc } = useChannelRpc(ctx)
  const [status, setStatus] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [keyShown, setKeyShown] = useState(false)
  const [relay, setRelay] = useState(undefined)
  const [relayKey, setRelayKey] = useState('')
  const [relayBusy, setRelayBusy] = useState(false)
  // 免费车道转发端口的接入配方。它和上面这块网关是两条独立监听：这里的地址与
  // 密钥由宿主按实际绑定的端口生成，端口没开就只给一句说明而不是一堆会骗人的
  // 配方（未启用时 /clients 回的是占位端口与占位 Key）。
  const clients = usePanel(() => api('/clients'), [])

  const loadGateway = useCallback(async () => {
    if (!available) return
    try { setStatus(await rpc('gateway.getEnabled', {}, 30_000)) } catch (error) { setNotice(String(error?.message ?? error)) }
  }, [available, rpc])
  const loadRelay = useCallback(async () => {
    try { setRelay(await api('/chan-gateway')) } catch { setRelay(null) }
  }, [])
  useEffect(() => { void loadGateway(); void loadRelay() }, [loadGateway, loadRelay])

  const toggleGateway = async enabled => {
    setBusy(true); setNotice('')
    try { setStatus(await rpc('gateway.setEnabled', { enabled }, 60_000)) } catch (error) { setNotice(String(error?.message ?? error)) } finally { setBusy(false) }
  }
  const applyRelay = async patch => {
    setRelayBusy(true); setNotice('')
    try { setRelay(await post('/chan-gateway/apply', patch)) } catch (error) { setNotice(String(error?.message ?? error)) } finally { setRelayBusy(false) }
  }
  const showRelayKey = async () => {
    try { setRelayKey((await api('/chan-gateway/key')).key ?? '') } catch { setRelayKey('') }
  }

  // The RPC returns structured values, not strings: `address` is
  // { host, port } and `apiKey` is { value, fromEnv, path } — rendering
  // either directly hands React an object, which is a crash (#31), not a
  // wrong sentence.
  const address = status?.address ?? null
  const gatewayUrl = address !== null && typeof address === 'object'
    ? `http://${address.host}:${address.port}/v1`
    : ''
  const apiKeyInfo = typeof status?.apiKey === 'object' && status?.apiKey !== null ? status.apiKey : null
  const apiKeyValue = apiKeyInfo?.value ?? ''
  const models = status?.models ?? []
  return h('div', { className: 'ofm_page' },
    h(PageHero, { title: t('gw.title'), sub: t('gw.sub') },
      h(Button, { onClick: () => { void loadGateway(); void loadRelay() } }, t('dash.refresh'))),
    notice !== '' ? h('div', { className: 'ofm_callout ofm_error' }, h('div', null, notice)) : null,
    h(Section, { title: t('gw.gatewayTitle'), hint: t('gw.gatewayHint') },
      status === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 96 } })
        : h('div', { className: 'ofm_panel' },
          h('div', { className: 'ofm_row' },
            h(Pill, { strong: true, tone: status.running === true ? 'ok' : 'warn' }, status.running === true ? t('gw.running') : t('gw.stopped')),
            status.blockedByEnv === true ? h(Pill, { tone: 'err' }, t('gw.envBlocked')) : null,
            h(Switch, { checked: status.enabled === true, label: t('gw.switch'), onChange: () => void toggleGateway(status.enabled !== true), disabled: busy })),
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('gw.endpoint')),
            gatewayUrl === '' ? h('span', { className: 'ofm_note' }, '—')
              : h(Fragment, null, h('code', { className: 'ofm_mono' }, gatewayUrl), h(Button, { kind: 'ghost', onClick: () => copy(gatewayUrl, () => {}) }, t('eac.copy')))),
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('gw.key')),
            apiKeyValue === '' ? h('span', { className: 'ofm_note' }, t('gw.keyNone'))
              : h(Fragment, null,
                h('code', { className: 'ofm_mono' }, keyShown ? apiKeyValue : '••••••••••••••••'),
                h(Button, { kind: 'ghost', onClick: () => setKeyShown(value => !value) }, keyShown ? t('gw.hide') : t('gw.show')),
                h(Button, { kind: 'ghost', onClick: () => copy(apiKeyValue, () => {}) }, t('eac.copy'))),
            h('span', { className: 'ofm_note' }, apiKeyInfo === null ? t('gw.keyNoneHint') : t('gw.keyNote'))),
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, `${t('gw.models')} ${models.length}`),
            h('span', { className: 'ofm_note' }, t('gw.portNote'))))),
    h(Section, { title: t('gw.relayTitle'), hint: t('gw.relayHint') },
      relay === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 96 } })
        : h('div', { className: 'ofm_panel' },
          h('div', { className: 'ofm_row' },
            h(Pill, { strong: true, tone: relay.relay?.running === true ? 'ok' : 'warn' }, relay.relay?.running === true ? t('gw.running') : t('gw.stopped')),
            h(Switch, {
              checked: relay.relay?.enabled === true, label: t('gw.relaySwitch'), disabled: relayBusy,
              onChange: () => void applyRelay({ enabled: relay.relay?.enabled !== true }),
            })),
          relay.relay?.error ? h('div', { className: 'ofm_callout ofm_error' }, h('div', null, relay.relay.error)) : null,
          h('div', { className: 'ofm_row' },
            h('div', { className: 'ofm_field' }, h('span', null, t('gw.relayBind')),
              h('select', {
                className: 'ofm_input', value: relay.relay?.host ?? '127.0.0.1',
                onChange: event => void applyRelay({ host: event.target.value }),
              },
              h('option', { value: '127.0.0.1' }, t('gw.bindLocal')),
              h('option', { value: '0.0.0.0' }, t('gw.bindLan')))),
            h('div', { className: 'ofm_field' }, h('span', null, t('gw.relayPort')),
              h('input', {
                className: 'ofm_input', type: 'number', min: 0, max: 65535, style: { width: 120 },
                defaultValue: relay.relay?.port ?? 18326,
                onBlur: event => { const port = Number(event.target.value); if (Number.isInteger(port) && port >= 0 && port <= 65535 && port !== (relay.relay?.port ?? 0)) void applyRelay({ port }) },
              }))),
          relay.relay?.running === true ? h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('gw.relayUrl')),
            h('code', { className: 'ofm_mono' }, `http://${relay.relay.host === '0.0.0.0' || relay.relay.host === '::' ? '<lan-ip>' : relay.relay.host}:${relay.relay.port}/v1`),
            h(Button, { kind: 'ghost', onClick: () => copy(`http://${relay.relay.host}:${relay.relay.port}/v1`, () => {}) }, t('eac.copy'))) : null,
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('gw.relayKey')),
            h('code', { className: 'ofm_mono' }, relayKey === '' ? '••••••••••••••••' : relayKey),
            h(Button, { kind: 'ghost', onClick: () => void showRelayKey() }, t('gw.show')),
            relayKey === '' ? null : h(Button, { kind: 'ghost', onClick: () => copy(relayKey, () => {}) }, t('eac.copy')),
            h(Button, {
              kind: 'ghost', disabled: relayBusy,
              onClick: async () => { try { setRelayKey((await post('/chan-gateway/rotate')).key ?? '') } catch (error) { setNotice(String(error?.message ?? error)) } },
            }, t('gw.rotate'))),
          h('p', { className: 'ofm_note' }, t('gw.relayNote')),
          h('p', { className: 'ofm_note' }, t('gw.freeLaneNote')))),
    h(Section, { title: t('gw.clientsTitle'), hint: t('gw.clientsHint') },
      clients.status === 'loading' ? h('div', { className: 'ofm_skel', style: { minHeight: 96 } })
        : clients.status === 'error'
          ? h(PanelError, { t, title: t('gw.clientsTitle'), message: clients.error, onRetry: clients.reload })
          // The recipes are generated from the port that actually bound, so a
          // listener that is off has nothing honest to print: the route answers
          // with a placeholder port and a placeholder key, and a pasted
          // placeholder is a client that silently fails to connect.
          : clients.data?.running !== true
            ? h('div', { className: 'ofm_callout ofm_rise' },
              h('div', null, h('b', null, t('gw.clientsOff')), h('div', null, t('gw.clientsOffHint'))))
            : h('div', { className: 'ofm_panel ofm_rise' },
              h('div', { className: 'ofm_row' },
                h('span', { className: 'ofm_note' }, t('forward.baseUrl')),
                h('code', { className: 'ofm_mono' }, clients.data.baseUrl),
                h(CopyButton, { t, text: clients.data.baseUrl }),
                h('span', { className: 'ofm_note' }, t('gw.clientsModels').replace('{n}', String((clients.data.models ?? []).length)))),
              clients.data.lanUrl === '' ? null
                : h('div', { className: 'ofm_row' },
                  h('span', { className: 'ofm_note' }, t('forward.lanUrl')),
                  h('code', { className: 'ofm_mono' }, clients.data.lanUrl),
                  h(CopyButton, { t, text: clients.data.lanUrl })),
              h('div', { className: 'ofm_duo' }, (clients.data.snippets ?? []).map((snippet, index) => h('div', {
                key: snippet.id, className: 'ofm_card ofm_rise',
                style: { animationDelay: `${Math.min(index, 8) * 22}ms` },
              },
              h('div', { className: 'ofm_cardhead' },
                h('span', { className: 'ofm_cardname' }, snippet.name),
                h('span', { className: 'ofm_tag' }, snippet.language)),
              h('pre', { className: 'ofm_snippet' }, snippet.body),
              h('div', { className: 'ofm_row' }, h(CopyButton, { t, text: snippet.body }))))))))
}
