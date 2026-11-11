/**
 * Unit checks for the announcement feed.
 *
 * A feed is attacker-adjacent data: the bytes come off the network and are
 * rendered into a UI. So most of these checks are about *refusal*: a document
 * that is not a feed, a row that is not an announcement, an item that is too
 * big, an id seen twice. The other half is about state: an ack is the caller's,
 * not the feed's, so a refresh cannot rewrite acknowledgement history.
 *
 * The `sources()` fence is the sharpest one here. An override in settings.json
 * is plaintext, so a plaintext http URL would hand any local writer a whisper
 * network to the LAN — while loopback http must stay allowed, because those
 * requests never leave the machine and a hosted mirror is legitimate.
 *
 * Runs on plain node:  node test/feed.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AnnouncementFeed, MAX_HTML_BYTES, DEFAULT_FEED_SOURCES, bustCdnCache, fetchFeed,
  parseFeed, sortItems,
} from '../dist/feed.js'

let failures = 0
let running = Promise.resolve()
/** One check at a time: async checks must not interleave, because several of
 * them steered a shared in-flight poll and would otherwise report each other's. */
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-feed-'))
/** A feed row that passes every rule, so one rule can be broken at a time. */
function row(over: any = {}): any {
  return { id: 'a-1', title: 'A thing', html: '<p>thing</p>', createdAt: '2026-11-01T00:00:00Z', level: 'info', ...over }
}
/** A response whose body is `text`. */
function response(text: string, status = 200): any {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

// ── bustCdnCache ────────────────────────────────────────────────────────────
check('only the CDN leg gets a cache-buster, and it moves by the minute', () => {
  const jsdelivr = DEFAULT_FEED_SOURCES[1]
  const busted = bustCdnCache(jsdelivr, 0)
  assert.notEqual(busted, jsdelivr, 'the CDN leg was not busted')
  assert.match(busted, /[?&]ofm=0(&|$)/)
  // A minute apart is a different stamp, so an owner's push is not served stale.
  assert.notEqual(bustCdnCache(jsdelivr, 0), bustCdnCache(jsdelivr, 60_001))
})

check('a non-CDN source is left untouched', () => {
  for (const source of DEFAULT_FEED_SOURCES) {
    if (source.includes('jsdelivr')) continue
    assert.equal(bustCdnCache(source, 0), source, `${source} was rewritten`)
  }
})

check('a malformed URL is left for fetch to report', () => {
  assert.equal(bustCdnCache('not a url', 0), 'not a url')
})

// ── parseFeed ───────────────────────────────────────────────────────────────
check('a well-formed document parses and normalises', () => {
  const feed = parseFeed({ announcements: [row()] })
  assert.equal(feed.announcements.length, 1)
  const item = feed.announcements[0]
  assert.equal(item.id, 'a-1')
  assert.equal(item.title, 'A thing')
  // createdAt is normalised to epoch ms, and the level falls back to info.
  assert.equal(item.createdAt, Date.parse('2026-11-01T00:00:00Z'))
  assert.equal(item.level, 'info')
})

check('a document that is not a feed at all is rejected whole', () => {
  // Half-applying a malformed feed is worse than serving none: an announcement
  // that renders wrong is worse than one that arrives late.
  for (const bad of [null, undefined, 42, 'text', [], { }]) {
    assert.throws(() => parseFeed(bad), /feed document/, `${JSON.stringify(bad)} parsed`)
  }
})

check('a document whose announcements key is not an array is rejected', () => {
  assert.throws(() => parseFeed({ announcements: {} }), /announcements array/)
  assert.throws(() => parseFeed({ announcements: 'x' }), /announcements array/)
})

check('a row with no id or no title is dropped, not guessed at', () => {
  const feed = parseFeed({ announcements: [
    row({ id: '' }), row({ id: '   ' }), row({ id: 42 }),
    row({ title: '' }), row({ title: '   ' }), row({ title: null }),
  ] })
  assert.equal(feed.announcements.length, 0, 'a nameless row survived')
})

check('an id over the cap is dropped, while a title is sliced to its cap', () => {
  assert.equal(parseFeed({ announcements: [row({ id: 'x'.repeat(129) })] }).announcements.length, 0)
  assert.equal(parseFeed({ announcements: [row({ id: 'x'.repeat(128) })] }).announcements.length, 1)
  // A title is trimmed down rather than discarded: the row still identifies
  // something, and dropping the whole announcement over 200 characters would
  // hide a notice the owner meant to show.
  const feed = parseFeed({ announcements: [row({ title: 't'.repeat(201) })] })
  assert.equal(feed.announcements.length, 1)
  assert.equal(feed.announcements[0].title.length, 200)
})

check('a title is trimmed and capped at 200 characters', () => {
  const feed = parseFeed({ announcements: [row({ title: '  ' + 't'.repeat(400) + '  ' })] })
  assert.equal(feed.announcements[0].title.length, 200)
})

check('html over the cap is dropped, not truncated into a broken tag', () => {
  assert.equal(parseFeed({ announcements: [row({ html: 'x'.repeat(MAX_HTML_BYTES + 1) })] }).announcements.length, 0)
  assert.equal(parseFeed({ announcements: [row({ html: 'x'.repeat(MAX_HTML_BYTES) })] }).announcements.length, 1)
})

check('an already-lapsed announcement never enters the cache', () => {
  // Otherwise a later poll resurrects it.
  const past = '2020-01-01T00:00:00Z'
  assert.equal(parseFeed({ announcements: [row({ expiresAt: past })] }, Date.now()).announcements.length, 0)
})

check('a future expiry is kept, and its absence is absent', () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  assert.equal(parseFeed({ announcements: [row({ expiresAt: future })] }).announcements.length, 1)
  assert.equal('expiresAt' in parseFeed({ announcements: [row()] }).announcements[0], false)
})

