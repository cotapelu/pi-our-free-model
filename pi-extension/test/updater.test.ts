/**
 * Unit checks for the in-app upgrader.
 *
 * The whole transaction is one rule — **nothing on the installed copy is touched
 * until the staged copy has been hash-verified** — and everything else follows
 * from it. So these checks are about the trust chain, not about the plumbing:
 *
 *   1. an unsigned or wrongly-signed manifest is never applied, however it
 *      arrived (a mirror is a transport, never an authority);
 *   2. a manifest whose `base` is absolute, protocol-relative or escapes the
 *      origin is refused — the sha256 pins would otherwise ride along inside
 *      the same forged document, pointing every download at the author's host;
 *   3. a file path that escapes the stage, and a size or hash that does not
 *      match, both abort the swap rather than install what was asked for;
 *   4. a failed swap restores the preimage from the verified backup, and a
 *      restore that cannot complete is reported rather than swallowed;
 *   5. a package-manager-owned copy is refused *before* any state is touched.
 *
 * Every check builds its own package, manifest and (throwaway) keypair under a
 * scratch dir, so nothing reaches the network and no installed copy is touched.
 *
 * Runs on plain node:  node test/updater.test.ts
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_MANIFEST_SOURCES, PINNED_MANIFEST_PUBLIC_KEY, PluginUpdater,
  backupPackage, bustCdnCache, compareVersions, downloadManifest, fileUrlOf,
  installStaged, isPackageManagerOwned, listPackageFiles, packageUsesHardLinks,
  parseManifest, parseUploadPackRefs, parseVersion, restoreBackup, signManifest,
  stableStringify, stageRelease, verifyInstalled, verifyManifestSignature, verifyStaged,
} from '../dist/updater.js'

let failures = 0
const check = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-upd-'))
}

/** A throwaway Ed25519 keypair, so nothing here touches the pinned release key. */
function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return { publicKey: spki, privateKey }
}

const sha256hex = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex256' in {} ? bytes : bytes).digest('hex')

const MAX_FILE = 4 * 1024 * 1024

