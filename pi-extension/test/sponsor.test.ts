/**
 * Unit checks for the sponsor copy and the once-per-day claim.
 *
 * Two rules carry the weight, and both are easy to get wrong in a way that only
 * shows up in front of a user:
 *
 *   1. **A local calendar day, not a UTC one.** `toISOString()` rolls "today"
 *      over at UTC midnight, so every viewer east of Greenwich sees the notice
 *      twice a day and every viewer west of the date line misses one.
 *   2. **The write has to succeed before the show.** A storage that refuses the
 *      write — a privacy-mode window, a full quota — must suppress the notice, or
 *      a refresh re-shows it forever. And a `show()` that throws rolls the day
 *      back, so a failed render does not spend a day.
 *
 * Runs on plain node:  node test/sponsor.test.ts
 */
import assert from 'node:assert/strict'
import { SPONSOR, SPONSOR_DAY_KEY, claimSponsorDay, sponsorLocalDay, sponsorView } from '../dist/sponsor.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

/** A storage that seeds its own map, records what was written, and can be told to refuse. */
function fakeStorage(over: Partial<Storage> = {}, initial: Record<string, string> = {}): Storage & { writes: Array<[string, string]> } {
  const map = new Map<string, string>(Object.entries(initial))
  const writes: Array<[string, string]> = []
  return {
    writes,
    get length() { return map.size },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push([key, value]); map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    ...over,
  } as Storage & { writes: Array<[string, string]> }
}

// ── the day rule ────────────────────────────────────────────────────────────
check('the local calendar day is YYYY-MM-DD, padded', () => {
  assert.equal(sponsorLocalDay(new Date(2026, 10, 6)), '2026-11-06')
  assert.equal(sponsorLocalDay(new Date(2026, 0, 1)), '2026-01-01')
  assert.equal(sponsorLocalDay(new Date(2026, 8, 30)), '2026-09-30')
})

check('the day is the machine\'s own, not UTC\'s', () => {
  // The whole point of the helper: `toISOString()` rolls over at UTC midnight.
  // 2026-11-06 23:30 local is still the 6th, wherever the machine is.
  assert.equal(sponsorLocalDay(new Date(2026, 10, 6, 23, 30, 0)), '2026-11-06')
  // 00:30 local on the 7th is the 7th, not "the 6th in UTC".
  assert.equal(sponsorLocalDay(new Date(2026, 10, 7, 0, 30, 0)), '2026-11-07')
})

check('a shift across midnight is a different day', () => {
  const before = sponsorLocalDay(new Date(2026, 10, 6, 23, 59, 59))
  const after = sponsorLocalDay(new Date(2026, 10, 7, 0, 0, 0))
  assert.notEqual(before, after)
})

// ── the claim ───────────────────────────────────────────────────────────────
check('the first showing succeeds and remembers the day', async () => {
  const storage = fakeStorage()
  let shown = 0
  const claimed = await claimSponsorDay({
    storage, now: () => new Date(2026, 10, 6), show: () => { shown += 1 },
  })
  assert.equal(claimed, true)
  assert.equal(shown, 1)
  assert.equal(storage.getItem(SPONSOR_DAY_KEY), '2026-11-06')
})

check('a second showing the same day is refused without calling show', async () => {
  const storage = fakeStorage({}, { [SPONSOR_DAY_KEY]: '2026-11-06' })
  let shown = 0
  const claimed = await claimSponsorDay({
    storage, now: () => new Date(2026, 10, 6), show: () => { shown += 1 },
  })
  assert.equal(claimed, false)
  assert.equal(shown, 0, 'an already-shown day was shown again')
  // Nothing was written, because nothing changed.
  assert.equal(storage.writes.length, 0)
})

check('a new day is shown again', async () => {
  const storage = fakeStorage({}, { [SPONSOR_DAY_KEY]: '2026-11-05' })
  let shown = 0
  const claimed = await claimSponsorDay({
    storage, now: () => new Date(2026, 10, 6), show: () => { shown += 1 },
  })
  assert.equal(claimed, true)
  assert.equal(shown, 1)
})

check('a storage that refuses the write suppresses the notice entirely', async () => {
  // This is the privacy-mode / full-quota case: re-showing it on every refresh is
  // the failure this rule exists to prevent.
  const storage = fakeStorage({ setItem: () => { throw new Error('QuotaExceededError') } })
  let shown = 0
  const claimed = await claimSponsorDay({
    storage, now: () => new Date(2026, 10, 6), show: () => { shown += 1 },
  })
  assert.equal(claimed, false)
  assert.equal(shown, 0, 'a notice with no remembered day was shown anyway')
})

check('a show() that throws rolls the day back rather than spending it', async () => {
  const storage = fakeStorage()
  const claimed = await claimSponsorDay({
    storage, now: () => new Date(2026, 10, 6),
    show: () => { throw new Error('render failed') },
  })
  assert.equal(claimed, false)
  // A first-time showing leaves nothing behind, so tomorrow still gets one.
  assert.equal(storage.getItem(SPONSOR_DAY_KEY), null)
})

check('a show() that throws restores the previous day, not a blank', async () => {
  const storage = fakeStorage({}, { [SPONSOR_DAY_KEY]: '2026-11-05' })
  await claimSponsorDay({
    storage, now: () => new Date(2026, 10, 6), show: () => { throw new Error('render failed') },
  })
  assert.equal(storage.getItem(SPONSOR_DAY_KEY), '2026-11-05')
})

check('an installation that says "not eligible" is never shown', async () => {
  const storage = fakeStorage()
  let shown = 0
  const claimed = await claimSponsorDay({
    storage, eligible: () => false, now: () => new Date(2026, 10, 6), show: () => { shown += 1 },
  })
  assert.equal(claimed, false)
  assert.equal(shown, 0)
  assert.equal(storage.writes.length, 0, 'an ineligible showing wrote a day')
})

check('the Web Lock is used when present, and its refusal is not a crash', async () => {
  const storage = fakeStorage()
  let shown = 0
  let requested = ''
  const locks = { request: async (name: string, callback: () => boolean) => { requested = name; return callback() } }
  const claimed = await claimSponsorDay({ storage, locks, now: () => new Date(2026, 10, 6), show: () => { shown += 1 } })
  assert.equal(claimed, true)
  assert.equal(requested, 'ofm-sponsor-daily')
  // A lock that refuses (another window holds it) is a `false`, not an exception.
  const denied = await claimSponsorDay({
    storage: fakeStorage(), locks: { request: async () => false }, now: () => new Date(2026, 10, 6), show: () => { throw new Error('must not show') },
  })
  assert.equal(denied, false)
})

// ── the copy ───────────────────────────────────────────────────────────────
check('the copy is data, and frozen', () => {
  assert.equal(Object.isFrozen(SPONSOR), true)
  assert.equal(Object.isFrozen(SPONSOR.paragraphs), true)
  // A surface renders these in its own idiom, so the copy must not be markup.
  assert.equal(SPONSOR.paragraphs.every(text => typeof text === 'string' && text !== ''), true)
  assert.equal(SPONSOR.paragraphs.length, 6)
  assert.ok(SPONSOR.url.startsWith('https://'))
})

check('the API view carries the copy minus the internal bookkeeping', () => {
  const view = sponsorView()
  assert.deepEqual(Object.keys(view).sort(), ['name', 'paragraphs', 'title', 'url'])
  assert.deepEqual(view.paragraphs, SPONSOR.paragraphs)
  // No `invite` code in the view: it belongs to the UI that offers a copy button.
  assert.equal('invite' in view, false)
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