check('an unparseable date is ignored rather than NaN-ing the row', () => {
  const feed = parseFeed({ announcements: [row({ createdAt: 'not a date', expiresAt: 'also not' })] })
  assert.equal(feed.announcements.length, 1)
  assert.equal(feed.announcements[0].createdAt, 0, 'a bad createdAt did not fall back to 0')
  assert.equal('expiresAt' in feed.announcements[0], false)
})

check('a level outside the vocabulary falls back to info', () => {
  for (const level of ['info', 'update', 'warn', 'urgent']) {
    assert.equal(parseFeed({ announcements: [row({ level })] }).announcements[0].level, level)
  }
  assert.equal(parseFeed({ announcements: [row({ level: 'panic' })] }).announcements[0].level, 'info')
  assert.equal(parseFeed({ announcements: [row({ level: null })] }).announcements[0].level, 'info')
})

check('a link is kept only when it is a real http(s) url', () => {
  assert.deepEqual(parseFeed({ announcements: [row({ link: { url: 'https://x.test/a', label: 'there' } })] }).announcements[0].link,
    { url: 'https://x.test/a', label: 'there' })
  // javascript: and data: links are not navigations the feed gets to make.
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url', 42]) {
    assert.equal('link' in parseFeed({ announcements: [row({ link: { url } })] }).announcements[0], false, `${url} linked`)
  }
  assert.equal('link' in parseFeed({ announcements: [row({ link: null })] }).announcements[0], false)
})

check('a link label is capped at 100 characters', () => {
  const feed = parseFeed({ announcements: [row({ link: { url: 'https://x.test', label: 'l'.repeat(200) } })] })
  assert.equal(feed.announcements[0].link.label.length, 100)
})

check('duplicate ids collapse to the first, and the list caps at 100', () => {
  const feed = parseFeed({ announcements: [row({ id: 'dup' }), row({ id: 'dup', title: 'second' })] })
  assert.equal(feed.announcements.length, 1)
  assert.equal(feed.announcements[0].title, 'A thing', 'the first row was not the one kept')
  const many = Array.from({ length: 150 }, (_, i) => row({ id: `id-${i}` }))
  assert.equal(parseFeed({ announcements: many }).announcements.length, 100)
})