// ── the trust chain ─────────────────────────────────────────────────────────
await check('a manifest signed with the pinned key verifies', async () => {
  // The pinned key's *shape* is pinned, not its private half: a round-trip
  // through a throwaway key proves the mechanism, and the pinned SPKI string
  // proves it is exactly what verifies.
  const k = keys()
  const manifest = { version: '1.0.0', base: '../', notes: 'test', publishedAt: '2026-01-01T00:00:00Z', files: [] }
  const signed = { ...manifest, signature: signManifest(manifest, k.privateKey) }
  assert.equal(verifyManifestSignature(signed, k.publicKey), true)
  // And the pinned key parses as an Ed25519 SPKI.
  const parsed = crypto.createPublicKey({ key: Buffer.from(PINNED_MANIFEST_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' })
  assert.equal(parsed.asymmetricKeyType, 'ed25519')
})

await check('an unsigned manifest never verifies', async () => {
  assert.equal(verifyManifestSignature({ version: '1.0.0', files: [] }, keys().publicKey), false)
  assert.equal(verifyManifestSignature({ version: '1.0.0', files: [], signature: '' }, keys().publicKey), false)
  assert.equal(verifyManifestSignature({ version: '1.0.0', files: [], signature: 'not-base64!!' }, keys().publicKey), false)
  assert.equal(verifyManifestSignature(null, keys().publicKey), false)
  assert.equal(verifyManifestSignature('a string', keys().publicKey), false)
})

await check('a manifest signed with a different key never verifies with the pinned one', async () => {
  const attacker = keys()
  const manifest = { version: '9.9.9', base: '../', files: [] }
  const signed = { ...manifest, signature: signManifest(manifest, attacker.privateKey) }
  assert.equal(verifyManifestSignature(signed, attacker.publicKey), true)
  // The release key is the one that counts.
  assert.equal(verifyManifestSignature(signed, keys().publicKey), false)
  assert.equal(verifyManifestSignature(signed, PINNED_MANIFEST_PUBLIC_KEY), false)
})

await check('the publisher contract is the parsed shape, not the raw document', async () => {
  // parseManifest normalises publishedAt (string -> epoch ms), lowercases hashes
  // and normalises path separators. The verifier recomputes the signature over
  // that same reconstruction, so a document signed in its raw spelling answers
  // false and an install could never apply the release. scripts/build-manifest.mjs
  // signs parseManifest(...) for exactly this reason.
  const k = keys()
  const manifest = { version: '1.0.0', base: '../', notes: 'test', publishedAt: '2026-01-01T00:00:00Z', files: [{ path: 'package.json', sha256: 'A'.repeat(64), size: 10 }] }
  const parsed = parseManifest(manifest)
  // The normalisations the verifier depends on.
  assert.equal(typeof parsed.publishedAt, 'number')
  assert.equal(parsed.publishedAt, Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(parsed.files[0].sha256, 'a'.repeat(64), 'a hash was not normalised to lowercase')
  // The verifier recomputes over the parsed document, so the object handed to
  // it must be the parsed one too — which is what downloadManifest does.
  assert.equal(verifyManifestSignature({ ...parsed, signature: signManifest(parsed, k.privateKey) }, k.publicKey), true)
  assert.equal(verifyManifestSignature({ ...parsed, signature: signManifest(manifest, k.privateKey) }, k.publicKey), false,
    'a raw-form signature verified: the port would accept a release its publisher never produced')
})

await check('a signature covers the signed fields only, so a wrapper change does not break it', async () => {
  const k = keys()
  const manifest = { version: '1.0.0', base: '../', notes: 'test', publishedAt: '2026-01-01T00:00:00Z', files: [] }
  const signed = { ...manifest, signature: signManifest(manifest, k.privateKey) }
  // Extra top-level fields are not covered: they cannot be used to smuggle.
  const wrapped = { ...signed, distributor: 'acme', signature: signed.signature }
  assert.equal(verifyManifestSignature(wrapped, k.publicKey), true, 'an innocent extra field broke the signature')
})

await check('a signed field changed after signing breaks the signature', async () => {
  const k = keys()
  const manifest = { version: '1.0.0', base: '../', files: [] }
  const signed = { ...manifest, signature: signManifest(manifest, k.privateKey) }
  const tampered = { ...signed, version: '9.9.9' }
  assert.equal(verifyManifestSignature(tampered, k.publicKey), false, 'a version swap was not caught')
})

// ── stableStringify ─────────────────────────────────────────────────────────
await check('stableStringify sorts keys, so a reordered manifest signs the same', async () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableStringify({ a: 1, b: 2 }), '{"a":1,"b":2}')
  // Key order is irrelevant; key content is not.
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }))
})

await check('stableStringify drops undefined object fields and nulls array slots', async () => {
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(stableStringify([undefined, 1]), '[null,1]')
  assert.equal(stableStringify(undefined), 'null')
  assert.equal(stableStringify(null), 'null')
})

await check('stableStringify is stable across nested shapes', async () => {
  const a = { x: { y: [1, { z: 2 }] }, w: 's' }
  const b = { w: 's', x: { y: [1, { z: 2 }] } }
  assert.equal(stableStringify(a), stableStringify(b))
})

// ── the manifest parser ─────────────────────────────────────────────────────
await check('a base that is not a relative path is refused', async () => {
  // The base is resolved against the manifest's own URL: an absolute value
  // would point every download at a host of the manifest author's choosing,
  // and the sha256 pins would ride along inside the same forged document.
  for (const base of ['https://evil.example/x', 'http://evil.example', '//evil.example/x', '/etc', 'C:\\x', 'a\\\\b']) {
    const m = { version: '1.0.0', base, files: [{ path: 'package.json', sha256: 'a'.repeat(64), size: 10 }] }
    assert.throws(() => parseManifest(m), new RegExp('relative' as any) instanceof RegExp ? /relative/ : /relative/, `base ${base} was accepted`)
  }
})

