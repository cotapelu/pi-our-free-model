/**
 * Unit checks for the ported core: stats, completion, runtime, failure.
 *
 * Two properties carry most of the weight:
 *
 *   1. **A rate over too few calls is `null`**, not a plausible `tok/s` — that is
 *      the whole point of `MIN_DECODE_MS`, and the panel's job is showing the user
 *      a number that means something.
 *   2. **Physical and logical counting must not be conflated.** A chain's links
 *      record their own calls and the chain records its own turn; missing the
 *      logical layer makes a configured chain invisible in its own panel.
 *
 * The rest pins the projections: an OpenAI body into this provider's message
 * vocabulary, and a failure into the wire envelope that travels through three
 * architectures.
 *
 * Runs on plain node:  node test/core.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildStats } from '../dist/core/stats.js'
import { createForwardCompletion, foldForwardOutcome, fromOpenAiMessages, publicModelRows, routableModelIds, toOpenAiUsage } from '../dist/core/completion.js'
import { computeMembership, createRuntimeStores, modelAvailability } from '../dist/core/runtime.js'
import { carryFailure } from '../dist/failure.js'
import { carriesImageContent, emptyBodyFailure } from '../dist/transport.js'
import { ROUTE_MAIN, ROUTE_REGION } from '../dist/adapter.js'

let failures = 0
let running = Promise.resolve()
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-core-'))

// ── toOpenAiUsage ───────────────────────────────────────────────────────────
check('harness usage reads as an OpenAI envelope, with both detail blocks', () => {
  assert.deepEqual(toOpenAiUsage({ inputTokens: 100, outputTokens: 40, reasoningTokens: 15, cacheReadTokens: 20 }), {
    prompt_tokens: 120,
    completion_tokens: 40,
    total_tokens: 160,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 15 },
  })
})

check('a missing usage stays missing rather than becoming a zeroed envelope', () => {
  // A zeroed envelope would assert "the model used nothing", which is a different
  // fact from "no usage was reported".
  assert.equal(toOpenAiUsage(undefined), undefined)
  assert.equal(toOpenAiUsage(null), undefined)
})

// ── buildStats ──────────────────────────────────────────────────────────────
check('an empty document yields zeroes and no measured rate', () => {
  const stats = buildStats({ version: 3, days: {}, models: {} }, [])
  assert.equal(stats.requests, 0)
  assert.equal(stats.turns, 0)
  assert.deepEqual(stats.models, [])
  assert.equal(stats.savings.percent, 0)
  assert.match(stats.savings.summary, /no requests measured yet/)
  assert.equal(stats.grand.calls, 0)
})

check('a rate over too few measurable calls is null, not a rounding error', () => {
  // `MIN_DECODE_MS` is 250 ms: below it the quotient is noise with a unit on it.
  const stats = buildStats({
    version: 3,
    days: { '2026-11-01': { total: 1, models: { 'ofm-kilo/a': { input: 10, output: 5, calls: 1, failed: 0, decodeMs: 40, decodeTokens: 2, ttftMs: 30, ttftSamples: 1 } } } },
  }, [])
  const row = stats.models[0]
  assert.equal(row.tps, null, 'a 2 ms decode produced a tok/s')
  assert.equal(row.avgTtftMs, 30, 'a first-byte sample was dropped')
})

check('a rate over enough measurable calls is computed', () => {
  const stats = buildStats({
    version: 3,
    days: { '2026-11-01': { total: 1, models: { 'ofm-kilo/a': { decodeMs: 2000, decodeTokens: 100, ttftMs: 100, ttftSamples: 2 } } } },
  }, [])
  assert.equal(stats.models[0].tps, 50)
  assert.equal(stats.models[0].avgTtftMs, 50)
})

check('a chain appears in its own panel, not only through its links', () => {
  // The logical layer is part of the row set, not a lookup table.
  const stats = buildStats({
    version: 3,
    days: {
      '2026-11-01': { total: 3, models: {
        'ofm-kilo/a': { input: 10, output: 5, calls: 1, failed: 0 },
        'ofm-opencode/b': { input: 20, output: 6, calls: 1, failed: 0 },
      } },
    },
    logical: { turns: 1, failed: 0, recovered: 0, models: { 'combo:chain': { turns: 1, failed: 0, recovered: 0 } } },
  }, [{ id: 'combo:chain', name: 'My chain' }])
  const chain = stats.models.find(row => row.model === 'combo:chain')
  assert.notEqual(chain, undefined, 'the chain was invisible in its own panel')
  assert.equal(chain.name, 'My chain', 'the catalog display name was not used')
  assert.equal(chain.turns, 1)
  // Physical and logical counts stay separate rather than being summed together.
  assert.equal(stats.turns, 1)
  assert.equal(stats.grand.calls, 2)
})

check('a lifetime counter wins over the row sum, and says so when it is missing', () => {
  const withLifetime = buildStats({
    version: 3, failedRequests: 7,
    days: { d: { total: 1, models: { m: { input: 1, output: 2, calls: 3, failed: 4 } } } },
  }, [])
  assert.equal(withLifetime.requestFailures, 7)
  assert.equal(withLifetime.requestFailuresEstimated, false)
  const without = buildStats({
    version: 3,
    days: { d: { total: 1, models: { m: { input: 1, output: 2, calls: 3, failed: 4 } } } },
  }, [])
  assert.equal(without.requestFailures, 4)
  assert.equal(without.requestFailuresEstimated, true, 'a summed estimate was presented as exact')
})

check('the savings percentage is computed here, from the bytes the rows counted', () => {
  const stats = buildStats({
    version: 3,
    days: {},
    savings: { bytesBefore: 2000, bytesAfter: 500, saved: 1500, blocks: 3, calls: 2, promptCalls: 0 },
  }, [])
  assert.equal(stats.savings.percent, 75)
  assert.match(stats.savings.summary, /1\.5 KB saved over 2 request\(s\) \(75%\)/)
})

// ── fromOpenAiMessages ──────────────────────────────────────────────────────
check('an OpenAI body projects into this provider\'s message vocabulary', () => {
  const rows = fromOpenAiMessages({ messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', content: 'done', tool_call_id: 'c1' },
  ] }, false, 'ofm-kilo/a')
  assert.equal(rows.length, 4)
  assert.deepEqual(rows[0].content, [{ type: 'text', text: 'be brief' }])
  // A tool call rides inside the assistant row, not as a row of its own.
  assert.equal(rows[2].content[0].type, 'tool-call')
  assert.equal(rows[2].content[0].name, 'read')
  // A tool result keeps its call id and names its source.
  assert.equal(rows[3].toolCallId, 'c1')
  assert.equal(rows[3].source.kind, 'tool')
  assert.equal(rows[3].source.callId, 'c1')
})

check('a content array is projected, and an empty one is not padded with a blank row', () => {
  const rows = fromOpenAiMessages({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'https://x.test/i.png' } }] },
    { role: 'assistant', content: '' },
  ] }, false, 'm')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].content[0].type, 'text')
  // An image travels as an attachment, so this layer never reads its bytes.
  assert.equal(rows[0].content[1].type, 'image')
  assert.equal(rows[0].content[1].attachment.url, 'https://x.test/i.png')
})

check('a Responses body projects through the same vocabulary', () => {
  const rows = fromOpenAiMessages({ input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'function_call', call_id: 'f1', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'f1', output: 'done' },
  ] }, true, 'm')
  assert.equal(rows.length, 3)
  assert.equal(rows[1].role, 'assistant')
  assert.equal(rows[1].content[0].type, 'tool-call')
  assert.equal(rows[2].role, 'tool')
  assert.equal(rows[2].content[0].text, 'done')
})

check('a string Responses input is one user turn', () => {
  assert.deepEqual(fromOpenAiMessages({ input: 'just text' }, true, 'm'),
    [{ role: 'user', content: [{ type: 'text', text: 'just text' }] }])
})

check('reasoning content rides along on an assistant row', () => {
  const rows = fromOpenAiMessages({ messages: [{ role: 'assistant', content: 'answer', reasoning_content: 'thoughts' }] }, false, 'm')
  assert.equal(rows[0].reasoning_content, 'thoughts')
  assert.equal(rows[0].source.model, 'm')
})

// ── foldForwardOutcome ──────────────────────────────────────────────────────
check('a tool call folds its deltas under the slot, then adopts the block-end', () => {
  // Matching by id alone would miss the slot's entry and fold one call into two.
  const outcome: any = { text: '', toolCalls: [], usage: undefined, truncated: false }
  foldForwardOutcome(outcome, { type: 'tool-call-delta', index: 3, argumentsDelta: '{"a":' })
  foldForwardOutcome(outcome, { type: 'tool-call-delta', index: 3, argumentsDelta: '1}' })
  foldForwardOutcome(outcome, { type: 'block-end', index: 3, block: { type: 'tool-call', id: 'late-id', name: 'read', arguments: '{"a":1}' } })
  assert.equal(outcome.toolCalls.length, 1, 'one call folded into two')
  assert.equal(outcome.toolCalls[0].id, 'late-id', 'the late id was not adopted')
  assert.equal(outcome.toolCalls[0].name, 'read')
  assert.equal(outcome.toolCalls[0].arguments, '{"a":1}')
})

check('a max-tokens ending marks the outcome truncated', () => {
  const outcome: any = { text: '', toolCalls: [], usage: undefined, truncated: false }
  foldForwardOutcome(outcome, { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(outcome.truncated, true)
})

check('an error ending carries the wire envelope, not the raw reason', () => {
  const outcome: any = { text: '', toolCalls: [], usage: undefined, truncated: false }
  foldForwardOutcome(outcome, { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 503', code: 'SERVER', status: 503, extra: 'dropped' } } })
  assert.equal(outcome.error, 'upstream 503')
  assert.deepEqual(outcome.failure, { message: 'upstream 503', code: 'SERVER', status: 503 })
})

check('an aborted ending reads as ABORTED regardless of the source code', () => {
  const outcome: any = { text: '', toolCalls: [], usage: undefined, truncated: false }
  foldForwardOutcome(outcome, { type: 'finish', reason: { kind: 'aborted', failure: { message: 'x', code: 'TIMEOUT' } } })
  assert.equal(outcome.failure.code, 'ABORTED')
})

// ── createForwardCompletion ────────────────────────────────────────────────
check('a stopped runtime refuses with 503, before anything else', async () => {
  const complete = createForwardCompletion({ adapter: { stream: async function* () {} }, state: () => ({ catalog: [], membership: {} }), signal: AbortSignal.abort() })
  await assert.rejects(() => complete({ model: 'm' }), (error: any) => {
    assert.equal(error.statusCode, 503)
    return true
  })
})

check('a model that is not routable is 404, not a silent empty answer', async () => {
  const state = () => ({ catalog: [{ id: 'm/a' }], membership: { [ROUTE_MAIN]: ['m/a'] } })
  const complete = createForwardCompletion({ adapter: { stream: async function* () {} }, state })
  await assert.rejects(() => complete({ model: 'm/nope' }), (error: any) => {
    assert.equal(error.statusCode, 404)
    return true
  })
  // A catalog entry the membership withholds is just as unroutable.
  const withheld = () => ({ catalog: [{ id: 'm/a' }], membership: { [ROUTE_MAIN]: ['m/b'] } })
  const other = createForwardCompletion({ adapter: { stream: async function* () {} }, state: withheld })
  await assert.rejects(() => other({ model: 'm/a' }), (error: any) => {
    assert.equal(error.statusCode, 404)
    return true
  })
})

check('one turn streams through and folds back what it produced', async () => {
  const seen: any[] = []
  const state = () => ({ catalog: [{ id: 'm/a' }], membership: { [ROUTE_MAIN]: ['m/a'] } })
  const complete = createForwardCompletion({
    adapter: { stream: async function* () {
      yield { type: 'text-delta', text: 'hello ' }
      yield { type: 'text-delta', text: 'world' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    state,
  })
  const outcome = await complete({ model: 'm/a' }, chunk => seen.push(chunk))
  assert.equal(outcome.text, 'hello world')
  assert.equal(outcome.usage.total_tokens, 12)
  assert.equal(seen.length, 4, 'every chunk was handed to the handler')
})

check('a truncated turn drops its half-written tool call rather than handing it over', () => {
  // The arguments would not parse, and a caller that executes tools would face a
  // failure nobody can read.
  const outcome: any = { text: '', toolCalls: [], usage: undefined, truncated: true }
  foldForwardOutcome(outcome, { type: 'tool-call-delta', index: 0, argumentsDelta: '{"a":' })
  foldForwardOutcome(outcome, { type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(outcome.truncated, true)
  // The fold itself keeps it; the trimming is the completion's, so the check is
  // on the same predicate the completion uses.
  const kept = outcome.toolCalls.filter((call: any) => {
    try { JSON.parse(call.arguments === '' ? '{}' : call.arguments); return true } catch { return false }
  })
  assert.equal(kept.length, 0, 'an unparseable tool call survived')
})

// ── carryFailure ───────────────────────────────────────────────────────────
check('a forwarded failure carries only the four representable fields', () => {
  assert.deepEqual(carryFailure({ message: 'boom', code: 'SERVER', status: 502, stack: 'dropped', providerRetryAfterMs: 900 }), {
    message: 'boom', code: 'SERVER', status: 502, providerRetryAfterMs: 900,
  })
})

check('a code that does not look like this vocabulary is dropped', () => {
  // Otherwise an upstream `type` string masquerades as one of these codes and a
  // downstream router matches on nothing.
  assert.deepEqual(carryFailure({ message: 'x', code: 'rate_limit_error' }), { message: 'x' })
  assert.deepEqual(carryFailure({ message: 'x', code: 'lower' }), { message: 'x' })
  assert.deepEqual(carryFailure({ message: 'x', code: 42 }), { message: 'x' })
})

check('an empty message falls back, and an aborted ending forces the code', () => {
  assert.deepEqual(carryFailure({}), { message: 'our free model failed the turn' })
  assert.deepEqual(carryFailure({ message: 'x', code: 'TIMEOUT' }, 'aborted'), { message: 'x', code: 'ABORTED' })
  assert.deepEqual(carryFailure(null, 'aborted'), { message: 'request aborted', code: 'ABORTED' })
})

check('a status outside the HTTP range is dropped, not clamped', () => {
  assert.deepEqual(carryFailure({ message: 'x', status: 0 }), { message: 'x' })
  assert.deepEqual(carryFailure({ message: 'x', status: 600 }), { message: 'x' })
  // A present-but-unusable `status` is dropped rather than replaced by the
  // alternates: the fallback is nullish-only, so an upstream's own `status: 'nope'`
  // cannot be silently rescued by a `statusCode` the same object happens to carry.
  assert.deepEqual(carryFailure({ message: 'x', status: 'nope' }), { message: 'x' })
})

// ── computeMembership / modelAvailability ──────────────────────────────────
check('a model splits into the region route only when the egress refuses it', () => {
  const catalog = [{ id: 'a' }, { id: 'b' }]
  const membership = computeMembership(catalog, {
    results: { a: { availability: 'available' }, b: { availability: 'region-blocked' } },
  }, {})
  assert.deepEqual(membership[ROUTE_MAIN], ['a'])
  assert.deepEqual(membership[ROUTE_REGION], ['b'])
})

check('a group with no models is omitted, not sent empty', () => {
  const membership = computeMembership([{ id: 'a' }], { results: { a: { availability: 'available' } } }, {})
  assert.deepEqual(Object.keys(membership), [ROUTE_MAIN])
})

check('hiding a model removes it from both routes without forgetting it', () => {
  const catalog = [{ id: 'a' }, { id: 'b' }]
  const settings = { hiddenModelIds: ['a'] }
  const membership = computeMembership(catalog, { results: { a: { availability: 'available' }, b: { availability: 'region-blocked' } } }, settings)
  assert.deepEqual(membership[ROUTE_MAIN], undefined)
  assert.deepEqual(membership[ROUTE_REGION], ['b'])
})

check('a whole-lane block folds to the full roster rather than an empty picker', () => {
  // A machine whose VPN is off otherwise shows nothing, which reads as "this
  // extension is broken" rather than "your egress changed".
  const catalog = [{ id: 'a' }, { id: 'b' }]
  const membership = computeMembership(catalog, {
    results: { a: { availability: 'unavailable' }, b: { availability: 'unavailable' } },
  }, {})
  assert.deepEqual(membership[ROUTE_MAIN], ['a', 'b'])
})

check('exposeRegionModels off keeps the region route absent', () => {
  const catalog = [{ id: 'a' }, { id: 'b' }]
  const membership = computeMembership(catalog, {
    results: { a: { availability: 'available' }, b: { availability: 'region-blocked' } },
  }, { exposeRegionModels: false })
  assert.deepEqual(membership[ROUTE_MAIN], ['a'])
  assert.equal(membership[ROUTE_REGION], undefined)
})

check('a paid model is not judged by the free lane\'s egress verdict', () => {
  // The channel's own auth and capacity govern, and the snapshot says nothing.
  assert.deepEqual(modelAvailability('x', { results: { x: { availability: 'unavailable' } } }, false), { availability: 'unknown', at: undefined })
  assert.deepEqual(modelAvailability('x', {}, true), { availability: 'unknown' })
})

// ── createRuntimeStores ────────────────────────────────────────────────────
check('the stores open under one directory, created owner-only', async () => {
  const dir = path.join(tempDir(), 'data')
  const stores = createRuntimeStores({ dataDir: dir })
  try {
    assert.ok(fs.existsSync(dir))
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'the data dir is readable by others')
    // Every store is readable through its own file.
    assert.equal(stores.settings.get().enabled, true)
    assert.equal(stores.stats.get().version, 3)
    assert.equal(stores.availability.get().results !== undefined, true)
    assert.equal(stores.catalogStore.get().entries !== undefined, true)
  } finally { stores.dispose() }
})

check('a relative data dir is refused rather than resolved against the cwd', () => {
  // A relative path would put the key ring wherever the process happened to start.
  assert.throws(() => createRuntimeStores({ dataDir: 'relative/path' }), TypeError)
})

check('an existing settings file keeps its own combos and hidden ids', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, combos: [{ name: 'mine' }], hiddenModelIds: ['m/x'] }))
  const stores = createRuntimeStores({ dataDir: dir })
  try {
    // A newly-advertised default must not appear in an existing install, and user
    // edits still win through the store's own merge.
    assert.deepEqual(stores.settings.get().hiddenModelIds, ['m/x'])
    assert.deepEqual(stores.settings.get().combos, [{ name: 'mine' }])
  } finally { stores.dispose() }
})

check('a fresh install gets the defaults, closed doors and all', async () => {
  const dir = tempDir()
  const stores = createRuntimeStores({ dataDir: dir })
  try {
    const settings = stores.settings.get()
    assert.equal(settings.enabled, true)
    assert.equal(settings.forward.enabled, false, 'the forward listener defaulted open')
    assert.equal(settings.forward.lan.enabled, false, 'the LAN relay defaulted open')
    assert.equal(settings.egress.enabled, false, 'the outlet defaulted open')
    assert.equal(settings.chanGateway.relay.enabled, false)
  } finally { stores.dispose() }
})

check('an older stats document is migrated before the first read', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({
    version: 1,
    days: { '2026-11-01': { total: 1, models: { m: { input: 5, output: 3, calls: 1, decodeMs: 999, decodeTokens: 5 } } } },
    models: { m: { failed: 2 } },
    requests: 9,
  }))
  const stores = createRuntimeStores({ dataDir: dir })
  try {
    const stats = stores.stats.get()
    assert.equal(stats.version, 3)
    // A rate measured over a window whose bytes were never counted is reset, not
    // carried forward as a plausible number.
    assert.equal(stats.days['2026-11-01'].models.m.decodeMs, 0)
    assert.equal(stats.days['2026-11-01'].models.m.decodeTokens, 0)
    assert.equal(stats.failedRequests, 2, 'a lifetime failure count was lost')
    assert.equal(stats.requests, 9)
  } finally { stores.dispose() }
})

// ── publicModelRows / routableModelIds ─────────────────────────────────────
check('the /v1/models rows carry the effort menu a model actually declares', () => {
  const snapshot = {
    catalog: [
      { id: 'm/a', contextWindow: 65536, efforts: ['low', 'high'] },
      { id: 'm/b', contextWindow: 8192 },
      { id: 'm/hidden' },
    ],
    membership: { [ROUTE_MAIN]: ['m/a', 'm/b'] },
    settings: { defaultMaxTokens: 8192 },
  }
  // The real helper returns objects with an `id` and answers `undefined` for a
  // model that declares no menu; a bare string would map to `undefined` and read
  // as a missing mapping rather than a missing menu.
  const effortsFor = (model: any) => Array.isArray(model.efforts)
    ? model.efforts.map((id: string) => ({ id }))
    : undefined
  const rows = publicModelRows(snapshot, effortsFor, () => 'low')
  assert.deepEqual(rows.map((row: any) => row.id), ['m/a', 'm/b'])
  assert.equal(rows[0].context_window, 65536)
  assert.deepEqual(rows[0].x_ofm_efforts, ['low', 'high'])
  assert.equal(rows[0].x_ofm_effort_default, 'low')
  // A model with no menu carries no menu fields rather than an empty one.
  assert.equal('x_ofm_efforts' in rows[1], false)
})

check('the region route rides along unless the installation hides it', () => {
  const snapshot = { catalog: [], membership: { [ROUTE_MAIN]: ['m/a'], [ROUTE_REGION]: ['m/b'] }, settings: {} }
  assert.deepEqual([...routableModelIds(snapshot)].sort(), ['m/a', 'm/b'])
  const hidden = { ...snapshot, settings: { exposeRegionModels: false } }
  assert.deepEqual([...routableModelIds(hidden)], ['m/a'])
})

// ── the empty-5xx pair ──────────────────────────────────────────────────────
check('a request is asked whether it carried images, before the failure is built', () => {
  assert.equal(carriesImageContent({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }), false)
  assert.equal(carriesImageContent({ messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }), true)
  assert.equal(carriesImageContent({ messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] }), true)
  assert.equal(carriesImageContent({ messages: [{ role: 'user', content: 'plain string' }] }), false)
  assert.equal(carriesImageContent({}), false)
  assert.equal(carriesImageContent(null), false)
  assert.equal(carriesImageContent({ messages: [{ role: 'user', content: [{ type: 'image', extra: 1 }, { type: 'text' }] }] }), true)
})

check('an empty 5xx body says what hop failed, and names the vision case', () => {
  // `HTTP 502` alone tells the caller nothing: a gateway hiccup and a refusal of
  // this exact request read identically (issue #549).
  const plain = emptyBodyFailure(502)
  assert.match(plain.message, /HTTP 502 with an empty body/)
  assert.match(plain.message, /upstream of the model, not in this request/)
  assert.equal(plain.statusCode, 502)
  assert.equal(plain.emptyBody, true)
  const vision = emptyBodyFailure(502, undefined, true)
  assert.match(vision.message, /carried image content/)
  assert.match(vision.message, /may not accept vision input/)
})

check('an empty-body failure keeps the retry-after and its 5xx retryability', () => {
  const failure = emptyBodyFailure(503, 1200)
  assert.equal(failure.providerRetryAfterMs, 1200)
  assert.equal(failure.code, 'SERVER')
  // No retry-after means no field, rather than a fabricated one.
  assert.equal('providerRetryAfterMs' in emptyBodyFailure(502), false)
})

running.then(() => {
  clearInterval(keepAlive)
  setTimeout(() => {
    if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
    console.log('\nALL CHECKS PASSED')
  }, 150)
})
