/**
 * Unit checks for the announcement-HTML allowlist parser.
 *
 * This is the boundary between a JSON file in a repository and a surface a user is
 * looking at, so the corpus below is the point: every one of these is a payload
 * that has actually been used to escape a naive renderer. The bar is not "the
 * output looks right" — it is "**nothing** that is not on the allowlist survives,
 * and text content does".
 *
 * Runs on plain node:  node test/sanitizer.test.ts
 */
import assert from 'node:assert/strict'
import {
  ALLOWED_TAGS, DROP_CONTENT_TAGS, MAX_HTML_NODES, STYLE_CAMEL,
  parseSafeHtml, safeHtmlToText, safeUrl, sanitizeAnnouncementHtml, sanitizeAttrs, sanitizeStyle,
} from '../dist/client/sanitizer.js'

let failures = 0
let running = Promise.resolve()
/** A ref'd keep-alive: the parse is all microtasks, so nothing else holds the loop. */
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}
/** Flatten the tree back to a string, tags and text, so a corpus can assert "gone". */
function flatten(nodes: any[]): string {
  return nodes.map(node => typeof node === 'string'
    ? node
    : `<${node.tag}${Object.entries(node.props ?? {}).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('')}>${flatten(node.children ?? [])}</${node.tag}>`
  ).join('')
}

// ── the XSS corpus ──────────────────────────────────────────────────────────
check('a script element and its content are dropped, closing tag included', () => {
  const nodes = parseSafeHtml('<p>before</p><script>alert(1)</script><p>after</p>')
  const text = flatten(nodes)
  assert.equal(text.includes('<script'), false, 'the script tag survived')
  assert.equal(text.includes('alert(1)'), false, 'the script body survived')
  assert.equal(text.includes('before'), true)
  assert.equal(text.includes('after'), true, 'a dropped region ate the content after it')
})

check('an event handler attribute is dropped, not escaped into the value', () => {
  for (const tag of ['img', 'a', 'div', 'body', 'svg', 'p']) {
    const nodes = parseSafeHtml(`<${tag} src="x" onerror="alert(1)" onclick='alert(2)' onload=alert(3)>t</${tag}>`)
    const text = flatten(nodes)
    assert.equal(text.includes('onerror'), false, `${tag} kept onerror`)
    assert.equal(text.includes('onclick'), false, `${tag} kept onclick`)
    assert.equal(text.includes('onload'), false, `${tag} kept onload`)
  }
})

check('a javascript: href is refused, and the href goes with it', () => {
  const nodes = parseSafeHtml('<a href="javascript:alert(1)">click</a>')
  const text = flatten(nodes)
  assert.equal(text.includes('javascript:'), false)
  // The anchor itself survives — only the dangerous URL goes.
  assert.equal(text.includes('click'), true)
  assert.equal(text.includes('href'), false, 'an empty href was emitted')
})

check('a data:text/html href is refused', () => {
  const nodes = parseSafeHtml('<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>')
  assert.equal(flatten(nodes).includes('data:text/html'), false)
  // An inline raster image is a different scheme handle: images only.
  const image = parseSafeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')
  assert.equal(flatten(image).includes('data:image/png'), true, 'an inline raster image was refused')
})

check('an inline SVG is dropped with its whole script context', () => {
  // SVG is excluded by *absence from the allowlist*, not by a filter: an inline
  // SVG is a document with its own script context.
  const nodes = parseSafeHtml('<p>ok</p><svg><script>alert(1)</script><circle r="9"/></svg>')
  const text = flatten(nodes)
  assert.equal(text.includes('<svg'), false)
  assert.equal(text.includes('alert(1)'), false)
  assert.equal(text.includes('circle'), false)
  assert.equal(text.includes('ok'), true)
})

check('a style attribute is filtered twice, and a url() is refused', () => {
  const nodes = parseSafeHtml('<div style="color:red;background-image:url(javascript:alert(1));position:fixed">t</div>')
  const text = flatten(nodes)
  assert.equal(text.includes('url('), false, 'a CSS url() survived')
  assert.equal(text.includes('position'), false, 'a non-allowlisted property survived')
  assert.equal(text.includes('color'), true, 'an allowlisted property was dropped')
})

