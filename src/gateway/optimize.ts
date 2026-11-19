/**
 * The five local answers that avoid a provider call entirely.
 *
 * Pure request-shape matches: a quota probe, a shell command prefix, a session
 * title, a suggestion-mode turn, a filepath extraction. Each answers a question
 * that carries no information a model can add, so the lane spends nothing — and
 * each is individually switchable, because a false positive would answer a real
 * question with a canned string. Every detector requires an exact marker, and
 * several additionally require the system prompt to be asking the same thing.
 *
 * The token counts are the ones a measured gateway reported, so a harness that
 * records usage sees the same rows and an audit of "why no tokens on that
 * request" finds a row instead of a hole.
 *
 * Ported from dsh's `src/local-optimize.js`.
 *
 * @module pi-extension/gateway/optimize.js
 */

import { createHash, randomUUID } from 'node:crypto'

export const OPTIMIZATIONS = ['quota', 'prefix', 'title', 'suggestion', 'filepath'] as const

export type OptimizationKind = typeof OPTIMIZATIONS[number]

const TWO_WORD_COMMANDS = new Set(['git', 'npm', 'docker', 'kubectl', 'cargo', 'go', 'pip', 'yarn'])
const LISTING_COMMANDS = new Set(['ls', 'dir', 'find', 'tree', 'pwd', 'cd', 'mkdir', 'rmdir', 'rm'])
const READING_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'type'])
const GREP_FLAGS_WITH_ARGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$/
const ESCAPABLE = new Set([' ', '\t', '\n', '\r', '\\', '"', "'", '$', '`'])
const EMPTY_FILEPATHS = '<filepaths>\n</filepaths>'

export interface LocalAnswer {
  kind: OptimizationKind
  text: string
  usage: { input: number; output: number }
}

const QUERY_TAIL = /(?:\?|#|&)[^\s]*$/g
const CALL_MARKER = /@CHAT_MODEL[-\w]*\s*$/i

/**
 * Split a command line into words the way the shell does.
 *
 * Quotes are handled, and the backslash rules differ *inside* double quotes:
 * a `\"` or `\\` or `\$` is an escape, but `\n` inside double quotes is a literal
 * backslash followed by `n` — the shell gives no meaning to that pair there.
 * Outside quotes only whitespace and a short set of punctuation are escapable,
 * so `ls foo\bar` keeps its backslash.
 */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let word: string | null = null
  let quote = ''
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === "'") {
      if (char === "'") quote = ''
      else word += char
      continue
    }
    if (quote === '"') {
      if (char === '"') { quote = ''; continue }
      if (char === '\\') {
        const next = command[index + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          word += next
          index += 1
        } else word += '\\'
        continue
      }
      word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      if (word === null) word = ''
      continue
    }
    if (char === '\\' && ESCAPABLE.has(command[index + 1])) {
      if (word === null) word = ''
      word += command[index + 1]
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v') {
      if (word !== null) { words.push(word); word = null }
      continue
    }
    if (word === null) word = ''
    word += char
  }
  if (quote !== '') throw new Error('no closing quotation')
  if (word !== null) words.push(word)
  return words
}

function isEnvAssignment(part: string): boolean {
  return ENV_ASSIGNMENT.test(part)
}

function stripEnvAssignments(parts: string[]): string[] {
  let start = 0
  for (let index = 0; index < parts.length; index += 1) {
    if (!isEnvAssignment(parts[index])) break
    start = index + 1
  }
  return parts.slice(start)
}

/**
 * The prefix a permission prompt is asking about.
 *
 * A substitution would run a second command, and the prefix is a label for the
 * permission dialog rather than something to execute, so a command carrying one
 * is *reported* (`command_injection_detected`) instead of parsed — answering
 * with a quoted label would let the caller believe it were safe to run.
 */
