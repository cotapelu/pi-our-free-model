/**
 * Durable storage for the user's token-saver switches.
 *
 * Same shape and discipline as `chain-store.ts`: a plain JSON file under the
 * user's own home, written atomically and restricted to the owner. What is
 * stored is untrusted, so every read goes back through a normaliser and an
 * unrecognised value falls back to the shipped default rather than being
 * honoured as a typo.
 *
 * The default is **everything off**, and that is deliberate. Compaction changes
 * what the model reads, and a prompt family changes how the model *writes* —
 * both are a user's choice to make, not something a provider extension silently
 * turns on for them.
 *
 * @module pi-extension/saver-store.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CAVEMAN_LEVELS, PONYTAIL_LEVELS, OFF } from './token-saver/prompts.js'

const FILE_NAME = 'saver.json'

/** The switches this store holds. */
export interface SaverSettings {
  /** Tool-output compaction (`token-saver/index.js`). */
  rtk: boolean
  /** Answer-shaping prompt family level. */
  caveman: string
  /** Work-shaping prompt family level. */
  ponytail: string
}

/** What a fresh machine starts from: the saver off, the user turns it on. */
export const SAVER_DEFAULTS: Readonly<SaverSettings> = Object.freeze({
  rtk: false,
  caveman: OFF,
  ponytail: OFF,
})

/** `<dataDir or $OFM_DATA_DIR or ~/.our-free-model>/saver.json`. */
export function saverPath() {
  return path.join(process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.our-free-model'), FILE_NAME)
}

/** One family's level: the stored value when it is a real level, else `off`. */
function levelOf(value: unknown, levels: readonly string[]): string {
  return typeof value === 'string' && levels.includes(value) ? value : OFF
}

/** Coerce a stored value into the settings shape, field by field. */
export function normalizeSaver(raw: any): SaverSettings {
  const section = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    rtk: typeof section.rtk === 'boolean' ? section.rtk : SAVER_DEFAULTS.rtk,
    caveman: levelOf(section.caveman, CAVEMAN_LEVELS),
    ponytail: levelOf(section.ponytail, PONYTAIL_LEVELS),
  }
}

/**
 * Read the stored switches, or the defaults on a first run or a damaged file.
 *
 * A damaged file is not repaired on read: the next write overwrites it with a
 * good copy, and a read that threw never blocks the turn it is scored against.
 */
export function readSaver(): SaverSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(saverPath(), 'utf8'))
    return normalizeSaver(parsed?.saver ?? parsed)
  } catch {
    return { ...SAVER_DEFAULTS }
  }
}

/**
 * Merge a patch in and persist atomically; returns what was stored.
 *
 * The merge runs over the *normalised* current value, so a stored typo cannot
 * survive a write, and an absent field keeps the value already on disk.
 */
export function writeSaver(patch: Partial<SaverSettings>): SaverSettings {
  const current = readSaver()
  const next = normalizeSaver({
    ...current,
    ...(patch?.rtk === undefined ? {} : { rtk: patch.rtk }),
    ...(patch?.caveman === undefined ? {} : { caveman: patch.caveman }),
    ...(patch?.ponytail === undefined ? {} : { ponytail: patch.ponytail }),
  })
  const file = saverPath()
  const directory = path.dirname(file)
  const temp = `${file}.tmp`
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, saver: next }, undefined, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* the rename already carried the temp file's mode on every platform that has one */
  }
  return next
}
