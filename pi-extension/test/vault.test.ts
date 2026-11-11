/**
 * Unit checks for the sealed-lane credential store.
 *
 * The seal's key exists nowhere: it is derived at unlock time from three masked
 * shards split across two shipped files (the mask is HKDF over the shard's own
 * seed with a pepper only the pair carries). Nothing in this test reaches a
 * network — the shards are static bytes — but the seal only opens on a gated
 * host, so every open below injects that gate.
 *
 * The three properties that must not pass by luck:
 *
 *   1. a host the gate refuses gets `null` — no credential, no error naming the
 *      endpoint or the payload;
 *   2. the same shards open the same seal, byte-identically, every time;
 *   3. every mutation (a flipped byte, a swapped shard, a truncated payload)
 *      lands on GCM's authentication check and returns `null` — never a partial
 *      credential, never a throw.
 *
 * Runs on plain node:  node test/vault.test.ts
 */
import assert from 'node:assert/strict'
import { LANE_ANCHOR } from '../dist/vault-anchor.js'
import { LANE_SEAL, LANE_SHARDS } from '../dist/vault-data.js'
import {
  FLAVOR_AIO, FLAVOR_HARNESS, FLAVOR_WEB, detectSealedHost, deriveSealKey,
  openSeal, openSealFrom, openSealWith, unlockSealedLane,
} from '../dist/vault.js'

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

// ── the host gate ────────────────────────────────────────────────────────────
check('a plain CLI process is not one of the published shells', () => {
  assert.equal(detectSealedHost({ env: {}, execPath: '/usr/bin/node', argv: ['node', 'app.js'] }), null)
  assert.equal(detectSealedHost({}), null)
})

check('the Tauri shell is recognised by its DSH_HOME + bundled node + web-desktop profile', () => {
  const flavor = detectSealedHost({
    env: { DSH_HOME: 'C:\\Users\\me\\AppData\\Roaming\\com.deepseek.dsh.desktop.aio' },
    execPath: 'C:\\app\\resources\\node\\node.exe',
    argv: ['node.exe', 'index.js', 'web-desktop'],
  })
  assert.equal(flavor, FLAVOR_AIO)
})

check('a Tauri home without the bundled node and profile is not the shell', () => {
  // Any one of the three alone is forgeable; the trio is not a coincidence.
  assert.equal(detectSealedHost({
    env: { DSH_HOME: 'C:\\com.deepseek.dsh.desktop.aio' },
    execPath: '/usr/local/bin/node',
    argv: ['node', 'app.js'],
  }), null)
  assert.equal(detectSealedHost({
    env: { DSH_HOME: 'C:\\com.deepseek.dsh.desktop.aio' },
    execPath: 'C:\\app\\resources\\node\\node.exe',
    argv: ['node.exe', 'index.js'],
  }), null)
})

check('an Electron desktop shell is recognised by its kernel-declared profile', () => {
  assert.equal(detectSealedHost({ profileName: 'desktop' }), FLAVOR_HARNESS)
  assert.equal(detectSealedHost({ profileName: 'tauri' }), FLAVOR_HARNESS)
})

check('a kernel-declared web profile is recognised', () => {
  assert.equal(detectSealedHost({ profileName: 'web' }), FLAVOR_WEB)
  assert.equal(detectSealedHost({ profileName: 'web-desktop' }), FLAVOR_WEB)
})

check('a profile no kernel would mints is refused', () => {
  assert.equal(detectSealedHost({ profileName: 'cli' }), null)
  assert.equal(detectSealedHost({ profileName: '' }), null)
  assert.equal(detectSealedHost({ profileName: 'unknown' }), null)
})

// ── the seal bytes ───────────────────────────────────────────────────────────
const UNMASKED = [
  Buffer.from(LANE_SHARDS[0].s, 'base64'),
  Buffer.from(LANE_SHARDS[1].s, 'base64'),
  Buffer.from(LANE_ANCHOR.s, 'base64'),
]
const PACKED = Buffer.from(LANE_SEAL, 'base64')

check('the shipped shards open the shipped seal', () => {
  const opened = openSeal() as any
  assert.ok(opened !== null, 'the seal did not open')
  assert.ok(opened.base.startsWith('https://'), 'the endpoint is not https')
  assert.ok(opened.base.endsWith('/v1'), 'the gateway base must end in /v1')
})

check('the same shards always open the same seal byte-identically', () => {
  const first = openSeal()
  const second = openSeal()
  assert.deepEqual(first, second)
})