check('an expression() and an @import are refused', () => {
  for (const value of [
    'width:expression(alert(1))',
    'background-color:@import "evil.css"',
    'color:rgb(1,2,3)"><script>alert(1)</script>',
  ]) {
    const nodes = parseSafeHtml(`<div style="${value}">t</div>`)
    assert.equal(flatten(nodes).includes('expression'), false, value)
    assert.equal(flatten(nodes).includes('@import'), false, value)
    assert.equal(flatten(nodes).includes('<script'), false, value)
  }
})

check('a comment and a CDATA section are dropped', () => {
  const nodes = parseSafeHtml('<p>a<!-- secret --><!--[if IE]><script>alert(1)</script><![endif]-->b</p>')
  const text = flatten(nodes)
  assert.equal(text.includes('secret'), false)
  assert.equal(text.includes('<script'), false)
  assert.equal(text.includes('a'), true)
  assert.equal(text.includes('b'), true)
})

check('a relative URL is refused, because the announcement is served from here', () => {
  for (const url of ['/admin', './x', '../escape', '//evil.test/x', 'page.html']) {
    assert.equal(safeUrl(url), undefined, `${url} was accepted`)
  }
})

check('an unrecognized tag is unwrapped, and its children survive', () => {
  const nodes = parseSafeHtml('<article><custom-tag>text <b>bold</b></custom-tag></article>')
  const text = flatten(nodes)
  assert.equal(text.includes('<article'), false)
  assert.equal(text.includes('<custom-tag'), false)
  assert.equal(text.includes('text'), true, 'unwrapping ate the children')
  assert.equal(text.includes('<b>bold</b>'), true)
})

check('an img with no surviving src is dropped rather than rendered broken', () => {
  const nodes = parseSafeHtml('<p>a</p><img src="javascript:alert(1)"><img><p>b</p>')
  const text = flatten(nodes)
  assert.equal(text.includes('<img'), false)
  assert.equal(text.includes('a'), true)
  assert.equal(text.includes('b'), true)
})

check('a tag opened but never closed is closed implicitly, children lifted', () => {
  const nodes = parseSafeHtml('<div><p>one<p>two</div>')
  const text = flatten(nodes)
  // Both paragraphs survive, and the div is closed once.
  assert.equal((text.match(/<p>/g) ?? []).length, 2)
  assert.equal((text.match(/<\/div>/g) ?? []).length, 1)
})

check('a closing tag with no opening frame is dropped whole', () => {
  const nodes = parseSafeHtml('</div></p>text')
  assert.deepEqual(nodes, ['text'])
})

// ── the allowlists themselves ───────────────────────────────────────────────
check('the allowlists are what the docblock says they are', () => {
  assert.equal(ALLOWED_TAGS.has('script'), false)
  assert.equal(ALLOWED_TAGS.has('img'), true)
  // Every drop-content tag is absent from the allowlist, so a dropped one cannot
  // also render.
  for (const tag of DROP_CONTENT_TAGS) assert.equal(ALLOWED_TAGS.has(tag), false, `${tag} is in both sets`)
  assert.equal(MAX_HTML_NODES, 4000)
  assert.equal(STYLE_CAMEL['background-color'], 'backgroundColor')
})

check('the style camel map covers every allowlisted property', () => {
  // A property present in the allowlist but missing from the map would render as
  // a hyphenated CSS key, which the React style object does not understand.
  for (const prop of ['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration']) {
    assert.equal(typeof STYLE_CAMEL[prop], 'string', `${prop} has no camel spelling`)
  }
})

// ── the budget ──────────────────────────────────────────────────────────────
check('a pathological body stops at the node cap rather than costing a render', () => {
  const huge = '<p>x</p>'.repeat(MAX_HTML_NODES + 500)
  const nodes = parseSafeHtml(huge)
  const count = (rows: any[]): number => rows.reduce((sum, row) => sum + (typeof row === 'string' ? 0 : 1 + count(row.children ?? [])), 0)
  assert.ok(count(nodes) <= MAX_HTML_NODES, `the parse produced ${count(nodes)} nodes`)
})

