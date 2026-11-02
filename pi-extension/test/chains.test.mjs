/**
 * Unit checks for the fallback-chain routing state machine.
 *
 * pi omits `request.failed` on the automatic-retry path and durably removes a
 * failed attempt from the projection, so the chain infers the failure from
 * router state plus `previous` (the last model that produced a successful
 * answer). These checks pin that inference, the walk cap, the round-robin
 * window, and the continuation rule that keeps prompt caches valid.
 *
 * Usage: node pi-extension/test/chains.test.mjs
 */
import assert from 'node:assert/strict'
import { chainId, chainByName, decideLink, intersectCapabilities, isAdvanceable, normalizeChains, CHAIN_PREFIX } from '../chains.js'

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

const CHAIN = (models, extra = {}) => ({ id: chainId('test'), name: 'Test', models, strategy: 'fallback', stickyLimit: 1, enabled: true, ...extra })
const model = (address, extra = {}) => {
  const [provider, id] = address.split('/')
  return { provider, id, contextWindow: 200000, maxTokens: 32000, input: ['text'], ...extra }
}
const addressOf = (model) => `${model.provider}/${model.id}`
const request = (extra) => ({ model: { provider: 'ofm-chain', id: 'test' }, thinkingLevel: 'off', reason: 'user', messages: [], ...extra })
/** State as the router leaves it after dispatching one link. */
const picked = (address, extra = {}) => ({ index: 0, cursor: 0, windowTurn: 0, turn: 0, walks: 0, ...extra, lastPick: address })

check('normalizeChains drops everything it cannot trust', () => {
  const chains = normalizeChains([
    null,
    { name: 'Good', models: ['ofm-kilo/a', 'ofm-kilo/b', 'ofm-kilo/a'] },
    { name: 'NoName', models: ['ofm-kilo/a'], id: `${CHAIN_PREFIX}explicit` },
    { name: 'BadLinks', models: ['no-slash', '', 'chain:self', 42] },
    { name: 'EmptyLinks', models: [] },
    { name: 'Typo', models: ['ofm-kilo/a'], strategy: 'round-robinn' },
    { name: 'Sticky', models: ['ofm-kilo/a', 'ofm-kilo/b'], strategy: 'round-robin', stickyLimit: 99 },
  ])
  assert.equal(chains.length, 4)
  assert.deepEqual(chains[0].models, ['ofm-kilo/a', 'ofm-kilo/b'], 'duplicates and self-links dropped')
  assert.equal(chains[2].strategy, 'fallback', 'an unknown strategy falls back, not honoured')
  assert.equal(chains[3].stickyLimit, 16, 'stickyLimit is clamped')
})

check('chain ids are stable and url-safe', () => {
  assert.equal(chainId('My Fast Chain'), `${CHAIN_PREFIX}my-fast-chain`)
  assert.equal(chainId('My Fast Chain'), chainId('my   fast--chain'))
  assert.match(chainId('chuỗi tiếng việt'), /^chain:chu-i-ti-ng-vi-t-[0-9a-f]{8}$/, 'non-Latin names get a hash suffix so the id stays unique')
  assert.equal(chainId('   '), '')
})

check('chainByName matches id, derived id and display name', () => {
  const chains = normalizeChains([{ name: 'My Chain', models: ['ofm-kilo/a'] }])
  assert.equal(chainByName(chains, 'my-chain').name, 'My Chain')
  assert.equal(chainByName(chains, 'My Chain').id, `${CHAIN_PREFIX}my-chain`)
  assert.equal(chainByName(chains, 'nope'), undefined)
})

check('capacities are the intersection, never the union', () => {
  const limits = intersectCapabilities([
    model('ofm-kilo/a', { contextWindow: 1000000, maxTokens: 131072, input: ['text', 'image'] }),
    model('ofm-kilo/b', { contextWindow: 128000, maxTokens: 8192, input: ['text'] }),
  ])
  assert.equal(limits.contextWindow, 128000)
  assert.equal(limits.maxTokens, 8192)
  assert.deepEqual(limits.input, ['text'])
})

check('thinking levels are the intersection too', () => {
  const withMenu = { ...model('ofm-kilo/a'), thinkingLevelMap: { off: 'none', low: 'low', high: 'high', xhigh: 'max' } }
  const withoutMenu = { ...model('ofm-kilo/b') }
  const levels = intersectCapabilities([withMenu, withoutMenu]).thinkingLevels
  assert.deepEqual(levels, ['off'], 'a link without a menu narrows the chain to off')
})

