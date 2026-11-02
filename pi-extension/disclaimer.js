/**
 * The one-time notice the free lanes owe the user.
 *
 * Both lanes this extension registers are somebody else's free tier, and each
 * has a property a user must know before typing anything they care about:
 * Kilo's free pool states on its own model cards that prompts may be logged by
 * the upstream provider and used to improve its services, and OpenCode's free
 * lane meters per session/IP, so a shared egress can spend it. That is not a
 * bug report, it is the price of the lane — but it has to be said once, in the
 * session where the models first appear, not buried in a README.
 *
 * The copy is versioned for the same reason dsh versions its disclaimer: when
 * the wording or the lanes change, the notice must be able to come back.
 *
 * @module pi-extension/disclaimer.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Bump to re-show the notice after the copy or the lanes change. */
export const NOTICE_VERSION = 1

const FILE_NAME = 'notice-ack.json'

/** `<dataDir or $OFM_DATA_DIR or ~/.our-free-model>/notice-ack.json`. */
export function ackPath(dataDir) {
  const root = dataDir ?? process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.our-free-model')
  return path.join(root, FILE_NAME)
}

/** The stored acknowledgement's version, or 0 when there is none. */
export function readAck(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ackPath(dataDir), 'utf8'))
    return Number.isFinite(parsed?.version) ? parsed.version : 0
  } catch {
    return 0
  }
}

/** Whether this machine has not yet seen the current notice. */
export function shouldNotice(dataDir) {
  return readAck(dataDir) < NOTICE_VERSION
}

/** Record that the notice was shown, so it does not come back every session. */
export function writeAck(dataDir) {
  const file = ackPath(dataDir)
  const directory = path.dirname(file)
  const temp = `${file}.tmp`
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(temp, `${JSON.stringify({ version: NOTICE_VERSION, at: Date.now() }, undefined, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* the rename already carried the temp file's mode on every platform that has one */
  }
  return NOTICE_VERSION
}

/**
 * The notice itself — short on purpose, and factual: what is free, what it
 * costs, and what not to send.
 */
export function noticeText() {
  return [
    'Our Free Model: free models from two third-party lanes.',
    'ofm-kilo — the upstream states free-pool prompts may be logged and used to improve its services.',
    'ofm-opencode — free tier metered per session/IP, so a shared network can spend it.',
    'Do not send passwords, keys, personal data or anything you would not hand to a third party.',
    'Each lane\'s terms are yours to follow. Details: pi-extension/README.md',
  ].join('\n')
}
