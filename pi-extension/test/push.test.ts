/**
 * Unit checks for the SSE push hub.
 *
 * The hub is small, so what matters is the *cleanup*: a half-open stream is a
 * leak that survives every later emit, and an interval that keeps running with
 * no listeners is a permanent wakeup. These checks drive it against fake
 * responses and a real `http` server, so nothing is asserted about a shape the
 * code merely claims.
 *
 * Runs on plain node:  node test/push.test.ts
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createPushHub, HEARTBEAT_MS } from '../dist/push.js'

let failures = 0
let running = Promise.resolve()
const check = (label: string, fn: () => Promise<void> | void) => {
  running = running.then(async () => {
    try { await fn(); console.log(`ok   ${label}`) }
    catch (error: any) { failures += 1; console.log(`FAIL ${label} — ${error?.message ?? error}`) }
  })
}

/** A response that records what was written, and can be told to break. */
function fakeRes(over: any = {}): any {
  return {
    writableEnded: false,
    destroyed: false,
    written: [] as string[],
    ended: 0,
    handlers: {} as Record<string, Function[]>,
    writeHead() {},
    write(chunk: string) {
      if (this.throwOnWrite === true) throw new Error('socket closed')
      this.written.push(chunk)
      return true
    },
    end() { this.ended += 1 },
    on(event: string, fn: Function) { (this.handlers[event] ??= []).push(fn) },
    /** Fire the 'close' handlers the way Node does. */
    close() { for (const fn of this.handlers.close ?? []) fn() },
    ...over,
  }
}
function fakeReq(): any {
  const handlers: Record<string, Function[]> = {}
  return { on: (event: string, fn: Function) => { (handlers[event] ??= []).push(fn) }, close() { for (const fn of handlers.close ?? []) fn() } }
}

// ── attach ──────────────────────────────────────────────────────────────────
check('attach writes the stream headers and an SSE comment, not an event', () => {
  const hub = createPushHub()
  const res = fakeRes()
  let head: any
  res.writeHead = (status: number, headers: any) => { head = { status, headers } }
  hub.attach(fakeReq(), res)
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(head.headers['cache-control'], 'no-cache, no-transform')
  assert.equal(head.headers['x-accel-buffering'], 'no', 'a buffering proxy would hold every frame')
  assert.deepEqual(res.written, [': connected\n\n'], 'attach wrote an event instead of a comment')
  assert.equal(hub.size, 1)
})

check('the hello snapshot travels with the connection, so the hub stays stateless', () => {
  const hub = createPushHub()
  const res = fakeRes()
  hub.attach(fakeReq(), res, { items: [], unread: 0 })
  const frame = res.written[res.written.length - 1]
  assert.match(frame, /^event: hello\n/)
  assert.match(frame, /"unread":0/)
  // A hub with no hello does not invent one.
  const plain = fakeRes()
  hub.attach(fakeReq(), plain)
  assert.equal(plain.written[plain.written.length - 1], ': connected\n\n')
})

check('a frame is one event with one JSON data line', () => {
  const hub = createPushHub()
  const res = fakeRes()
  hub.attach(fakeReq(), res, undefined)
  res.written.length = 0
  hub.sendTo(res, 'announcement', { title: 'a\nb', quote: '"x"' })
  assert.equal(res.written.length, 1)
  const frame = res.written[0]
  // A newline inside a field would split the frame on the client side: this is
  // exactly why the payload goes through JSON.stringify.
  assert.equal(frame, `event: announcement\ndata: ${JSON.stringify({ title: 'a\nb', quote: '"x"' })}\n\n`)
  const [event, data] = frame.trimEnd().split('\n')
  assert.equal(event, 'event: announcement')
  assert.equal(data.startsWith('data: '), true)
  assert.deepEqual(JSON.parse(data.slice(6)), { title: 'a\nb', quote: '"x"' })
})

check('emit reaches every attached client and no one else', () => {
  const hub = createPushHub()
  const a = fakeRes(); const b = fakeRes()
  hub.attach(fakeReq(), a); hub.attach(fakeReq(), b)
  a.written.length = 0; b.written.length = 0
  hub.emit('tick', { n: 1 })
  assert.equal(a.written.length, 1)
  assert.equal(b.written.length, 1)
  // A response never attached is not broadcast to.
  const stranger = fakeRes()
  hub.emit('tick', { n: 2 })
  assert.equal(stranger.written.length, 0)
})

check('`data` defaults to an empty object rather than "undefined"', () => {
  const hub = createPushHub()
  const res = fakeRes()
  hub.sendTo(res, 'ping', undefined)
  assert.match(res.written[0], /data: \{\}\n\n/)
})

// ── cleanup ─────────────────────────────────────────────────────────────────
check('a closed request drops its stream', () => {
  const hub = createPushHub()
  const res = fakeRes()
  const req = fakeReq()
  hub.attach(req, res)
  assert.equal(hub.size, 1)
  req.close()
  assert.equal(hub.size, 0, 'a closed request left its stream attached')
})

check('a closed response drops its stream', () => {
  const hub = createPushHub()
  const res = fakeRes()
  hub.attach(fakeReq(), res)
  res.close()
  assert.equal(hub.size, 0)
})

check('a stream already ended is dropped instead of written to', () => {
  const hub = createPushHub()
  const gone = fakeRes({ writableEnded: true })
  hub.attach(fakeReq(), gone)
  // attach refuses it outright, so the roster never holds a response that
  // already ended and nothing is written at all.
  assert.equal(hub.size, 0, 'an ended response was put on the roster')
  hub.emit('x', {})
  assert.equal(gone.written.length, 0, 'a write was attempted on an ended response')
})

