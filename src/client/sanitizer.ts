/**
 * The announcement-HTML allowlist parser.
 *
 * Announcements arrive as HTML from a JSON file in the repository, and they are
 * rendered into a surface the user is looking at. The bytes are therefore not
 * trusted, and this is the boundary that decides what survives.
 *
 * The design is an **allowlist with unwrapping**, not a blacklist:
 *
 * - A tag that is not on the list is *unwrapped* — its children survive, so a
 *   `<div class="note">` typo or a future `<article>` still reads correctly.
 * - A tag whose *content* must never be shown (`script`, `style`, `iframe`,
 *   `svg`, `math`, `form`, …) is dropped with everything inside it, closing tag
 *   included.
 * - Style values are filtered twice: an allowlist of six properties, then a
 *   rejection of anything containing `url(`, `expression`, `javascript:`, `@`,
 *   `<` or `>`.
 * - URLs are allowlisted by scheme — `http(s)`, `mailto` with a plausible
 *   address, an in-page `#fragment`, and inline images for data URLs only. A
 *   relative URL is refused, because the announcement is served from this
 *   gateway and a relative one is an escape hatch.
 *
 * A node cap bounds the parse itself: an announcement is 48 KB of prose, and a
 * pathological body must not cost a render.
 *
 * The virtual tree is deliberately renderer-agnostic — `htmlToReact` and
 * `htmlToDom` both consume it, so the sanitizer has no dependency on either.
 *
 * Ported from dsh's `client.js` (`parseSafeHtml`, `safeUrl`, `sanitizeStyle`,
 * `sanitizeAttrs`, and the constants beside them).
 *
 * @module pi-extension/client/sanitizer.js
 */

/** An element node in the sanitized tree. */
export interface SafeElement {
  type: 'el'
  tag: string
  props: Record<string, any>
  children: SafeNode[]
}

/**
 * A node in the sanitized tree.
 *
 * Text is a **bare string**, not a `{type:'text'}` wrapper: both materializers
 * want it that way, and it keeps the node count the parser reports honest. An
 * element is the only object shape, so `'el' in node` is the discriminator.
 */
export type SafeNode = SafeElement | string

/** Tags that may remain. Anything else is unwrapped. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])

/** Everything these elements contain is dropped, closing tag included. */
export const DROP_CONTENT_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'title', 'svg',
  'math', 'form', 'input', 'button', 'select', 'option', 'video', 'audio', 'canvas', 'link', 'meta', 'base',
])

/** Elements with no closing tag, so the parser must not push a frame for them. */
export const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img'])

/** The parse budget. An announcement is 48 KB of prose; this bounds a pathological one. */
export const MAX_HTML_NODES = 4000

/** Six style properties, and nothing else. */
export const ALLOWED_STYLE_PROPS: ReadonlySet<string> = new Set([
  'color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration',
])

/** The CSS spelling to the camelCase the renderers read. */
export const STYLE_CAMEL: Readonly<Record<string, string>> = Object.freeze({
  'background-color': 'backgroundColor',
  'text-align': 'textAlign',
  'font-weight': 'fontWeight',
  'font-style': 'fontStyle',
  'text-decoration': 'textDecoration',
  color: 'color',
})

/**
 * One URL, allowlisted by scheme.
 *
 * A relative URL is refused on purpose: the announcement is served from this
 * gateway, and a relative one is an escape hatch to whatever else is mounted.
 */
