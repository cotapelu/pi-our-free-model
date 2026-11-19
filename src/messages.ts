/**
 * Harness message vocabulary <-> upstream wire shapes, plus the SSE readers that
 * turn provider events back into harness `StreamChunk`s.
 *
 * Three provider shapes are in play because the free lane is not one API:
 * `chat` (OpenAI Chat Completions), `responses` (OpenAI Responses) and
 * `messages` (Anthropic Messages). Which one a model answers on is fixed by
 * `wireFor` in upstream.ts.
 *
 * Ported from dsh's `src/messages.js`.
 *
 * @module pi-extension/messages.js
 */

import { baseModelId, restoreToolName, toToolDefs, needsVision } from './upstream.js'

/** Content types an image lane can carry, matched against the verified media type. */
const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Text of a content block list, joining every text-bearing block. */
function textOf(blocks: any[] | undefined): string {
  const parts: string[] = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Normalise a message's content into a block list.
 */
function blocksOf(content: any): any[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === 'string') return { type: 'text', text: part }
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') return { type: 'text', text: String(part.text ?? '') }
      return part
    }).filter((block: any) => block !== null && typeof block === 'object')
  }
  return []
}

function hasBlocks(blocks: any[] | undefined, type: string): boolean {
  return Array.isArray(blocks) && blocks.some((block: any) => block?.type === type)
}

/** A user image block's data URL, or undefined when it cannot travel. */
function imageDataUrl(block: any, resolveImage?: (attachment: any) => string | undefined): string | undefined {
  if (block?.offloaded === true) return undefined
  return resolveImage?.(block.attachment) ?? (typeof block.attachment?.url === 'string' ? block.attachment.url : undefined)
}

/**
 * The tool results one message carries, in whichever vocabulary the kernel wrote it.
 */
function toolResultsOf(message: any): { callId: string; content: any[]; isError: boolean }[] {
  if (message?.role === 'tool') {
    const id = callIdOf(message)
    return id === null ? [] : [{ callId: id, content: blocksOf(message.content), isError: message.isError === true }]
  }
  const out: { callId: string; content: any[]; isError: boolean }[] = []
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? message?.source?.callId ?? '')
    if (id === '') continue
    out.push({ callId: id, content: blocksOf(block.content), isError: block.isError === true })
  }
  return out
}

function callIdOf(message: any): string | null {
  const id = String(message?.toolCallId ?? message?.source?.callId ?? '')
  return id === '' ? null : id
}

/**
 * Drop tool calls that were never answered, and answers with no call.
 */
export function repairToolPairing(messages: any[] | undefined): any[] {
  const list = messages ?? []
  const answered = new Set<string>()
  for (const message of list) {
    for (const result of toolResultsOf(message)) answered.add(result.callId)
  }

  const keptCalls = new Set<string>()
  const out: any[] = []
  for (const message of list) {
    const results = toolResultsOf(message)
    if (results.length > 0) {
      if (message.role === 'tool') {
        if (keptCalls.has(results[0].callId)) out.push(message)
        continue
      }
      const kept = new Set(results.filter((result: any) => keptCalls.has(result.callId)).map((result: any) => result.callId))
      const blocks = blocksOf(message.content)
      const rest = blocks.filter((block: any) => block?.type !== 'tool-result'
        || kept.has(String(block.toolCallId ?? message.source?.callId ?? '')))
      if (rest.length === blocks.length) out.push(message)
      else if (rest.length > 0) out.push({ ...message, content: rest })
      continue
    }
    if (message?.role === 'tool') continue
    if (message?.role !== 'assistant') {
      out.push(message)
      continue
    }
    const blocks = blocksOf(message.content)
    const toolBlocks = blocks.filter((block: any) => block?.type === 'tool-call')
    const calls = toolBlocks.filter((block: any) =>
      answered.has(String(block.id ?? '')) && String(block.name ?? '') !== ''
    )
    for (const call of calls) keptCalls.add(String(call.id))
    if (calls.length === toolBlocks.length) {
      if (calls.length > 0 || blocks.some((block: any) => block?.type === 'text' && block.text)) out.push(message)
      continue
    }
    if (calls.length === 0) {
      if (blocks.some((block: any) => block?.type === 'text' && block.text)) {
        out.push({ ...message, content: blocks.filter((block: any) => block?.type !== 'tool-call') })
      }
      continue
    }
    out.push({ ...message, content: blocks.filter((block: any) =>
      block?.type !== 'tool-call' || calls.some((c: any) => c.id === block.id)) })
  }

  return out
}