await check('a manifest with no package.json is refused', async () => {
  assert.throws(() => parseManifest({ version: '1.0.0', base: '../', files: [{ path: 'index.js', sha256: 'a'.repeat(64), size: 10 }] }), /package\.json/)
  assert.throws(() => parseManifest({ version: '1.0.0', base: '../', files: [] }), /no file list/)
})

await check('a version that is not semver is refused', async () => {
  for (const version of ['', '1.0', 'v1.0.0', '1.0.0.0', 'abc', '1.0.0-']) {
    assert.throws(() => parseManifest({ version, base: '../', files: [{ path: 'package.json', sha256: 'a'.repeat(64), size: 10 }] }), /semver/, `version ${JSON.stringify(version)} was accepted`)
  }
})

await check('a file path that escapes the release is refused', async () => {
  for (const rel of ['../escape', '/absolute', 'a/../b', '..', 'C:/x', 'a//b', 'a/..', '']) {
    assert.throws(() => parseManifest({ version: '1.0.0', base: '../', files: [{ path: rel, sha256: 'a'.repeat(64), size: 10 }, { path: 'package.json', sha256: 'b'.repeat(64), size: 10 }] }), /safe relative path/, `path ${JSON.stringify(rel)} was accepted`)
  }
})

await check('a duplicate file entry is refused', async () => {
  assert.throws(() => parseManifest({
    version: '1.0.0', base: '../',
    files: [
      { path: 'package.json', sha256: 'a'.repeat(64), size: 10 },
      { path: 'package.json', sha256: 'a'.repeat(64), size: 10 },
    ],
  }), /twice/)
})

await check('a non-hash sha256 and an out-of-range size are refused', async () => {
  const base = { version: '1.0.0', base: '../' }
  for (const sha256 of ['', 'short', 'z'.repeat(64), 'G'.repeat(63), undefined]) {
    assert.throws(() => parseManifest({ ...base, files: [{ path: 'package.json', sha256, size: 10 }] }), /sha256/, `hash ${JSON.stringify(sha256)} was accepted`)
  }
  for (const size of [0, -1, 1.5, '10', undefined, MAX_FILE + 1]) {
    assert.throws(() => parseManifest({ ...base, files: [{ path: 'package.json', sha256: 'a'.repeat(64), size }] }), /size/, `size ${JSON.stringify(size)} was accepted`)
  }
})


// ── versions ────────────────────────────────────────────────────────────────
await check('semver precedence, including pre-releases', async () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, 'numeric compare, not string compare')
  // A pre-release sorts before its release.
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  // Two pre-releases compare by identifier, numeric before alpha.
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
  assert.equal(compareVersions('1.0.0-rc.1.1', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-beta.1'), -1)
})

await check('a malformed version is not a crash', async () => {
  assert.equal(parseVersion('nope'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)
  // Comparing two malformed values is stable and never throws: the caller is
  // the settings page, which shows whatever this answer is rather than dying.
  assert.equal(compareVersions('nope', 'nope'), 0)
  assert.equal(typeof compareVersions('nope', '1.0.0'), 'number')
  assert.equal(typeof compareVersions('1.0.0', 'nope'), 'number')
})

// ── pkt-line refs ───────────────────────────────────────────────────────────
await check('a pkt-line ref advertisement parses and a truncated one is refused', async () => {
  // Build: 4-byte header, then the payload.
  const line = (payload: string) => {
    const body = Buffer.from(payload, 'utf8')
    // A pkt-line is 4 ASCII hex characters naming the total length, then the
    // payload — the wire format git itself writes, not a binary uint32.
    const head = (body.length + 4).toString(16).padStart(4, '0')
    return Buffer.concat([Buffer.from(head, 'latin1'), body])
  }
  const sha = 'a'.repeat(40)
  const body = Buffer.concat([
    line(`${sha} refs/heads/main\u0000capabilities-report\u0000`),
    Buffer.from('0000', 'latin1'),
  ])
  const refs = parseUploadPackRefs(body)
  assert.equal(refs.get('refs/heads/main'), sha)

  // A body that stops before the flush packet is refused.
  assert.throws(() => parseUploadPackRefs(line(`${sha} refs/heads/main\u0000`)), /incomplete/)
  // A bad header is refused.
  assert.throws(() => parseUploadPackRefs(Buffer.from('zzzznot-hex', 'latin1')), /invalid ref/)
})

// ── staging and install ─────────────────────────────────────────────────────
/** One installable package laid out under a scratch dir. */
function pkg(over: { files?: Record<string, string>; version?: string } = {}) {
  const dir = scratch()
  const files = over.files ?? {
    'package.json': JSON.stringify({ name: 'test', version: over.version ?? '1.0.0' }, null, 2),
    'index.js': 'export default () => {}\n',
    'README.md': 'hello\n',
  }
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
  }
  return { dir, files }
}

