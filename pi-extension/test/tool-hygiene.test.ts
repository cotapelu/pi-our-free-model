import assert from 'node:assert/strict'

const { renumberToolCalls, DECOY_TOOL_NAMES, rewriteSseFrames } = await import('../dist/gateway/response-stream.js')

const encoder = new TextEncoder()

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function toStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value, { stream: true })
  }
  return out
}

function testRenumberToolCalls() {
  // Empty input
  assert.deepEqual(renumberToolCalls([]), { calls: [], count: 0 })

  // Single call, already index 0
  assert.deepEqual(renumberToolCalls([{ id: 'call_1', name: 'my_tool', arguments: '{}' }]), {
    calls: [{ id: 'call_1', name: 'my_tool', arguments: '{}' }],
    count: 1,
  })

  // Multiple calls with sparse upstream indices
  assert.deepEqual(renumberToolCalls([
    { id: 'call_a', name: 'tool_a', arguments: '{}' },
    { id: 'call_b', name: 'tool_b', arguments: '{}' },
  ]), {
    calls: [
      { id: 'call_a', name: 'tool_a', arguments: '{}' },
      { id: 'call_b', name: 'tool_b', arguments: '{}' },
    ],
    count: 2,
  })

  // Decoy calls are dropped (read and shell)
  assert.deepEqual(renumberToolCalls([
    { id: 'call_1', name: 'read', arguments: '{}"path":"/tmp"}' },
    { id: 'call_2', name: 'my_tool', arguments: '{}' },
    { id: 'call_3', name: 'shell', arguments: '"echo hi"' },
  ]), {
    calls: [{ id: 'call_2', name: 'my_tool', arguments: '{}' }],
    count: 1,
  })

  // All decoys
  assert.deepEqual(renumberToolCalls([
    { id: 'call_1', name: 'read', arguments: '{}' },
    { id: 'call_2', name: 'shell', arguments: '{}' },
  ]), { calls: [], count: 0 })

  // Missing id gets synthesized
  assert.deepEqual(renumberToolCalls([{ name: 'my_tool', arguments: '{}' }]), {
    calls: [{ id: 'call_0', name: 'my_tool', arguments: '{}' }],
    count: 1,
  })

  console.log('ok - renumberToolCalls')
}

async function testRewriteSseFramesRenumbersAndSuppresses() {
  // aliases simulates the real flow: request side renamed read → read_ofm1,
  // response side restores read_ofm1 → read, then read is suppressed as decoy.
  const aliases = new Map<string, string>([['read_ofm1', 'read'], ['shell_ofm1', 'shell']])
  const body = toStream(sse({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [
          { index: 5, id: 'call_1', type: 'function', function: { name: 'read_ofm1', arguments: '{}' } },
          { index: 5, id: 'call_2', type: 'function', function: { name: 'my_tool', arguments: '{"a":1}' } },
          { index: 7, id: 'call_3', type: 'function', function: { name: 'shell_ofm1', arguments: '{}' } },
        ],
      },
    }],
  }))
  const rewritten = rewriteSseFrames(body, aliases, false)
  const text = await collect(rewritten)
  const lines = text.trim().split('\n\n')
  const dataLine = lines.find((l) => l.startsWith('data: '))
  assert(dataLine !== undefined, 'expected a data frame')
  const payload = JSON.parse(dataLine.slice('data: '.length))
  const calls = payload.choices?.[0]?.delta?.tool_calls ?? []
  assert.equal(calls.length, 1, 'should keep only 1 non-decoy call')
  assert.equal(calls[0]?.index, 0, 'index should be renumbered to 0')
  assert.equal(calls[0]?.function?.name, 'my_tool')
  console.log('ok - rewriteSseFrames renumbers and suppresses decoys')
}

async function testRewriteSseFramesWithAliases() {
  const aliases = new Map<string, string>([['read_ofm1', 'read']])
  const body = toStream(sse({
    id: 'chatcmpl-2',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'read_ofm1', arguments: '{}' } },
        ],
      },
    }],
  }))
  const rewritten = rewriteSseFrames(body, aliases, false)
  const text = await collect(rewritten)
  const lines = text.trim().split('\n\n')
  const dataLine = lines.find((l) => l.startsWith('data: '))
  assert(dataLine !== undefined)
  const payload = JSON.parse(dataLine.slice('data: '.length))
  const calls = payload.choices?.[0]?.delta?.tool_calls ?? []
  assert.equal(calls.length, 0, 'read decoy should be suppressed after alias restore')
  console.log('ok - rewriteSseFrames suppresses read decoy after alias restore')
}

async function testRewriteSseFramesPreservesNonToolFrames() {
  // A frame with no tool calls should pass through unchanged
  const aliases = new Map<string, string>()
  const body = toStream(sse({
    id: 'chatcmpl-3',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: 'hello' },
    }],
  }))
  const rewritten = rewriteSseFrames(body, aliases, false)
  const text = await collect(rewritten)
  assert(text.includes('"content":"hello"'), 'content should be preserved')
  console.log('ok - rewriteSseFrames preserves non-tool frames')
}

testRenumberToolCalls()
await testRewriteSseFramesRenumbersAndSuppresses()
await testRewriteSseFramesWithAliases()
await testRewriteSseFramesPreservesNonToolFrames()
