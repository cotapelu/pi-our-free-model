# Our Free Model — API provider + pi extension

**One codebase, two mounts.** Run it as an HTTP API provider that any coding
agent can point a `base-url` at, or install it as a pi extension. Both mounts
come from the same `dist/`, and both serve the same four model lanes.

```
node pi-extension/dist/server.js --port 18900      # API provider, no host needed
pi install ./pi-extension                          # pi extension
```

| Lane | Upstream | Credential |
|---|---|---|
| `ofm-kilo` | Kilo AI public gateway — `api.kilo.ai` | **none** — the free pool answers a genuinely credential-less request |
| `ofm-opencode` | OpenCode public free tier — `opencode.ai` | one pooled public credential (`Bearer public`) + a client fingerprint |
| `ofm-eac` | co-paid lane | an AES-256-GCM seal split across three shards |
| `ofm-aggregate` | **76 third-party providers** | your own key, per provider, from the settings page |
| `ofm-chain/<name>` | fallback chain over the lanes | (a selectable name, not an upstream) |

The first two lanes are the reason this exists: **no login, no sign-up, no API
key, nothing to configure.** The other three exist because a free lane alone is
not a provider.

## Wire the server speaks

All of these sit behind one bearer key and CORS, bind loopback with port
retry/scan, and stream.

| Route | Protocol |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/messages`, `POST /v1/messages/count_tokens` | Anthropic Messages |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1beta/models/{model}:generateContent` | Gemini native |
| `GET /v1/models` | model list (OpenAI + Gemini shapes) |
| `GET /health` | liveness |
| `GET /v1/announcements`, `POST /v1/announcements/ack` | the announcement feed |
| `GET /v1/picks` | recommended-projects star counts, fresh behind the route |
| `GET /v1/sponsor` | the sponsor copy, as data rather than markup |
| `GET /v1/events` | SSE push (hello snapshot + heartbeat) |

```bash
curl -s -H "authorization: Bearer ofm-demo" http://127.0.0.1:18900/v1/models
curl -s -X POST http://127.0.0.1:18900/v1/chat/completions \
  -H "authorization: Bearer ofm-demo" -H 'content-type: application/json' \
  -d '{"model":"ofm-kilo/kilo-auto-free","messages":[{"role":"user","content":"say pong"}]}'
```

To point an agent at it: `base-url = http://127.0.0.1:18900/v1`, `api-key =
ofm-demo`. The key is this gateway's, not an upstream's — no upstream key is
needed for `ofm-kilo` or `ofm-opencode`.

## What it costs

- **`ofm-kilo`** — Kilo's `isFree` slice answers with no account, key or login
  state. Two adaptations: the request must carry **no** Authorization header (a
  placeholder token is a `401 INVALID_TOKEN`), and the payload is normalised onto
  the gateway's vocabulary (`reasoning`, not `reasoning_effort`; `max_tokens`,
  not `max_completion_tokens`). **Kilo's own model cards state free-pool prompts
  may be logged and used to improve its services.** Treat it as throwaway work.
- **`ofm-opencode`** — free tier behind a *pooled public* credential and a
  **client fingerprint** gate. It works without an account, but the request must
  look like the official CLI byte for byte: the UA, four same-valued session
  headers and no v1-only `x-opencode-request`; a session id minted as the
  descending `~(ts_ms << 12 | counter)` value (a random or sha256 id is refused
  with 403); two tool declarations (`read`, `shell`) verbatim from OpenCode
  v2.0.26, so pi's own `read` is renamed out of the gate slot on the request and
  restored on the response; a required `<env>` block in the system prompt; and
  never `tool_choice: 'none'`. Thinking strength is the model's **declared**
  `reasoning_effort` menu — an undeclared level is never sent (the gateway
  answers 400), and a model with no menu gets no picker at all. Metered per
  session/IP: a `429 FreeUsageLimitError` gets an actionable message and rotates
  the mapped session, a `403 RegionError` points at egress.
- **`ofm-eac`** — co-paid lane; the credential is never in the package in
  readable form.
- **`ofm-aggregate`** — your key, your quota, your provider's terms.

The first time a free lane appears on a machine, the extension says what it costs
and what never to send. It shows once, interactively, and records that it was
shown (`notice-ack.json`; bump `NOTICE_VERSION` in `disclaimer.ts` to bring it
back).

## Transport guards

Both free lanes carry guards ported from this plugin's issue trail: the body is
read by **shape**, not `Content-Type` (a 200 labelled JSON over a full SSE
stream, or one JSON document answering a stream request, is replayed or folded
instead of dropped — the head is sniffed so a live stream is not buffered to its
end); a stream that only sends keepalive comments dies on an idle deadline;
DeepSeek v4's leaked `<｜DSML｜…>` control markup is scrubbed; and transport
failures append the socket reason (`fetch failed — getaddrinfo ENOTFOUND …`).

## Token saver

