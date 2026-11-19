/**
 * Open a URL in the user's own browser — the one thing the console may spawn
 * on the user's behalf.
 *
 * Narrow on purpose: the console hands over a *link it constructed itself* (the
 * EAC login URL), never a path or a command from a request body. Anything that
 * is not a plain http(s) URL, or that smuggles credentials into the URL, is
 * refused here rather than quoted into a shell.
 *
 * `platform`, `exec` and `systemRoot` are all injected: a test runner is not
 * Windows x64, and the launch path has to be exercisable where CI actually runs.
 *
 * Ported from dsh's `packages/standalone/open-external.mjs`.
 *
 * @module pi-extension/packages/standalone/open-external.js
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export interface OpenExternalOptions {
  platform?: string
  exec?: typeof runFile
  systemRoot?: string
}

export async function openExternal(
  value: string,
  { platform = process.platform, exec = runFile, systemRoot = process.env.SystemRoot ?? 'C:\\Windows' }: OpenExternalOptions = {},
): Promise<boolean> {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  try {
    if (platform === 'win32') {
      // `Start-Process` with an encoded command, not a string on a command line:
      // the URL never reaches a shell parser, and a quote inside it cannot end
      // the argument early.
      const command = `Start-Process -FilePath '${url.href.replaceAll("'", "''")}' -ErrorAction Stop`
      await exec(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000 })
    } else await exec(platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url.href], { timeout: 10000 })
    return true
  } catch { return false }
}
