/**
 * Unit checks for the trust fence.
 *
 * The plugin's routes run *before* the connection service's own admission
 * check, so this fence is the only thing between a loopback port and a browser
 * on another origin. The properties this suite pins:
 *
 *   1. **a mounted Host service is authoritative, and a failure in it is 503,
 *      never bypass** — a fence that opens when its own check throws has
 *      switched the host's authentication off;
 *   2. **a missing service falls through to the replica**, it does not answer
 *      "admission unavailable" — that confusion is what turned every request
 *      into a 503 on hosts before dsh 0.1.7 (issue #89);
 *   3. the replica refuses DNS rebinding (a Host that is not loopback), a
 *      cross-site fetch, and an Origin/Referer whose authority does not match
 *      the Host;
 *   4. the desktop's `dsh-app://app` relay Referer is allowed, but only when
 *      the browser stripped both markers — it is not an Origin grant.
 *
 * Runs on plain node:  node test/trust.test.ts
 */
import assert from 'node:assert/strict'
import {
  DESKTOP_RELAY_REFERER, connectionAdmissionView, isLoopbackHost, rejectionFor, structuralRejection,
} from '../dist/trust.js'

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

/** A request as the fence reads it. */
function req(headers: Record<string, any>): any {
  return { headers }
}

// ── isLoopbackHost ──────────────────────────────────────────────────────────
check('a same-machine address is loopback', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.1:8080', ' http://127.0.0.1:8326 ']) {
    assert.equal(isLoopbackHost(host), true, `${host} was not loopback`)
  }
})

check('a routable address is not loopback, and that is the whole point', () => {
  // The lanes are keyed to this machine's egress and priced against whoever
  // shares it: binding one would hand the quota to the subnet.
  for (const host of ['0.0.0.0', '192.168.1.10', 'example.com', '10.0.0.1', '[::2]', 'fe80::1']) {
    assert.equal(isLoopbackHost(host), false, `${host} was treated as loopback`)
  }
})

check('a missing or malformed host is not loopback', () => {
  for (const host of ['', undefined as any, null as any, ':::', 'http://', 'not a host at all']) {
    assert.equal(isLoopbackHost(host), false, `${JSON.stringify(host)} was treated as loopback`)
  }
})

// ── the replica fence ───────────────────────────────────────────────────────
check('a loopback request with no browser markers passes the replica', () => {
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326' })), undefined)
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8326' }), undefined), undefined)
})

check('a Host that is not loopback is refused (DNS rebinding)', () => {
  assert.equal(structuralRejection(req({ host: 'evil.example' })), 403)
  assert.equal(structuralRejection(req({ host: '192.168.1.5:8326' })), 403)
  // The reason is fixed and names no caller-supplied string.
  let decision: any
  rejectionFor(req({ host: 'evil.example' }), undefined, (d) => { decision = d })
  assert.equal(decision.reason, 'host-not-loopback')
  assert.equal(decision.source, 'structural')
  assert.equal(decision.status, 403)
})

check('a missing Host is refused, not passed', () => {
  assert.equal(structuralRejection(req({})), 403)
  assert.equal(structuralRejection(req({ host: '' })), 403)
})

check('a cross-site fetch is refused', () => {
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', 'sec-fetch-site': 'cross-site' })), 403)
  // A same-site and a same-origin fetch are fine.
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', 'sec-fetch-site': 'same-site' })), undefined)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', 'sec-fetch-site': 'same-origin' })), undefined)
})

check('an Origin whose authority does not match the Host is refused', () => {
  // A different port, a different host and a different scheme are three
  // different refusals, each naming the header that carried it.
  let decision: any
  rejectionFor(req({ host: '127.0.0.1:8326', origin: 'http://127.0.0.1:9999' }), undefined, (d) => { decision = d })
  assert.equal(decision.status, 403)
  assert.equal(decision.reason, 'origin-mismatch')
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', origin: 'http://evil.example' })), 403)
  // The web server speaks plain http on a loopback bind: an Origin claiming
  // https is not this page.
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', origin: 'https://127.0.0.1:8326' })), 403)
})

check('an Origin that matches the Host passes', () => {
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', origin: 'http://127.0.0.1:8326' })), undefined)
  // A default port is filled in on both sides, so a matching pair still matches.
  assert.equal(structuralRejection(req({ host: '127.0.0.1', origin: 'http://127.0.0.1' })), undefined)
})

check('a Referer is checked the same way an Origin is', () => {
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: 'http://127.0.0.1:8326/settings' })), undefined)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: 'http://evil.example/x' })), 403)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: 'not a url' })), 403)
})

