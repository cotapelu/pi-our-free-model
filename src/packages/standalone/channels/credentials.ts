/**
 * The standalone's credential store: one JSON file per data directory, written
 * synchronously and atomically, never read from DSH's files.
 *
 * The write is a temp file `0600` + rename, and the temp's permissions are
 * tightened *before* the rename — a crash between the two would leave the real
 * file world-readable for as long as the window lasted. A failed write removes
 * its own temp and rethrows: a credential the user believes is saved but is not
 * is worse than the error that says so.
 *
 * A ref is validated against a strict charset rather than used as a key
 * directly: this file is the one place an account token lives, and a ref that
 * walks out of `[A-Za-z0-9_.-]` is not one this store ever minted.
 *
 * Ported from dsh's `packages/standalone/channels/credentials.mjs`.
 *
 * @module pi-extension/packages/standalone/channels/credentials.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { restrictPermissions } from '../../../gateway/store.js'

export interface ChannelCredentials {
  resolve(ref: string): Promise<{ value: string; source: 'local' } | undefined>
  describe(ref: string): Promise<{ source: 'local' | undefined }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  dispose(): void
}

/** 独立应用凭据仓库。同步原子写入，失败冒泡；从不读取 DSH 文件。 */
export function createCredentials(dataDir: string): ChannelCredentials {
  const file = path.join(dataDir, 'channel-credentials.json')
  let values: Record<string, string> = {}
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('独立凭据文件格式错误')
    values = loaded
  }
  let closed = false
  const key = (ref: unknown): string => {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(ref)) throw new TypeError('凭据引用无效')
    return ref
  }
  const save = (next: Record<string, string>) => {
    if (closed) throw new Error('凭据仓库已停止')
    const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
      restrictPermissions(temp)
      fs.renameSync(temp, file)
      values = next
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  return {
    async resolve(ref) {
      const value = values[key(ref)]
      return typeof value === 'string' ? { value, source: 'local' } : undefined
    },
    async describe(ref) { return { source: typeof values[key(ref)] === 'string' ? 'local' : undefined } },
    async set(ref, value) {
      if (typeof value !== 'string') throw new TypeError('凭据必须为字符串')
      save({ ...values, [key(ref)]: value })
    },
    async unset(ref) {
      const next = { ...values }
      delete next[key(ref)]
      save(next)
    },
    dispose() { closed = true; values = {} },
  }
}
