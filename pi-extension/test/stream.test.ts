/**
 * Unit checks for the provider SSE → harness chunk projection.
 *
 * Three wires are in play (`chat`, `messages`, `responses`) and the properties
 * this suite pins are the ones a decoder gets wrong in a way the user feels:
 *
 *   1. **usage is disjoint, not the raw total** — `inputTokens` is uncached
 *      input only, so the OpenAI `prompt_tokens` total has its cache hits
 *      subtracted back out;
 *   2. **a stream cut mid-answer is not a finished turn** — `readStream` reports
 *      `sawFinish: false`, and a broken tool call (arguments that never parse)
 *      flags the turn rather than letting the harness execute it;
 *   3. **the thinking menu is read under every spelling** — `reasoning`,
 *      `reasoning_content`, `reasoning_text`, `thinking` and the Anthropic
 *      `thinking_delta` all land as reasoning blocks.
 *
 * Runs on plain node:  node test/stream.test.ts
 */
import assert from 'node:assert/strict'
import { BlockSink, finishReason, mapUsage, readStream, sanitizeUsage, windowTokens } from '../dist/stream.js'

let failures = 0
const check = (label: string, fn: () => void | Promise<void>) => {
  Promise.resolve().then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((error: any) => { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) })
}

/** Feed one array of raw `data:` payloads as an async iterable of strings. */
function frames(payloads: any[]): AsyncIterable<string> {
  return (async function* () {
    for (const payload of payloads) yield typeof payload === 'string' ? payload : JSON.stringify(payload)
  })()
}

/** Drive readStream to completion, collecting every emitted chunk. */
async function drain(wire: 'chat' | 'messages' | 'responses', payloads: any[], renameMap = new Map<string, string>(), options: any = {}) {
  const chunks: any[] = []
  const iterator = readStream(frames(payloads), wire, renameMap, () => 1000, options)
  while (true) {
    const row = await iterator.next()
    if (row.done) return { chunks, snapshot: row.value }
    chunks.push(row.value)
  }
}

// ── mapUsage ─────────────────────────────────────────────────────────────────
check('usage is disjoint: prompt_tokens minus its cache hits', () => {
  const usage = mapUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 } })
  assert.equal(usage!.inputTokens, 200)
  assert.equal(usage!.outputTokens, 200)
  assert.equal(usage!.cacheReadTokens, 800)
  assert.equal(usage!.totalTokens, 1200)
})

check('an absent details block is zero, not NaN', () => {
  // The durable session log rejects a non-finite number outright, so an absent
  // cache count must default to zero *before* the subtraction.
  const usage = mapUsage({ prompt_tokens: 500, completion_tokens: 50 })
  assert.equal(usage!.inputTokens, 500)
  assert.equal(usage!.cacheReadTokens, undefined)
  assert.equal(usage!.totalTokens, 550)
  assert.ok(Number.isFinite(usage!.inputTokens))
})

check('reasoning tokens only appear when the provider reports some', () => {
  assert.equal(mapUsage({ prompt_tokens: 1, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 4 } })!.reasoningTokens, 4)
  assert.equal(mapUsage({ prompt_tokens: 1, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 0 } })!.reasoningTokens, undefined)
})

check('the Anthropic spelling maps onto the same disjoint shape', () => {
  const usage = mapUsage({ input_tokens: 900, output_tokens: 80, input_tokens_details: { cached_tokens: 400 } })
  assert.equal(usage!.inputTokens, 500)
  assert.equal(usage!.outputTokens, 80)
})

check('an empty or non-object usage is undefined, not zeros', () => {
  assert.equal(mapUsage(undefined), undefined)
  assert.equal(mapUsage(null), undefined)
  assert.equal(mapUsage('nope'), undefined)
  assert.equal(mapUsage({}), undefined)
})

// ── sanitizeUsage / windowTokens ─────────────────────────────────────────────
check('an over-window stamp keeps decode counts but drops input pressure', () => {
  const usage = { inputTokens: 300000, outputTokens: 500, reasoningTokens: 100, totalTokens: 300500 }
  const trusted = sanitizeUsage(usage, 131072)
  assert.equal(trusted.inputTokens, 0)
  assert.equal(trusted.outputTokens, 500)
  assert.equal(trusted.reasoningTokens, 100)
  assert.equal(trusted.totalTokens, undefined)
})

check('an in-window stamp is returned untouched', () => {
  const usage = { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 }
  assert.equal(sanitizeUsage(usage, 131072), usage)
})

check('a stamp with nothing left to keep is dropped entirely', () => {
  assert.equal(sanitizeUsage({ inputTokens: 999999, outputTokens: 0, totalTokens: 999999 }, 131072), undefined)
})

