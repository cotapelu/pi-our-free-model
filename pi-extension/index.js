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
 *
 * Both lanes fetch their roster live from the upstream listing on every load
 * (an offline snapshot keeps the models present before the first refresh), and
 * both stream through pi-ai's OpenAI-Completions implementation so tool calls,
 * thinking, usage and cancellation behave exactly like a built-in provider.
 *
 * @module pi-extension/index.js
 */
import { kiloModels, kiloProvider, PROVIDER_ID as KILO_ID } from './kilo.js'
import { opencodeModels, opencodeProvider, PROVIDER_ID as OPENECODE_ID } from './opencode.js'

/**
 * Register the free lanes. Async on purpose: pi waits for the factory, so the
 * freshly fetched rosters are visible to `pi --list-models` and startup model
 * selection, and the offline snapshot covers a machine with no route upstream.
 */
export default async function (pi) {
  const [kilo, opencode] = await Promise.all([kiloModels(), opencodeModels()])

  pi.registerProvider(KILO_ID, kiloProvider({ models: kilo }))
  pi.registerProvider(OPENECODE_ID, opencodeProvider({ models: opencode }))

  pi.registerCommand('ofm', {
    description: 'Our Free Model: status, or /ofm refresh to re-fetch the live rosters',
    handler: async (arg, ctx) => {
      const verb = String(arg ?? '').trim().toLowerCase()
      if (verb !== '' && verb !== 'status' && verb !== 'refresh') {
        ctx.ui.notify('/ofm [status|refresh] — refresh re-fetches both upstream rosters', 'info')
        return
      }
      if (verb === 'status') {
        const kiloCount = ctx.modelRegistry.getModelsOfType('chat', KILO_ID).length
        const opencodeCount = ctx.modelRegistry.getModelsOfType('chat', OPENECODE_ID).length
        ctx.ui.notify(`ofm-kilo: ${kiloCount} free models · ofm-opencode: ${opencodeCount} free models`, 'info')
        return
      }
      const [nextKilo, nextOpencode] = await Promise.all([kiloModels(), opencodeModels()])
      pi.unregisterProvider(KILO_ID)
      pi.unregisterProvider(OPENECODE_ID)
      pi.registerProvider(KILO_ID, kiloProvider({ models: nextKilo }))
      pi.registerProvider(OPENECODE_ID, openencodeProvider({ models: nextOpencode }))
      if (ctx.hasUI) {
        ctx.ui.notify(`refreshed: ofm-kilo ${nextKilo.length} models · ofm-opencode ${nextOpencode.length} models`, 'info')
      }
    },
  })
}
