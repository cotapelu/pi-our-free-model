/**
 * Preferences: which models the picker shows, and how hard it thinks.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/pages/preferences.js
 */

import { createElement: h, useEffect, useState } from 'react'
import { ago } from '../api.js'
import { Button, Panel, Switch } from '../chrome.js'

export function Preferences(props) {
  const { summary, t, onApply, busy } = props
  const settings = summary.settings
  const [draft, setDraft] = useState(settings)
  useEffect(() => setDraft(settings), [summary])
  return h(Panel, null,
    h('div', { className: 'ofm_row', style: { gap: 20 } },
      h(Switch, { checked: settings.enabled !== false, label: t('pref.enabled'), onChange: () => onApply({ enabled: !(settings.enabled !== false) }) }),
      h(Switch, { checked: settings.exposeRegionModels !== false, label: t('pref.exposeRegion'), onChange: () => onApply({ exposeRegionModels: !(settings.exposeRegionModels !== false) }) })),
    h('div', { className: 'ofm_row', style: { gap: 20 } },
      h(Switch, { checked: settings.hideFreeModels === true, disabled: busy, label: t('pref.hideFreeModels'), onChange: () => onApply({ hideFreeModels: settings.hideFreeModels !== true }) }),
      h(Switch, { checked: settings.hideEacModels === true, disabled: busy, label: t('pref.hideEacModels'), onChange: () => onApply({ hideEacModels: settings.hideEacModels !== true }) })),
    h('div', { className: 'ofm_row' },
      field(t('pref.interval'), h('input', { className: 'ofm_input', style: { maxWidth: 100 }, value: draft?.probeIntervalMinutes ?? 15, onChange: e => setDraft(c => ({ ...c, probeIntervalMinutes: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
      field(t('pref.maxTokens'), h('input', { className: 'ofm_input', style: { maxWidth: 120 }, value: draft?.defaultMaxTokens ?? 32768, onChange: e => setDraft(c => ({ ...c, defaultMaxTokens: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
      h(Button, { kind: 'primary', disabled: busy, onClick: () => onApply({ probeIntervalMinutes: draft.probeIntervalMinutes, defaultMaxTokens: draft.defaultMaxTokens }) }, t('forward.apply'))),
    h('div', { className: 'ofm_row', style: { gap: 8 } },
      h('span', { className: 'ofm_pill' }, `${t('pref.egress')}: ${summary.egress?.ip ?? '—'}${summary.egress?.country ? ` (${summary.egress.country})` : ''}`),
      h('span', { className: 'ofm_pill' }, `${t('pref.probedAt')}: ${ago(summary.probedAt, t.locale)}`)))
}