/**
 * Project harness messages onto OpenAI Chat Completions.
 */
export function toChatMessages(messages: any[] | undefined, resolveImage?: (attachment: any) => string | undefined, warnings?: string[]): any[] {
  const out: any[] = []
  const followUp: any[] = []
  const flushFollowUp = () => {
    if (followUp.length > 0) out.push({ role: 'user', content: followUp.splice(0) })
  }
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (results.length === 0) flushFollowUp()
    let blocks = blocksOf(message.content)
    if (results.length > 0) {
      for (const result of results) {
        const images: any[] = []
        for (const block of result.content) {
          if (block?.type !== 'image') continue
          const url = imageDataUrl(block, resolveImage)
          if (url !== undefined) images.push({ type: 'image_url', image_url: { url } })
          else if (warnings) warnings.push('image-dropped')
        }
        const text = textOf(result.content)
        out.push({ role: 'tool', tool_call_id: result.callId, content: text || (images.length > 0 ? '(see attached image)' : '(no output)') })
        if (images.length > 0) {
          followUp.push({ type: 'text', text: `The result of tool call ${result.callId} is ${images.length} image(s), attached below.` }, ...images)
        }
      }
      blocks = blocks.filter((block: any) => block?.type !== 'tool-result')
    }
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text) out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const parts: any[] = []
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') {
            const url = imageDataUrl(block, resolveImage)
            if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
            else if (warnings) warnings.push('image-dropped')
          }
        }
        if (parts.length === 0) {
          const fallback = textOf(blocks)
          if (fallback) out.push({ role: 'user', content: fallback })
          break
        }
        if (results.length > 0) followUp.push(...parts)
        else out.push({
          role: 'user',
          content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
        })
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls: any[] = []
        for (const block of blocks) {
          if (block?.type === 'tool-call') {
            calls.push({
              id: String(block.id ?? ''),
              type: 'function',
              function: { name: String(block.name ?? ''), arguments: typeof block.arguments === 'string' ? block.arguments : '{}' },
            })
          }
        }
        if (!text && calls.length === 0) break
        const entry: any = { role: 'assistant', content: text || null }
        if (typeof message.reasoning_content === 'string') entry.reasoning_content = message.reasoning_content
        if (calls.length > 0) entry.tool_calls = calls
        out.push(entry)
        break
      }
      case 'tool': break
      default: break
    }
  }
  flushFollowUp()
  return out
}

/** A Claude `image` block from a resolved image URL, or undefined when it cannot travel. */
function claudeImageBlock(url: string | undefined, warnings?: string[]): { type: string; source: { type: string; media_type: string; data: string } } | undefined {
  if (url === undefined) {
    if (warnings) warnings.push('image-dropped')
    return undefined
  }
  const comma = String(url).indexOf(',')
  const head = comma === -1 ? '' : String(url).slice(0, comma)
  const media = head.match(/data:([^;]+)/)?.[1]
  if (media === undefined || !IMAGE_MEDIA.has(media)) {
    if (warnings) warnings.push('image-dropped')
    return undefined
  }
  return { type: 'image', source: { type: 'base64', media_type: media, data: String(url).slice(comma + 1) } }
}

