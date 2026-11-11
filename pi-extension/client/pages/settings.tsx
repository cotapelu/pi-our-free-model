/**
 * The settings page and its two tabs: the free lane and the co-paid lane.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/settings.js
 */

import { createElement: h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, PageHero, Panel, Section, PanelSkeleton, PanelError, ModelCard, Roster, Heatmap, TrendChart, Sparkline } from '../chrome.js'

export function SettingsPage(props) {
  const tagged = props.locale === undefined ? props.t : Object.assign(x => props.t(x), { locale: props.locale })
  const t = tagged
  const [busy, setBusy] = useState(false)
  const [benches, setBenches] = useState({})
  const summary = useAsync(() => api('/summary'), [])
  const stats = useAsync(() => api('/stats'), [])
  // GitHub 授权状态由这一层持有：模型卡的锁标记与 EAC 面板必须看到同一个
  // 判定，登录 / 退出后两边同时更新；60 秒轮询兜住别处（另一台机器）的变动。
  const [eacAuth, setEacAuth] = useState(undefined)
  useEffect(() => {
    let alive = true
    const load = () => api('/eac/status', { timeout: 20_000 })
      .then(data => { if (alive) setEacAuth(data) })
      .catch(() => { if (alive) setEacAuth({ available: false, authorized: false, login: '' }) })
    load()
    const timer = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  // 登录流只有这一份：EAC 面板、页头的未授权按钮、上锁模型卡的「去授权」
  // 共享同一个进行中的会话（同一轮询、同一条提示），见 useEacLogin。
  const eacLogin = useEacLogin({ t, summary, onAuth: setEacAuth })

  const apply = async patch => {
    setBusy(true)
    try {
      await post('/settings', patch)
      summary.reload(); stats.reload()
    } catch (error) {
      // The route can refuse a patch — a routable forward bind, for one — and a
      // rejection nobody shows is a button that appears to do nothing.
      showToast({ title: t('settings.failed'), body: String(error?.message ?? error), tone: 'warn' })
    } finally { setBusy(false) }
  }
  const bench = async model => {
    setBenches(current => ({ ...current, [model.id]: { running: true } }))
    try {
      // 默认档（balanced）而不是 deep：测速要回答的是“这个模型日常多快”，
      // 默认档就是日常档；deep 每次最多烧 32K 输出 token，且经常把固定
      // bench 会话自己打到 429。
      // The backend owns the 300s total budget; leave 30s for its final response.
      const result = await post('/bench', { model: model.id }, 330_000)
      setBenches(current => ({ ...current, [model.id]: { running: false, result: t('bench.result').replace('{ttft}', result.ttftMs).replace('{tps}', result.tokensPerSecond ?? '—').replace('{reasoning}', result.reasoningTokens ?? '—') + (result.persisted === false ? ' · ' + t('bench.notSaved') : '') } }))
      summary.reload()
    } catch (error) {
      setBenches(current => ({ ...current, [model.id]: { running: false, result: String(error?.message ?? error) } }))
      summary.reload()
    }
  }

  if (summary.status === 'loading' && summary.data === undefined) return h('div', { className: 'ofm_root' }, h('p', { className: 'ofm_note' }, t('loading')))
  if (summary.status === 'error') {
    return h('div', { className: 'ofm_root' },
      h('div', { className: 'ofm_callout ofm_error' }, h('div', null, h('b', null, t('loadFailed')), h('div', null, summary.error))),
      h('div', null, h(Button, { onClick: () => summary.reload() }, t('retry'))))
  }
  const data = summary.data
  // 匿名免费与 Kilo 共用状态统计；清单条目不会被当成实测成功。
  const counts = freePoolView(data).counts
  return h(Shell, {
    t: tagged, data, counts, summary, stats, eacAuth, setEacAuth, eacLogin,
    busy, setBusy, apply, bench, benches, ctx: props.ctx,
  })
}

export function FreePage(props) {
  const { t, data, counts, summary, stats, eacAuth, eacLogin, busy, catalogBusy, apply, bench, benches, refresh, reprobe } = props
  const { total, selectable, anonymous, kilo: kiloCount } = freePoolView(data)
  const ok = counts.available ?? 0
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(100 * selectable / total))) : null
  const ratio = total > 0 ? selectable / total : 0
  // 颜色跟随可选比例；实际探测结果仍由下方五格状态独立显示。
  const level = ratio >= 0.6 ? 'ok' : ratio >= 0.3 ? 'busy' : 'over'
  return h('div', { className: 'ofm_page' },
    h(SponsorBanner, { t }),
    h('header', { className: 'ofm_hero ofm_glass' },
      h('div', { className: 'ofm_pagehead' },
        h('div', { className: 'ofm_pagetitle' },
          h('h2', null, t('free.title')),
          h('p', { className: 'ofm_pagesub' }, t('free.sub'))),
        h('div', { className: 'ofm_pills' },
          h(Pill, { strong: true, tone: data.settings.enabled !== false ? 'ok' : 'err' }, data.settings.enabled !== false ? t('pref.enabled') : 'off'),
          h(Pill, null, `${t('pref.egress')} ${data.egress?.country ?? data.egress?.ip ?? '—'}`),
          h(Pill, null, `${t('pref.probedAt')} ${ago(data.probedAt, t.locale)}`))),
      h('div', { className: 'ofm_tankrow' },
        h(Tank, { pct, level, size: 'xl', label: `${t('free.tankLabel')} ${pct ?? '—'}%` }),
        h('div', { className: 'ofm_tankside' },
          h('div', { className: 'ofm_pooltop' },
            h('span', { className: `ofm_poolbadge ${level}` },
              h('span', { className: 'ofm_pooldot' }),
              `${t('free.tankLabel')} ${pct ?? '—'}%`),
            h(StarButton, { t })),
          h('div', { className: 'ofm_poolstats', title: t('free.statHint').replace('{total}', String(total)) },
            h('div', { className: 'ofm_stat' }, h('b', null, String(ok)), h('span', null, t('state.available'))),
            h('div', { className: `ofm_stat${(counts['region-blocked'] ?? 0) > 0 ? ' hot' : ''}` },
              h('b', null, String(counts['region-blocked'] ?? 0)), h('span', null, t('state.region-blocked'))),
            h('div', { className: 'ofm_stat' }, h('b', null, String(counts.unavailable ?? 0)), h('span', null, t('state.unavailable'))),
            h('div', { className: `ofm_stat${(counts.throttled ?? 0) > 0 ? ' hot' : ''}` },
              h('b', null, String(counts.throttled ?? 0)), h('span', null, t('state.throttled'))),
            h('div', { className: 'ofm_stat' }, h('b', null, String(counts.unknown ?? 0)), h('span', null, t('state.unknown')))),
          h('div', { className: 'ofm_poolmeta' },
            h('span', { className: 'ofm_note' }, total > 0
              ? t('free.tankNote').replace('{selectable}', String(selectable)).replace('{total}', String(total))
              : t('free.tankEmpty')),
            h('span', { className: 'ofm_note' }, t('free.sources').replace('{anonymous}', String(anonymous)).replace('{kilo}', String(kiloCount))),
            h('span', { className: 'ofm_note' }, t('meta.description'))),
          h('div', { className: 'ofm_row' },
            h(Button, { disabled: busy || catalogBusy, onClick: refresh }, catalogBusy || summary.status === 'loading' ? t('probing') : t('refresh')),
            h(Button, { disabled: busy || catalogBusy, onClick: reprobe }, t('reprobe')))))),
    h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, { summary: data, t, onBench: bench, benches, auth: eacAuth, eacLogin, only: 'free', onApply: apply, busy })),
    h(Section, { title: t('section.dash'), hint: t('section.dashHint') },
      stats.status === 'ready' && stats.data !== undefined ? h(Dashboard, { stats: stats.data, summary: data, t })
        : h('p', { className: 'ofm_note' }, t('loading'))),
    h(Section, { title: t('section.forward'), hint: t('section.forwardHint') }, h(Forward, { settings: data.settings, t, onApply: apply, busy })),
    h(Section, { title: t('section.egress'), hint: t('section.egressHint') }, h(Egress, { settings: data.settings, t, onApply: apply, busy })),
    h(Section, { title: t('section.prefs'), hint: t('section.prefsHint') }, h(Preferences, { summary: data, t, onApply: apply, busy })),
    h(Section, { title: t('section.news'), hint: t('section.newsHint') }, h(NewsPanel, { t })))
}