check('a fallback chain starts at the head on a user turn', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const { index } = decideLink({ chain: CHAIN(['ofm-kilo/a', 'ofm-kilo/b']), members, request: request({ reason: 'user' }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/a')
})

check('a retry advances to the link after the one that failed', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const chain = CHAIN(['ofm-kilo/a', 'ofm-kilo/b'])
  const failed = { model: members[0], message: { stopReason: 'error', errorMessage: 'overloaded' } }
  const { index } = decideLink({ chain, members, request: request({ reason: 'retry', failed, state: picked('ofm-kilo/a', { index: 0 }) }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/b')
})

check('a retry advances from state when pi omits `failed`', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  // pi 1.4.0's automatic-retry path passes no `failed`, and `previous` is empty
  // because the failed attempt is skipped as a successful response.
  const { index } = decideLink({ chain: CHAIN(['ofm-kilo/a', 'ofm-kilo/b']), members, request: request({ reason: 'retry', state: picked('ofm-kilo/a', { index: 0 }) }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/b')
})

check('an overflow retry does not move the chain', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const failed = { model: members[0], message: { stopReason: 'error', errorMessage: 'context length exceeded' } }
  const { index } = decideLink({ chain: CHAIN(['ofm-kilo/a', 'ofm-kilo/b']), members, request: request({ reason: 'retry', failed, state: picked('ofm-kilo/a', { index: 0 }) }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/a', 'compaction owns the overflow, not the chain')
})

check('the transcript stands in when pi omits `previous`', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const chain = CHAIN(['ofm-kilo/a', 'ofm-kilo/b'])
  // A print-mode turn arrives with the previous answer only in the transcript.
  const messages = [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', provider: 'ofm-kilo', model: 'b', stopReason: 'stop', content: [] },
    { role: 'user', content: 'now' },
  ]
  const { index, state } = decideLink({ chain, members, request: request({ reason: 'user', state: picked('ofm-kilo/b', { index: 1, walks: 1 }), messages }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/a', 'the pick answered, so the walk resets and the chain returns to its head')
  assert.equal(state.walks, 0)
})

check('a continuation stays on the model that answered', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const previous = { model: members[1], thinkingLevel: 'off' }
  const { index } = decideLink({ chain: CHAIN(['ofm-kilo/a', 'ofm-kilo/b']), members, request: request({ reason: 'continuation', previous, state: picked('ofm-kilo/b', { index: 1, turn: 1 }) }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/b', 'the prompt cache and thinking signature stay valid')
})

check('the next user turn after a quota wall starts past the failed link', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const chain = CHAIN(['ofm-kilo/a', 'ofm-kilo/b'])
  // The turn pi would not retry: quota exhausted on link a, so no `previous`.
  const { index, state } = decideLink({ chain, members, request: request({ reason: 'user', state: picked('ofm-kilo/a', { index: 0 }) }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/b')
  assert.equal(state.walks, 1)
})

check('a successful turn leaves the fallback chain at its head', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const previous = { model: members[1], thinkingLevel: 'off' }
  const { index, state } = decideLink({ chain: CHAIN(['ofm-kilo/a', 'ofm-kilo/b']), members, request: request({ reason: 'user', previous, state: picked('ofm-kilo/b', { index: 1, turn: 3, walks: 1 }) }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/a')
  assert.equal(state.walks, 0, 'the success resets the failure walk')
})

check('the walk is capped, so a dead chain holds instead of flapping', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const chain = CHAIN(['ofm-kilo/a', 'ofm-kilo/b'])
  // Both links have now failed inside one streak: the retry holds the last
  // link instead of wrapping back to the head.
  const { index } = decideLink({ chain, members, request: request({ reason: 'retry', state: picked('ofm-kilo/b', { index: 1, walks: 1 }) }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/b')
})

check('the next user turn applies the strategy again after an exhausted walk', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const chain = CHAIN(['ofm-kilo/a', 'ofm-kilo/b'])
  // A fresh user turn is a fresh attempt: a fallback chain starts at the head,
  // exactly as dsh's does.
  const { index } = decideLink({ chain, members, request: request({ reason: 'user', state: picked('ofm-kilo/b', { index: 1, walks: 1 }) }) })
  assert.equal(addressOf(members[index]), 'ofm-kilo/a')
})

check('round-robin rotates per sticky window', () => {
  const members = [model('ofm-kilo/a'), model('ofm-kilo/b')]
  const chain = CHAIN(['ofm-kilo/a', 'ofm-kilo/b'], { strategy: 'round-robin', stickyLimit: 2 })
  let state = { index: 0, cursor: 0, windowTurn: 0, turn: 0, walks: 0, lastPick: undefined }
  const picks = []
  for (let turn = 0; turn < 4; turn += 1) {
    const decision = decideLink({ chain, members, request: request({ reason: 'user', previous: { model: members[decision_of(state)] ?? members[0], thinkingLevel: 'off' }, state }) })
    state = decision.state
    picks.push(addressOf(members[decision.index]))
  }
  assert.deepEqual(picks, ['ofm-kilo/a', 'ofm-kilo/a', 'ofm-kilo/b', 'ofm-kilo/b'])
  function decision_of(inner) {
    return inner.index ?? 0
  }
})

check('a chain of one link never leaves it', () => {
  const members = [model('ofm-kilo/a')]
  const chain = CHAIN(['ofm-kilo/a'])
  const failed = { model: members[0], message: { stopReason: 'error', errorMessage: 'overloaded' } }
  const first = decideLink({ chain, members, request: request({ reason: 'retry', failed, state: picked('ofm-kilo/a', { index: 0 }) }) })
  assert.equal(addressOf(members[first.index]), 'ofm-kilo/a')
  const next = decideLink({ chain, members, request: request({ reason: 'user', state: { ...first.state } }) })
  assert.equal(addressOf(members[next.index]), 'ofm-kilo/a')
})

check('a context overflow does not advance the chain', () => {
  assert.equal(isAdvanceable({ stopReason: 'error', errorMessage: 'context length exceeded' }), false)
  assert.equal(isAdvanceable({ stopReason: 'error', errorMessage: 'context window overflow for this model' }), false)
  assert.equal(isAdvanceable({ stopReason: 'aborted' }), false)
  assert.equal(isAdvanceable({ stopReason: 'error', errorMessage: 'free quota for this egress is spent (429)' }), true)
  assert.equal(isAdvanceable({ stopReason: 'error', errorMessage: 'upstream blocks this model for this egress region (403)' }), true)
  assert.equal(isAdvanceable({ stopReason: 'error', errorMessage: 'HTTP 503' }), true)
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
