/**
 * The recommended-projects page: the star counts, read live and never invented.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/picks.js
 */

import { createElement: h, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { api, kilo, ago, copy } from '../api.js'
import { useAsync } from '../hooks.js'
import { showToast, osNotify } from '../toast.js'
import { Button, Pill, PageHero, Panel, Section, PanelSkeleton, PanelError } from '../chrome.js'

export function RecoCard(props) {
  const { t, index, stat, mark, name, repo, badge, tagline, body, chips, repoUrl, extraUrl, extraLabel } = props
  const stars = stat !== null && typeof stat.stars === 'number' ? stat.stars : null
  const shown = useCountUp(stars, props.effects)
  const forks = stat !== null && typeof stat.forks === 'number' ? stat.forks : null
  const pushedAt = stat !== null && typeof stat.pushedAt === 'number' ? stat.pushedAt : null
  const stale = stat !== null && stat.stale === true
  // One fork is one fork; the label is the only place the page can tell.
  const forkLabel = forks === 1 ? t('picks.fork') : t('picks.forks')
  return h('article', { className: 'ofm_recocard', style: { '--i': String(index) } },
    h('div', { className: 'ofm_recotop' },
      h('span', { className: 'ofm_recomark', 'aria-hidden': 'true' }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: mark }))),
      h('div', { className: 'ofm_recoid' },
        h('span', { className: 'ofm_reconame' }, name),
        h('span', { className: 'ofm_recorepo' }, repo)),
      h('span', { className: 'ofm_recobadge' }, badge)),
    h('p', { className: 'ofm_recotagline' }, tagline),
    h('p', { className: 'ofm_recobody' }, body),
    h('div', { className: 'ofm_recochips' }, chips.map(chip => h('span', { key: chip, className: 'ofm_recochip' }, chip))),
    h('div', { className: 'ofm_recofoot' },
      h('div', { className: 'ofm_recofacts' },
        stars === null ? null : h('span', { className: 'ofm_recofact' },
          h('b', null, grouped(shown ?? stars)),
          h('span', null, t('picks.stars')),
          stale ? h('span', { className: 'ofm_reconote' }, t('picks.stale')) : null),
        forks === null ? null : h('span', { className: 'ofm_recofact' }, h('b', null, grouped(forks)), h('span', null, forkLabel)),
        pushedAt === null ? null : h('span', { className: 'ofm_recofact' }, h('b', null, ago(pushedAt, t.locale)), h('span', null, t('picks.updated')))),
      h('div', { className: 'ofm_recoacts' },
        h('a', { className: 'ofm_recogo', href: extraUrl, target: '_blank', rel: 'noreferrer noopener' },
          extraLabel,
          h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: RECO_EXT_MARK }))),
        h('a', {
          className: 'ofm_recostar', href: repoUrl, target: '_blank', rel: 'noreferrer noopener',
          title: `${t('picks.starHint')} · ${repo}`,
        },
          h('span', { className: 'ofm_recostarring', 'aria-hidden': 'true' }),
          h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: STAR_GLYPH })),
          t('picks.star')))))
}

export function PicksPage(props) {
  const { t } = props
  const picks = useAsync(() => api('/picks'), [])
  const repos = picks.data?.repos ?? []
  const statOf = id => repos.find(row => row.id === id) ?? null
  // A cold read gives the host four seconds to reach GitHub, so a slow first
  // answer can land after the page is already on screen. One delayed re-read
  // fills the numbers in; the flag makes sure it is one, not a poll.
  const [retried, setRetried] = useState(false)
  const numbers = repos.some(row => typeof row.stars === 'number')
  useEffect(() => {
    if (retried || numbers || picks.status !== 'ready') return undefined
    const timer = setTimeout(() => { setRetried(true); picks.reload() }, 6000)
    return () => clearTimeout(timer)
  }, [retried, numbers, picks.status, picks.reload])
  // The project count and star total cover the same successfully read rows.
  const counted = repos.filter(row => Number.isFinite(row.stars))
  const total = counted.reduce((sum, row) => sum + row.stars, 0)
  return h('div', { className: 'ofm_page' },
    h('header', { className: 'ofm_hero ofm_glass' },
      h('span', { className: 'ofm_recoglow', 'aria-hidden': 'true' }),
      h('div', { className: 'ofm_pagehead' },
        h('div', { className: 'ofm_pagetitle' },
          h('h2', null, t('picks.title')),
          h('p', { className: 'ofm_pagesub' }, t('picks.sub'))),
        h('div', { className: 'ofm_pills' },
          total > 0 ? h(Pill, { strong: true }, t('picks.totalStars').replace('{n}', grouped(total)).replace('{c}', grouped(counted.length))) : null,
          h(StarButton, { t })))),
    h('div', { className: 'ofm_recogrid' },
      h(RecoCard, {
        t, effects: props.effects, index: 0, stat: statOf('eac-desktop'), mark: RECO_DESKTOP_MARK,
        name: 'EAC-Desktop', repo: 'Ebony-Vinyl/EAC-Desktop',
        badge: t('picks.desktop.badge'),
        tagline: t('picks.desktop.tagline'),
        body: t('picks.desktop.body'),
        chips: [t('picks.desktop.tag1'), t('picks.desktop.tag2'), t('picks.desktop.tag3'), t('picks.desktop.tag4')],
        repoUrl: RECO_LINKS.desktop.repo, extraUrl: RECO_LINKS.desktop.extra, extraLabel: t('picks.getDesktop'),
      }),
      h(RecoCard, {
        t, effects: props.effects, index: 1, stat: statOf('eac-pack'), mark: RECO_PACK_MARK,
        name: 'EAC-Pack', repo: 'Ebony-Vinyl/EAC-Pack',
        badge: t('picks.pack.badge'),
        tagline: t('picks.pack.tagline'),
        body: t('picks.pack.body'),
        chips: [t('picks.pack.tag1'), t('picks.pack.tag2'), t('picks.pack.tag3'), t('picks.pack.tag4')],
        repoUrl: RECO_LINKS.pack.repo, extraUrl: RECO_LINKS.pack.extra, extraLabel: t('picks.getPack'),
      }),
      h(RecoCard, {
        t, effects: props.effects, index: 2, stat: statOf('eac-design-world'), mark: RECO_DESIGN_MARK,
        name: 'EAC-design-world', repo: 'Ebony-Vinyl/EAC-design-world',
        badge: t('picks.design.badge'),
        tagline: t('picks.design.tagline'),
        body: t('picks.design.body'),
        chips: [t('picks.design.tag1'), t('picks.design.tag2'), t('picks.design.tag3'), t('picks.design.tag4')],
        repoUrl: RECO_LINKS.designWorld.repo, extraUrl: RECO_LINKS.designWorld.extra, extraLabel: t('picks.getDesign'),
      })),
    picks.status === 'error' ? h('p', { className: 'ofm_reconote' }, t('picks.liveFailed')) : null,
    h('p', { className: 'ofm_reconote' }, t('picks.foot')))
}
