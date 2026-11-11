/**
 * Unit checks for the attribution seam.
 *
 * The property being pinned is that **attribution is always present**. A request
 * with no User-Agent is a request the upstream can freely refuse, so a host
 * helper that is missing, misshapen or throwing must degrade to a literal rather
 * than to nothing.
 *
 * Runs on plain node:  node test/attribution.test.ts
 */
import assert from 'node:assert/strict'
import { FALLBACK_ATTRIBUTION, resolveAttributionUserAgent, userAgentWith } from '../dist/attribution.js'

let failures = 0
const keepAlive = setInterval(() => {}, 500)
const check = (label: string, fn: () => Promise<void> | void) => {
  const run = async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  }
  run()
}

const drop = () => { clearInterval(keepAlive) }

check('a host helper\'s own User-Agent is used, verbatim', async () => {
  const agent = await resolveAttributionUserAgent({
    load: async () => ({ attributionHeaders: () => ({ 'user-agent': 'host/1.2.3' }) }),
  })
  assert.equal(agent, 'host/1.2.3')
  // Both spellings, because a host is not obliged to normalise its own keys.
  const capitalised = await resolveAttributionUserAgent({
    load: async () => ({ attributionHeaders: () => ({ 'User-Agent': 'host/9.9.9' }) }),
  })
  assert.equal(capitalised, 'host/9.9.9')
})

check('an empty User-Agent from the helper falls back rather than sending nothing', async () => {
  for (const headers of [{ 'user-agent': '' }, {}, undefined, null]) {
    const agent = await resolveAttributionUserAgent({
      load: async () => ({ attributionHeaders: () => headers as any }),
    })
    assert.equal(agent, FALLBACK_ATTRIBUTION, `${JSON.stringify(headers)} sent nothing`)
  }
})

check('a host with no helper at all costs one argument', async () => {
  assert.equal(await resolveAttributionUserAgent(), FALLBACK_ATTRIBUTION)
  assert.equal(await resolveAttributionUserAgent({}), FALLBACK_ATTRIBUTION)
})

check('a throwing helper call degrades and logs the reason', async () => {
  const logged: string[] = []
  const agent = await resolveAttributionUserAgent({
    load: async () => ({ attributionHeaders: () => { throw new Error('kernel busy') } }),
    debug: message => logged.push(message),
  })
  assert.equal(agent, FALLBACK_ATTRIBUTION)
  assert.match(logged.join('\n'), /attribution helper unavailable/)
  assert.match(logged.join('\n'), /kernel busy/)
})

check('a failing module load degrades the same way', async () => {
  const agent = await resolveAttributionUserAgent({
    load: async () => { throw new Error('cannot resolve module') },
  })
  assert.equal(agent, FALLBACK_ATTRIBUTION)
})

check('the fallback names this provider, so an upstream can act on it', () => {
  assert.match(FALLBACK_ATTRIBUTION, /our-free-model/)
  // A URL, because "why this User-Agent" has to be answerable from the header.
  assert.match(FALLBACK_ATTRIBUTION, /https?:\/\//)
})

check('userAgentWith is the same rule at the call site', () => {
  assert.equal(userAgentWith('host/1.2.3'), 'host/1.2.3')
  // A missing or empty attribution is the *same* fallback, not an empty header.
  for (const value of [undefined, '', null as any]) {
    assert.equal(userAgentWith(value as any), FALLBACK_ATTRIBUTION, `${String(value)} sent nothing`)
  }
})

drop()
setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 150)
