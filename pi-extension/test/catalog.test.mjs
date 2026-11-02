/**
 * Unit checks for the catalog helpers the two lanes share.
 *
 * The numbers here are the difference between a turn that works and a 400: pi
 * must never be handed a thinking level the upstream does not declare, a context
 * window smaller than the lane actually serves, or a model whose row is served
 * on a wire this extension does not speak.
 *
 * Usage: node pi-extension/test/catalog.test.mjs
 */
import assert from 'node:assert/strict'
import {
  effortMap,
  isOpencodeFreeId,
  kiloEffortMap,
  kiloModel,
  opencodeModel,
  safeId,
  staticKiloModels,
  staticOpencodeModels,
  staticUpstreamIds,
  STATIC_KILO_MODELS,
} from '../catalog.js'

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failures += 1
  }
}

const OPENECODE_ROW = (id, extra = {}) => ({
  id,
  name: id,
  limit: { context: 200000, output: 32000 },
  modalities: { input: ['text'] },
  capabilities: { reasoning: { supported: true } },
  api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/openai/v1' } },
  ...extra,
})

check('effortMap keeps declared levels and nulls the rest', () => {
  const map = effortMap(['low', 'high', 'max'])
  assert.equal(map.low, 'low')
  assert.equal(map.high, 'high')
  assert.equal(map.max, 'max')
  assert.equal(map.xhigh, 'max', 'a `max` rung carries xhigh upward')
  assert.equal(map.medium, null)
  assert.equal(map.off, null, 'no `none` declared means no off rung')
})

