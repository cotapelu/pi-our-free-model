/**
 * The co-paid lane's pool panel and its live reading.
 *
 * `usePool` polls on one interval and publishes through context-free props, so
 * every panel that shows capacity reads the same number without three timers.
 * The reading is the gateway's own truth: inflight, star-funded accounts and the
 * operator's configured cap — never an estimate this console invents.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/pool.js
 */

import { createElement: h, useEffect, useRef, useState } from 'react'
import { api } from './api.js'

export function Tank(props) {
  const { pct, level = 'ok', size, label } = props
  const filled = Number(pct) > 0
  const tankRef = useRef(null)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (!filled || typeof IntersectionObserver !== 'function' || !tankRef.current) return undefined
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    observer.observe(tankRef.current)
    return () => observer.disconnect()
  }, [filled])
  const fish = ['f1', 'f2', 'f3'].map(name => h('i', { className: `ofm_fish ${name}`, key: name },
    h('svg', { viewBox: '0 0 24 14' }, h('path', { d: FISH_PATH }))))
  const bubbles = ['b1', 'b2', 'b3', 'b4', 'b5'].map(name => h('i', { className: `ofm_bubble ${name}`, key: name }))
  if (pct === null || pct === undefined) return null
  return h('div', {
    className: `ofm_tank ${level}${size === 'xl' ? ' xl' : ''}`,
    ref: tankRef,
    'data-ofm-motion': filled && visible ? 'on' : 'off',
    role: 'img',
    'aria-label': label ?? `${pct}%`,
    style: { '--lvl': `${Math.max(0, Math.min(100, pct))}%` },
  },
    h('div', { className: 'ofm_tankwater' },
      h('div', { className: 'ofm_tankdeep' }, ...bubbles, ...fish),
      h('i', { className: 'ofm_wave w1' }),
      h('i', { className: 'ofm_wave w2' })),
    h('i', { className: 'ofm_tankrays' }),
    h('i', { className: 'ofm_tankshine' }),
    h('div', { className: 'ofm_tankglass' }))
}

export function poolReading(pool) {
  const active = Number.isFinite(pool.active24h) ? pool.active24h : null
  const capacityKnown = Number.isFinite(pool.pool) && pool.pool > 0
  // Two readings, on purpose: the tank cannot hold more than full, but the
  // page must not round a pool running at 147% of its provisioned capacity
  // down to "100%" — that reads as "exactly at capacity", which is a
  // different, calmer sentence than what the gateway is saying.
  const rawPct = capacityKnown && active !== null ? Math.round(100 * active / pool.pool) : null
  const pct = rawPct === null ? null : Math.max(0, Math.min(100, rawPct))
  // A gateway build that predates the level verdict answers without one.
  // The plugin then applies the same default thresholds locally, so an
  // upgraded panel never reads a calm color off an unupgraded server —
  // and once the gateway does send its verdict, that one wins.
  const level = pool.level === 'over' || (pool.level === undefined && pool.inflight >= 80) ? 'over'
    : pool.level === 'busy' || (pool.level === undefined && pool.inflight >= 30) ? 'busy' : 'ok'
  return { active, capacityKnown, pct, rawPct, level }
}

export function capacityText(pool, t) {
  if (pool.poolSource === 'formula') return t('pool.formula').replace('{stars}', String(pool.stars ?? '—'))
  if (pool.poolSource === 'configured') return t('pool.configured')
  return t('pool.capacityUnknown')
}

export function usePool() {
  const [pool, setPool] = useState(undefined)
  const [poolError, setPoolError] = useState('')
  useEffect(() => {
    let alive = true
    // The gateway can be slow under exactly the load this panel reports;
    // the 8s api() default would abort while the backend is still waiting.
    const load = () => api('/pool', { timeout: 25_000 })
      .then(data => {
        if (!alive) return
        setPool(data?.pool != null ? data : null)
        setPoolError('')
      })
      .catch(error => {
        if (!alive) return
        setPool(null)
        // The backend tags the failure with a fixed reason code; map it to
        // readable text instead of hiding the panel in silence.
        const code = /\(([^)]+)\)\s*$/.exec(String(error?.message ?? ''))?.[1] ?? ''
        setPoolError(code)
      })
    load()
    const timer = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  return { pool, poolError }
}
