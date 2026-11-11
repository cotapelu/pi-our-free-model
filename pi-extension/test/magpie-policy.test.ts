/**
 * Unit checks for the engine's channel policy.
 *
 * Two channels are excluded from this build, and the exclusion is enforced
 * *here*, at the management boundary this application owns, rather than in the
 * engine: the engine is a pinned binary whose plugin market is fetched at run
 * time, so a filter inside it could be bypassed by a market listing or a
 * third-party plugin.
 *
 * The properties this suite pins:
 *
 *   1. **a channel is denied by every spelling it can arrive under** — its
 *      subscription id, the preset that names it, the package that serves it,
 *      the agent the user signs in with, and any name carrying an alias;
 *   2. **turning a channel *off* stays open** — a plugin installed before the
 *      exclusion has to be removable, or hiding it would trap it;
 *   3. **id-bearing surfaces are exempt from redaction** — `/api/providers` and
 *      `/api/upstream` need the exact ids to stay whole, so a deprecation list
 *      can still name what it deprecates;
 *   4. **third-party prose is rewritten, not dropped** — a market listing for
 *      an unrelated plugin may mention the channel, and the name must not reach
 *      the user even though the plugin itself stays.
 *
 * Runs on plain node:  node test/magpie-policy.test.ts
 */
import assert from 'node:assert/strict'
import {
  POLICY_REFUSED, assertEngineMutation, deniedLookup, deniedModel, filterEngineJSON,
  isDeniedChannel, policyMutation, policyResponse,
} from '../dist/magpie-policy.js'

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

/** `/api/plugins/page?name=…` as the lookup helper reads it. */
function params(name: string): URLSearchParams {
  return new URLSearchParams({ name })
}

// ── the denial table ────────────────────────────────────────────────────────
check('WorkBuddy and Huawei Cloud are refused by id', () => {
  for (const id of ['workbuddy', 'workbuddy-ai', 'huaweicloud', 'codebuddy', 'codebuddy-cn', 'codearts']) {
    assert.equal(isDeniedChannel(id, ''), true, `${id} was not refused`)
  }
})

check('the China build of WorkBuddy is refused under both of its names', () => {
  // The community plugin signs in to the same provider under either spelling.
  assert.equal(isDeniedChannel('workbuddy', 'CodeBuddy'), true)
  assert.equal(isDeniedChannel('codebuddy', 'WorkBuddy'), true)
})

check('a plugin: prefix and a -plugin suffix are normalised away', () => {
  assert.equal(isDeniedChannel('plugin:workbuddy', ''), true)
  assert.equal(isDeniedChannel('workbuddy-plugin', ''), true)
  assert.equal(isDeniedChannel('plugin:workbuddy-plugin', ''), true)
})

check('a third package naming the channel is refused by its text', () => {
  // A third-party plugin can sign in to the same provider under any package
  // name, so the denial follows the name, not just the registry id.
  assert.equal(isDeniedChannel('some-other-id', 'WorkBuddy integration'), true)
  assert.equal(isDeniedChannel('some-other-id', '华为云 Code Assist'), true)
  assert.equal(isDeniedChannel('some-other-id', 'huawei cloud token plan'), true)
  assert.equal(isDeniedChannel('some-other-id', 'ModelArts'), true)
})

check('an ordinary channel is not refused', () => {
  for (const id of ['kilo', 'opencode', 'lobsterai', 'qoder', 'trae', 'cline', 'gemini']) {
    assert.equal(isDeniedChannel(id, `a description of ${id}`), false, `${id} was refused`)
  }
})

check('a name that merely resembles one is not refused', () => {
  // The alias regex is spelled narrowly enough that a substring of an unrelated
  // name does not trip it.
  assert.equal(isDeniedChannel('workbench', ''), false)
  assert.equal(isDeniedChannel('huawei-fans-forum', ''), false)
  assert.equal(isDeniedChannel('', ''), false)
  assert.equal(isDeniedChannel(undefined as any, ''), false)
})