check('windowTokens removes unstreamed reasoning from the numerator', () => {
  // Billed for thinking that never streamed: counting it attributes a whole
  // thinking phase to the seconds the answer took.
  assert.equal(windowTokens({ outputTokens: 422, reasoningTokens: 291 }, false), 131)
  assert.equal(windowTokens({ outputTokens: 422, reasoningTokens: 291 }, true), 422)
  assert.equal(windowTokens({ outputTokens: 100 }, false), 100)
  assert.equal(windowTokens(undefined, false), 0)
})

// ── finishReason ─────────────────────────────────────────────────────────────
check('every provider finish token maps onto one harness reason', () => {
  assert.deepEqual(finishReason('stop'), { kind: 'stop' })
  assert.deepEqual(finishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(finishReason('tool_use'), { kind: 'tool-calls' })
  assert.deepEqual(finishReason('function_call'), { kind: 'tool-calls' })
  assert.deepEqual(finishReason('length'), { kind: 'max-tokens' })
  assert.deepEqual(finishReason('max_tokens'), { kind: 'max-tokens' })
  assert.deepEqual(finishReason('incomplete'), { kind: 'max-tokens' })
})

check('the Anthropic stop reasons map the same way', () => {
  assert.deepEqual(finishReason('end_turn'), { kind: 'stop' })
  assert.deepEqual(finishReason('stop_sequence'), { kind: 'stop' })
})

// ── BlockSink ────────────────────────────────────────────────────────────────
check('a tool call without a provider id gets a minted stand-in', () => {
  const chunks: any[] = []
  const sink = new BlockSink(chunk => chunks.push(chunk), 0, 8192)
  sink.toolStart('c0', '', 'read')
  sink.toolArgs('c0', '{}')
  sink.closeAll()
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.ok(call.block.id.startsWith('call_'), `the id was not minted: ${call.block.id}`)
  assert.equal(call.block.name, 'read')
})

check('a call with no name is a broken call, not an executable one', () => {
  const sink = new BlockSink(() => {}, 0, 8192)
  sink.toolStart('c0', 'call_x', '')
  sink.toolArgs('c0', '{"path":"a"}')
  sink.closeAll()
  assert.equal(sink.brokenToolCall, true)
})

check('arguments that never parse are flagged only when structurally cut', () => {
  const complete = new BlockSink(() => {}, 0, 8192)
  complete.toolStart('c0', 'id', 'read')
  complete.toolArgs('c0', 'not json at all')
  complete.closeAll()
  assert.equal(complete.brokenToolCall, false, 'a complete-but-invalid value must not look like a cut')

  const cut = new BlockSink(() => {}, 0, 8192)
  cut.toolStart('c0', 'id', 'read')
  cut.toolArgs('c0', '{"path":"a.txt"')
  cut.closeAll()
  assert.equal(cut.brokenToolCall, true, 'an unclosed bracket must flag the turn')
})

check('a parallel-call batch gets one block per wire index', () => {
  const chunks: any[] = []
  const sink = new BlockSink(chunk => chunks.push(chunk), 0, 8192)
  sink.toolStart(sink.toolKey({ index: 0 }), 'id_a', 'read')
  sink.toolArgs('c0', '{}')
  sink.toolStart(sink.toolKey({ index: 1 }), 'id_b', 'write')
  sink.toolArgs('c1', '{}')
  sink.closeAll()
  const calls = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(calls.length, 2, `expected 2 calls, got ${calls.length}`)
  assert.deepEqual(calls.map(call => call.block.name), ['read', 'write'])
})

check('DSML control markup is scrubbed from visible text as it flows', () => {
  const chunks: any[] = []
  const sink = new BlockSink(chunk => chunks.push(chunk), 0, 8192)
  sink.text('t', 'hello <｜DSML｜ calls> world')
  const deltas = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)
  assert.ok(!deltas.join('').includes('DSML'), 'the control markup leaked through')
  assert.ok(deltas.join('').includes('hello'), 'real text was dropped with the markup')
})

check('a tail that could still complete into the opening is held back', () => {
  const chunks: any[] = []
  const sink = new BlockSink(chunk => chunks.push(chunk), 0, 8192)
  sink.text('t', 'answer <｜DSML')
  const held = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(held, 'answer ', 'an unresolvable tail was emitted early')
  // The next delta resolves it into a complete tag, which is then scrubbed.
  sink.text('t', '｜ calls> and more')
  const rest = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(rest, 'answer  and more')
})

