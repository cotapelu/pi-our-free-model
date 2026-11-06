/**
 * Unit checks for the five local answers.
 *
 * The contract that must not pass by luck: a detector that fires on a real
 * question would answer it with a canned string, so every one has to hold for its
 * own marker and refuse everything else — including requests that merely look
 * close, and requests whose second marker is quoted inside the first.
 *
 * Usage: node pi-extension/test/optimize.test.mjs
 */
import assert from 'node:assert/strict'
import {
  detectOptimization, extractCommandPrefix, extractFilepathsFromCommand, localAnswerId,
  shellWords, toMessagesResponse, tryOptimizations,
} from '../dist/gateway/optimize.js'

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label} — ${error.message}`)
    failures += 1
  }
}

check('shellWords splits unquoted whitespace and honours quotes', () => {
  assert.deepEqual(shellWords('git commit -m "a b"'), ['git', 'commit', '-m', 'a b'])
  assert.deepEqual(shellWords("l's \"n'"), ['ls "n'])
})

check('shellWords unescapes outside quotes only where the shell does', () => {
  assert.deepEqual(shellWords('ls a\\ b'), ['ls', 'a b'])
  // `n` is not escapable outside quotes, so the backslash stays literal.
  assert.deepEqual(shellWords('ls a\\nb'), ['ls', 'a\\nb'])
})

check('a double-quoted backslash is only an escape before a character the shell gives meaning to', () => {
  assert.deepEqual(shellWords('echo "a\\nb"'), ['echo', 'a\\nb'])
  assert.deepEqual(shellWords('echo "a\\"b"'), ['echo', 'a"b'])
  assert.deepEqual(shellWords('echo "a\\\\b"'), ['echo', 'a\\b'])
  assert.deepEqual(shellWords('echo "a\\$b"'), ['echo', 'a$b'])
})

check('an unterminated quote is refused rather than guessed at', () => {
  assert.throws(() => shellWords('echo "abc'), /no closing quotation/)
})

check('a command prefix strips env assignments and flags', () => {
  assert.equal(extractCommandPrefix('git status'), 'git status')
  assert.equal(extractCommandPrefix('FOO=1 git status --short'), 'git status')
  assert.equal(extractCommandPrefix('FOO=1 ls -la'), 'FOO=1 ls')
})

check('a two-word command reads the operation, and a flag after it does not', () => {
  assert.equal(extractCommandPrefix('docker compose up'), 'docker compose')
  assert.equal(extractCommandPrefix('npm install --save'), 'npm install')
})

check('a command substitution is reported, never parsed', () => {
  assert.equal(extractCommandPrefix('git status `rm -rf /`'), 'command_injection_detected')
  assert.equal(extractCommandPrefix('git status $(whoami)'), 'command_injection_detected')
})

check('an empty or assignment-only command answers none', () => {
  assert.equal(extractCommandPrefix(''), 'none')
  assert.equal(extractCommandPrefix('FOO=1'), 'none')
  assert.equal(extractCommandPrefix('   '), 'none')
})

check('a reading command names its non-flag arguments', () => {
  assert.equal(extractFilepathsFromCommand('cat -n src/index.ts'), '<filepaths>\nsrc/index.ts\n</filepaths>')
  assert.equal(extractFilepathsFromCommand('head README.md LICENSE'), '<filepaths>\nREADME.md\nLICENSE\n</filepaths>')
})

check('a listing command names nothing to read', () => {
  assert.equal(extractFilepathsFromCommand('ls -la src'), '<filepaths>\n</filepaths>')
  assert.equal(extractFilepathsFromCommand('find . -name *.ts'), '<filepaths>\n</filepaths>')
})

check("grep's pattern is skipped unless a flag supplied it", () => {
  assert.equal(extractFilepathsFromCommand('grep "todo" src/index.ts'), '<filepaths>\nsrc/index.ts\n</filepaths>')
  assert.equal(extractFilepathsFromCommand('grep -e "todo" src/index.ts'), '<filepaths>\nsrc/index.ts\n</filepaths>')
  assert.equal(extractFilepathsFromCommand('grep -e "todo"'), '<filepaths>\n</filepaths>')
})

check('the Output section a caller truncates is not consulted for paths', () => {
  assert.equal(
    extractFilepathsFromCommand('cat src/index.ts', 'output line one\n\n<extra>'),
    '<filepaths>\nsrc/index.ts\n</filepaths>',
  )
})

check('a quota probe at max_tokens 1 is answered locally', () => {
  const request = { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'What quota is left?' }] }
  assert.equal(detectOptimization(request), 'quota')
  assert.equal(tryOptimizations(request)?.text, 'Quota check passed.')
})

check('a quota question at a normal budget is left to the model', () => {
  assert.equal(detectOptimization({ model: 'x', max_tokens: 1024, messages: [{ role: 'user', content: 'quota?' }] }), null)
})

check('the prefix optimization reads the last Command marker', () => {
  const content = '<policy_spec>\nSome policy about `git status`.\n\nCommand:docker compose up\n</policy_spec>'
  assert.equal(detectOptimization({ model: 'x', messages: [{ role: 'user', content }] }), 'prefix')
  assert.equal(tryOptimizations({ model: 'x', messages: [{ role: 'user', content }] })?.text, 'docker compose')
})

check('a title request is answered when the system asks for a sentence-case title', () => {
  assert.equal(detectOptimization({
    model: 'x',
    system: 'Write a sentence-case title for this session.',
    messages: [{ role: 'user', content: 'anything' }],
  }), 'title')
})

check('a title request that merely mentions the word is not answered', () => {
  assert.equal(detectOptimization({
    model: 'x',
    system: 'You are an assistant.',
    messages: [{ role: 'user', content: 'anything' }],
  }), null)
})

check('a request carrying tools is not answered by the title optimization', () => {
  assert.equal(detectOptimization({
    model: 'x',
    system: 'Write a sentence-case title.',
    messages: [{ role: 'user', content: 'anything' }],
    tools: [{ name: 'read' }],
  }), null)
})

check('a suggestion-mode turn is answered empty', () => {
  assert.equal(detectOptimization({
    model: 'x',
    messages: [{ role: 'user', content: '[SUGGESTION MODE: list]\nsuggest something' }],
  }), 'suggestion')
  assert.equal(tryOptimizations({
    model: 'x',
    messages: [{ role: 'user', content: '[SUGGESTION MODE: list]\nsuggest something' }],
  })?.text, '')
})

check('a filepath extraction needs both the command and the output', () => {
  const request = {
    model: 'x',
    system: 'Extract any file paths that this command reads.',
    messages: [{ role: 'user', content: 'Command:cat -n src/index.ts\nOutput:file contents' }],
  }
  assert.equal(detectOptimization(request), 'filepath')
  assert.equal(tryOptimizations(request)?.text, '<filepaths>\nsrc/index.ts\n</filepaths>')
})

check('a filepath request that names neither the block nor the system ask is left to the model', () => {
  assert.equal(detectOptimization({
    model: 'x',
    system: 'You are an assistant.',
    messages: [{ role: 'user', content: 'Command:cat src/index.ts\nOutput:contents' }],
  }), null)
})

check('a disabled optimization is not answered', () => {
  const request = { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'quota?' }] }
  assert.equal(detectOptimization(request, { quota: false }), null)
})

check('an ordinary conversation is never answered locally', () => {
  assert.equal(detectOptimization({
    model: 'x',
    messages: [{ role: 'user', content: 'explain how a hash map works' }],
  }), null)
})

check('a local answer wraps as an Anthropic message with the reported usage', () => {
  const response = toMessagesResponse({ kind: 'quota', text: 'Quota check passed.', usage: { input: 10, output: 5 }, model: 'ofm-kilo/a' })
  assert.equal(response.type, 'message')
  assert.equal(response.role, 'assistant')
  assert.equal(response.model, 'ofm-kilo/a')
  assert.equal(response.content[0].text, 'Quota check passed.')
  assert.equal(response.stop_reason, 'end_turn')
  assert.equal(response.usage.input_tokens, 10)
  assert.equal(response.usage.output_tokens, 5)
  assert.match(response.id, /^msg_/)
})

check('a local answer id is stable for the same answer', () => {
  const one = localAnswerId({ kind: 'quota', text: 'Quota check passed.', usage: { input: 10, output: 5 }, model: '' })
  const two = localAnswerId({ kind: 'quota', text: 'Quota check passed.', usage: { input: 10, output: 5 }, model: '' })
  const three = localAnswerId({ kind: 'title', text: 'Conversation', usage: { input: 100, output: 5 }, model: '' })
  assert.equal(one, two)
  assert.notEqual(one, three)
})

if (failures > 0) {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
