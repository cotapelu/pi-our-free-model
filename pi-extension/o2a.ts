/**
 * Barrel re-export of the o2a modules, keeping the `src/o2a.js` import path
 * working for code ported from dsh's `src/upstream.js`, `src/messages.js`,
 * `src/forward.js`, etc.
 *
 * @module pi-extension/o2a.js
 */

export { BASE62_ALPHABET, CANONICAL_SESSION_RE, DESCENDING_TIME_RE } from './o2a/identity.js'
export { sessionPhaseMs, phaseAgeMs, canonicalSessionID, randomProjectID, isOfficialSessionID, randomID } from './o2a/identity.js'
export { CLIENT_UA, O2A_VERSION } from './o2a/version.js'
export { officialTool, officialToolset, renamableToolName } from './o2a/official-tools.js'
export { renameAndCompleteTools } from './o2a/toolshape.js'
export { ToolRenameMap } from './o2a/tool-renames.js'
export { injectOfficialPrompt } from './o2a/official-prompt.js'
export { ensureChatUsage, ensureV2CompletionLimit } from './o2a/gateway-body.js'
export { officialToolsText } from './o2a/asset-source.js'
export { gatewayHeaders } from './o2a/headers.js'