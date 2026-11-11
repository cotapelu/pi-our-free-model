/**
 * What the user has acknowledged, per announcement id.
 *
 * The feed module owns no ack state on purpose — a refresh must never rewrite
 * acknowledgement history — so this is the caller's half. It lives apart from
 * the feed cache because the two answer different questions and fail
 * differently: the cache is "what the owner published", this file is "what this
 * person has already read".
 *
 * Same discipline as `chain-store.ts` and `saver-store.ts`: a plain JSON file
 * under the user's own data directory, written atomically, creator-only. A file
 * another local user can edit can mark a security notice as read.
 *
 * @module pi-extension/feed-ack.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { restrictPermissions } from './gateway/store.js'

const FILE_NAME = 'feed-ack.json'
/** An id longer than this is not one this module ever wrote; drop it. */
const MAX_ID_LENGTH = 160

/** `<dataDir or $OFM_DATA_DIR or ~/.our-free-model>/feed-ack.json`. */
export function feedAckPath(): string {
  return path.join(process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.our-free-model'), FILE_NAME)
}

/** Coerce a stored file into the ack shape, dropping anything untrusted. */
export function normalizeAck(raw: any): { ids: string[] } {
  const section = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const ids = Array.isArray(section.ids) ? section.ids : []
  const kept: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) continue
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(id)
  }
  return { ids: kept }
}

/** Read the acknowledged ids. An unreadable or corrupt file is an empty set, not a crash. */
export function readAck(): Set<string> {
  try { return new Set(normalizeAck(JSON.parse(fs.readFileSync(feedAckPath(), 'utf8'))).ids) }
  catch { return new Set() }
}

/** Persist the acknowledged ids atomically, creator-only. */
export function writeAck(ids: Iterable<string>): boolean {
  try {
    const file = feedAckPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(normalizeAck({ ids: [...ids] }), undefined, 2)}\n`, { mode: 0o600 })
    restrictPermissions(temp)
    fs.renameSync(temp, file)
    return true
  } catch {
    // The ack is a convenience, never a gate: losing it re-shows a notice.
    return false
  }
}

/** Add ids to the set and persist. @returns what is now acknowledged. */
export function acknowledge(ids: Iterable<string>): Set<string> {
  const next = readAck()
  for (const id of ids) {
    const clean = String(id ?? '').trim()
    // The length cap is checked here too, so a caller cannot smuggle a value in.
    if (clean === '' || clean.length > MAX_ID_LENGTH) continue
    next.add(clean)
  }
  writeAck(next)
  return next
}