export function extractCommandPrefix(command: string): string {
  const text = typeof command === 'string' ? command : ''
  if (text.includes('`') || text.includes('$(')) return 'command_injection_detected'

  let parts: string[]
  try {
    parts = shellWords(text)
  } catch {
    const fallback = stripEnvAssignments(text.split(/\s+/).filter((part) => part !== ''))
    return fallback.length > 0 ? fallback[0] : 'none'
  }
  if (parts.length === 0) return 'none'

  const env: string[] = []
  let start = 0
  for (let index = 0; index < parts.length; index += 1) {
    if (!isEnvAssignment(parts[index])) break
    env.push(parts[index])
    start = index + 1
  }
  if (start >= parts.length) return 'none'

  const commandParts = parts.slice(start)
  const first = commandParts[0]
  if (TWO_WORD_COMMANDS.has(first) && commandParts.length > 1) {
    const second = commandParts[1]
    if (!second.startsWith('-')) return `${first} ${second}`
    return first
  }
  // A one-word command keeps its env prefix (`FOO=1 ls`), while the two-word
  // branch above drops it (`FOO=1 git status` answers `git status`). Both are
  // labels for a dialog, not commands.
  return env.length === 0 ? first : `${env.join(' ')} ${first}`
}

function filepathBlock(paths: string[]): string {
  return paths.length === 0 ? EMPTY_FILEPATHS : `<filepaths>\n${paths.join('\n')}\n</filepaths>`
}

/**
 * The file paths a command reads, in the `<filepaths>` block Claude Code parses.
 *
 * A listing command names files without reading them, so there is nothing to
 * extract and the block is empty; a reading command's non-flag arguments are
 * the paths; grep's pattern is not a path and is skipped — except when a flag
 * supplied the pattern, because then every positional is a path.
 */
export function extractFilepathsFromCommand(command: string, output?: string): string {
  void output
  const text = typeof command === 'string' ? command : ''
  let parts: string[]
  try {
    parts = shellWords(text)
  } catch {
    return EMPTY_FILEPATHS
  }
  const commandParts = stripEnvAssignments(parts)
  if (commandParts.length === 0) return EMPTY_FILEPATHS

  const base = commandParts[0].split('/').pop()!.split('\\').pop()!.toLowerCase()
  if (LISTING_COMMANDS.has(base)) return EMPTY_FILEPATHS
  if (READING_COMMANDS.has(base)) {
    return filepathBlock(commandParts.slice(1).filter((part) => !part.startsWith('-')))
  }
  if (base !== 'grep') return EMPTY_FILEPATHS

  let patternViaFlag = false
  const positional: string[] = []
  let skipNext = false
  for (const part of commandParts.slice(1)) {
    if (skipNext) { skipNext = false; continue }
    if (!part.startsWith('-')) { positional.push(part); continue }
    if (part === '-e' || part === '-f' || part === '--regexp') {
      patternViaFlag = true
      skipNext = true
    } else if (part.startsWith('--regexp=')) {
      patternViaFlag = true
    } else if (GREP_FLAGS_WITH_ARGS.has(part)) {
      skipNext = true
    }
  }
  return filepathBlock(patternViaFlag ? positional : positional.slice(1))
}

/** The `Output:` section ends at the first tag or blank line. */
function truncateOutput(output: string): string {
  let text = output
  for (const marker of ['<', '\n\n']) {
    if (text.includes(marker)) text = text.split(marker)[0].trim()
  }
  return text
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (typeof block?.text === 'string') out += block.text
  }
  return out
}

function systemText(request: any): string {
  const system = request?.system
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system.filter((block: any) => typeof block?.text === 'string').map((block: any) => block.text).join('\n\n')
}

function hasTools(request: any): boolean {
  return Array.isArray(request?.tools) && request.tools.length > 0
}

/** The single user turn a supported prompting API hands in, or undefined. */
function singleUserTurn(request: any): any | undefined {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  if (messages.length !== 1) return undefined
  const message = messages[0]
  if (message?.role !== 'user') return undefined
  return message
}

function stripTail(text: string): string {
  return text.replace(QUERY_TAIL, '').replace(CALL_MARKER, '').trim()
}

