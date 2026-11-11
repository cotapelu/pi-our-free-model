/**
 * The desktop shell's child process: the standalone service under Tauri's watch.
 *
 * The Rust shell (kept verbatim under `src-tauri/`) spawns this file as a Node
 * child and speaks one line of JSON on either side of stdin: `shutdown` to stop
 * the service, and a one-line ready/error envelope back on stdout. Everything
 * the shell learns about the service — its port, its management URL — arrives
 * through that envelope, which is also why an error carries only a code: startup
 * detail never leaks an account, an API key or a login token into the shell's log.
 *
 * stdin closing *is* the parent leaving: the shell can die without a chance to
 * say `shutdown`, and a service left listening on the port after its window is
 * gone is a port the next launch cannot bind.
 *
 * Ported from dsh's `packages/desktop/service-host.mjs`.
 *
 * @module pi-extension/packages/desktop/service-host.js
 */

import readline from 'node:readline'
import { startStandalone } from '../standalone/service.js'

// 桌面壳只控制自己启动的服务；stdin 关闭表示父进程已经离开。
let service: Awaited<ReturnType<typeof startStandalone>> | undefined
let closing: Promise<void> | undefined
let parentGone = false
const input = readline.createInterface({ input: process.stdin })
const stop = () => {
  parentGone = true
  if (closing !== undefined || service === undefined) return closing
  closing = service.close().catch(() => { process.exitCode = 1 }).finally(() => {
    input.close()
    process.stdin.destroy()
  })
  return closing
}
input.on('line', (line) => { if (line === 'shutdown') void stop() })
input.on('close', () => { void stop() })
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

async function main() {
  const args = process.argv.slice(2)
  const options: Record<string, unknown> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-refresh') options.refresh = false
    else if (args[i] === '--data-dir' && args[i + 1]) options.dataDir = args[++i]
    else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] ?? '')) options.port = Number(args[++i])
    else throw new Error('桌面服务启动参数无效')
  }
  service = await startStandalone(options as never)
  if (parentGone) await stop()
  else process.stdout.write(JSON.stringify({
    protocol: 'ofm-desktop-ready/v1', product: service.product, pid: process.pid,
    port: service.port, managementUrl: service.managementUrl,
  }) + '\n')
}

void main().catch((error) => {
  // 仅传递错误码，启动信息不会泄漏账号、API Key 或登录令牌。
  const code = (error as { code?: string } | null | undefined)?.code
  process.stdout.write(JSON.stringify({
    protocol: 'ofm-desktop-error/v1',
    code: code === 'EEXIST' ? 'DATA_DIRECTORY_IN_USE' : 'START_FAILED',
  }) + '\n')
  process.exitCode = 1
  input.close()
  process.stdin.destroy()
})