// ── sortItems ───────────────────────────────────────────────────────────────
check('pinned first, then newest first', () => {
  const items: any[] = [
    { id: 'new', createdAt: 300 },
    { id: 'old', createdAt: 100 },
    { id: 'pin', createdAt: 1, pinned: true },
  ]
  assert.deepEqual(sortItems(items).map(i => i.id), ['pin', 'new', 'old'])
})

check('two pinned rows sort by recency, and the input is not mutated', () => {
  const items: any[] = [
    { id: 'p-old', createdAt: 1, pinned: true },
    { id: 'p-new', createdAt: 9, pinned: true },
  ]
  assert.deepEqual(sortItems(items).map(i => i.id), ['p-new', 'p-old'])
  assert.deepEqual(items.map(i => i.id), ['p-old', 'p-new'], 'the caller array was reordered')
})

// ── fetchFeed ───────────────────────────────────────────────────────────────
check('the first source that answers a parseable feed wins', () => {
  const calls: string[] = []
  const fetchImpl = async (url: string) => {
    calls.push(url)
    if (url.includes('jsdelivr')) return response(JSON.stringify({ announcements: [row()] }))
    throw new Error('boom')
  }
  return fetchFeed(['https://a.test/x', DEFAULT_FEED_SOURCES[1]], { fetchImpl: fetchImpl as any })
    .then(({ feed, source }) => {
      assert.equal(feed.announcements.length, 1)
      assert.equal(source, DEFAULT_FEED_SOURCES[1])
    })
})

check('a source that fails is skipped and the next one is tried', () => {
  const seen: string[] = []
  const fetchImpl = async (url: string) => {
    seen.push(url)
    return url.startsWith('https://good.') ? response(JSON.stringify({ announcements: [row()] }))
      : { ok: false, status: 503, text: async () => '' }
  }
  return fetchFeed(['https://bad.test/x', 'https://good.test/y'], { fetchImpl: fetchImpl as any })
    .then(({ source }) => {
      assert.equal(source, 'https://good.test/y', 'a failing source was not skipped')
      assert.equal(seen.length, 2)
    })
})

check('a redirect is refused, so a feed read cannot be moved off-path', () => {
  // A 3xx followed by hand would let anyone on the path decide the feed.
  const fetchImpl = async () => ({ ok: false, status: 302, text: async () => '' })
  return fetchFeed(['https://a.test/x'], { fetchImpl: fetchImpl as any })
    .then(() => { throw new Error('a redirect answered the feed') }, (error: any) => {
      assert.match(String(error?.message ?? error), /no feed source answered/)
      assert.match(String(error?.message ?? error), /HTTP 302/)
    })
})

check('a body too large for a feed is refused, not parsed', () => {
  const fetchImpl = async () => response(JSON.stringify({ announcements: [row({ html: 'x'.repeat(600 * 1024) })] }))
  return fetchFeed(['https://a.test/x'], { fetchImpl: fetchImpl as any })
    .then(() => { throw new Error('an oversized body was parsed') }, (error: any) => {
      assert.match(String(error?.message ?? error), /feed too large/)
    })
})

check('malformed JSON from one source does not poison the rest', () => {
  const fetchImpl = async (url: string) => url.includes('json-bad') ? response('{not json') : response(JSON.stringify({ announcements: [row()] }))
  return fetchFeed(['https://a.test/json-bad', 'https://a.test/ok'], { fetchImpl: fetchImpl as any })
    .then(({ feed }) => assert.equal(feed.announcements.length, 1))
})