/** Project harness messages onto the Anthropic Messages shape. */
export function toClaudeMessages(messages: any[] | undefined, resolveImage?: (attachment: any) => string | undefined, warnings?: string[]): { system: string | undefined; messages: any[] } {
  const out: any[] = []
  let systemText = ''
  const push = (role: string, blocks: any[]) => {
    const previous = out[out.length - 1]
    if (previous?.role === role) previous.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(blocksOf(message.content))
      if (text) systemText = systemText ? `${systemText}\n\n${text}` : text
      continue
    }
    if (results.length > 0) {
      const lead: any[] = []
      for (const result of results) {
        const inner: any[] = []
        for (const block of result.content) {
          if (block?.type === 'text' && block.text) inner.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') {
            const image = claudeImageBlock(imageDataUrl(block, resolveImage), warnings)
            if (image !== undefined) inner.push(image)
          }
        }
        lead.push({
          type: 'tool_result', tool_use_id: result.callId,
          content: inner.length > 0 ? inner : [{ type: 'text', text: '(no output)' }],
          is_error: result.isError,
        })
      }
      push('user', lead)
      if (message.role === 'tool') continue
    }
    const blocks = blocksOf(message.content).filter((block: any) => block?.type !== 'tool-result')
    const content: any[] = []
    for (const block of blocks) {
      if (block?.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
      else if (block?.type === 'tool-call') {
        let input: any = {}
        try { input = JSON.parse(block.arguments || '{}') } catch { input = {} }
        content.push({ type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input })
      } else if (block?.type === 'image') {
        const image = claudeImageBlock(imageDataUrl(block, resolveImage), warnings)
        if (image !== undefined) content.push(image)
      }
    }
    if (content.length === 0) continue
    push(message.role === 'assistant' ? 'assistant' : 'user', content)
  }
  return { system: systemText || undefined, messages: out }
}

/** Project harness messages onto the OpenAI Responses input item list. */
export function toResponseInput(messages: any[] | undefined, resolveImage?: (attachment: any) => string | undefined, warnings?: string[]): any[] {
  const out: any[] = []
  const followUp: any[] = []
  const flushFollowUp = () => {
    if (followUp.length > 0) out.push({ type: 'message', role: 'user', content: followUp.splice(0) })
  }
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (results.length === 0) flushFollowUp()
    if (results.length > 0) {
      for (const result of results) {
        const images: any[] = []
        for (const block of result.content) {
          if (block?.type !== 'image') continue
          const url = imageDataUrl(block, resolveImage)
          if (url !== undefined) images.push({ type: 'input_image', image_url: url })
          else if (warnings) warnings.push('image-dropped')
        }
        const text = textOf(result.content)
        out.push({
          type: 'function_call_output', call_id: result.callId,
          output: text || (images.length > 0 ? '(see attached image)' : '(no output)'),
        })
        if (images.length > 0) {
          followUp.push({ type: 'input_text', text: `The result of tool call ${result.callId} is ${images.length} image(s), attached below.` }, ...images)
        }
      }
    }
    if (message.role === 'tool') continue
    const blocks = blocksOf(message.content).filter((block: any) => block?.type !== 'tool-result')
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(blocks)
      if (text) out.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text }] })
      continue
    }
    if (message.role === 'assistant') {
      const text = textOf(blocks)
      if (text) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const block of blocks) {
        if (block?.type === 'tool-call') {
          out.push({ type: 'function_call', call_id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: typeof block.arguments === 'string' ? block.arguments : '{}' })
        }
      }
      continue
    }
    const parts: any[] = []
    for (const block of blocks) {
      if (block?.type === 'text' && block.text) parts.push({ type: 'input_text', text: block.text })
      else if (block?.type === 'image') {
        const url = imageDataUrl(block, resolveImage)
        if (url !== undefined) parts.push({ type: 'input_image', image_url: url })
        else if (warnings) warnings.push('image-dropped')
      }
    }
    if (parts.length > 0) {
      if (results.length > 0) followUp.push(...parts)
      else out.push({ type: 'message', role: 'user', content: parts })
    }
  }
  flushFollowUp()
  return out
}

export { baseModelId, restoreToolName, toToolDefs, needsVision }