check('effortMap honours a declared none rung and verbatim xhigh', () => {
  const map = effortMap(['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  assert.equal(map.off, 'none', 'the free lane\'s off value is its own `none`')
  assert.equal(map.minimal, 'minimal')
  assert.equal(map.xhigh, 'xhigh')
  assert.equal(map.max, 'xhigh', 'a model that declares xhigh but not max answers xhigh')
})

check('only -free ids are on the OpenCode pool', () => {
  assert.equal(isOpencodeFreeId('deepseek-v4.1-flash-free'), true)
  assert.equal(isOpencodeFreeId('beam-free'), true)
  assert.equal(isOpencodeFreeId('big-pickle'), true)
  assert.equal(isOpencodeFreeId('claude-sonnet-4-5'), false)
})

check('ids become wire-safe for pi addressing', () => {
  assert.equal(safeId('kilo-auto/free'), 'kilo-auto-free')
  assert.equal(safeId('nvidia/nemotron-3.5-super-vl:free'), 'nvidia-nemotron-3.5-super-vl-free')
  assert.equal(safeId('beam-free'), 'beam-free')
})

check('measured capacities win over the listing floor', () => {
  const model = opencodeModel(OPENECODE_ROW('deepseek-v4.1-flash-free', { modalities: { input: ['text', 'image/png'] } }))
  assert.equal(model.contextWindow, 1048576, 'the served window, not the published 200000')
  assert.equal(model.maxTokens, 384000, 'the served output ceiling, not 32000')
  assert.deepEqual(model.input, ['text', 'image'])
})

check('a model without a declared menu gets no reasoning levels', () => {
  const model = opencodeModel(OPENECODE_ROW('mimo-v2.6-flash-free', { modalities: { input: ['text', 'image/png'] } }))
  assert.equal(model.reasoning, false, 'sending an undeclared effort would be a 400')
  assert.equal(model.thinkingLevelMap, undefined)
})

check('rows served on another wire are skipped, not mis-sent', () => {
  assert.equal(opencodeModel(OPENECODE_ROW('union-alpha', { api: { messages: {} } })), null, 'Anthropic-wire row')
  assert.equal(opencodeModel(OPENECODE_ROW('muse-spark-1.3-contributor-free', { api: { responses: {} } })), null, 'Responses-wire row')
  assert.equal(opencodeModel(OPENECODE_ROW('claude-sonnet-4-5')), null, 'paid row')
})

check('a chat row carries its own declared base url', () => {
  const model = opencodeModel(OPENECODE_ROW('beam-free'))
  assert.equal(model.baseUrl, 'https://opencode.ai/inference/openai/v1')
})

check('kilo rows map with the gateway compat and effort object map', () => {
  const model = kiloModel({
    id: 'reflection/beam-free',
    name: 'Beam Free',
    isFree: true,
    context_length: 1048576,
    top_provider: { max_completion_tokens: 131072 },
    architecture: { input_modalities: ['text'] },
    supported_parameters: ['max_tokens', 'tools', 'reasoning', 'include_reasoning'],
  })
  assert.equal(model.id, 'reflection-beam-free')
  assert.equal(model.reasoning, true)
  assert.equal(model.thinkingLevelMap.off, 'off', 'off rides a sentinel the wire layer translates')
  assert.equal(model.thinkingLevelMap.high, 'high')
  assert.equal(model.thinkingLevelMap.max, null)
  assert.equal(model.compat.supportsStore, false)
  assert.equal(model.compat.maxTokensField, 'max_tokens')
})

check('kilo families that cannot switch thinking off have no off rung', () => {
  const mandatory = kiloEffortMap({ id: 'liquid/lfm-2.5-2.6b:free', supported_parameters: ['reasoning'] })
  assert.equal(mandatory.off, null, 'the endpoint answers 400 to an off request')
  const router = kiloEffortMap({ id: 'kilo-auto/free', supported_parameters: ['reasoning'] })
  assert.equal(router.off, null, 'the auto-routers think anyway')
  const normal = kiloEffortMap({ id: 'nvidia/nemotron:free', supported_parameters: ['reasoning'] })
  assert.equal(normal.off, 'off')
  assert.equal(kiloEffortMap({ id: 'nvidia/x:free', supported_parameters: ['max_tokens'] }), undefined, 'no reasoning param means no menu')
})

check('non-free Kilo rows are dropped', () => {
  assert.equal(kiloModel({ id: 'anthropic/claude-opus', isFree: false }), null)
})

check('the offline snapshot covers the id the lane serves without a -free suffix', () => {
  const ids = staticOpencodeModels().map((model) => model.id)
  assert.ok(ids.includes('big-pickle'), 'the lane\'s anonymous id is on the snapshot')
  const pickle = staticOpencodeModels().find((model) => model.id === 'big-pickle')
  assert.equal(pickle.contextWindow, 262144)
  assert.equal(pickle.maxTokens, 131072)
  assert.deepEqual(pickle.input, ['text', 'image'])
  assert.equal(pickle.reasoning, false, 'it declares no thinking menu')
})

check('every snapshot id is a live-mappable free id', () => {
  // A snapshot id the live mapping would drop is a model that disappears the
  // moment the network answers — the reverify script reports that as drift.
  for (const model of staticOpencodeModels()) {
    assert.equal(isOpencodeFreeId(model.id), true, `${model.id} must read as free`)
  }
})

check('every snapshot id carries the wire id it must be sent as', () => {
  const map = staticUpstreamIds()
  assert.equal(map.size, STATIC_KILO_MODELS.length, 'one wire id per snapshot row')
  for (const [safe, wire] of map) {
    assert.equal(safeId(wire), safe, `${wire} must sanitize to ${safe}`)
    assert.ok(wire.includes('/') || wire.includes(':'), `${wire} must be the upstream's own spelling`)
  }
  assert.equal(map.get('reflection-beam-free'), 'reflection/beam-free')
})

check('offline snapshots are non-empty and carry measured numbers', () => {
  assert.ok(staticOpencodeModels().length >= 5)
  assert.ok(staticKiloModels().length >= 10)
  const deepseek = staticOpencodeModels().find((model) => model.id === 'deepseek-v4.1-flash-free')
  assert.equal(deepseek.contextWindow, 1048576)
  assert.equal(deepseek.maxTokens, 384000)
  assert.equal(deepseek.thinkingLevelMap.off, 'none')
  const mimo = staticOpencodeModels().find((model) => model.id === 'mimo-v2.6-flash-free')
  assert.equal(mimo.maxTokens, 131072)
  assert.equal(mimo.reasoning, false)
  const router = staticKiloModels().find((model) => model.id === 'kilo-auto-free')
  assert.equal(router.thinkingLevelMap.off, null, 'the auto router has no off rung to offer')
  const normal = staticKiloModels().find((model) => model.id === 'reflection-beam-free')
  assert.equal(normal.thinkingLevelMap.off, 'off', 'a normal free row keeps the off rung')
  for (const model of staticKiloModels()) {
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  }
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