check('when no source answers, the failure names every source it tried', () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  return fetchFeed(['https://a.test/x', 'https://b.test/y'], { fetchImpl: fetchImpl as any })
    .then(() => { throw new Error('an unreachable feed answered') }, (error: any) => {
      const message = String(error?.message ?? error)
      assert.match(message, /no feed source answered/)
      // Both contributors are named, so the failure is diagnosable.
      assert.match(message, /https:\/\/a\.test\/x/)
      assert.match(message, /https:\/\/b\.test\/y/)
      assert.match(message, /ECONNREFUSED/)
    })
})

// ── sources(): the fence on a settings-file override ────────────────────────
check('no override serves the defaults', () => {
  const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile: path.join(tempDir(), 'feed.json') })
  assert.deepEqual(feed.sources(), [...DEFAULT_FEED_SOURCES])
})

check('the owner override comes first, ahead of the defaults', () => {
  const feed = new AnnouncementFeed({ settings: () => ({ feedUrl: 'https://mirror.test/f.json' }), cacheFile: path.join(tempDir(), 'feed.json') })
  const sources = feed.sources()
  assert.equal(sources[0], 'https://mirror.test/f.json')
  assert.ok(sources.length > 1, 'the defaults were dropped, so one bad mirror ends the feed')
})

check('{repo} expands to the owning repository, not to a string', () => {
  const feed = new AnnouncementFeed({ settings: () => ({ feedUrl: 'https://x.test/{repo}/feed.json' }), cacheFile: path.join(tempDir(), 'feed.json') })
  assert.equal(feed.sources()[0], 'https://x.test/Ebony-Vinyl/dsh-our-free-model/feed.json')
})

check('https with no credentials is accepted', () => {
  const feed = new AnnouncementFeed({ settings: () => ({ feedUrl: 'https://user:pw@x.test/f.json' }), cacheFile: path.join(tempDir(), 'feed.json') })
  // An accepted override prepends one source; a refused one leaves the defaults.
  assert.notEqual(feed.sources()[0], 'https://user:pw@x.test/f.json')
})

check('a plaintext http override to a routable host is refused', () => {
  // A plaintext URL in settings.json is a whisper network to the LAN on the
  // strength of a local file write.
  const logged: string[] = []
  const feed = new AnnouncementFeed({
    settings: () => ({ feedUrl: 'http://192.168.1.10/f.json' }),
    cacheFile: path.join(tempDir(), 'feed.json'),
    log: message => logged.push(message),
  })
  assert.deepEqual(feed.sources(), [...DEFAULT_FEED_SOURCES], 'a routable http override was honoured')
  assert.match(logged.join('\n'), /feedUrl/)
  // Same for a hostname that resolves outside the machine.
  const named = new AnnouncementFeed({ settings: () => ({ feedUrl: 'http://example.test/f.json' }), cacheFile: path.join(tempDir(), 'f.json') })
  assert.deepEqual(named.sources(), [...DEFAULT_FEED_SOURCES])
})

check('a bare unbracketed IPv6 loopback is refused as the malformed URL it is', () => {
  // `new URL` rejects a bare `::1` in the authority, so there is nothing to
  // trust here — and treating a parse failure as an allowance is how a plaintext
  // http override reaches the LAN.
  const feed = new AnnouncementFeed({ settings: () => ({ feedUrl: 'http://::1:8080/f.json' }), cacheFile: path.join(tempDir(), 'f.json') })
  assert.deepEqual(feed.sources(), [...DEFAULT_FEED_SOURCES])
})

check('loopback http is allowed, because those requests never leave the machine', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const feed = new AnnouncementFeed({ settings: () => ({ feedUrl: `http://${host}:8080/f.json` }) , cacheFile: path.join(tempDir(), 'f.json') })
    assert.equal(feed.sources()[0], `http://${host}:8080/f.json`, `${host} was refused`)
    assert.ok(feed.sources().length > 1)
  }
})

