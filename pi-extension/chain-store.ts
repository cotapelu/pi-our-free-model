/**
 * Durable storage for the user's chains, so they survive restarts and `/reload`.
 *
 * A plain JSON file under the user's own home (not pi's directory, and not the
 * repository), written atomically and restricted to the owner. Chains are user
 * input that crossed a process boundary, so every read goes back through
 * `normalizeChains` — this module never trusts what it reads.
 *
 * @module pi-extension/chain-store.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeChains } from './chains.js'

const FILE_NAME = 'chains.json'

/** `~/.our-free-model/chains.json`, overridable for tests. */
export function chainsPath() {
  return path.join(process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.our-free-model'), FILE_NAME)
}

/** Read the stored chains, or an empty list on a first run or a damaged file. */
export function readChains() {
  try {
    const parsed = JSON.parse(fs.readFileSync(chainsPath(), 'utf8'))
    return normalizeChains(Array.isArray(parsed?.chains) ? parsed.chains : parsed)
  } catch {
    return []
  }
}

/** Write the chains atomically; returns what was stored, normalized. */
export function writeChains(chains: any[]) {
  const normalized = normalizeChains(chains)
  const file = chainsPath()
  const directory = path.dirname(file)
  const temp = `${file}.tmp`
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, chains: normalized }, undefined, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* the rename already carried the temp file's mode on every platform that has one */
  }
  return normalized
}
