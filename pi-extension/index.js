/**
 * Our Free Model — pi provider extension.
 *
 * Turns the two keyless upstream lanes this repository already documents and
 * drives into pi model providers, so `pi` can select them like any built-in
 * provider: no login, no sign-up, no API key.
 *
 *   ofm-opencode  OpenCode's public free tier (`opencode.ai`) — free models
 *                 behind a pooled public credential plus a client fingerprint.
 *   ofm-kilo      Kilo AI's public gateway free pool (`api.kilo.ai`) — free
 *                 models with no credential whatsoever.
 *   ofm-chain     fallback chains over both lanes: one selectable name whose
 *                 links are tried in order, the first one that answers wins.
 *
 * Both lanes fetch their roster live from the upstream listing on every load
 * (an offline snapshot keeps the models present before the first refresh), and
 * both stream through pi-ai's OpenAI-Completions implementation so tool calls,
 * thinking, usage and cancellation behave exactly like a built-in provider.
 *
 * @module pi-extension/index.js
 */
import { CHAIN_PREFIX, CHAIN_PROVIDER, chainByName, chainId, decideLink, intersectCapabilities, normalizeChains } from './chains.js'
import { readChains, writeChains } from './chain-store.js'
import { kiloModels, kiloProvider, PROVIDER_ID as KILO_ID } from './kilo.js'
import { opencodeModels, opencodeProvider, PROVIDER_ID as OPENECODE_ID } from './opencode.js'

/** Split command input on `|`, trimming each field. */
function fields(input) {
  return String(input ?? '').split('|').map((field) => field.trim())
}

/** Resolve one `provider/model` address against the live registry. */
function resolveLink(ctx, address) {
  const slash = address.indexOf('/')
  if (slash <= 0 || slash === address.length - 1) return undefined
  return ctx.modelRegistry.find(address.slice(0, slash), address.slice(slash + 1))
}

/** Register (or re-register) one chain as a virtual model. */
function registerChain(pi, chain, ctx) {
  // Limits come from the links that resolve right now; pi replaces them with the
  // dispatched model's own after the first response either way.
  const members = ctx === undefined ? [] : chain.models.map((address) => resolveLink(ctx, address)).filter(Boolean)
  const limits = intersectCapabilities(members)
  pi.registerVirtualModel({
    provider: CHAIN_PROVIDER,
    id: chain.id.slice(CHAIN_PREFIX.length),
    name: chain.name,
    thinkingLevels: limits.thinkingLevels ?? ['off'],
    ...(limits.contextWindow === undefined ? {} : { contextWindow: limits.contextWindow }),
    ...(limits.maxTokens === undefined ? {} : { maxTokens: limits.maxTokens }),
    ...(limits.input === undefined ? {} : { input: limits.input }),
    route: (request, routeCtx) => {
      const links = chain.models.map((address) => resolveLink(routeCtx, address)).filter(Boolean)
      if (links.length === 0) {
        throw new Error(`the chain "${chain.name}" has no link that exists right now: ${chain.models.join(', ')}`)
      }
      const { index, state } = decideLink({ chain, members: links, request })
      const model = links[index]
      return { model, thinkingLevel: clampLevel(request.thinkingLevel, model), state }
    },
  })
}

/** The highest level the picked model actually accepts; `off` always is. */
function clampLevel(level, model) {
  const map = model.thinkingLevelMap
  if (map === undefined) return 'off'
  if (map[level] !== undefined && map[level] !== null) return level
  const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const wanted = order.indexOf(level)
  for (let step = wanted + 1; step < order.length; step += 1) {
    if (map[order[step]] !== undefined && map[order[step]] !== null) return order[step]
  }
  for (let step = wanted - 1; step >= 0; step -= 1) {
    if (map[order[step]] !== undefined && map[order[step]] !== null) return order[step]
  }
  return 'off'
}

/** Register every enabled chain, after the lanes exist to resolve links against. */
function registerChains(pi, chains, ctx) {
  for (const chain of chains) {
    if (chain.enabled === false) continue
    registerChain(pi, chain, ctx)
  }
}

/** Describe the chains for the command's status output. */
function describeChains(ctx, chains) {
  if (chains.length === 0) return 'no chains yet — add one with /ofm chain add'
  return chains
    .map((chain) => {
      const links = chain.models
        .map((address) => `${resolveLink(ctx, address) ? '' : '⚠ '}${address}`)
        .join(' → ')
      return `${chain.enabled === false ? '⏸ ' : '▶ '}${chain.id}  ${chain.name}  [${chain.strategy}]  ${links}`
    })
    .join('\n')
}