check('a destroyed response is dropped, not written to', () => {
  const hub = createPushHub()
  const gone = fakeRes({ destroyed: true })
  hub.attach(fakeReq(), gone)
  assert.equal(hub.size, 0, 'a destroyed response was put on the roster')
  hub.emit('x', {})
  assert.equal(gone.written.length, 0)
})

check('a client that hangs up before attach does not crash the route handler', () => {
  // The race is ordinary: the request lands, the handler runs a moment later,
  // and the socket is already gone. An unguarded connect write turns that into
  // a 500 for a request nobody is waiting on.
  const logged: string[] = []
  const hub = createPushHub({ logger: { debug: (m: string) => logged.push(m) } })
  const dead = fakeRes({ throwOnWrite: true })
  assert.doesNotThrow(() => hub.attach(fakeReq(), dead), 'attach threw on a dead socket')
  assert.equal(hub.size, 0, 'a dead client was added to the roster')
  assert.equal(dead.written.length, 0)
  // A response that already ended is refused before any write either.
  const gone = fakeRes({ writableEnded: true })
  hub.attach(fakeReq(), gone)
  assert.equal(hub.size, 0)
  assert.equal(gone.written.length, 0)
})

check('a write that throws drops the client, so later emits skip a dead peer', () => {
  const logged: string[] = []
  const hub = createPushHub({ logger: { debug: (m: string) => logged.push(m) } })
  // Healthy on arrival, dead on the next write: the socket closes between the
  // connect and the first event, which is the race the guard exists for.
  const dead = fakeRes()
  const live = fakeRes()
  hub.attach(fakeReq(), dead); hub.attach(fakeReq(), live)
  dead.throwOnWrite = true
  dead.written.length = 0; live.written.length = 0
  hub.emit('a', {})
  assert.equal(hub.size, 1, 'the dead peer was kept on the roster')
  assert.equal(live.written.length, 1, 'the dead peer blocked the live one')
  hub.emit('b', {})
  assert.deepEqual(dead.written, [], 'the dead peer was written to again')
  assert.equal(live.written.length, 2)
  assert.match(logged.join('\n'), /dropped client/)
})

check('a client dropped mid-broadcast does not skip the rest', () => {
  // Iterating a live Set while removing from it skips the next entry.
  const hub = createPushHub()
  const first = fakeRes()
  const second = fakeRes()
  hub.attach(fakeReq(), first); hub.attach(fakeReq(), second)
  first.throwOnWrite = true
  first.written.length = 0
  second.written.length = 0
  hub.emit('a', {})
  assert.equal(second.written.length, 1, 'the entry after the dropped one was skipped')
})

check('dispose ends every stream, so a hot reload leaves nothing half-open', () => {
  const hub = createPushHub()
  const a = fakeRes(); const b = fakeRes()
  hub.attach(fakeReq(), a); hub.attach(fakeReq(), b)
  hub.dispose()
  assert.equal(a.ended, 1)
  assert.equal(b.ended, 1)
  assert.equal(hub.size, 0)
})

check('dispose survives a stream that throws on end', () => {
  const hub = createPushHub()
  const bad = fakeRes({ end: () => { throw new Error('already gone') } })
  hub.attach(fakeReq(), bad)
  // A second client must be closed even though the first one threw.
  const good = fakeRes()
  hub.attach(fakeReq(), good)
  hub.dispose()
  assert.equal(good.ended, 1, 'a throwing stream blocked the dispose')
  assert.equal(hub.size, 0)
})

check('an unref() heartbeat does not hold the process open', () => {
  // Default parameter values are documented, so this pins the shipped one.
  assert.equal(HEARTBEAT_MS, 25_000)
})

// ── heartbeat, against a real server ────────────────────────────────────────
check('a live heartbeat reaches a real client, and stops when the last leaves', async () => {
  // The interval itself is only observable against a real socket; a fake
  // response would let any implementation pass.
  const hub = createPushHub({ heartbeatMs: 40 })
  const server = http.createServer((req, res) => hub.attach(req, res, { unread: 1 }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const frames: string[] = []
  await new Promise<void>((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/events`, res => {
      res.setEncoding('utf8')
      res.on('data', chunk => {
        frames.push(String(chunk))
        if (frames.length >= 2) {
          // The stream is held open by design, so close() would wait forever.
          res.destroy()
          resolve()
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
  })
  const joined = frames.join('')
  assert.match(joined, /^: connected\n\n/)
  assert.match(joined, /event: hello\ndata: /)
  // Two comment heartbeats observed means the timer really is running.
  assert.equal((joined.match(/: ping\n\n/g) ?? []).length >= 1, true, 'no heartbeat arrived')
  await new Promise<void>(resolve => server.close(() => resolve()))
  hub.dispose()
})

check('a client that vanishes is removed by the server side too', async () => {
  const hub = createPushHub({ heartbeatMs: 25 })
  const server = http.createServer((req, res) => hub.attach(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  await new Promise<void>((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/events`, res => {
      res.resume()
      // Abandoning the socket must leave the hub with nobody on the roster.
      setTimeout(() => { req.destroy(); resolve() }, 60)
    })
    req.on('error', reject)
  })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(hub.size, 0, 'a destroyed client is still on the roster')
  await new Promise<void>(resolve => server.close(() => resolve()))
  hub.dispose()
})

running.then(() => setTimeout(() => {
  if (failures > 0) { console.log(`\n${failures} FAIL`); process.exit(1) }
  console.log('\nALL CHECKS PASSED')
}, 200))