export function EacPage(props) {
  const { t, data, summary, eacAuth, setEacAuth, eacLogin, busy, catalogBusy, apply, bench, benches, refresh, reprobe } = props
  const { pool, poolError } = usePool()
  const reading = pool === undefined || pool === null ? null : poolReading(pool)
  const levelText = reading === null ? '' : reading.level === 'over' ? t('pool.levelOver') : reading.level === 'busy' ? t('pool.levelBusy') : t('pool.levelOk')
  const eacCount = data.catalog.filter(m => m.channel === 'eac').length
  const reasonText = pool === null
    ? (({ 'no-lane': t('pool.reasonNoLane'), 'gateway-status': t('pool.reasonGateway'), malformed: t('pool.reasonMalformed'), unreachable: t('pool.reasonUnreachable') })[poolError]
      ?? (poolError !== '' ? poolError : t('pool.reasonUnknown')))
    : ''
  return h('div', { className: 'ofm_page' },
    h(SponsorBanner, { t }),
    h('header', { className: 'ofm_hero ofm_glass' },
      h('div', { className: 'ofm_pagehead' },
        h('div', { className: 'ofm_pagetitle' },
          h('h2', null, t('eac.title')),
          h('p', { className: 'ofm_pagesub' }, t('eac.sub'))),
        h('div', { className: 'ofm_pills' },
          h(Pill, { strong: true, tone: eacAuth?.authorized === true ? 'ok' : 'warn' },
            eacAuth?.authorized === true ? t('eac.pillOk') : t('eac.pillLocked')),
          h(Pill, null, `${t('section.models')} ${eacCount}`),
          h(Pill, null, `${t('pref.egress')} ${data.egress?.country ?? data.egress?.ip ?? '—'}`))),
      h('div', { className: 'ofm_tankrow' },
        h(Tank, { pct: reading?.pct ?? null, level: reading?.level ?? 'ok', size: 'xl', label: `${t('eac.tankLabel')} ${reading?.rawPct ?? '—'}%` }),
        h('div', { className: 'ofm_tankside' },
          h('div', { className: 'ofm_pooltop' },
            reading === null
              ? h('span', { className: 'ofm_poolbadge' }, h('span', { className: 'ofm_pooldot' }),
                pool === undefined ? t('loading') : t('pool.unavailable').replace('{reason}', reasonText))
              : h('span', { className: `ofm_poolbadge ${reading.level}` },
                h('span', { className: 'ofm_pooldot' }),
                `${levelText} · ${t('pool.live')} ${pool.inflight}`),
            // 未授权时把登录入口放到页头：撞到「没授权」的用户第一眼看到的
            // 位置就该有钥匙，而不是要先找到下方的授权区。
            eacAuth?.available === true && eacAuth?.authorized !== true
              ? h(Button, { kind: 'primary', disabled: eacLogin.busy || eacLogin.pending !== null, onClick: eacLogin.login },
                eacLogin.busy ? t('eac.starting') : t('eac.login'))
              : null,
            h(StarButton, { t })),
          reading === null ? null : h(Fragment, null,
            h('div', { className: 'ofm_poolstats' },
              h('div', { className: `ofm_stat${reading.level === 'over' ? ' hot' : ''}` },
                h('b', null, String(pool.inflight)), h('span', null, t('pool.live'))),
              h('div', { className: 'ofm_stat' },
                h('b', null, reading.active === null ? '—' : String(reading.active)), h('span', null, t('pool.active'))),
              h('div', { className: 'ofm_stat' },
                h('b', null, reading.capacityKnown ? String(pool.pool) : '—'), h('span', null, t('pool.capacity')))),
            h('div', { className: 'ofm_poolmeta' },
              h('span', { className: 'ofm_note' }, `${t('pool.reach')} ${reading.rawPct ?? '—'}%`),
              h('span', { className: 'ofm_note' }, capacityText(pool, t)))),
          h('div', { className: 'ofm_row' },
            h(Button, { disabled: busy || catalogBusy, onClick: refresh }, catalogBusy || summary.status === 'loading' ? t('probing') : t('refresh')),
            h(Button, { disabled: busy || catalogBusy, onClick: reprobe }, t('reprobe')))))),
    h(Section, { title: t('section.eac'), hint: t('section.eacHint') }, h(EacAuth, { t, auth: eacAuth, eacLogin })),
    h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, { summary: data, t, onBench: bench, benches, auth: eacAuth, eacLogin, only: 'eac', onApply: apply, busy })),
    h(Section, { title: t('section.news'), hint: t('section.newsHint') }, h(NewsPanel, { t })))
}
