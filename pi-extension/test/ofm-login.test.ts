/**
 * Unit checks for the `/ofm login` and `/ofm logout` command branches.
 *
 * The command is the only surface a user has for the co-paid GitHub gate, and
 * the branch that matters for most hosts is the *absence* one: a CLI process is
 * not a shell the seal opens on, so opening a browser there would only produce
 * a 401 the user cannot act on. These checks pin that the command says so
 * instead, and that the other branches do not crash on a host with no lane.
 *
 * The full login walk (prepare → browser → poll → stored token) is pinned by
 * `eac-login.test.ts` against a stub fetch; this suite pins the command wiring.
 *
 * Runs on plain node:  node test/ofm-login.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failures = 0
const check = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`ok   ${label}`) }
  catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
}

/** A stub pi that records every provider, model and command registered on it. */
function stubPi(notices: string[]) {
  const registered: Record<string, any> = {}
  return {
    registered,
    pi: {
      on: () => {},
      registerProvider: (id: string, p: any) => { registered[id] = p },
      unregisterProvider: (id: string) => { delete registered[id] },
      registerVirtualModel: () => {},
      unregisterVirtualModel: () => {},
      registerCommand: (name: string, def: any) => { registered[`cmd:${name}`] = def },
    },
  }
}

/** A ctx whose UI only collects notifications, so no interactive step blocks. */
function stubCtx(notices: string[]) {
  return {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(String(message)) },
    modelRegistry: { getModelsOfType: () => [], find: () => undefined },
  }
}

/** Boot the extension against an isolated data dir. */
async function boot(notices: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-login-cmd-'))
  process.env.OFM_DATA_DIR = dir
  const { registered, pi } = stubPi(notices)
  const factory = (await import('../dist/index.js')).default
  await factory(pi as any)
  return { registered, command: registered['cmd:ofm'] }
}

await check('the extension registers the /ofm command', async () => {
  const notices: string[] = []
  const { command } = await boot(notices)
  assert.ok(command !== undefined, 'the /ofm command was not registered')
  assert.equal(typeof command.handler, 'function')
})

await check('login on a host with no lane says so, it does not open a browser', async () => {
  // A CLI process is not a shell the seal opens on. Telling the user to open a
  // URL there would only produce a 401 they cannot act on.
  const notices: string[] = []
  const { command } = await boot(notices)
  await command.handler('login', stubCtx(notices))
  assert.equal(notices.length, 1)
  assert.match(notices[0], /not available on this host/, `the message was: ${notices[0]}`)
})

await check('logout on a host with no lane says the same thing, not a crash', async () => {
  const notices: string[] = []
  const { command } = await boot(notices)
  await command.handler('logout', stubCtx(notices))
  assert.match(notices[0] ?? '', /not available on this host/)
})

await check('the status branch still answers on a host with no lane', async () => {
  // The lane's absence must not take the whole command down with it.
  const notices: string[] = []
  const { command } = await boot(notices)
  await command.handler('status', stubCtx(notices))
  assert.match(notices[0] ?? '', /ofm-kilo/)
})

await check('an unknown verb is not silently swallowed', async () => {
  const notices: string[] = []
  const { command } = await boot(notices)
  await command.handler('login-nonsense', stubCtx(notices))
  assert.ok(notices.length > 0, 'an unknown verb produced no answer at all')
})

await check('the lanes the gateway serves are registered alongside the command', async () => {
  // The command is registered whether or not the co-paid lane exists, so a CLI
  // host can still refresh the two keyless lanes through it.
  const notices: string[] = []
  const { registered } = await boot(notices)
  assert.ok(registered['ofm-kilo'] !== undefined, 'the kilo lane was not registered')
  assert.ok(registered['ofm-opencode'] !== undefined, 'the opencode lane was not registered')
})

setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 400)