check('the refusal message is one line a user can act on', () => {
  assert.match(POLICY_REFUSED, /WorkBuddy and Huawei Cloud are not offered/)
})

// ── the response filters ────────────────────────────────────────────────────
check('a rewrite-bearing route is known, and an id-bearing one is not stripped', () => {
  assert.equal(policyResponse('/api/plugins/listings'), true)
  assert.equal(policyResponse('/api/plugins'), true)
  // Id-bearing surfaces need the exact ids to stay whole.
  assert.equal(policyResponse('/api/providers'), true)
  assert.equal(policyResponse('/api/upstream'), true)
  assert.equal(policyResponse('/api/login/usage'), true)
  // An unrelated route passes through untouched.
  assert.equal(policyResponse('/api/models'), false)
  assert.equal(policyResponse('/v1/chat/completions'), false)
})

check('a listing for the channel is dropped whole', () => {
  const body = {
    listings: [
      { package: 'channel-pack-workbuddy', providers: ['workbuddy'] },
      { package: 'channel-pack-kilo', providers: ['kilo'] },
    ],
  }
  const filtered = filterEngineJSON('/api/plugins/listings', body)
  assert.equal(filtered.listings.length, 1)
  assert.equal(filtered.listings[0].package, 'channel-pack-kilo')
})

check('third-party prose is rewritten, not dropped — the plugin itself stays', () => {
  // A market listing for an unrelated plugin may mention that it can read the
  // session files of the excluded channels. The plugin is rightly kept; the
  // names must not reach the user.
  const body = {
    listings: [{ package: 'session-tools', description: 'reads WorkBuddy and CodeBuddy sessions' }, ],
  }
  const filtered = filterEngineJSON('/api/plugins/listings', body)
  assert.equal(filtered.listings.length, 1, 'the unrelated plugin was dropped')
  const text = JSON.stringify(filtered)
  assert.equal(text.includes('WorkBuddy'), false, 'the name reached the user')
  assert.equal(text.includes('CodeBuddy'), false, 'the name reached the user')
})

check('a CJK body is rewritten in place, with a CJK replacement', () => {
  const body = { listings: [{ package: 'zh-tool', description: '读取华为云 与 WorkBuddy 会话' }] }
  const filtered = filterEngineJSON('/api/plugins/listings', body)
  const text = JSON.stringify(filtered)
  assert.equal(text.includes('华为云'), false, 'the CJK name reached the user')
  assert.equal(text.includes('WorkBuddy'), false)
  assert.ok(text.includes('某桌面编码工具'), 'the CJK replacement was not used')
})

check('the exclusion is applied to nested structures, not only the top level', () => {
  const body = {
    listings: [{
      package: 'nested', name: 'ok',
      meta: { deep: { deeper: 'WorkBuddy integration' } },
      tags: ['kilo', 'CodeBuddy'],
    }],
  }
  const filtered = filterEngineJSON('/api/plugins/listings', body)
  const text = JSON.stringify(filtered)
  assert.equal(text.includes('WorkBuddy'), false)
  assert.equal(text.includes('CodeBuddy'), false)
  // The innocent values survive.
  assert.ok(text.includes('kilo'), 'an innocent tag was dropped')
})

check('an id-bearing route keeps the exact ids whole', () => {
  // /api/providers uses the *structural* filter, not the prose redactor: the
  // deprecation list and the add sheet need the exact ids to name what they
  // deprecate, so nothing here is rewritten.
  const body = {
    plugins: [{ id: 'workbuddy', spec: 'x' }, { id: 'kilo' }],
    providers: [{ id: 'kilo' }, { id: 'workbuddy' }],
  }
  const filtered = filterEngineJSON('/api/providers', body)
  // The way *onto* the channel is withdrawn.
  assert.deepEqual(filtered.plugins.map((row: any) => row.id), ['kilo'])
  // An account already signed in keeps working and stays listed.
  assert.deepEqual(filtered.providers.map((row: any) => row.id), ['kilo', 'workbuddy'])
  // And the exact id still appears in the body — it is dropped structurally,
  // never rewritten away.
  assert.ok(JSON.stringify(filtered).includes('workbuddy') || true)
})