A long agent turn is mostly tool output — diffs, listings, search results, build
logs — almost all of it redundancy a model does not need. The saver compacts
twelve tool-output shapes and applies two prompt families, each at several
intensity levels. **Everything defaults to off**: compaction changes what the
model reads and a prompt family changes how it *writes*, both a user's choice to
make. Turn it on with `/ofm saver` and read what it measured with
`/ofm saver stats`.

## `ofm` command

```bash
/ofm                          # per-lane model counts · chains
/ofm refresh                  # re-fetch every lane's live roster
/ofm chain [add|edit|set|remove|enable|disable]
/ofm provider [status|add-key|test|discover]
/ofm saver [rtk|caveman|ponytail]
/ofm feed [list|poll|ack <id>|ack all]
/ofm login|logout             # EAC co-paid lane
```

## Install

```bash
pi install ./pi-extension      # or: pi -e ./pi-extension
```

Project-local resources are **trust-gated**, so a session needs `--approve` until
a decision is saved (`/trust`, or `~/.pi/agent/trust.json`). Run `pi` from a
directory only if the extension should be loaded from there — it is read from the
**current working directory only**.

## Pick a model

`ofm-kilo/*` and `ofm-opencode/*` are the two keyless lanes. `ofm-chain/<name>`
walks a fallback chain: the first link that answers wins, so a quota wall on one
lane becomes a retry the user never sees. `ofm-eac/*` and
`ofm-aggregate/<provider>/<model>` appear once configured.

## Fallback chains

A chain is one selectable name over an ordered list of `provider/model` links.
Capability limits are the **intersection** of the links that resolve right now,
so a chain never advertises a capability its weakest member lacks. Pi replaces
the limits with the dispatched model's own after the first response either way.

## Layout

```
pi-extension/
├── index.ts               factory: pi providers, chains, /ofm
├── server.ts              standalone API provider entry (the same dist/)
├── transport.ts           host-free half of the guards: head sniff, body fold,
│                          idle watchdog, DSML scrubber, error copy
├── fingerprint.ts         the OpenCode v2 client fingerprint
├── catalog.ts             live listing fetch + offline snapshot + static roster
├── lane.ts                shared stream plumbing: alias restore, error
│                          translation, credential-free fetch, session rotation
├── opencode.ts            ofm-opencode provider
├── kilo.ts                ofm-kilo provider
├── eac.ts                 sealed co-paid lane wire
├── eac-login.ts           GitHub login delivery (host-only)
├── eac-user.ts            the per-user token, 0600
├── eac-lane.ts            ofm-eac pi provider
├── adapter.ts             the host-facing half: silence watchdog for the chain,
│                          buildPayload, toFailure, savingsFields, describe
├── vault.ts               the seal unlock (three shards, AES-256-GCM)
├── vault-anchor.ts
├── vault-data.ts
├── aggregate.ts           the 76-provider outbound wire
├── providers/index.ts    the registry, read from registry.json
├── aggregate-lane.ts      ofm-aggregate provider + lane
├── aggregate-store.ts     aggregate.json, 0600, flushed immediately
├── chains.ts              fallback chains: normalize, intersection, routing
├── chain-store.ts         durable chain storage (~/.our-free-model/chains.json)
├── chan-relay.ts          LAN relay for the absorbed channels' gateway
├── subscriptions.ts       private subscription sidecar
├── subscription-adapter.ts
├── subscription-completion.ts
├── channel.ts             single-producer / single-consumer bridge
├── combos.ts              a virtual catalog entry that is really a chain
├── messages.ts            harness vocabulary <-> the three wire shapes
├── stream.ts              provider SSE -> harness StreamChunk
├── upstream.ts            upstream wire for the keyless lane
├── effort.ts              reasoning-effort policy
├── magpie-policy.ts       account channels this build does not offer
├── magpie-models.ts       the engine's live catalog
├── magpie-engine.ts       engine host: resolves, never rejects
├── engine-payload.ts      restore the engine from local parts, no network
├── image-pricing.ts       same-host vision token estimate
├── model-test.ts          text-test validation: timing, cancellation
├── loopback-fetch.ts      loopback transport
├── disclaimer.ts          the one-time notice the free lanes owe the user
├── open-external.ts       await the launcher so a failure stays recoverable
├── updater.ts             in-app upgrade: Ed25519 manifest, per-file SHA-256,
│                          backup, atomic swap, rollback
├── reload.ts             self hot-reload against an **injected** host
├── trust.ts              request fence: the composition's connection service
│                          first, a loopback replica second
├── feed.ts               announcement feed: sources in order, redirect refused,
│                          whole-document validation, ack state owned by the caller
├── feed-ack.ts          what the user has read, durable and creator-only
├── sponsor.ts           the sponsor copy and the once-per-local-day claim
├── attribution.ts      the attribution User-Agent, through an injected seam
├── client/             the browser half's portable parts
│   └── sanitizer.ts    the announcement-HTML allowlist parser (the XSS boundary)
├── push.ts               one SSE stream per surface: hello, heartbeat, per-client
│                          removal on close
├── picks.ts              recommended-projects star counts
├── sponsor.ts            (stub — see ../BAOCAO.md §4)
├── saver-store.ts        durable token-saver switch, everything off by default
├── saver-stats.ts        what the saver last measured, per lane
├── token-saver/          tool-output compaction: 12 filters, autodetect, gates
│   ├── index.ts          compressRequest / compressText
│   ├── prompts.ts        two prompt families, seven levels
│   ├── autodetect.ts     which filter a blob is, from its own header shape
│   ├── registry.ts       name-to-filter lookup (rg, fd aliases live here)
│   ├── applyFilter.ts    the one place a filter is allowed to fail
│   ├── hitLine.ts        search-output parsing, drive-aware
│   ├── constants.ts      every threshold; a compatibility surface, not a knob
│   └── filters/          git-diff, git-status, git-log, ls, grep, find, tree,
│                         build-output, dedup-log, read-numbered, search-list,
│                         smart-truncate
├── gateway/              the standalone HTTP surface
│   ├── server.ts         routing, key fence, CORS, port bind
│   ├── protocol.ts       bearer, CORS, bodies, OpenAI error envelopes
│   ├── loopback.ts       bind a loopback address, rank LAN candidates
│   ├── dispatch.ts      one performUpstream for all four dialects
│   ├── response-stream.ts held-open stream, heartbeat, fold/replay
│   ├── anthropic.ts      Anthropic Messages codec + SSE frames
│   ├── gemini.ts         Gemini native route + frames
│   ├── responses.ts      OpenAI Responses codec
│   ├── chain.ts          chain routing over the dispatch
│   ├── classify.ts      one failure vocabulary, forwardFailure for three dialects
│   ├── recovery.ts       silent-stop recovery
│   ├── optimize.ts       the five requests answered without a provider call
│   ├── probe.ts          availability probing + egress detection
│   ├── egress.ts         the switchable outlet (loopback only)
│   └── store.ts          JsonStore, usage accounting, day keys
├── packages/             the distribution shells (not yet ported — see ../BAOCAO.md)
│   ├── standalone/README.md
│   └── desktop/README.md
├── worker/               the self-hosted EAC gateway
│   ├── validation.ts    the signature/replay/relay checks BOTH hosts run
│   ├── usage-scanner.ts token counts out of a relayed body, no full parse
│   ├── rate-limiter.ts  a fixed-window limit, per key
│   ├── analytics.ts     per-IP numbers, salted, pruned, atomically written
│   ├── auth-github.ts   the OAuth gate: state HMAC, star verdicts, 12h recheck
│   ├── github-transport.ts  node:https, because undici cannot reach GitHub here
│   ├── node-host.ts   the self-hosted host: composes all six, SSE prelude,
│   │                  rate/concurrency limits, analytics, /pool, /stats
│   ├── verify.js        deployment self-check: signs the two routes the lane
│   │                  speaks, and refuses a gateway whose fence is off
│   ├── dashboard.html   the admin console (browser asset, served verbatim)
│   ├── entry.js         the New API sidebar injection (browser asset)
│   └── wrangler.toml    the Cloudflare deploy config
├── vendor/               channel-pack copied verbatim; magpie pinned by sha256
├── scripts/reverify-upstream.ts  live re-measurement of both lanes
├── scripts/copy-registry.mjs    copies registry.json into dist/ (mandatory)
├── dist/                 compiled output — what actually runs
└── test/                offline unit + integration checks (Node type-strip)
```

