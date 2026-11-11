/**
 * The gateway stand-in the offline suites share: an SSE that answers the
 * listing and the probe pings without touching the real free lane.
 *
 * dsh's full fake kernel also carried a cordis-shaped context, because the
 * plugin mounted inside a host. This package has no host kernel: the extension
 * entry and the service entry inject their seams as parameters, so a suite
 * stubs `fetchImpl`/`now`/`logger` directly — which the 57 TS suites already do.
 * What every suite still needs is a *upstream*, and that half is ported whole.
 *
 * Nothing here imports the plugin, because the lane's base constants read their
 * environment variables once at import time: a caller sets them, then imports
 * the module under test dynamically. The three variables this package's modules
 * read are pre-seeded to a dead loopback port so a suite that forgets one fails
 * closed instead of dialing the real lane.
 *
 * Ported from dsh's `scripts/lib/fake-kernel.mjs` (the gateway half).
 *
 * @module pi-extension/test/lib/stub-upstream.js
 */

import http from 'node:http'

// The offline discipline is "no suite reaches the network". An unset base
// defaults to a closed loopback port; a suite that wants a stand-in sets its own
// value before importing the module under test.
for (const [name, value] of [
  ['OUR_FREE_MODEL_BASE', 'http://127.0.0.1:0'],
  ['OFM_OPENECODE_BASE', 'http://127.0.0.1:0'],
  ['OFM_KILO_BASE', 'http://127.0.0.1:0'],
]) {
  if (process.env[name] === undefined) {
    const dead = http.createServer()
    await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve))
    process.env[name] = `http://127.0.0.1:${dead.address().port}`
    await new Promise(resolve => dead.close(resolve))
  }
}

/**
 * One healthy SSE body, in the Chat Completions shape every stub model speaks.
 *
 * Usage rides the top level of the final chunk, which is where a real gateway
 * puts it (`stream_options.include_usage`) — `feedChat` reads it from there and
 * nowhere else.
 */
export function chatFrames(text = 'ok') {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
}

/**
 * Start the stand-in gateway.
 *
 * @param {object} options
 * @param {string[]} options.listing - model ids `GET /inference/v1/models` names
 * @param {(id: string, body: object, api: object) => {status?: number, body?: string, socket?: boolean, contentType?: string}} options.answer
 *   what one `POST` to the model's endpoint looks like; `api.refuseAll` etc. are
 *   readable from the returned object so a test can flip verdicts between rounds
 */
export async function stubUpstream({ listing = [], answer = () => ({ body: chatFrames() }) }) {
  const requests = []
  const api = { refuseAll: false }
  /** The listing the stub names, mutable so a test can make upstream add one. */
  let rows = listing.map(id => ({ id }))
  api.setListing = ids => { rows = ids.map(id => ({ id })) }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', row => chunks.push(row))
    req.on('end', async () => {
      const url = String(req.url ?? '')
      if (req.method === 'GET' && url === '/inference/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: rows }))
        return
      }
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* a malformed body is a scripted failure */ }
      requests.push({ path: url, body })
      const verdict = api.refuseAll ? { status: 400, body: JSON.stringify({ error: { message: 'Model is unavailable.' } }) } : answer(body.model, body, api)
      if (verdict.socket === true) {
        // No answer at all: the transport dies before a status line. The probe
        // must read this as "nothing learned", not as a refused model.
        req.destroy()
        res.destroy()
        return
      }
      const status = verdict.status ?? 200
      const contentType = verdict.contentType ?? (status === 200 ? 'text/event-stream; charset=utf-8' : 'application/json')
      const send = () => {
        res.writeHead(status, { 'content-type': contentType })
        if (verdict.pieces !== undefined) {
          // Deliver in pieces so a test can split a frame across chunk boundaries.
          for (const piece of verdict.pieces) res.write(piece)
          res.end()
          return
        }
        res.end(verdict.body)
      }
      // A held answer keeps one probe round in flight, which is what lets a test
      // look at the state between "the listing named it" and "the probe knows".
      // `wait` is the stronger form: the test holds the door open itself and
      // releases it when it is done looking, so no wall-clock race is involved.
      if (verdict.wait !== undefined) await verdict.wait
      if (verdict.holdMs !== undefined) {
        // Headers now, then the pieces it was given, then silence. A script that
        // asked for both was held to one of them — the pieces were dropped on the
        // floor, so "the answer arrived and then the connection stalled" could
        // only ever be tested as "nothing arrived at all".
        res.writeHead(status, { 'content-type': contentType })
        res.flushHeaders?.()
        for (const piece of verdict.pieces ?? []) res.write(piece)
        setTimeout(() => res.end(), verdict.holdMs).unref?.()
        return
      }
      if (verdict.delayMs === undefined) send()
      else setTimeout(send, verdict.delayMs).unref?.()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  server.unref()
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    api,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