// ── readStream: the chat wire ────────────────────────────────────────────────
check('chat: text and reasoning deltas become harness chunks', async () => {
  const { chunks, snapshot } = await drain('chat', [
    { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking' } }] },
    { choices: [{ index: 0, delta: { content: 'answer' } }] },
    {},
  ])
  const kinds = chunks.map(chunk => chunk.type)
  assert.ok(kinds.includes('reasoning-delta'))
  assert.ok(kinds.includes('text-delta'))
  assert.equal(snapshot.sawReasoning, true)
  assert.equal(snapshot.sawText, true)
  assert.equal(snapshot.sawFinish, false, 'a stream with no finish token is not finished')
})

check('chat: a usage frame is accumulated and the finish token recorded', async () => {
  const { snapshot } = await drain('chat', [
    { choices: [{ index: 0, delta: { content: 'hi' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ])
  assert.equal(snapshot.sawFinish, true)
  assert.equal(snapshot.finish, 'stop')
  assert.equal(snapshot.usage.outputTokens, 2)
})

check('chat: an in-stream error is classified, not swallowed', async () => {
  let thrown: any
  try {
    await drain('chat', [{ error: { message: 'quota exceeded', code: 'rate_limit' } }])
  } catch (error: any) { thrown = error }
  assert.ok(thrown !== undefined, 'the in-stream error was swallowed')
  assert.equal(thrown.kind, 'rate_limit')
})

check('chat: the fingerprint rename map restores the caller tool spelling', async () => {
  const renameMap = new Map([['read_client', 'read']])
  const { chunks } = await drain('chat', [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_client' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ], renameMap)
  const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(end.block.name, 'read', 'the alias was not restored')
})

// ── readStream: the Anthropic messages wire ───────────────────────────────────
check('messages: content_block text and thinking deltas land in their own blocks', async () => {
  const { chunks, snapshot } = await drain('messages', [
    { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ])
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'hmm'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'done'))
  assert.equal(snapshot.finish, 'end_turn')
  // message_start's prompt count survives the output-only message_delta.
  assert.equal(snapshot.usage.inputTokens, 30)
  assert.equal(snapshot.usage.outputTokens, 7)
})

check('messages: a tool_use block carries its id, name and assembled arguments', async () => {
  const { chunks } = await drain('messages', [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"a.txt"}' } },
    { type: 'message_stop' },
  ])
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(call.block.id, 'toolu_1')
  assert.equal(call.block.name, 'read')
  assert.deepEqual(JSON.parse(call.block.arguments), { path: 'a.txt' })
})

check('messages: message_stop is a deliberate ending even with no stop_reason', async () => {
  const { snapshot } = await drain('messages', [{ type: 'message_stop' }])
  assert.equal(snapshot.sawFinish, true)
  // It marks the end but must not erase a token a status frame already gave.
  assert.equal(snapshot.finish, undefined)
})

// ── readStream: the OpenAI responses wire ────────────────────────────────────
check('responses: output_text and reasoning summary deltas land separately', async () => {
  const { chunks, snapshot } = await drain('responses', [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', output_index: 0, delta: 'think' },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'say' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 3 } } },
  ])
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta'))
  assert.equal(snapshot.finish, 'stop')
  assert.equal(snapshot.usage.outputTokens, 3)
})

check('responses: a max_output_tokens incomplete reason reads as max-tokens', async () => {
  const { snapshot } = await drain('responses', [
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'partial' },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
  ])
  assert.equal(snapshot.finish, 'length')
  // The provider token survives; the caller maps it onto a harness reason.
  assert.deepEqual(finishReason(snapshot.finish), { kind: 'max-tokens' })
})

check('responses: every deliberate ending is a finish, not a cut', async () => {
  for (const type of ['response.completed', 'response.incomplete', 'response.done']) {
    const { snapshot } = await drain('responses', [
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'x' },
      { type, response: { status: type === 'response.completed' ? 'completed' : undefined } },
    ])
    assert.equal(snapshot.sawFinish, true, `${type} was read as a cut stream`)
  }
})

check('responses: a failed response is thrown as a classified failure', async () => {
  let thrown: any
  try {
    await drain('responses', [
      { type: 'response.failed', response: { status: 'failed', error: { message: 'region not allowed', code: 'region_blocked' } } },
    ])
  } catch (error: any) { thrown = error }
  assert.ok(thrown !== undefined, 'the failed response was swallowed')
  assert.equal(thrown.kind, 'unavailable')
})

check('responses: a function_call item streams its arguments deltas', async () => {
  const { chunks } = await drain('responses', [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'fc1', name: 'read' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '{"path":"a"}' },
    { type: 'response.completed', response: { status: 'completed' } },
  ])
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(call.block.name, 'read')
  assert.deepEqual(JSON.parse(call.block.arguments), { path: 'a' })
})

// ── the checkpoint ───────────────────────────────────────────────────────────
check('a reasoning-only stream keeps a checkpoint the recovery path can use', async () => {
  const long = 'x'.repeat(2000)
  const { snapshot } = await drain('chat', [
    { choices: [{ index: 0, delta: { reasoning_content: long } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ], new Map(), { checkpointLimit: 1000 })
  assert.equal(snapshot.sawFinish, true, 'a stopped turn reports no finish')
  assert.equal(snapshot.reasoningText.length <= 1000, true)
  assert.equal(snapshot.checkpointTruncated, true)
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 200)