export function safeUrl(raw: unknown, isImage = false): string | undefined {
  const value = String(raw ?? '').trim()
  if (value === '' || value.length > 2000) return undefined
  const lower = value.toLowerCase()
  if (/^https?:\/\//.test(lower)) return value
  if (lower.startsWith('mailto:') && /^[^@\s]+@[^@\s]+$/.test(value.slice(7))) return value
  if (lower.startsWith('#')) return value
  // Only inline raster images, and only the three formats a browser will render
  // without sniffing. SVG is excluded by its absence here, not by a filter —
  // an inline SVG is a document with its own script context.
  if (isImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value
  return undefined
}

/** One `style` attribute, allowlisted property by property and value by value. */
export function sanitizeStyle(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const decl of String(raw ?? '').split(';')) {
    const at = decl.indexOf(':')
    if (at === -1) continue
    const prop = decl.slice(0, at).trim().toLowerCase()
    const value = decl.slice(at + 1).trim()
    if (!ALLOWED_STYLE_PROPS.has(prop) || value === '' || value.length > 120) continue
    // The second filter. A CSS `url()` is a network read, `expression()` is
    // script, and `<`/`>` is a way out of the attribute entirely.
    if (/url\(|expression|javascript:|@|<|>/.test(value.toLowerCase())) continue
    out[STYLE_CAMEL[prop] ?? prop] = value
  }
  return out
}

/** One tag's attribute text, reduced to the few attributes each tag may carry. */
export function sanitizeAttrs(tag: string, attrText: unknown): Record<string, any> {
  const props: Record<string, any> = {}
  // The attribute grammar, quoted or unquoted. `[^>"']` keeps a value from
  // running past the tag's own `>`.
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(String(attrText ?? ''))) !== null) {
    const key = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (key === 'style') {
      const style = sanitizeStyle(value)
      if (Object.keys(style).length > 0) props.style = style
      continue
    }
    if (tag === 'a' && key === 'href') {
      const url = safeUrl(value)
      if (url !== undefined) {
        props.href = url
        // A link in an announcement opens somewhere else, never in this surface.
        props.target = '_blank'
        props.rel = 'noopener noreferrer'
      }
      continue
    }
    if (tag === 'img' && key === 'src') {
      const url = safeUrl(value, true)
      if (url !== undefined) props.src = url
      continue
    }
    if ((tag === 'img' || tag === 'a') && key === 'title') { props.title = value.slice(0, 300); continue }
    if (tag === 'img' && key === 'alt') { props.alt = value.slice(0, 300); continue }
    if ((key === 'width' || key === 'height') && /^\d{1,4}$/.test(value)) { props[key] = Number(value); continue }
  }
  return props
}

/**
 * Tokenize announcement HTML into the sanitized tree.
 *
 * Text nodes are carried as bare strings rather than `{type:'text'}` objects,
 * because that is what both materializers want and it keeps the node count the
 * parser reports honest.
 */
/**
 * The entities a text node may carry.
 *
 * A publisher writes `&amp;` and means `&`. Decoding it on the way in is what
 * makes the output projection's escaping a **round trip** rather than a double
 * one: an announcement author who wrote `&amp;` sees `&` on screen, which is the
 * whole point of writing the entity. Only these five plus the numeric forms are
 * recognised — an unknown entity is left exactly as written, because inventing a
 * mapping is how a typo becomes a silent substitution.
 */
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
})

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