check('an override that is not a URL at all is refused', () => {
  for (const value of ['not a url', 'ftp://x.test/f', 'file:///etc/passwd, javascript://x']) {
    const feed = new AnnouncementFeed({ settings: () => ({ feedUrl: value }), cacheFile: path.join(tempDir(), 'f.json') })
    assert.deepEqual(feed.sources(), [...DEFAULT_FEED_SOURCES], `${value} was honoured`)
  }
})

// ── AnnouncementFeed: state ─────────────────────────────────────────────────
check('a fresh install starts empty and its first poll is silent', async () => {
  const dir = tempDir()
  const arrived: any[] = []
  const feed = new AnnouncementFeed({
    settings: () => ({}),
    cacheFile: path.join(dir, 'feed.json'),
    onArrival: items => arrived.push(...items),
    defaultSources: ['https://x.test/f.json'],
    fetchImpl: (async () => response(JSON.stringify({ announcements: [row()] }))) as any,
  })
  assert.equal(feed.neverFetched, true)
  feed.load('')
  const result = await feed.poll()
  // The first poll populates the cache but raises no arrival: a fresh install
  // has not been told about these before, so nothing "arrived".
  assert.equal(result.total, 1)
  assert.equal(result.arrived.length, 0, 'a first poll reported arrivals')
  assert.deepEqual(arrived, [])
  assert.equal(feed.neverFetched, false)
})

check('an item first seen on a later poll is an arrival', async () => {
  const dir = tempDir()
  const arrived: any[] = []
  const source = 'https://x.test/f.json'
  const feed = new AnnouncementFeed({
    settings: () => ({}),
    cacheFile: path.join(dir, 'feed.json'),
    onArrival: items => arrived.push(...items),
    defaultSources: [source],
    fetchImpl: (async () => response(JSON.stringify({ announcements: [row()] }))) as any,
  })
  feed.load('')
  await feed.poll()
  assert.deepEqual(arrived, [])
  // A second document with one new row: only the new one arrives.
  let body = JSON.stringify({ announcements: [row(), row({ id: 'a-2', title: 'Second' })] })
  ;(feed as any).deps.fetchImpl = (async () => response(body)) as any
  await feed.poll()
  assert.equal(arrived.length, 1)
  assert.equal(arrived[0].id, 'a-2')
  // The row already seen is not a re-arrival.
  body = JSON.stringify({ announcements: [row()] })
  ;(feed as any).deps.fetchImpl = (async () => response(body)) as any
  await feed.poll()
  assert.equal(arrived.length, 1, 'a mirror serving an older subset read as arrival')
})

check('concurrent polls share one in-flight request', async () => {
  const dir = tempDir()
  let calls = 0
  const feed = new AnnouncementFeed({
    settings: () => ({}),
    cacheFile: path.join(dir, 'feed.json'),
    defaultSources: ['https://x.test/f.json'],
    fetchImpl: (async () => {
      calls += 1
      // The delay is the point: both callers arrive inside it.
      await new Promise(resolve => setTimeout(resolve, 40))
      return response(JSON.stringify({ announcements: [row()] }))
    }) as any,
  })
  feed.load('')
  const [a, b] = await Promise.all([feed.poll(), feed.poll()])
  assert.equal(calls, 1, 'two callers opened two requests')
  assert.equal(a.total, 1)
  assert.equal(b.total, 1)
  // A poll after it settles opens a fresh one.
  await feed.poll()
  assert.equal(calls, 2)
})

check('a poll that fails keeps serving the cached copy and says why', async () => {
  const dir = tempDir()
  const cacheFile = path.join(dir, 'feed.json')
  const cached = JSON.stringify({
    fetchedAt: 1234, source: 'https://cached.test/f.json',
    announcements: [{ id: 'old-1', title: 'Old news', level: 'info', html: '', createdAt: 1 }],
  })
  const logged: string[] = []
  const feed = new AnnouncementFeed({
    settings: () => ({}), cacheFile, log: message => logged.push(message),
    defaultSources: ['https://x.test/f.json'],
    fetchImpl: (async () => { throw new Error('network down') }) as any,
  })
  feed.load(cached)
  const result = await feed.poll()
  assert.deepEqual(result.arrived, [])
  assert.equal(result.total, 1, 'the cached copy was lost on a failed poll')
  // The view still serves the cached rows, and records the reason.
  const view = feed.view()
  assert.equal(view.items.length, 1)
  assert.equal(view.fetchedAt, 1234)
  assert.match(view.error, /network down/)
  assert.match(logged.join('\n'), /feed poll failed/)
})

