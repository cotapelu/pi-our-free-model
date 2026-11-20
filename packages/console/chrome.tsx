/**
 * The console's chrome: the primitives every page is built from, the two
 * hand-drawn charts, and the model roster.
 *
 * The charts are hand-drawn SVG because the shell ships no plotting primitive,
 * and because a chart library would be the one dependency this console cannot
 * take (it ships inside a host it does not control). `buildHeatCells` owns the
 * 119-day window: the heatmap's span is a calendar fact, not a layout choice.
 *
 * Ported from dsh's `client.js`.
 *
 * @module pi-extension/client/chrome.js
 */

import { createElement as h, useMemo, useState, useCallback, useEffect, Fragment } from 'react'
import { kilo } from './api.js'
import { ago } from '../shared/utils.js'

/** Simple icon component for workspace toolbar. */
export function WorkspaceIcon({ name }) {
  const icons = {
    close: 'M4 4l16 16M20 4L4 20',
    expand: 'M4 8V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4',
    refresh: 'M23 4v6h-6M1 20v-6h6',
    settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 1-2.73.73l-.22-.38a2 2 0 0 1-.73-2.73l.15-.15a2 2 0 0 1 1-1.72V4a2 2 0 0 1 2-2h.44a2 2 0 0 1 2 2v.18a2 2 0 0 0 1 1.73l.43.25a2 2 0 0 0 2 0l.15-.08a2 2 0 0 1 2.73.73l.22.39a2 2 0 0 0-.73 2.73l-.15.08a2 2 0 0 1-1 1.72V20a2 2 0 0 1-2 2h-.44a2 2 0 0 1-2-2v-.18a2 2 0 0 0-1-1.73l-.43-.25a2 2 0 0 1-2 0l-.15.08a2 2 0 0 1 2 2zM20 9h1a2 2 0 0 1 0 4h-1M8 4v1m5-1v1',
  }
  const path = icons[name] || icons.expand
  return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
    h('path', { d: path, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
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

/** Provider display names for subscription accounts. */
export const SUBSCRIPTION_PROVIDERS = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
  kilo: 'Kilo',
}

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
  }
  return list
}

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(message =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'image' && block.offloaded !== true)
  )
}

/** Switch component */
export const Switch = (props: {
  label?: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) => h('button', {
  type: 'button',
  className: 'ofm_switch',
  role: 'switch',
  'aria-label': props.label,
  'aria-checked': props.checked ? 'true' : 'false',
  disabled: props.disabled === true,
  onClick: props.onChange,
}, h('i'), props.label === undefined ? null : h('span', null, props.label))

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