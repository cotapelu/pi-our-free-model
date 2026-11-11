/**
 * Unit checks for the engine payload restore.
 *
 * The engine binary is 68MB, so it ships as gzip parts under a signed manifest
 * and is restored on first use. What must not pass by luck is that *every* link
 * in that chain is verified, because a skipped one turns a corrupt restore into
 * a silently-wrong binary the plugin will then run:
 *
 *   - part size, then part sha256, then the concatenated sha256, then gzip,
 *     then the output size, then the output sha256 — each checked against the
 *     declared value, in order;
 *   - a failure at any link leaves the temp file removed and throws, so nothing
 *     half-restored is ever executed;
 *   - metadata that does not describe a restorable payload is refused *before*
 *     a byte is read.
 *
 * Every check builds its own payload in a temp dir, so nothing here reads the
 * real 9 parts (35MB) and none of it spends disk beyond the scratch.
 *
 * Runs on plain node:  node test/engine-payload.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { hasEnginePayload, materializeEngine } from '../dist/engine-payload.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

const sha256hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const PART_SIZE = 4096

/** One described payload laid out under a scratch pkgDir. */
function payload(over: {
  binary?: Buffer
  parts?: Buffer[]
  tamper?: { field: 'part.sha256' | 'compressed.sha256' | 'output.sha256' | 'part.size' | 'compressed.size' | 'outputSize' | 'parts.length'; value?: any }
  dropPart?: boolean
} = {}) {
  const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-'))
  const binary = over.binary ?? Buffer.concat([randomBytes(7000), Buffer.from('MAGPIE-BINARY')])
  const compressed = gzipSync(binary)
  // Split the compressed bytes into parts of exactly PART_SIZE.
  const parts: Buffer[] = over.parts ?? Array.from({ length: Math.ceil(compressed.length / PART_SIZE) }, (_, i) => compressed.subarray(i * PART_SIZE, (i + 1) * PART_SIZE))
  const partsDir = path.join(pkgDir, 'src', 'engine-parts')
  fs.mkdirSync(partsDir, { recursive: true })
  const partRows = parts.map((bytes, i) => {
    const file = path.join(partsDir, `win32-x64.${String(i).padStart(3, '0')}.part`)
    fs.writeFileSync(file, bytes)
    return { path: `src/engine-parts/win32-x64.${String(i).padStart(3, '0')}.part`, size: bytes.length, sha256: sha256hex(bytes) }
  })
  let entry: any = {
    sha256: sha256hex(binary),
    compressed: {
      algorithm: 'gzip', size: compressed.length, sha256: sha256hex(compressed),
      outputSize: binary.length, parts: partRows,
    },
  }
  if (over.tamper) {
    entry = JSON.parse(JSON.stringify(entry))
    const t = over.tamper
    if (t.field === 'part.sha256') entry.compressed.parts[0].sha256 = 'f'.repeat(64)
    if (t.field === 'compressed.sha256') entry.compressed.sha256 = 'f'.repeat(64)
    if (t.field === 'output.sha256') entry.sha256 = 'f'.repeat(64)
    if (t.field === 'part.size') entry.compressed.parts[0].size = 999999
    if (t.field === 'compressed.size') entry.compressed.size = 999999
    if (t.field === 'outputSize') entry.compressed.outputSize = 999999
    if (t.field === 'parts.length') entry.compressed.parts = entry.compressed.parts.slice(0, -1)
  }
  if (over.dropPart) {
    const dropped = entry.compressed.parts[0].path
    fs.rmSync(path.join(pkgDir, dropped), { force: true })
  }
  return { pkgDir, binary, entry }
}