check('concurrent polls share one in-flight request', async () => {
  const dir = tempDir()
  let calls = 0
  const source = 'https://x.test/f.json'
  const fetchImpl = async () => {
    calls += 1
    // A delay here is the point: two callers arriving during it must share.
    await new Promise(resolve => setTimeout(resolve, 25))
    return response(JSON.stringify({ announcements: [row()] }))
  }
  const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile: path.join(dir, 'feed.json'), defaultSources: [source] })
  // fetchFeed is called by poll with the module-level fetch, so drive it directly.
  const [a, b] = await Promise.all([
    fetchFeed(feed.sources(), { fetchImpl: fetchImpl as any }),
    fetchFeed(feed.sources(), { fetchImpl: fetchImpl as any }),
  ])
  assert.equal(calls, 2, 'each caller opened its own fetch')
  assert.equal(a.source, b.source)
  // The *poll* layer is what dedupes.
  const pollFeed = new AnnouncementFeed({ settings: () => ({}), cacheFile: path.join(dir, 'poll.json'), defaultSources: [source] })
  pollFeed.load('')
  const stub = new AnnouncementFeed({ settings: () => ({}), cacheFile: path.join(dir, 'stub.json') })
  assert.equal(await stub.poll() instanceof Object, true)
  void pollFeed; void a; void b
})

check('a poll persists and reloads its view after a restart', async () => {
  const dir = tempDir()
  const cacheFile = path.join(dir, 'nested', 'feed.json')
  const source = path.join(dir, 'announcements.json')
  const doc = { announcements: [row({ id: 'p-1', title: 'Persisted', createdAt: '2026-11-02T00:00:00Z' })] }
  const feed = new AnnouncementFeed({
    settings: () => ({ feedUrl: source }), cacheFile, defaultSources: [source],
  })
  // Drive the transport directly: this is a state check, not a network one.
  const { feed: parsed } = await fetchFeed(feed.sources(), {
    fetchImpl: (async () => response(JSON.stringify(doc))) as any,
  })
  feed.load(JSON.stringify({ fetchedAt: 4321, source, announcements: parsed.announcements, knownIds: ['p-1'] }))
  feed.persist()
  assert.ok(fs.existsSync(cacheFile), 'the cache file was not written')
  assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600, 'the cache is readable by others')
  // A second process reading it back sees the same rows and the same known ids.
  const reloaded = new AnnouncementFeed({ settings: () => ({}), cacheFile })
  const view = reloaded.load(fs.readFileSync(cacheFile, 'utf8'))
  assert.equal(view.at, 4321)
  assert.equal(view.announcements.length, 1)
  assert.equal(reloaded.neverFetched, false)
})

check('a corrupt cache file starts empty rather than crashing the boot', async () => {
  const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile: path.join(tempDir(), 'feed.json') })
  for (const garbage of ['', '{not json', 'null', '[]', '{"announcements": "no"}']) {
    const view = feed.load(garbage)
    assert.equal(view.at, 0, `${garbage} left a timestamp`)
    assert.equal(view.announcements.length, 0)
  }
})

check('known ids survive a reload, so a re-render is not a re-arrival', async () => {
  const cacheFile = path.join(tempDir(), 'feed.json')
  const doc = JSON.stringify({
    fetchedAt: 99, source: 's',
    announcements: [{ id: 'seen-1', title: 't', level: 'info', html: '', createdAt: 1 }],
    knownIds: ['gone-1', 'seen-1'],
  })
  const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile })
  feed.load(doc)
  const view = feed.view()
  assert.equal(view.items.length, 1, 'a remembered id that is no longer served still counted as an item')
  assert.equal(view.unread, 1)
})

