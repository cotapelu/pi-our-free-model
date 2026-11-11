/**
 * The two materializers of the sanitized tree, kept out of `sanitizer.ts` on
 * purpose: the announcement parser is shared with the gateway half (`feed.ts`
 * parses publisher HTML on node, where there is no `document`), while these two
 * only exist where there is a renderer.
 *
 * Both take the same `Array<SafeNode>` `parseSafeHtml` returns and neither has
 * an innerHTML sink: the DOM one creates every element and sets every attribute,
 * and the React one hands the tree to the caller's own element factory. The
 * allowlist the parser enforced is therefore the last word on what reaches the
 * document either way.
 *
 * Ported from dsh's `client.js` (`htmlToDom`, `htmlToReact`).
 *
 * @module pi-extension/client/sanitizer-materialize.js
 */

import type { SafeNode } from './sanitizer.js'

/** Materialize the sanitized tree as React elements (`htmlToReact`, keys positional). */
export function htmlToReact(nodes: Array<SafeNode>, h: (tag: string, props: Record<string, any>, ...children: any[]) => any): Array<any> {
  return nodes.map((node, index) => typeof node === 'string'
    ? node
    : h(node.tag, { key: index, ...node.props }, ...htmlToReact(node.children ?? [], h)))
}

/** Materialize the sanitized tree as DOM nodes (`htmlToDom`, for toasts and modals). */
export function htmlToDom(nodes: Array<SafeNode>): Array<Node> {
  return nodes.map(node => {
    if (typeof node === 'string') return document.createTextNode(node)
    const el = document.createElement(node.tag)
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (key === 'style') { Object.assign(el.style, value); continue }
      if (value === undefined || value === null) continue
      el.setAttribute(key, String(value))
    }
    for (const child of htmlToDom(node.children ?? [])) el.appendChild(child)
    return el
  })
}