// ── sanitizeStyle / sanitizeAttrs directly ──────────────────────────────────
check('sanitizeStyle keeps only the six allowlisted properties', () => {
  assert.deepEqual(sanitizeStyle('color:red;text-align:center;font-weight:bold;position:fixed;z-index:9'), {
    color: 'red', textAlign: 'center', fontWeight: 'bold',
  })
})

check('sanitizeStyle refuses a value that is empty, long, or dangerous', () => {
  assert.deepEqual(sanitizeStyle('color:'), {})
  assert.deepEqual(sanitizeStyle(`color:${'a'.repeat(200)}`), {})
  assert.deepEqual(sanitizeStyle('color:red;background-color:url(x)'), { color: 'red' })
})

check('sanitizeAttrs gives a link its safe-target attributes and nothing else', () => {
  const props = sanitizeAttrs('a', 'href="https://x.test/a" target="_self" rel="opener" id="own" data-x="1" title="t"')
  assert.deepEqual(props, { href: 'https://x.test/a', target: '_blank', rel: 'noopener noreferrer', title: 't' })
})

check('sanitizeAttrs caps width/height to digits and a bound', () => {
  assert.deepEqual(sanitizeAttrs('img', 'width="600" height="400"'), { width: 600, height: 400 })
  assert.deepEqual(sanitizeAttrs('img', 'width="60000"'), {})
  assert.deepEqual(sanitizeAttrs('img', 'width="6e2"'), {})
  assert.deepEqual(sanitizeAttrs('img', 'width=""'), {})
})

check('sanitizeAttrs survives an attribute text that is not a string', () => {
  assert.deepEqual(sanitizeAttrs('div', undefined), {})
  assert.deepEqual(sanitizeAttrs('div', null), {})
  assert.deepEqual(sanitizeAttrs('div', 42), {})
})

// ── re-escaping on the way out ──────────────────────────────────────────────
check('the text projection re-escapes, so a consumer cannot un-escape it', () => {
  // The parser refused what it did not recognise; this refuses to re-emit it.
  const nodes = parseSafeHtml('<p>a &amp; b &lt; c &gt; d</p>')
  const text = safeHtmlToText(nodes)
  assert.equal(text.includes('&lt;'), true)
  assert.equal(text.includes('&gt;'), true)
  assert.equal(text.includes('<script'), false)
})

check('the projection round-trips a whole announcement shape', () => {
  const nodes = parseSafeHtml('<h2>Title</h2><p>Body <b>bold</b> <a href="https://x.test">link</a></p><ul><li>one</li><li>two</li></ul>')
  const text = safeHtmlToText(nodes)
  for (const part of ['<h2>Title</h2>', '<b>bold</b>', '<li>one</li>', '<li>two</li>']) {
    assert.equal(text.includes(part), true, `${part} was lost`)
  }
})

// ── the whole pipeline ──────────────────────────────────────────────────────
check('sanitizeAnnouncementHtml reports what it kept and what it dropped', () => {
  const result = sanitizeAnnouncementHtml('<h2>T</h2><p>body</p><script>alert(1)</script><iframe src="x"></iframe>')
  assert.ok(result.elements >= 2, 'the surviving elements were not counted')
  assert.equal(result.dropped, 2, 'the dropped tags were not counted')
  assert.equal(result.text.includes('alert(1)'), false)
})

check('an empty or non-string announcement yields an empty tree, not a crash', () => {
  for (const value of [undefined, null, '', '   ', 42, {}, []]) {
    assert.deepEqual(parseSafeHtml(value), [], `${JSON.stringify(value)} produced nodes`)
    const result = sanitizeAnnouncementHtml(value)
    assert.equal(result.elements, 0)
    assert.equal(result.dropped, 0)
    assert.equal(result.text, '')
  }
})

check('a body that is only a dropped region yields an empty tree', () => {
  assert.deepEqual(parseSafeHtml('<script>alert(1)</script>'), [])
  assert.deepEqual(parseSafeHtml('<style>body{}</style>'), [])
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
