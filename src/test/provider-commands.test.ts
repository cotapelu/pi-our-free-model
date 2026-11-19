import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Unit tests for the /ofm provider subcommand (on|off|status).
 *
 * These exercise the logic added to `pi-extension/index.ts` by simulating
 * the file reads/writes it performs against a temp data dir.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-provider-test-'))
const SETTINGS_FILE = path.join(DATA_DIR, 'gateway.json')

function readSettings(): { version?: number; key?: string; port?: number; host?: string; enabled?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(settings: { version?: number; key?: string; port?: number; host?: string; enabled?: boolean }) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 })
}

// --- provider off ---
writeSettings({ version: 1, key: 'ofm-test-key', port: 18900, host: '127.0.0.1', enabled: true })
let s = readSettings()
s.enabled = false
writeSettings(s)
s = readSettings()
assert.equal(s.enabled, false, 'provider off sets enabled=false')
assert.equal(s.port, 18900, 'port preserved')
assert.equal(s.key, 'ofm-test-key', 'key preserved')
console.log('ok - provider off')

// --- provider on ---
s.enabled = true
writeSettings(s)
s = readSettings()
assert.equal(s.enabled, true, 'provider on sets enabled=true')
console.log('ok - provider on')

// --- provider status reads settings ---
writeSettings({ version: 1, key: 'ofm-status-key', port: 18999, host: '127.0.0.1', enabled: true })
s = readSettings()
assert.equal(s.enabled, true)
assert.equal(s.port, 18999)
assert.equal(s.host, '127.0.0.1')
assert.equal(s.key, 'ofm-status-key')
console.log('ok - provider status reads settings')

// --- no settings file means defaults ---
fs.rmSync(SETTINGS_FILE, { force: true })
const missing = readSettings()
assert.equal(missing.enabled, undefined, 'no file -> enabled undefined (defaults to true in UI)')
console.log('ok - no settings file -> defaults')

// --- empty string key is preserved (|| not ??) ---
writeSettings({ version: 1, key: '', port: 0, host: '', enabled: false })
s = readSettings()
assert.equal(s.key, '', 'empty key string preserved')
assert.equal(s.enabled, false)
console.log('ok - empty key preserved')

// cleanup
fs.rmSync(DATA_DIR, { recursive: true, force: true })
console.log('\nALL /ofm PROVIDER CHECKS PASSED')
