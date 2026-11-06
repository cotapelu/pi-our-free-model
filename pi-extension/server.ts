/**
 * Standalone entry point: run the free lanes as an API provider without `pi`.
 *
 *   node pi-extension/dist/server.js [--port 18900] [--key ofm-…]
 *
 * Defaults come from the environment (`OFM_GATEWAY_PORT`, `OFM_GATEWAY_HOST`,
 * `OFM_GATEWAY_KEY`, `OFM_DATA_DIR`), a key is minted when none is given, and the
 * port that actually bound is printed at start because a requested port that is
 * taken walks to the next free one.
 *
 * @module pi-extension/server.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { kiloModels } from './kilo.js'
import { opencodeModels } from './opencode.js'
import { buildLaneModels } from './gateway/dispatch.js'
import { startGateway, type GatewayHandle } from './gateway/server.js'
import { generateKey } from './gateway/protocol.js'
import { readChains } from './chain-store.js'
import { normalizeChains } from './chains.js'
import type { ChainRow } from './gateway/chain.js'
import { JsonStore } from './gateway/store.js'

const DEFAULT_PORT = 18900
const DEFAULT_HOST = '127.0.0.1'

function dataDir(): string {
  return process.env.OFM_DATA_DIR ?? path.join(os.homedir(), '.our-free-model')
}

interface GatewaySettingsFile {
  version: number
  key: string
  port: number
  host: string
}

function settingsStore(): JsonStore<GatewaySettingsFile> {
  return new JsonStore<GatewaySettingsFile>({
    file: path.join(dataDir(), 'gateway.json'),
    initial: { version: 1, key: '', port: 0, host: '127.0.0.1' },
  })
}

function readStoredKey(): string {
  return settingsStore().get().key
}

function storeKey(key: string): void {
  settingsStore().update({ key })
}

function argValue(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return undefined
  const next = process.argv[at + 1]
  return typeof next === 'string' && !next.startsWith('--') ? next : undefined
}

async function main() {
  const log = (message: string) => console.log(`[ofm-gateway] ${message}`)
  const host = argValue('host') ?? process.env.OFM_GATEWAY_HOST ?? DEFAULT_HOST
  const requestedPort = Number(argValue('port') ?? process.env.OFM_GATEWAY_PORT ?? DEFAULT_PORT)
  const minted = generateKey()
  const stored = settingsStore()
  // `||`, not `??`: an empty stored key means none was ever minted, and an empty
  // string is not nullish.
  const key = argValue('key') || process.env.OFM_GATEWAY_KEY || stored.get().key || minted
  if (stored.get().key !== key) {
    stored.update({ key })
    stored.flush()
  }
  fs.mkdirSync(dataDir(), { recursive: true })

  log('fetching both rosters from upstream…')
  const [kilo, opencode, chains] = await Promise.all([kiloModels(), opencodeModels(), Promise.resolve(readChains())])
  const models = buildLaneModels(kilo, opencode)
  const chainRows: ChainRow[] = normalizeChains(chains as never) as ChainRow[]
  log(`roster ready: ofm-kilo ${kilo.length} models · ofm-opencode ${opencode.length} models`)
  if (chainRows.length > 0) log(`chains ready: ${chainRows.filter((chain) => chain.enabled !== false).length}/${chainRows.length} enabled`)

  let gateway: GatewayHandle
  try {
    gateway = await startGateway({
      settings: () => ({ host, port: requestedPort, enabled: true, key }),
      models: () => models,
      chains: () => chainRows,
      log,
    })
  } catch (error) {
    console.error(`[ofm-gateway] could not start: ${(error as Error).message}`)
    process.exitCode = 1
    return
  }

  log(`listening on http://${gateway.host}:${gateway.port} (requested ${gateway.requestedPort}${gateway.fellBack ? ' — taken, moved' : ''})`)
  log(`api key: ${key}`)
  log(`models:  ${gateway.port === 0 ? '?' : gateway.port} — GET /v1/models`)
  log('try:')
  log(`  curl http://127.0.0.1:${gateway.port}/v1/chat/completions \\`)
  log(`    -H "authorization: Bearer ${key}" -H 'content-type: application/json' \\`)
  log(`    -d '{"model":"ofm-kilo/kilo-auto-free","messages":[{"role":"user","content":"say pong"}]}'`)

  const shutdown = async () => {
    log('shutting down')
    await gateway.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main()
