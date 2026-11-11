/**
 * The routing-group page: chains of models, and the order they answer in.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/routing.js
 */

import { createElement: h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, PageHero, Panel, Section, PanelSkeleton, PanelError, ModelCard, Roster, Heatmap, TrendChart, Sparkline } from '../chrome.js'

export function RoutingPage(props) {
  const { t } = props
  const panel = usePanel(() => api('/combos'), [])
  const [editing, setEditing] = useState(null)
  const [confirm, setConfirm] = useState('')
  const chains = panel.data?.combos ?? []
  const models = panel.data?.models ?? []
  const lookup = useMemo(() => new Map(models.map(row => [row.id, row])), [models])

  const resolvedOf = chain => {
    const answered = (panel.data?.usable ?? []).find(row => row.id === chain.id)
    if (answered !== undefined) return answered.models
    return (chain.models ?? []).filter(id => lookup.has(id))
  }
  const missingOf = chain => (chain.models ?? []).filter(id => !lookup.has(id))
  const save = async row => {
    // The whole list is written back, because that is the route's shape: it
    // normalizes and replaces. An edit keeps its id, so a rename never changes
    // the model id a client may already be pinned to.
    const known = chains.some(chain => chain.id === row.id)
    const rows = known ? chains.map(chain => chain.id === row.id ? row : chain) : [...chains, row]
    const answer = await post('/combos', { combos: rows })
    panel.patch({ combos: answer.combos, usable: answer.usable })
    panel.reload()
    setEditing(null)
    showToast({ title: t('routing.saved'), body: t('routing.savedBody'), holdMs: 3200 })
  }
  const remove = async id => {
    const answer = await post('/combos', { combos: chains.filter(chain => chain.id !== id) })
    panel.patch({ combos: answer.combos, usable: answer.usable })
    panel.reload()
    setConfirm('')
    showToast({ title: t('routing.saved'), body: t('routing.savedBody'), holdMs: 3200 })
  }
  // A fresh chain is the same editor with an empty draft: the fields, the
  // member list and the validation are identical, only the id is absent.
  const blank = { name: '', models: [], strategy: 'fallback', stickyLimit: 1, enabled: true }

  return h('div', { className: 'ofm_page' },
    h(PageHero, { title: t('routing.title'), sub: t('routing.sub') },
      h('div', { className: 'ofm_pills' },
        h(Pill, null, t('routing.chains') + ' ' + String(chains.length)))),
    panel.status === 'loading' ? h(PanelSkeleton) : null,
    panel.status === 'error'
      ? h(PanelError, { t, title: t('routing.loadFailed'), message: panel.error, onRetry: panel.reload })
      : null,
    panel.status === 'ready'
      ? h(Section, { title: t('routing.chains'), hint: t('routing.chainsHint') },
        // The editor renders full width above the list rather than inside a
        // grid cell: a chain's member list and its picker need the room, and a
        // form squeezed into a 252 px column is a form nobody can order.
        editing !== null
          ? h(ChainEditor, {
            t, models, chain: editing.chain,
            onSave: save, onCancel: () => setEditing(null),
          })
          : chains.length === 0
            ? h('div', { className: 'ofm_panel' },
              h('div', { className: 'ofm_paneltitle' }, t('routing.empty')),
              h('p', { className: 'ofm_note' }, t('routing.emptyHint')),
              h('div', { className: 'ofm_row' },
                h(Button, { kind: 'primary', onClick: () => setEditing({ chain: blank }) }, t('routing.newChain'))))
            : h('div', { className: 'ofm_row' },
              h(Button, { kind: 'primary', onClick: () => setEditing({ chain: blank }) }, t('routing.newChain'))),
        chains.length === 0 ? null : h('div', { className: 'ofm_grid' }, chains.map((chain, index) => h(ChainCard, {
          key: chain.id, t, index, chain, lookup,
          resolved: resolvedOf(chain), missing: missingOf(chain),
          capacity: (panel.data?.usable ?? []).find(row => row.id === chain.id),
          confirming: confirm === chain.id,
          onEdit: () => setEditing({ chain }),
          onDelete: () => { if (confirm === chain.id) void remove(chain.id); else setConfirm(chain.id) },
        }))),
        confirm === '' ? null : h('p', { className: 'ofm_note' }, t('routing.deleteWarn')))
      : null)
}