/**
 * Register the free lanes and the chains. Async on purpose: pi waits for the
 * factory, so the freshly fetched rosters are visible to `pi --list-models` and
 * startup model selection, and the offline snapshot covers a machine with no
 * route upstream.
 */
export default async function (pi) {
  const [kilo, opencode, chains] = await Promise.all([kiloModels(), opencodeModels(), Promise.resolve(readChains())])

  pi.registerProvider(KILO_ID, kiloProvider({ models: kilo }))
  pi.registerProvider(OPENECODE_ID, opencodeProvider({ models: opencode }))
  registerChains(pi, chains)

  pi.registerCommand('ofm', {
    description: 'Our Free Model: status | refresh | chain [add|remove|enable|disable]',
    handler: async (arg, ctx) => {
      const words = String(arg ?? '').trim().split(/\s+/).filter(Boolean)
      const head = (words[0] ?? 'status').toLowerCase()
      const rest = words.slice(1).join(' ')
      const notify = (message) => {
        if (ctx.hasUI) ctx.ui.notify(message, 'info')
      }

      if (head === 'chain' && (words[1] ?? '').toLowerCase() === 'add') {
        const [name, ...links] = fields(rest.replace(/^add\s+/i, ''))
        if (name === '' || links.length === 0) {
          notify('/ofm chain add <name> | <provider/model> | <provider/model> [| fallback|round-robin]')
          return
        }
        const stored = writeChains([...chains, { id: chainId(name), name, models: links }])
        chains.length = 0
        chains.push(...stored)
        registerChains(pi, stored, ctx)
        notify(`chain ${chainId(name)} added with ${links.length} links`)
        return
      }

      if (head === 'chain' && (words[1] ?? '').toLowerCase() === 'remove') {
        const target = chainByName(chains, words.slice(2).join(' '))
        if (target === undefined) {
          notify(`no chain named "${words.slice(2).join(' ')}"`)
          return
        }
        const stored = writeChains(chains.filter((chain) => chain.id !== target.id))
        chains.length = 0
        chains.push(...stored)
        pi.unregisterVirtualModel(CHAIN_PROVIDER, target.id.slice(CHAIN_PREFIX.length))
        notify(`chain ${target.id} removed`)
        return
      }

      if (head === 'chain' && ['enable', 'disable'].includes((words[1] ?? '').toLowerCase())) {
        const enable = words[1].toLowerCase() === 'enable'
        const target = chainByName(chains, words.slice(2).join(' '))
        if (target === undefined) {
          notify(`no chain named "${words.slice(2).join(' ')}"`)
          return
        }
        const stored = writeChains(chains.map((chain) => (chain.id === target.id ? { ...chain, enabled: enable } : chain)))
        chains.length = 0
        chains.push(...stored)
        if (enable) registerChain(pi, stored.find((chain) => chain.id === target.id), ctx)
        else pi.unregisterVirtualModel(CHAIN_PROVIDER, target.id.slice(CHAIN_PREFIX.length))
        notify(`chain ${target.id} ${enable ? 'enabled' : 'disabled'}`)
        return
      }

      if (head === 'chain') {
        notify(describeChains(ctx, chains))
        return
      }

      if (head === 'refresh') {
        const [nextKilo, nextOpencode] = await Promise.all([kiloModels(), opencodeModels()])
        pi.unregisterProvider(KILO_ID)
        pi.unregisterProvider(OPENECODE_ID)
        pi.registerProvider(KILO_ID, kiloProvider({ models: nextKilo }))
        pi.registerProvider(OPENECODE_ID, opencodeProvider({ models: nextOpencode }))
        notify(`refreshed: ofm-kilo ${nextKilo.length} models · ofm-opencode ${nextOpencode.length} models`)
        return
      }

      notify(`ofm-kilo: ${ctx.modelRegistry.getModelsOfType('chat', KILO_ID).length} free models · ofm-opencode: ${ctx.modelRegistry.getModelsOfType('chat', OPENECODE_ID).length} free models · chains: ${chains.length}`)
    },
  })
}

/** Exported for the chain tests, which drive the same routing decision. */
export const internals = { registerChain, clampLevel, intersectCapabilities, normalizeChains }