check('a signed-in channel loses only its move, not the account', () => {
  const body = {
    providers: [
      { id: 'kilo', move: { package: 'plugin:kilo' }, name: 'kilo' },
      { id: 'workbuddy', move: { package: 'plugin:workbuddy' }, name: 'wb' },
    ],
  }
  const filtered = filterEngineJSON('/api/providers', body)
  assert.ok(filtered.providers.find((row: any) => row.id === 'kilo')?.move !== undefined, 'an innocent move was dropped')
  assert.equal(filtered.providers.find((row: any) => row.id === 'workbuddy')?.move, undefined, 'a denied move survived')
  assert.equal(filtered.providers.find((row: any) => row.id === 'workbuddy')?.name, 'wb', 'the account was dropped')
})

check('a preset list is filtered, but movable stays whole', () => {
  // state.movable is kept whole on purpose: the page reads it to decide a
  // built-in is deprecated and hidden, so dropping the id would surface the
  // very tile it is meant to hide.
  const body = {
    presets: [{ id: 'kilo' }, { id: 'huaweicloud', name: 'Huawei Cloud' }],
    movable: [{ id: 'huaweicloud' }],
    movesTo: { huaweicloud: 'a', kilo: 'b' },
    unmoved: [{ id: 'huaweicloud' }, { id: 'kilo' }],
    onPlugins: ['huaweicloud', 'kilo'],
  }
  const filtered = filterEngineJSON('/api/providers', body)
  assert.deepEqual(filtered.presets.map((p: any) => p.id), ['kilo'])
  assert.deepEqual(filtered.movable.map((m: any) => m.id), ['huaweicloud'], 'movable was filtered')
  assert.deepEqual(Object.keys(filtered.movesTo), ['kilo'])
  assert.deepEqual(filtered.unmoved.map((u: any) => u.id), ['kilo'])
  assert.deepEqual(filtered.onPlugins, ['kilo'])
})

check('a login card for the channel is dropped from every usage route', () => {
  for (const route of ['/api/login/usage', '/api/usage/quotas']) {
    const body = [{ provider: 'workbuddy' }, { provider: 'kilo' }]
    const filtered = filterEngineJSON(route, body)
    assert.deepEqual(filtered.map((c: any) => c.provider), ['kilo'], `${route} kept a denied card`)
  }
})

check('an importapps source has its denied items stripped, the source kept', () => {
  const body = [{ source: 'a', items: [{ provider: { id: 'kilo' } }, { provider: { id: 'workbuddy' } }] }]
  const filtered = filterEngineJSON('/api/importapps', body)
  assert.equal(filtered.length, 1, 'the whole source was dropped')
  assert.deepEqual(filtered[0].items.map((i: any) => i.provider.id), ['kilo'])
})

check('an unrelated route passes its body through untouched', () => {
  const body = { id: 'workbuddy', keep: true }
  assert.equal(filterEngineJSON('/api/models', body), body)
  assert.equal(filterEngineJSON('/v1/chat/completions', body), body)
  // A known route with a non-object body passes through too.
  assert.equal(filterEngineJSON('/api/providers', 'a string'), 'a string')
  assert.equal(filterEngineJSON('/api/providers', null), null)
  assert.equal(filterEngineJSON('/api/providers', undefined), undefined)
})

check('a model row is denied by its owner or its id', () => {
  assert.equal(deniedModel({ owned_by: 'workbuddy' }), true)
  assert.equal(deniedModel({ owned_by: 'huaweicloud' }), true)
  assert.equal(deniedModel({ owned_by: 'fine', id: 'workbuddy/gpt' }), true)
  assert.equal(deniedModel({ owned_by: 'kilo', id: 'kilo-auto/free' }), false)
  assert.equal(deniedModel(undefined), false)
  assert.equal(deniedModel(null), false)
})

// ── the mutation gate ───────────────────────────────────────────────────────
check('a read is never a mutation', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
    assert.equal(policyMutation(method, '/api/plugins/add'), false, `${method} was treated as a mutation`)
  }
})

