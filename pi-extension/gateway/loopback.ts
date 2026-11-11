/**
 * Loopback-only bind resolution and port acquisition.
 *
 * A gateway on this machine spends this machine's free-lane quota, so the
 * default bind is a loopback address and a routable one must be refused rather
 * than defaulted past. The check is on the *resolved IP*, never on the spelling:
 * `localhost` is a name the OS resolves, and a hosts file or enterprise DNS that
 * points it at a routable interface would hand the lane to the subnet while a
 * string comparison kept passing (the exact defect dsh's forward.js documents).
 *
 * @module pi-extension/gateway/loopback.js
 */

import dns from 'node:dns'
import net from 'node:net'

function isLoopbackIp(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.')
}

/**
 * The address a listener may bind. A literal loopback IP passes; anything else is
 * resolved and every answer must be loopback before `listen` sees it.
 */
export async function resolveLoopbackBind(host: unknown): Promise<string> {
  const value = String(host ?? '').trim() || '127.0.0.1'
  const literal = value.replace(/^\[|\]$/g, '')
  if (net.isIP(literal)) {
    if (!isLoopbackIp(literal)) throw new Error(`the gateway binds a loopback address only (got ${value})`)
    return literal
  }
  let addresses: dns.LookupAddress[]
  try {
    addresses = await dns.promises.lookup(literal, { all: true, verbatim: true })
  } catch (error) {
    throw new Error(`could not resolve the gateway bind host "${value}" (${(error as Error)?.message ?? error})`)
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`the gateway bind host "${value}" resolved to no address`)
  }
  const routable = addresses.find((address) => !isLoopbackIp(address.address))
  if (routable !== undefined) {
    throw new Error(`the gateway binds a loopback address only — "${value}" resolves to ${routable.address}`)
  }
  return addresses[0].address
}

/** A refused `listen`, read into something a caller can act on rather than a stack. */
export type BindErrorKind = 'held' | 'in-use' | 'unavailable' | 'unknown'

export function classifyBindError(error: unknown): { kind: BindErrorKind; code: string; retryable: boolean; hint: string } {
  const code = String((error as { code?: string })?.code ?? '')
  if (code === 'EACCES' || code === 'EPERM') {
    return { kind: 'held', code, retryable: true, hint: 'another process already owns this port; a wildcard (0.0.0.0) listener can make a loopback bind fail with EACCES instead of EADDRINUSE' }
  }
  if (code === 'EADDRINUSE') {
    return { kind: 'in-use', code, retryable: true, hint: 'another process already owns this port' }
  }
  if (code === 'EADDRNOTAVAIL') {
    return { kind: 'unavailable', code, retryable: false, hint: 'the resolved loopback address is not on this machine' }
  }
  return { kind: 'unknown', code, retryable: false, hint: '' }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function listenOnce(server: import('node:http').Server, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      const bound = server.address()
      resolve(typeof bound === 'object' && bound !== null ? bound.port ?? 0 : 0)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, address)
  })
}

/**
 * Bind the listener, tolerating a port that is *temporarily* or *permanently*
 * someone else's: a closing listener frees within a few hundred milliseconds, so
 * the requested port is worth a few retries before the gateway is declared dead,
 * and a genuinely taken port walks to the next free one rather than leaving the
 * gateway down until the user guesses a different number.
 */
export async function bindGatewayPort(
  server: import('node:http').Server,
  { address, port, attempts = 4, backoffMs = 150, scan = 10, log = () => {} }: {
    address: string
    port: number
    attempts?: number
    backoffMs?: number
    scan?: number
    log?: (message: string) => void
  },
): Promise<{ port: number; requested: number; fellBack: boolean }> {
  const requested = Number.isFinite(Number(port)) && Number(port) > 0 ? Math.trunc(Number(port)) : 0
  if (requested === 0) return { port: await listenOnce(server, 0, address), requested: 0, fellBack: false }
  let last: unknown = null
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return { port: await listenOnce(server, requested, address), requested, fellBack: false }
    } catch (error) {
      last = error
      if (!classifyBindError(error).retryable) throw error
      log(`port ${requested} is not available yet (${String((error as { code?: string })?.code ?? '')}); retrying`)
      if (attempt < attempts - 1) await delay(backoffMs * 2 ** attempt)
    }
  }
  for (let offset = 1; offset <= Math.max(0, scan) && requested + offset <= 65535; offset += 1) {
    try {
      return { port: await listenOnce(server, requested + offset, address), requested, fellBack: true }
    } catch (error) {
      last = error
      if (!classifyBindError(error).retryable) throw error
    }
  }
  void last
  return { port: await listenOnce(server, 0, address), requested, fellBack: true }
}

/**
 * The IPv4 addresses another machine on this network could dial, best first.
 *
 * Physical interfaces come before virtual ones (WSL/Hyper-V/Docker adapters, VPN
 * and tunnel adapters), because a machine commonly holds two private addresses
 * and the one the OS happened to list first is often the one that cannot answer
 * from outside. Re-derived on every ask: a laptop that changed networks holds a
 * different set than it did a minute ago.
 */
export function rankLanAddresses(interfaces: Record<string, import('node:os').NetworkInterfaceInfo[] | undefined>): string[] {
  const VIRTUAL = /(vethernet|hyper-?v|wsl|virtualbox|vmware|docker|br-|veth|tailscale|zerotier|utun|awdl|llw|anpi|^(?:tun|tap|utun)\d|loopback|bluetooth|wi-?fi direct|local area connection\*|virtual)/i
  const rows: { address: string; virtual: boolean }[] = []
  const seen = new Set<string>()
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (entry?.family !== 'IPv4' || entry.internal === true) continue
      const address = String(entry.address ?? '')
      if (address === '' || address.startsWith('169.254.') || seen.has(address)) continue
      seen.add(address)
      rows.push({ address, virtual: VIRTUAL.test(String(name)) })
    }
  }
  rows.sort((a, b) => Number(a.virtual) - Number(b.virtual))
  return rows.map((row) => row.address)
}