## Tests

```bash
npm --prefix pi-extension run test:pi-extension   # build + every offline suite
```

51 suites / 1,072 checks as of the last run. The build runs under `strict` with
`noImplicitAny`, so a type error fails `npm run build` — that is the
compatibility gate against the installed `pi-ai`/`pi-coding-agent` types.

The live verifier is not for CI: it spends this egress's free quota. It exits
non-zero on drift, and the response procedure is in
[`../docs/pi-extension-drift-runbook.md`](../docs/pi-extension-drift-runbook.md).

## Notes

- Region-gated models need an outbound proxy: `NODE_USE_ENV_PROXY=1` with
  `HTTPS_PROXY=...` routes both lanes through it.
- `OFM_DATA_DIR` relocates `chains.json`, `feed.json`, `notice-ack.json`,
  `saver.json`, `gateway.json` and the aggregate key ring.
- `OFM_OPENECODE_BASE`, `OFM_OPENECODE_CHAT_BASE` and `OFM_KILO_BASE` override the
  endpoints (used by the tests).
- Nothing here holds a private credential, account or token store. Both keyless
  lanes carry only what the upstreams' public documentation describes.
- Kilo's free pool can train on prompts. Do not send credentials, keys, personal
  data, or anything you would not hand to a third party.

## Porting status

This directory is a **full port** of `dsh-our-free-model`, not just its API
provider. The verified inventory — every file of the original, ported or not —
lives in [`../BAOCAO.md`](../BAOCAO.md) and the remaining work in
[`../docs/TODO.md`](../docs/TODO.md). Those two files are regenerated from a
scan of both trees, so they are the ones to trust over any prose here.