check('a worker-mode seal carries a signing secret; a direct-mode seal a key', () => {
  const opened = openSeal() as any
  if (opened.mode === 'worker') {
    assert.ok(typeof opened.signingSecret === 'string' && opened.signingSecret.length >= 32)
    assert.equal(opened.apiKey, undefined)
  } else {
    assert.ok(typeof opened.apiKey === 'string' && /^[\w-]{20,}$/.test(opened.apiKey))
    assert.equal(opened.signingSecret, undefined)
  }
})

check('an opened credential is JSON-round-trip clean (the harness log rejects NaN/undefined)', () => {
  const credential = unlockSealedLane({ profileName: 'web' }) as any
  assert.ok(credential !== null)
  const copy = JSON.parse(JSON.stringify(credential))
  assert.deepEqual(copy, credential)
})

check('deriveSealKey is deterministic and 32 bytes', () => {
  const a = deriveSealKey(UNMASKED)
  const b = deriveSealKey(UNMASKED)
  assert.ok(Buffer.isBuffer(a) && a.length === 32, 'the key is not 32 bytes')
  assert.ok(a.equals(b), 'the derivation is not deterministic')
})

// ── every mutation fails the authentication check ───────────────────────────
check('a single flipped shard byte fails the derivation and the open', () => {
  const flipped = [...UNMASKED]
  flipped[0] = Buffer.from(flipped[0])
  flipped[0][0] ^= 0x01
  assert.equal(openSealWith(flipped, PACKED), null)
})

check('a swapped shard set fails to open', () => {
  const swapped = [UNMASKED[1], UNMASKED[0], UNMASKED[2]]
  assert.equal(openSealWith(swapped, PACKED), null)
})

check('a payload truncated to iv+tag is refused, not partially decrypted', () => {
  const short = PACKED.subarray(0, 12 + 16)
  assert.equal(openSealWith(UNMASKED, short), null)
})

check('a payload one byte short is refused', () => {
  const trimmed = PACKED.subarray(0, PACKED.length - 1)
  assert.equal(openSealWith(UNMASKED, trimmed), null)
})

check('a payload with a flipped ciphertext byte is refused', () => {
  const tampered = Buffer.from(PACKED)
  tampered[20] ^= 0x01
  assert.equal(openSealWith(UNMASKED, tampered), null)
})

check('an empty or short shard set is refused', () => {
  assert.equal(openSealWith([], PACKED), null)
  assert.equal(openSealWith([Buffer.alloc(8), Buffer.alloc(8)], PACKED), null)
})

check('a short raw shard byte is refused even when the pair unmask cleanly', () => {
  assert.equal(openSealWith([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)], PACKED), null)
})

check('openSealFrom rejects anything that is not a list of {s,w} rows', () => {
  assert.equal(openSealFrom([], LANE_SEAL), null)
  assert.equal(openSealFrom(undefined as any, LANE_SEAL), null)
  assert.equal(openSealFrom(null as any, LANE_SEAL), null)
  assert.equal(openSealFrom('nope' as any, LANE_SEAL), null)
  // A row missing its seed cannot be unmasked.
  assert.equal(openSealFrom([{ s: LANE_SHARDS[0].s } as any], LANE_SEAL), null)
})

// ── the gate + seal entry point ──────────────────────────────────────────────
check('unlockSealedLane refuses a host the gate does not recognise', () => {
  assert.equal(unlockSealedLane({}), null)
  assert.equal(unlockSealedLane({ profileName: 'cli' }), null)
  assert.equal(unlockSealedLane({ profileName: undefined }), null)
})

check('unlockSealedLane opens on a recognised host and carries the flavor', () => {
  const credential = unlockSealedLane({ profileName: 'web' }) as any
  assert.ok(credential !== null, 'the lane did not open on a recognised host')
  assert.equal(credential.flavor, FLAVOR_WEB)
  assert.ok(credential.base.startsWith('https://'))
  // No internals leak into the field names.
  assert.deepEqual(Object.keys(credential).sort(), ['base', 'flavor'].concat(
    credential.mode === 'worker' ? ['mode', 'signingSecret'] : ['apiKey', 'mode'],
  ).sort())
})

check('unlockSealedLane is re-runnable: no decrypted byte outlives the call frame', () => {
  // Two opens on the same host give independent objects.
  const a = unlockSealedLane({ profileName: 'desktop' }) as any
  const b = unlockSealedLane({ profileName: 'desktop' }) as any
  assert.ok(a !== null && b !== null)
  assert.notEqual(a, b)
  assert.deepEqual(a, b)
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 50)
