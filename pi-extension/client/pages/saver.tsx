/**
 * The token-saver page: what the savers measured, per model.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/saver.js
 */

import { createElement: h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, PageHero, Panel, Section, PanelSkeleton, PanelError, ModelCard, Roster, Heatmap, TrendChart, Sparkline } from '../chrome.js'

export function SaverPage(props) {
  const { t } = props
  const panel = usePanel(() => Promise.all([api('/token-saver'), api('/local-optimize')])
    .then(([saver, local]) => ({ saver, local })), [])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const saver = panel.data?.saver
  const local = panel.data?.local
  const savings = saver?.savings ?? null

  const write = async (kind, action) => {
    setBusy(kind)
    setError('')
    try { await action() } catch (failure) {
      // The route refuses an unknown level with a 400 and a sentence naming
      // the legal ones; showing it is more useful than swallowing it.
      setError(String(failure?.message ?? failure))
      showToast({ title: t('saver.failed'), body: String(failure?.message ?? failure), tone: 'warn', holdMs: 6000 })
    } finally { setBusy('') }
  }
  const saveSaver = patch => write('saver', async () => {
    const answer = await post('/token-saver', patch)
    // The POST answer carries the stored switches; the measurement is the
    // host's own tally and is only served by the GET, so it is kept as-is.
    panel.patch(current => ({ ...current, saver: { ...answer.tokenSaver, savings: current.saver?.savings } }))
    showToast({ title: t('saver.saved'), body: t('saver.savedBody'), holdMs: 3200 })
  })
  const saveLocal = patch => write('local', async () => {
    const answer = await post('/local-optimize', patch)
    panel.patch(current => ({ ...current, local: answer.localOptimize }))
    showToast({ title: t('saver.saved'), body: t('saver.savedBody'), holdMs: 3200 })
  })

  return h('div', { className: 'ofm_page' },
    h(PageHero, { title: t('saver.title'), sub: t('saver.sub') },
      h('div', { className: 'ofm_pills' },
        h(Pill, { strong: true, tone: saver?.enabled === false ? 'warn' : 'ok' },
          saver?.enabled === false ? t('agg.disabled') : t('agg.enabled')))),
    panel.status === 'loading' ? h(PanelSkeleton) : null,
    panel.status === 'error'
      ? h(PanelError, { t, title: t('saver.loadFailed'), message: panel.error, onRetry: panel.reload })
      : null,
    error === '' ? null : h('div', { className: 'ofm_callout ofm_error ofm_rise' }, h('div', null, error)),
    panel.status === 'ready'
      ? h(Fragment, null,
        // The master switch governs all three savers, so it stands on its own
        // above them: inside the prompt-shaping section it read as that
        // section's switch, which is the one thing it is not.
        h('div', { className: 'ofm_panel ofm_rise' },
          h('div', { className: 'ofm_row' },
            h(Switch, {
              checked: saver.enabled !== false, label: t('saver.master'), disabled: busy !== '',
              onChange: () => { if (busy === '') saveSaver({ enabled: saver.enabled === false }) },
            }),
            h('span', { className: 'ofm_note' }, t('saver.masterHint')))),
        h(Section, { title: t('saver.dashTitle'), hint: t('saver.dashHint') },
          savings === null
            ? h('p', { className: 'ofm_note' }, t('saver.noData'))
            : h('div', { className: 'ofm_panel ofm_rise' },
              h('div', { className: 'ofm_stats' },
                stat(`${fmtInt(savings.bytesBefore)} B`, t('saver.bytesBefore')),
                stat(`${fmtInt(savings.bytesAfter)} B`, t('saver.bytesAfter')),
                stat(`${fmtInt(savings.saved)} B`, t('saver.bytesSaved')),
                stat(String(savings.blocks), t('saver.blocks')),
                stat(String(savings.calls), t('saver.calls')),
                stat(String(savings.promptCalls), t('saver.promptCalls'))),
              savings.bytesBefore > 0
                ? h(SavingsMeter, { t, percent: savings.percent })
                : h('p', { className: 'ofm_note' }, t('saver.noData')),
              savings.summary === undefined || savings.summary === ''
                ? null
                : h('p', { className: 'ofm_note' }, `${t('saver.report')} · ${savings.summary}`))),
        h(Section, { title: t('saver.promptTitle'), hint: t('saver.promptHint') },
          h('div', { className: 'ofm_panel ofm_rise' },
            h('div', { className: 'ofm_duo' },
              h('div', { className: 'ofm_field' },
                h('span', null, t('saver.caveman')),
                h(LevelPicker, {
                  t, levels: saver.cavemanLevels ?? [], value: saver.prompts?.caveman, disabled: busy !== '',
                  onChange: level => saveSaver({ prompts: { caveman: level } }),
                }),
                h('span', null, t('saver.cavemanWhat'))),
              h('div', { className: 'ofm_field' },
                h('span', null, t('saver.ponytail')),
                h(LevelPicker, {
                  t, levels: saver.ponytailLevels ?? [], value: saver.prompts?.ponytail, disabled: busy !== '',
                  onChange: level => saveSaver({ prompts: { ponytail: level } }),
                }),
                h('span', null, t('saver.ponytailWhat')))),
            h('p', { className: 'ofm_note' }, t('saver.voiceWarn')))),
        h(Section, { title: t('saver.rtk'), hint: t('saver.rtkWhat') },
          h('div', { className: 'ofm_panel ofm_rise' },
            h('div', { className: 'ofm_row' },
              h(Switch, {
                checked: saver.rtk === true, label: t('saver.rtk'), disabled: busy !== '',
                onChange: () => { if (busy === '') saveSaver({ rtk: saver.rtk !== true }) },
              })),
            h('p', { className: 'ofm_note' }, t('saver.rtkSafety')))),
        h(Section, { title: t('saver.localTitle'), hint: t('saver.localHint') },
          h('div', { className: 'ofm_panel ofm_rise' },
            h('div', { className: 'ofm_row' },
              h(Switch, {
                checked: local.enabled !== false, label: t('saver.local.enabled'), disabled: busy !== '',
                onChange: () => { if (busy === '') saveLocal({ enabled: local.enabled === false }) },
              })),
            h('div', { className: 'ofm_duo' },
              h('div', { className: 'ofm_field' },
                h(Switch, {
                  checked: local.quota !== false, label: t('saver.local.quota'), disabled: busy !== '',
                  onChange: () => { if (busy === '') saveLocal({ quota: local.quota === false }) },
                }),
                h('span', null, t('saver.local.quotaHint'))),
              h('div', { className: 'ofm_field' },
                h(Switch, {
                  checked: local.prefix !== false, label: t('saver.local.prefix'), disabled: busy !== '',
                  onChange: () => { if (busy === '') saveLocal({ prefix: local.prefix === false }) },
                }),
                h('span', null, t('saver.local.prefixHint'))),
              h('div', { className: 'ofm_field' },
                h(Switch, {
                  checked: local.title !== false, label: t('saver.local.title'), disabled: busy !== '',
                  onChange: () => { if (busy === '') saveLocal({ title: local.title === false }) },
                }),
                h('span', null, t('saver.local.titleHint'))),
              h('div', { className: 'ofm_field' },
                h(Switch, {
                  checked: local.suggestion !== false, label: t('saver.local.suggestion'), disabled: busy !== '',
                  onChange: () => { if (busy === '') saveLocal({ suggestion: local.suggestion === false }) },
                }),
                h('span', null, t('saver.local.suggestionHint'))),
              h('div', { className: 'ofm_field' },
                h(Switch, {
                  checked: local.filepath !== false, label: t('saver.local.filepath'), disabled: busy !== '',
                  onChange: () => { if (busy === '') saveLocal({ filepath: local.filepath === false }) },
                }),
                h('span', null, t('saver.local.filepathHint')))))))
      : null)
}
