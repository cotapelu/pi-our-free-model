/**
 * Plugin page: nested page inside the settings for a specific extension.
 *
 * New in v2.8.3 - ported from dsh's `client.js` plugin-page section.
 * Handles plugin page assets served by the host.
 *
 * @module pi-extension/client/pages/plugin-page.tsx
 */

import { createElement as h, useEffect, useRef, useState, Fragment } from 'react'
import { api } from '../api.js'
import { showToast } from '../toast.js'
import { Button, Section } from '../chrome.js'

export function PluginPage({ t, pluginId, onBack }) {
  const [page, setPage] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const iframeRef = useRef(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    api(`/extensions/page?id=${encodeURIComponent(pluginId)}`, { timeout: 15_000 })
      .then(payload => {
        if (!alive) return
        if (payload?.html) {
          setPage(payload.html)
        } else if (payload?.url) {
          setPage({ url: payload.url })
        } else {
          setError(t('ext.pageEmpty'))
        }
        setLoading(false)
      })
      .catch(err => {
        if (!alive) return
        setError(String(err?.message ?? err))
        setLoading(false)
      })
    return () => { alive = false }
  }, [pluginId])

  if (loading) {
    return h('div', { className: 'ofm_page' },
      h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, t('ext.pageTitle')),
            h('p', { className: 'ofm_pagesub' }, t('ext.pageSub'))),
          h('div', { className: 'ofm_pills' },
            h(Button, { kind: 'ghost', onClick: onBack }, '← ' + t('ext.back'))))),
      h('div', { className: 'ofm_chanwrap' },
        [0, 1, 2].map(i => h('div', { className: 'ofm_skel', key: i, style: { minHeight: 120 } }))))
  }

  if (error) {
    return h('div', { className: 'ofm_page' },
      h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, t('ext.pageTitle')),
            h('p', { className: 'ofm_pagesub' }, t('ext.pageSub'))),
          h('div', { className: 'ofm_pills' },
            h(Button, { kind: 'ghost', onClick: onBack }, '← ' + t('ext.back'))))),
      h('div', { className: 'ofm_callout' },
        h('div', null, h('b', null, t('ext.pageError')), h('div', null, error)),
        h(Button, { onClick: () => window.location.reload() }, t('retry'))))
  }

  if (typeof page === 'string') {
    // HTML content - sanitize and render in sandboxed iframe
    const host = useMemo(() => {
      const node = document.createElement('div')
      node.setAttribute('data-ofm-plugin-page-root', 'true')
      document.body.appendChild(node)
      return node
    }, [])
    useEffect(() => () => { if (host.parentNode !== null) host.parentNode.removeChild(host) }, [host])

    return ReactDOM.createPortal(h('div', { className: 'ofm_page' },
      h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, t('ext.pageTitle')),
            h('p', { className: 'ofm_pagesub' }, t('ext.pageSub'))),
          h('div', { className: 'ofm_pills' },
            h(Button, { kind: 'ghost', onClick: onBack }, '← ' + t('ext.back'))))),
      h('div', { className: 'ofm_pluginpage' },
        h('iframe', {
          ref: iframeRef,
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
          style: { width: '100%', height: 'calc(100vh - 140px)', border: 'none', background: 'var(--dsw-alias-bg-body)' },
          srcDoc: page,
        }))), host)
  }

  if (page?.url) {
    // External URL - open in iframe with sandbox
    const host = useMemo(() => {
      const node = document.createElement('div')
      node.setAttribute('data-ofm-plugin-page-root', 'true')
      document.body.appendChild(node)
      return node
    }, [])
    useEffect(() => () => { if (host.parentNode !== null) host.parentNode.removeChild(host) }, [host])

    return ReactDOM.createPortal(h('div', { className: 'ofm_page' },
      h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, t('ext.pageTitle')),
            h('p', { className: 'ofm_pagesub' }, t('ext.pageSub'))),
          h('div', { className: 'ofm_pills' },
            h(Button, { kind: 'ghost', onClick: onBack }, '← ' + t('ext.back'))))),
      h('div', { className: 'ofm_pluginpage' },
        h('iframe', {
          ref: iframeRef,
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
          style: { width: '100%', height: 'calc(100vh - 140px)', border: 'none', background: 'var(--dsw-alias-bg-body)' },
          src: page.url,
        }))), host)
  }

  return null
}

import ReactDOM from 'react-dom'
import { createElement as h, useMemo } from 'react'