const ANSWERERS: Record<OptimizationKind, (request: any) => { text: string; usage: { input: number; output: number } } | null> = {
  quota(request: any) {
    const message = singleUserTurn(request)
    if (message === undefined) return null
    const maxTokens = request?.max_tokens
    if (!(maxTokens === 1 || maxTokens === '1')) return null
    if (!textOf(message.content).toLowerCase().includes('quota')) return null
    return { text: 'Quota check passed.', usage: { input: 10, output: 5 } }
  },
  prefix(request: any) {
    const message = singleUserTurn(request)
    if (message === undefined) return null
    const content = textOf(message.content)
    if (!content.includes('<policy_spec>') || !content.includes('Command:')) return null
    // The last marker wins: the policy spec above it may itself quote the word.
    const start = content.lastIndexOf('Command:') + 'Command:'.length
    return { text: stripTail(extractCommandPrefix(content.slice(start).trim())), usage: { input: 100, output: 5 } }
  },
  title(request: any) {
    if (hasTools(request)) return null
    const system = systemText(request).toLowerCase()
    if (!system.includes('title')) return null
    const sentenceCase = system.includes('sentence-case title')
    const jsonField = system.includes('return json') && system.includes('field')
      && (system.includes('coding session') || system.includes('this session'))
    if (!sentenceCase && !jsonField) return null
    return { text: 'Conversation', usage: { input: 100, output: 5 } }
  },
  suggestion(request: any) {
    for (const message of request?.messages ?? []) {
      if (message?.role !== 'user') continue
      if (textOf(message.content).includes('[SUGGESTION MODE:')) {
        return { text: '', usage: { input: 100, output: 1 } }
      }
    }
    return null
  },
  filepath(request: any) {
    const message = singleUserTurn(request)
    if (message === undefined || hasTools(request)) return null
    const content = textOf(message.content)
    if (!content.includes('Command:') || !content.includes('Output:')) return null

    const lower = content.toLowerCase()
    const userNamesFilepaths = lower.includes('filepaths') || lower.includes('<filepaths>')
    const system = systemText(request).toLowerCase()
    const systemAsksForPaths = system.includes('extract any file paths') || system.includes('file paths that this command')
    if (!userNamesFilepaths && !systemAsksForPaths) return null

    const start = content.indexOf('Command:') + 'Command:'.length
    const marker = content.indexOf('Output:', start)
    if (marker === -1) return null
    const command = content.slice(start, marker).trim()
    const output = truncateOutput(content.slice(marker + 'Output:'.length).trim())
    return { text: extractFilepathsFromCommand(command, output), usage: { input: 100, output: 10 } }
  },
}

/**
 * Which optimization answers this request, if any.
 *
 * The first one in the shipped order wins: `quota` is a marker exact enough that
 * a coincidence would still be harmless, and a request that carries two markers
 * is answered by the cheaper of the two.
 */
export function detectOptimization(request: any, enabled?: Partial<Record<OptimizationKind, boolean>>): OptimizationKind | null {
  return firstAnswer(request, enabled)?.kind ?? null
}

function firstAnswer(request: any, enabled?: Partial<Record<OptimizationKind, boolean>>): LocalAnswer | null {
  for (const kind of OPTIMIZATIONS) {
    if (enabled?.[kind] === false) continue
    const answer = ANSWERERS[kind](request)
    if (answer !== null) return { kind, ...answer }
  }
  return null
}

export interface LocalResult {
  kind: OptimizationKind
  text: string
  usage: { input: number; output: number }
  model: string
}

/** Answer the request locally when one of the five optimizations applies. */
export function tryOptimizations(request: any, options: { enabled?: boolean | Partial<Record<OptimizationKind, boolean>>; model?: string } = {}): LocalResult | null {
  const answer = firstAnswer(request, typeof options?.enabled === 'object' ? options.enabled : undefined)
  if (answer === null) return null
  if (options?.enabled === false) return null
  const model = options?.model ?? request?.model
  return { kind: answer.kind, text: answer.text, usage: answer.usage, model: typeof model === 'string' ? model : '' }
}

/** Wrap a local answer in the Anthropic Messages response a caller expects. */
export function toMessagesResponse(result: LocalResult, options: { model?: string; id?: string } = {}) {
  return {
    id: typeof options?.id === 'string' && options.id !== '' ? options.id : `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: options?.model ?? result?.model ?? '',
    content: [{ type: 'text', text: result?.text ?? '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: result?.usage?.input ?? 0, output_tokens: result?.usage?.output ?? 0 },
  }
}

/** A stable id for a local answer, so a repeat of the same request reuses it. */
export function localAnswerId(result: LocalResult): string {
  return createHash('sha256').update(`${result.kind}\n${result.text}`).digest('hex').slice(0, 16)
}