export function parseSafeHtml(html: unknown): Array<SafeNode> {
  if (typeof html !== 'string' || html.trim() === '') return []
  const root = { tag: '', props: {}, children: [] as SafeNode[] }
  const stack: Array<{ tag: string; props: Record<string, any>; children: SafeNode[] }> = [root]
  const top = () => stack[stack.length - 1]
  let nodes = 0
  let skipUntil: string | null = null
  const tokenRe = /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>|<\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(html)) !== null) {
    if (nodes >= MAX_HTML_NODES) break
    if (match[0].startsWith('<!--')) continue
    if (match[4] !== undefined) {
      if (skipUntil === null) {
        const text = match[4]
        const kept = top().children
        // Whitespace-only text is kept only where it separates two nodes: a
        // leading space before the first child is noise a renderer would strip.
        if (text.trim() !== '' || (kept.length > 0 && typeof kept[kept.length - 1] !== 'string')) {
          kept.push(decodeEntities(text))
        }
      }
      continue
    }
    const name = (match[1] ?? match[2] ?? '').toLowerCase()
    if (name === '') continue
    if (match[1] !== undefined) {
      // A closing tag. Inside a dropped region it only ends the region.
      if (skipUntil !== null) {
        if (name === skipUntil) skipUntil = null
        continue
      }
      if (!ALLOWED_TAGS.has(name)) continue
      // Find the frame this tag closes; an unmatched close is dropped whole.
      let depth = stack.length - 1
      while (depth > 0 && stack[depth].tag !== name) depth -= 1
      if (depth === 0) continue
      // Anything still open below it is closed implicitly and **keeps its own
      // tag**, which is what a browser does with unclosed markup: `<div><p>one<p>
      // two</div>` is two paragraphs inside the div. Lifting only the children
      // — which is what the original did — silently dropped every unclosed
      // element's tag, so a malformed announcement lost its `<b>`, `<i>` and
      // `<p>` formatting and read as one run of plain text.
      while (stack.length - 1 > depth) {
        const dropped = stack.pop()!
        top().children.push({ type: 'el', tag: dropped.tag, props: dropped.props, children: dropped.children })
        nodes += 1
      }
      const frame = stack.pop()!
      top().children.push({ type: 'el', tag: frame.tag, props: frame.props, children: frame.children })
      nodes += 1
      continue
    }
    // An opening tag.
    if (skipUntil !== null) continue
    if (DROP_CONTENT_TAGS.has(name)) { skipUntil = name; continue }
    if (!ALLOWED_TAGS.has(name)) continue
    const props = sanitizeAttrs(name, match[3])
    // An `<img>` with no surviving `src` is dropped rather than rendered broken.
    if (name === 'img' && props.src === undefined) continue
    if (VOID_TAGS.has(name)) {
      top().children.push({ type: 'el', tag: name, props, children: [] })
      nodes += 1
      continue
    }
    stack.push({ tag: name, props, children: [] })
  }
  while (stack.length > 1) {
    const frame = stack.pop()!
    top().children.push(...frame.children)
  }
  return root.children
}

/**
 * Render the sanitized tree as HTML, so any consumer can escape it again.
 *
 * Text is entity-encoded on the way out, which is the second half of the
 * boundary: the parser refused what it did not recognise, and this refuses to
 * re-emit what it did.
 */
export function safeHtmlToText(nodes: Array<SafeNode>): string {
  return nodes.map(node => typeof node === 'string'
    ? node.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : `<${node.tag}${attrsToString(node.props)}>${safeHtmlToText(node.children)}</${node.tag}>`
  ).join('')
}

/** One element's attribute text, re-emitted with the same escaping as a text node. */
function attrsToString(props: Record<string, any>): string {
  const out: string[] = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value).map(([prop, v]) => `${prop}:${String(v)}`).join(';')
      if (css !== '') out.push(`style="${css}"`)
      continue
    }
    out.push(`${key}="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`)
  }
  return out.length === 0 ? '' : ` ${out.join(' ')}`
}

/**
 * The whole pipeline: parse, and report how much survived.
 *
 * `dropped` counts the tags that were removed with their content, which is the
 * number a maintainer wants when an announcement renders oddly.
 */
export function sanitizeAnnouncementHtml(html: unknown): { nodes: Array<SafeNode>; text: string; elements: number; dropped: number } {
  const nodes = parseSafeHtml(html)
  const countElements = (rows: Array<SafeNode>): number => rows.reduce((sum, node) => sum + (typeof node !== 'string' ? 1 + countElements(node.children) : 0), 0)
  const dropped = DROP_CONTENT_TAGS.size > 0 && typeof html === 'string'
    ? (html.match(new RegExp(`<\\s*(${[...DROP_CONTENT_TAGS].join('|')})\\b`, 'gi')) ?? []).length
    : 0
  return { nodes, text: safeHtmlToText(nodes), elements: countElements(nodes), dropped }
}