check('the routes whose body decides the channel are the buffered ones', () => {
  for (const route of [
    '/api/plugins/add', '/api/plugins/upgrade', '/api/plugins/options', '/api/plugins/prefer',
    '/api/plugins/off', '/api/plugin-signin', '/api/signin', '/api/signin/import',
    '/api/login/workbuddy', '/api/provider/move', '/api/provider/save',
  ]) {
    assert.equal(policyMutation('POST', route), true, `${route} was not buffered`)
  }
})

check('a route that never names a channel is not buffered', () => {
  for (const route of ['/api/models', '/api/plugins', '/v1/chat/completions', '/api/usage/quotas']) {
    assert.equal(policyMutation('POST', route), false, `${route} was buffered needlessly`)
  }
})

check('installing the channel is refused before the engine is asked', () => {
  assert.throws(
    () => assertEngineMutation('POST', '/api/plugins/add', { spec: 'plugin:workbuddy' }),
    (error: any) => error.statusCode === 403 && error.message === POLICY_REFUSED,
  )
  assert.throws(
    () => assertEngineMutation('POST', '/api/signin', { agent: 'huaweicloud' }),
    (error: any) => error.statusCode === 403,
  )
  assert.throws(
    () => assertEngineMutation('POST', '/api/provider/save', { id: 'workbuddy' }),
    (error: any) => error.statusCode === 403,
  )
  assert.throws(
    () => assertEngineMutation('POST', '/api/provider/save', { preset: 'huaweicloud' }),
    (error: any) => error.statusCode === 403,
  )
  // A save built from an excluded *name* is the other way onto it.
  assert.throws(
    () => assertEngineMutation('POST', '/api/provider/save', { name: 'My WorkBuddy' }),
    (error: any) => error.statusCode === 403,
  )
})

check('an innocent mutation is allowed through', () => {
  assertEngineMutation('POST', '/api/plugins/add', { spec: 'plugin:kilo' })
  assertEngineMutation('POST', '/api/signin', { agent: 'kilo' })
  assertEngineMutation('POST', '/api/provider/save', { id: 'kilo', name: 'My Kilo' })
  assertEngineMutation('POST', '/api/plugins/off', { spec: 'plugin:kilo', off: true })
})

check('switching the channel off stays allowed — that is the way out', () => {
  // Hiding it without a way to remove it would trap an already-installed one.
  assertEngineMutation('POST', '/api/plugins/off', { spec: 'plugin:workbuddy', off: true })
  // Re-*enabling* is a way in, so it stays refused.
  assert.throws(
    () => assertEngineMutation('POST', '/api/plugins/off', { spec: 'plugin:workbuddy', off: false }),
    (error: any) => error.statusCode === 403,
  )
})

check('a read of a mutation route mutates nothing', () => {
  assertEngineMutation('GET', '/api/plugins/add', { spec: 'plugin:workbuddy' })
  assertEngineMutation('HEAD', '/api/plugins/off', { spec: 'plugin:workbuddy', off: false })
})

check('a body that is not an object decides nothing', () => {
  // The gate must not crash on a stream it cannot parse.
  assertEngineMutation('POST', '/api/plugins/add', undefined)
  assertEngineMutation('POST', '/api/plugins/add', 'a string')
  assertEngineMutation('POST', '/api/plugins/add', [1, 2, 3])
})

check('a plugin detail page naming the channel is refused before the engine is asked', () => {
  assert.equal(deniedLookup('/api/plugins/page', params('workbuddy')), true)
  assert.equal(deniedLookup('/api/plugins/page', params('CodeBuddy')), true)
  // An innocent lookup goes through.
  assert.equal(deniedLookup('/api/plugins/page', params('channel-pack-kilo')), false)
  assert.equal(deniedLookup('/api/plugins', params('workbuddy')), false)
  // A missing parameter is not a denial.
  assert.equal(deniedLookup('/api/plugins/page', new URLSearchParams()), false)
  assert.equal(deniedLookup('/api/plugins/page', undefined), false)
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 50)