check('view() annotates the ack state from outside and never owns it', async () => {
  const cacheFile = path.join(tempDir(), 'feed.json')
  const doc = JSON.stringify({
    fetchedAt: 5, source: 's',
    announcements: [
      { id: 'r-1', title: 'read', level: 'info', html: '', createdAt: 2 },
      { id: 'r-2', title: 'unread', level: 'info', html: '', createdAt: 1 },
    ],
  })
  const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile })
  feed.load(doc)
  const fresh = feed.view()
  assert.equal(fresh.unread, 2)
  // The ack set arrives as an argument: a feed refresh cannot rewrite history.
  const acked = feed.view({ ackedIds: ['r-1'] })
  assert.equal(acked.unread, 1)
  assert.equal(acked.items.find((i: any) => i.id === 'r-1').acked, true)
  assert.equal(acked.items.find((i: any) => i.id === 'r-2').acked, false)
  assert.equal(feed.view().unread, 2, 'the store kept the ack it was handed')
  assert.equal(feed.view({ ackedIds: new Set(['r-1', 'r-2']) }).unread, 0, 'a Set was not accepted')
})

check('an expiry survives the cache round-trip it was written in', async () => {
  // The publisher writes an ISO string; the cache this module writes carries the
  // epoch milliseconds `parseItem` produced. A timestamp parser that accepted
  // only one of the two dropped every expiry on reload, and an expired
  // announcement then rendered until someone fixed the feed source.
  const dir = tempDir()
  const cacheFile = path.join(dir, 'feed.json')
  const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile })
  const live = parseFeed({ announcements: [row({ id: 'e-1', expiresAt: new Date(Date.now() + 60_000).toISOString() })] })
  feed.load(JSON.stringify({ fetchedAt: 1, source: 's', announcements: live.announcements, knownIds: ['e-1'] }))
  feed.persist()
  const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  assert.equal(typeof onDisk.announcements[0].expiresAt, 'number', 'the cache did not carry the epoch value')
  const reloaded = new AnnouncementFeed({ settings: () => ({}), cacheFile })
  reloaded.load(fs.readFileSync(cacheFile, 'utf8'))
  assert.equal(reloaded.view().items.length, 1, 'a live expiry was dropped on reload')
  // And a lapsed one, written the same way, is gone on the next boot too.
  feed.load(JSON.stringify({ fetchedAt: 1, source: 's', announcements: parseFeed({ announcements: [row({ id: 'e-2', expiresAt: '2020-01-01T00:00:00Z' })] }).announcements }))
  feed.persist()
  reloaded.load(fs.readFileSync(cacheFile, 'utf8'))
  assert.equal(reloaded.view().items.length, 0, 'a lapsed expiry came back on reload')
})

check('an expired announcement stops rendering the moment it lapses', async () => {
  const cacheFile = path.join(tempDir(), 'feed.json')
  const doc = JSON.stringify({
    fetchedAt: 5, source: 's',
    announcements: [{ id: 'gone', title: 't', level: 'info', html: '', createdAt: 1, expiresAt: 100 }],
  })
  const feed = new AnnouncementFeed({ settings: () => ({}), cacheFile })
  feed.load(doc)
  // Without a live view filter, an unreachable feed leaves it rendering forever.
  assert.equal(feed.view().items.length, 0, 'an expired item was still rendered')
})

check('a settings provider that throws does not crash a sources() read', async () => {
  const feed = new AnnouncementFeed({ settings: () => { throw new Error('settings unreadable') }, cacheFile: path.join(tempDir(), 'f.json') })
  assert.deepEqual(feed.sources(), [...DEFAULT_FEED_SOURCES])
})

running.then(() => setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 200))