await check('a well-described payload restores to the exact bytes', async () => {
  const { pkgDir, binary, entry } = payload()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-data-'))
  try {
    const restored = await materializeEngine({ pkgDir, dataDir, entry, platform: 'win32' })
    assert.ok(fs.existsSync(restored), 'the executable was not written')
    assert.ok(restored.endsWith('.exe'), 'the platform extension was not applied')
    assert.deepEqual(fs.readFileSync(restored), binary, 'the restored bytes differ from the original')
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

await check('a restore that already landed is not redone', async () => {
  const { pkgDir, binary, entry } = payload()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-data-'))
  try {
    const first = await materializeEngine({ pkgDir, dataDir, entry, platform: 'win32' })
    const second = await materializeEngine({ pkgDir, dataDir, entry, platform: 'win32' })
    assert.equal(first, second)
    assert.deepEqual(fs.readFileSync(second), binary)
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

await check('the restored file is 0700', async () => {
  const { pkgDir, entry } = payload()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-data-'))
  try {
    const restored = await materializeEngine({ pkgDir, dataDir, entry, platform: 'linux' })
    const mode = fs.statSync(restored).mode & 0o777
    assert.equal(mode, 0o700, `expected 0700, got ${mode.toString(8)}`)
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

await check('hasEnginePayload reports presence, not restorability', async () => {
  const { pkgDir, entry } = payload()
  try {
    assert.equal(hasEnginePayload(pkgDir, entry), true)
    const dropped = payload({ dropPart: true })
    assert.equal(hasEnginePayload(dropped.pkgDir, dropped.entry), false, 'a missing part was reported present')
    fs.rmSync(dropped.pkgDir, { recursive: true, force: true })
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
  }
})

for (const field of ['part.sha256', 'compressed.sha256', 'output.sha256', 'part.size', 'compressed.size', 'outputSize', 'parts.length']) {
  await check(`a tampered ${field} fails the restore and leaves nothing behind`, async () => {
    const { pkgDir, entry } = payload({ tamper: { field } as any })
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-data-'))
    try {
      let thrown: any
      try { await materializeEngine({ pkgDir, dataDir, entry, platform: 'win32' }) } catch (error: any) { thrown = error }
      assert.ok(thrown !== undefined, `a tampered ${field} restored cleanly`)
      // The half-restored temp must not survive: it would be a wrong binary.
      const runtimeDir = path.join(dataDir, 'engine-runtime')
      if (fs.existsSync(runtimeDir)) {
        for (const name of fs.readdirSync(runtimeDir)) {
          assert.ok(!name.endsWith('.tmp'), `a temp file survived a ${field} failure: ${name}`)
        }
      }
    } finally {
      fs.rmSync(pkgDir, { recursive: true, force: true })
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
}

await check('non-gzip compressed bytes are refused', async () => {
  // A payload that claims gzip but carries something else must fail at gunzip,
  // not silently produce a corrupt binary.
  const { pkgDir, entry } = payload()
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-')), 'x')
  fs.mkdirSync(path.dirname(bad), { recursive: true })
  fs.writeFileSync(bad, randomBytes(200))
  fs.rmSync(path.join(pkgDir, entry.compressed.parts[0].path), { force: true })
  fs.writeFileSync(path.join(pkgDir, entry.compressed.parts[0].path), fs.readFileSync(bad))
  fs.rmSync(path.dirname(bad), { recursive: true, force: true })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-data-'))
  try {
    let thrown: any
    try { await materializeEngine({ pkgDir, dataDir, entry, platform: 'win32' }) } catch (error: any) { thrown = error }
    assert.ok(thrown !== undefined, 'non-gzip bytes restored cleanly')
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

await check('metadata that describes nothing restorable is refused before a read', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-data-'))
  const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-'))
  const bad = [
    undefined,
    null,
    {},
    { sha256: 'not-a-hash' },
    { sha256: 'a'.repeat(64) },
    { sha256: 'a'.repeat(64), compressed: { algorithm: 'gzip' } },
    { sha256: 'a'.repeat(64), compressed: { algorithm: 'gzip', size: 10, sha256: 'b'.repeat(64), outputSize: 10, parts: [] } },
    { sha256: 'a'.repeat(64), compressed: { algorithm: 'gzip', size: 10, sha256: 'b'.repeat(64), outputSize: -1, parts: [{ path: 'src/engine-parts/x.000.part', size: 10, sha256: 'c'.repeat(64) }] } },
    { sha256: 'a'.repeat(64), compressed: { algorithm: 'brotli', size: 10, sha256: 'b'.repeat(64), outputSize: 10, parts: [{ path: 'src/engine-parts/x.000.part', size: 10, sha256: 'c'.repeat(64) }] } },
  ]
  try {
    for (const entry of bad) {
      let thrown: any
      try { await materializeEngine({ pkgDir, dataDir, entry: entry as any, platform: 'win32' }) } catch (error: any) { thrown = error }
      assert.ok(thrown !== undefined, `${String(entry)} was accepted`)
      assert.match(String(thrown.message), /metadata/)
    }
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

await check('a part path outside the manifest root is refused', async () => {
  // A part naming `../../etc/passwd` must not be read just because its size and
  // hash happen to match.
  const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-payload-data-'))
  const binary = Buffer.from('small')
  const compressed = gzipSync(binary)
  const entry = {
    sha256: sha256hex(binary),
    compressed: { algorithm: 'gzip', size: compressed.length, sha256: sha256hex(compressed), outputSize: binary.length, parts: [{ path: '../escaped.000.part', size: compressed.length, sha256: sha256hex(compressed) }] },
  }
  try {
    let thrown: any
    try { await materializeEngine({ pkgDir, dataDir, entry: entry as any, platform: 'win32' }) } catch (error: any) { thrown = error }
    assert.ok(thrown !== undefined, 'an escaping part path was accepted')
    assert.match(String(thrown.message), /metadata/)
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 400)