check('a Referer carrying a relative or empty value is ignored', () => {
  // An absent Referer is normal on a plain fetch, not a refusal.
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: '' })), undefined)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: '   ' })), undefined)
})

check('the desktop relay Referer is allowed only once the markers are stripped', () => {
  // Desktop forwardWebRequest strips Origin and sec-fetch-site before relaying
  // to loopback, and keeps this Referer. It is not an Origin grant.
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: DESKTOP_RELAY_REFERER })), undefined)
  // With either marker still present it is a browser that named two origins.
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: DESKTOP_RELAY_REFERER, origin: 'http://evil.example' })), 403)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: DESKTOP_RELAY_REFERER, 'sec-fetch-site': 'cross-site' })), 403)
})

check('only the owned application page counts as the desktop relay', () => {
  // An arbitrary custom protocol is not a grant.
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: 'myapp://evil' })), 403)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: 'dsh-app://evil' })), 403)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: 'dsh-app://app:8080/' })), 403)
  assert.equal(structuralRejection(req({ host: '127.0.0.1:8326', referer: 'dsh-app://user@app/' })), 403)
})

// ── a mounted Host service ──────────────────────────────────────────────────
check('a mounted service that admits is authoritative', () => {
  const service = { admit: () => undefined }
  assert.equal(rejectionFor(req({ host: 'evil.example' }), service), undefined,
    'the structural fence overrode a Host that admitted')
})

check('a mounted service that rejects is authoritative too', () => {
  const service = { admit: () => ({ rejection: 401 }) }
  let decision: any
  const status = rejectionFor(req({ host: '127.0.0.1:8326' }), service, (d) => { decision = d })
  assert.equal(status, 401)
  // The reason says the Host decided, not the replica.
  assert.equal(decision.source, 'connection')
  assert.equal(decision.reason, 'host-rejected')
})

check('a bare status return is read as a rejection, not as "no rejection"', () => {
  // Handed through bare, an object-shaped return reads as no rejection and
  // switches the host's authentication off.
  const view = connectionAdmissionView({ requestRejection: () => 401 })
  const status = rejectionFor(req({ host: '127.0.0.1:8326' }), view)
  assert.equal(status, 401)
})

check('a legacy service that refuses nothing is authoritative too', () => {
  // A mounted service's decision is the app's own admission (trust fence plus
  // browser-auth cookie); the replica exists only for compositions without
  // one. So a Host that says "admit" overrides the structural fence — which is
  // exactly why a *throwing* service answers 503 instead of falling through.
  const view = connectionAdmissionView({ requestRejection: () => undefined })
  assert.equal(rejectionFor(req({ host: 'evil.example' }), view), undefined)
})

check('a service published after load is read per request, not cached', () => {
  // The composition may publish `connection` long after plugins load, so the
  // view is late-binding: a thunk resolves it on each admission.
  let current: any = undefined
  const view = connectionAdmissionView(() => current)
  assert.equal(typeof view.admit, 'undefined', 'admit was memoised before the service existed')
  current = { admit: () => ({ rejection: 418 }) }
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8326' }), view), 418, 'the late service was not picked up')
})

check('an object-shaped return with no rejection field admits', () => {
  const service = { admit: () => ({ something: 'else' }) }
  assert.equal(rejectionFor(req({ host: 'evil.example' }), service), undefined, 'a rejection was invented')
})

check('a Host service that throws answers 503, it never bypasses authentication', () => {
  const service = { admit: () => { throw new Error('boom') } }
  let decision: any
  const status = rejectionFor(req({ host: '127.0.0.1:8326' }), service, (d) => { decision = d })
  assert.equal(status, 503)
  assert.equal(decision.reason, 'admission-error')
  // A throwing Host service must not open the fence.
  assert.equal(decision.source, 'connection')
})

check('a logger that throws cannot change the HTTP decision', () => {
  const service = { admit: () => ({ rejection: 401 }) }
  // Diagnostics are observational; a broken observer never widens the fence.
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8326' }), service, () => { throw new Error('logger down') }), 401)
})

check('a missing service falls through to the replica, not to a 503', () => {
  // That confusion is what turned every request into 503 admission unavailable
  // on hosts before dsh 0.1.7 (issue #89).
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8326' }), undefined), undefined)
  assert.equal(rejectionFor(req({ host: 'evil.example' }), undefined), 403)
  assert.equal(rejectionFor(req({ host: '127.0.0.1:8326' }), {}), undefined)
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 100)