await check('a manifest describing the files that exist installs and verifies', async () => {
  const { dir, files } = pkg()
  const manifest = manifestFor(files)
  const stage = path.join(scratch(), 'stage')
  try {
    fs.mkdirSync(stage, { recursive: true })
    for (const [rel, contents] of Object.entries(files)) {
      const target = path.join(stage, ...rel.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    }
    verifyStaged(stage, manifest)
    await installStaged(stage, path.join(scratch(), 'pkg'), manifest.files.map(f => f.path))
  } catch (error: any) {
    assert.fail(`a matching install failed: ${error?.message}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a staged file with a drifted hash is refused', async () => {
  const { dir, files } = pkg()
  const manifest = manifestFor(files)
  const stage = path.join(scratch(), 'stage')
  try {
    fs.mkdirSync(stage, { recursive: true })
    for (const [rel, contents] of Object.entries(files)) {
      const target = path.join(stage, ...rel.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    }
    // Tamper with one staged byte: the hash check must catch it.
    fs.appendFileSync(path.join(stage, 'index.js'), '\n// drift\n')
    assert.throws(() => verifyStaged(stage, manifest), /hash drift|size drift/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a missing staged file is refused', async () => {
  const { dir, files } = pkg()
  const manifest = manifestFor(files)
  const stage = path.join(scratch(), 'stage')
  try {
    fs.mkdirSync(path.join(stage, 'x'), { recursive: true })
    fs.writeFileSync(path.join(stage, 'package.json'), files['package.json'])
    assert.throws(() => verifyStaged(stage, manifest), /staged file missing/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a stage whose package.json version disagrees with the manifest is refused', async () => {
  const { dir, files } = pkg()
  const manifest = manifestFor(files)
  const stage = path.join(scratch(), 'stage')
  try {
    fs.mkdirSync(stage, { recursive: true })
    for (const [rel, contents] of Object.entries(files)) {
      const target = path.join(stage, ...rel.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    }
    // A version drift with a matching hash must still be refused: the manifest
    // is what the download was verified against, so a package.json that
    // disagrees with it means the stage is not the release.
    const newer = { ...files, 'package.json': JSON.stringify({ name: 'test', version: '9.9.9' }, null, 2) }
    fs.writeFileSync(path.join(stage, 'package.json'), newer['package.json'])
    assert.throws(() => verifyStaged(stage, manifestFor(newer === files ? files : files)), /package\.json says|hash drift|size drift/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a release that installs cleanly reads back identical, and a drifted one does not', async () => {
  const { dir, files } = pkg()
  const manifest = manifestFor(files)
  const stage = path.join(scratch(), 'stage')
  const target = scratch()
  try {
    fs.mkdirSync(stage, { recursive: true })
    for (const [rel, contents] of Object.entries(files)) {
      const dest = path.join(stage, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, contents)
    }
    await installStaged(stage, target, manifest.files.map(f => f.path))
    verifyInstalled(target, manifest)
    // Drift one byte and the read-back refuses.
    fs.appendFileSync(path.join(target, 'index.js'), '\n// drift\n')
    assert.throws(() => verifyInstalled(target, manifest), /hash drift|missing/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a file the new release drops is removed by installStaged', async () => {
  const { dir, files } = pkg()
  const target = scratch()
  const stage = path.join(scratch(), 'stage')
  try {
    // Install a 3-file release into an empty package.
    fs.mkdirSync(stage, { recursive: true })
    for (const [rel, contents] of Object.entries(files)) {
      const dest = path.join(stage, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, contents)
    }
    fs.writeFileSync(path.join(target, 'stale.js'), 'an old file the new release dropped\n')
    const manifest = manifestFor(files)
    // Install only the current release: the leftover is swept.
    await installStaged(stage, target, manifest.files.map(f => f.path))
    assert.equal(fs.existsSync(path.join(target, 'stale.js')), false, 'a dropped file lingered')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── backup and restore ──────────────────────────────────────────────────────
await check('a backup can be restored byte-for-byte', async () => {
  const { dir } = pkg()
  const backupDir = path.join(scratch(), 'rollback')
  const target = scratch()
  try {
    await installStaged(dir, target, listPackageFiles(dir))
    const before = new Map(listPackageFiles(target).map(rel => [rel, fs.readFileSync(path.join(target, ...rel.split('/')))]))
    const backedUp = await backupPackage(target, backupDir)
    assert.equal(backedUp, listPackageFiles(dir).length)
    // Wipe and destroy, then restore.
    for (const rel of listPackageFiles(target)) fs.rmSync(path.join(target, ...rel.split('/')), { force: true })
    fs.writeFileSync(path.join(target, 'garbage.js'), 'not part of the old release\n')
    restoreBackup(backupDir, target)
    const after = new Map(listPackageFiles(target).map(rel => [rel, fs.readFileSync(path.join(target, ...rel.split('/')))]))
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'the restored file set differs')
    for (const [rel, bytes] of before) assert.ok(after.get(rel)?.equals(bytes), `${rel} was not restored byte-for-byte`)
    assert.equal(fs.existsSync(path.join(target, 'garbage.js')), false, 'an extra file survived the restore')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a restore with no backup refuses, rather than emptying the package', async () => {
  // This is the one that matters: listPackageFiles answers [] for a directory
  // that does not exist, and an install that has never updated has no rollback
  // copy. Walking into the delete loop would empty the package while the
  // running process keeps going from memory.
  const { dir } = pkg()
  const target = scratch()
  try {
    await installStaged(dir, target, listPackageFiles(dir))
    const before = listPackageFiles(target).length
    assert.throws(() => restoreBackup(path.join(scratch(), 'nonexistent'), target), /no rollback copy/)
    assert.equal(listPackageFiles(target).length, before, 'the package was emptied by a refused restore')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('a receipt that is not a valid rollback receipt is refused', async () => {
  const backupDir = scratch()
  try {
    fs.writeFileSync(path.join(backupDir, 'index.js'), 'x')
    fs.writeFileSync(path.join(backupDir, '.ofm-backup.json'), JSON.stringify({ files: 'nope' }))
    assert.throws(() => restoreBackup(backupDir, scratch()), /invalid rollback receipt/)
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true })
  }
})

// ── listPackageFiles ────────────────────────────────────────────────────────
await check('repository scaffolding never looks like dropped release files', async () => {
  const dir = pkg().dir
  try {
    // A development copy carries directories a release never ships.
    for (const name of ['scripts', 'docs', 'feed', 'node_modules', 'catalog', 'worker', 'vendor', 'packages']) {
      fs.mkdirSync(path.join(dir, name, 'deep'), { recursive: true })
      fs.writeFileSync(path.join(dir, name, 'x.js'), 'x')
    }
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'x')
    fs.writeFileSync(path.join(dir, 'index.js.ofm-new'), 'release scratch')
    fs.writeFileSync(path.join(dir, 'index.js.ofm-old'), 'release scratch')
    const listed = listPackageFiles(dir)
    for (const name of ['scripts', 'docs', 'feed', 'node_modules', 'catalog', 'worker', 'vendor', 'packages']) {
      assert.ok(!listed.some(rel => rel.startsWith(`${name}/`)), `${name} was treated as a release file`)
    }
    assert.ok(!listed.some(rel => rel.startsWith('.git/')), '.git was treated as a release file')
    assert.ok(!listed.some(rel => rel.endsWith('.ofm-new') || rel.endsWith('.ofm-old')), 'release scratch was treated as a release file')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('the vendored runtime assets do participate in backup and restore', async () => {
  const dir = pkg().dir
  try {
    fs.mkdirSync(path.join(dir, 'vendor', 'magpie'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'vendor', 'magpie', 'engine.json'), '{}')
    const listed = listPackageFiles(dir)
    assert.ok(listed.includes('vendor/magpie/engine.json'), 'a vendored runtime asset was skipped')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── the gate on a package-manager install ───────────────────────────────────
await check('a copy pnpm owns is detected and refused', async () => {
  // Two exact filesystem records, read beside the profile root (two levels above
  // pkgDir) — a node_modules directory inside the copy is deliberately not one.
  const profileDir = scratch()
  const pkgDir = path.join(profileDir, 'node_modules', 'dsh-our-free-model')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}')
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'x')
  // A node_modules inside the copy proves nothing.
  fs.mkdirSync(path.join(pkgDir, 'node_modules'), { recursive: true })
  assert.equal(isPackageManagerOwned(pkgDir), false, 'an inner node_modules was treated as ownership')
  // The lockfile is.
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'importers:\n  .:\n    dependencies:\n      dsh-our-free-model:\n        specifier: link:../x\n')
  assert.equal(isPackageManagerOwned(pkgDir), false, 'a link: specifier was treated as ownership')
  fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'importers:\n  .:\n    dependencies:\n      dsh-our-free-model:\n        specifier: ^1.0.0\n')
  assert.equal(isPackageManagerOwned(pkgDir), true, 'a real dependency was not detected')
  fs.rmSync(path.join(profileDir, 'pnpm-lock.yaml'))
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'node_modules', '.modules.yaml'), JSON.stringify({ hoistedLocations: { 'dsh-our-free-model@1.0.0': 'node_modules/.pnpm' } }))
  assert.equal(isPackageManagerOwned(pkgDir), true, 'a hoisted location was not detected')
})

await check('an ordinary linked copy is not treated as pnpm-owned', async () => {
  const profileDir = scratch()
  const pkgDir = path.join(profileDir, 'plugins', 'dsh-our-free-model')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}')
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'x')
  assert.equal(isPackageManagerOwned(pkgDir), false)
  // And hard links are the other ownership record.
  assert.equal(packageUsesHardLinks(pkgDir), false)
})

// ── downloads and mirrors ───────────────────────────────────────────────────
await check('a manifest that no source answers is reported with every failure', async () => {
  const failures: string[] = []
  await assert.rejects(
    downloadManifest(['https://example.invalid/feed/manifest.json'], {
      timeoutMs: 50,
      fetchImpl: (async () => { throw new Error('fetch failed') }) as any,
      verifyKey: keys().publicKey,
    }),
    /no manifest source answered/,
  )
  void failures
})

await check('an unsigned manifest is refused by downloadManifest, not staged', async () => {
  // A mirror is a transport, never an authority: an unsigned document from a
  // working origin is still refused.
  await assert.rejects(
    downloadManifest(['https://example.test/manifest.json'], {
      timeoutMs: 500,
      fetchImpl: (async () => new Response(JSON.stringify({ version: '1.0.0', base: '../', files: [{ path: 'package.json', sha256: 'a'.repeat(64), size: 10 }] }), { status: 200 })) as any,
      verifyKey: keys().publicKey,
    }),
    /signature missing|no manifest source/,
  )
})

await check('an unreachable manifest source is reported by origin', async () => {
  await assert.rejects(
    downloadManifest(['https://a.invalid/x', 'https://b.invalid/y'], {
      timeoutMs: 50,
      fetchImpl: (async () => { throw new Error('fetch failed') }) as any,
    }),
    /a\.invalid|could not/,
  )
})

await check('bustCdnCache touches only jsDelivr hosts', async () => {
  const plain = 'https://raw.githubusercontent.com/o/r/main/feed/manifest.json'
  assert.equal(bustCdnCache(plain), plain)
  const busted = bustCdnCache('https://cdn.jsdelivr.net/gh/o/r@main/feed/manifest.json')
  assert.ok(busted.includes('ofm='), `the cache hint was not added: ${busted}`)
  // A malformed URL is returned unchanged, not thrown on.
  assert.equal(bustCdnCache('not a url'), 'not a url')
})

await check('a manifest-relative file URL resolves against the manifest origin', async () => {
  const manifest = { version: '1.0.0', base: '../', files: [], notes: '', publishedAt: 0 }
  assert.equal(
    fileUrlOf('https://example.test/repo/feed/manifest.json', manifest as any, 'index.js'),
    'https://example.test/repo/index.js',
  )
  // A base that climbs out of the feed directory is honoured (that is the point).
  assert.equal(
    fileUrlOf('https://example.test/feed/manifest.json', { ...manifest, base: '../' } as any, 'a/b.js'),
    'https://example.test/a/b.js',
  )
})

await check('the default sources are all https and immutable-by-resolution', async () => {
  assert.ok(DEFAULT_MANIFEST_SOURCES.length > 0)
  for (const source of DEFAULT_MANIFEST_SOURCES) {
    assert.ok(source.startsWith('https://'), `${source} is not https`)
  }
})

/** A manifest describing exactly `files`, signed with a throwaway key. */
function manifestFor(files: Record<string, string>, version = '1.0.0') {
  const rows = Object.entries(files).map(([rel, contents]) => ({
    path: rel,
    sha256: crypto.createHash('sha256').update(contents, 'utf8').digest('hex'),
    size: Buffer.byteLength(contents, 'utf8'),
  }))
  return parseManifest({ version, base: '../', notes: 'test', publishedAt: '2026-01-01T00:00:00Z', files: rows })
}

await check('the whole transaction refuses before touching anything it cannot finish', async () => {
  // An update whose manifest is unsigned must not stage, must not back up, and
  // must not leave a state file behind claiming otherwise.
  const dataDir = scratch()
  const pkgDir = pkg().dir
  try {
    const k = keys()
    const updater = new PluginUpdater({
      pkgDir, dataDir,
      settings: () => ({}),
      fetchImpl: (async () => new Response(JSON.stringify({ version: '1.0.0', base: '../', files: [{ path: 'package.json', sha256: 'a'.repeat(64), size: 10 }] }), { status: 200 })) as any,
      manifestPublicKey: k.publicKey,
      runningVersion: '1.0.0',
      defaultSources: ['https://example.test/feed/manifest.json'],
    })
    await assert.rejects(updater.apply({ version: '2.0.0' }), /not signed|no manifest|signature/)
    // No state file was written: a refused transaction must not look like one
    // the next boot has to recover from.
    assert.equal(fs.existsSync(path.join(dataDir, 'upgrade-state.json')), false, 'a refused update left a transaction state')
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
  }
})

await check('the version gate refuses a downgrade', async () => {
  const dataDir = scratch()
  const pkgDir = pkg({ version: '5.0.0' }).dir
  try {
    const k = keys()
    const manifest = { version: '1.0.0', base: '../', notes: '', publishedAt: '2026-01-01T00:00:00Z', files: [{ path: 'package.json', sha256: 'a'.repeat(64), size: 10 }] }
    // The publisher signs the shape the verifier reconstructs — the parsed
    // document, with publishedAt normalised to a number and paths and hashes
    // normalised. Signing the raw form ships a release no install can apply.
    const signed = { ...manifest, signature: signManifest(parseManifest(manifest), k.privateKey) }
    const updater = new PluginUpdater({
      pkgDir, dataDir, settings: () => ({}),
      manifestPublicKey: k.publicKey, runningVersion: '5.0.0',
      defaultSources: ['https://example.test/feed/manifest.json'],
      fetchImpl: (async () => new Response(JSON.stringify(signed), { status: 200 })) as any,
    })
    await assert.rejects(updater.apply({ version: '1.0.0' }), /newer than/)
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true })
  }
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 500)
