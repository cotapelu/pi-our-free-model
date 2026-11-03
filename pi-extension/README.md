# Our Free Model — pi provider extension

Turns two **keyless** free-model lanes into pi model providers, so `pi` selects
them like any built-in provider: **no login, no sign-up, no API key, nothing to
configure.** Written in TypeScript; `pi` runs the compiled `dist/`.

| Provider | Upstream | Credential |
|---|---|---|
| `ofm-kilo` | Kilo AI public gateway — `https://api.kilo.ai/api/gateway` | none — the free pool answers a genuinely credential-less request |
| `ofm-opencode` | OpenCode public free tier — `https://opencode.ai` | one pooled public credential (`Bearer public`) plus a client fingerprint |
| `ofm-chain` | fallback chains over both lanes | (a selectable model name, not an upstream) |

Both live rosters are fetched from the upstream listing on every load. An
offline snapshot keeps the models present when the machine has no route
upstream, and a refresh that cannot reach the listing keeps the last roster it
served — together with the upstream spellings it learned, so a turn never
carries pi's own safe id to a lane that is up. Tool calls, thinking deltas,
usage accounting and cancellation behave like any other provider, because both
lanes stream through pi-ai's OpenAI-Completions implementation.

## Install

The folder is a pi package. It is **TypeScript**, and `pi` loads the compiled
`dist/index.js`, so build once before installing — and again after editing the
source:

```bash
npm --prefix pi-extension install     # dev deps (typescript, @types/node, the pi type packages)
npm --prefix pi-extension run build   # tsc → pi-extension/dist  (also runs automatically via "prepare")
```

then install it:

```bash
pi install ./pi-extension     # from this repository root — loads on every `pi`, no approval
```

or try it for one invocation:

```bash
pi -e ./pi-extension
```

The project-local form, `pi install ./pi-extension -l`, records the package in
`.pi/settings.json` so it activates only inside this repository. pi gates
project-local resources behind a trust check, so it is **not loaded** until you
pass `--approve` when you run `pi` in the repo.

## Pick a model

```bash
pi --list-models | grep ofm                    # the two rosters + any chains
pi --model ofm-kilo/reflection-beam-free       # a Kilo free model
pi --model ofm-opencode/deepseek-v4.1-flash-free --thinking high
pi --model "ofm-opencode/deepseek-v4.1-flash-free:high"   # :<thinking> shorthand
pi --model ofm-chain/my-chain                  # a fallback chain
```

Interactive: run `pi`, use Ctrl+P to cycle models, or pass `--models`/`--model`.
`/ofm` reports the current rosters; `/ofm refresh` re-fetches both listings.

## Fallback chains

A chain is one selectable model name whose links are real models, tried in
order — the first one that answers wins. It exists for the failures these lanes
actually have: a quota wall on one link while the other lane is idle, a region
refusal, a 5xx.

```bash
/ofm chain add My Chain | ofm-kilo/reflection-beam-free | ofm-opencode/beam-free
/ofm chain add RR | ofm-kilo/a | ofm-kilo/b | round-robin:2
/ofm chain                                  # list, live/total per chain
/ofm chain edit <id|name>                   # wizard: name → links → strategy → sticky
/ofm chain set <id|name> links <provider/model> | <provider/model>
/ofm chain set <id|name> strategy fallback|round-robin[:sticky]
/ofm chain set <id|name> sticky <1..16>
/ofm chain enable|disable|remove <id>
```

`chain edit` is an interactive wizard over the same edits: it asks for the name
(the current name shows as a placeholder — leaving it blank keeps it), the links
(one per line, prefilled with the current ones), the strategy, and — for
`round-robin` — the sticky window, then validates exactly like `add`. Cancelling
writes nothing; in a non-interactive session it points at the `set` forms and
the chains file.

The trailing field of `add` is the strategy when it spells one; everything
between the name and that field is a link, and a link that is not
`provider/model` is refused rather than dropped. Links are checked against the
live registry: an add whose links are all unresolvable is refused with their
spellings named (a typo, not a roster change), while an add with some dead links
is accepted and names them. `set` edits an existing chain without touching the
file.

`fallback` (default) always starts at the head; `round-robin` rotates the start
per `stickyLimit` turns. A chain's advertised capacities are the **intersection**
of its links — the honest numbers, never the union. Chains persist in
`~/.our-free-model/chains.json` (`OFM_DATA_DIR` overrides).

How the failover advances is a property of pi, not this extension: pi routes
once per request, retries only *transient* failures, and deliberately does not
retry a quota wall (`FreeUsageLimitError` is an account limit in its policy).
So a chain advances on the retry when pi retries, and on the **next user turn**
after a failure pi refuses to retry. A continuation stays on the model that
answered, so prompt caches and thinking signatures survive, and a walk is capped
at `links - 1` moves per streak.

## Why these models are free — and what it costs

- **`ofm-kilo`** — Kilo publishes an OpenAI-compatible gateway whose `isFree`
  slice answers with no account, key or login state. Only adaptation: the
  request must carry **no** Authorization header (a placeholder token is a
  `401 INVALID_TOKEN`), and the payload is normalised onto the gateway's
  vocabulary (`reasoning` rather than `reasoning_effort`, `max_tokens` rather
  than `max_completion_tokens`). **The gateway's own model cards state that
  free-pool prompts may be logged by the upstream provider and used to improve
  its services.** Treat this lane as throwaway work, never for secrets.
- **`ofm-opencode`** — OpenCode serves a free tier behind a *pooled public*
  credential and a **client fingerprint** gate. The lane works without an
  account, but the request must look like the official CLI, byte for byte:
  User-Agent `opencode/latest/2.0.26/cli`; four same-valued session headers and
  no v1-only `x-opencode-request`; a session id minted as the descending
  `~(ts_ms << 12 | counter)` value (a random or sha256 id is refused with 403);
  two tool declarations (`read`, `shell`) verbatim from OpenCode v2.0.26, so
  pi's own `read` is renamed out of the gate slot on the request and restored on
  the response; a required `<env>` block in the system prompt; and never
  `tool_choice: 'none'`. Thinking strength is the model's **declared**
  `reasoning_effort` menu — a level the model does not declare is never sent
  (the gateway answers 400), and a model with no menu gets no picker at all.
  The lane meters per session/IP: a `429 FreeUsageLimitError` gets an actionable
  message and rotates the mapped session, a `403 RegionError` points at egress.

Both lanes also carry transport guards ported from this plugin's issue trail:
the body is read by **shape**, not `Content-Type` (a 200 labelled JSON over a
full SSE stream, or one JSON document answering a stream request, is replayed or
folded instead of dropped — the head is sniffed so a live stream is not buffered
to its end); a stream that only sends keepalive comments dies on an idle
deadline; DeepSeek v4's leaked `<｜DSML｜…>` control markup is scrubbed; and
transport failures append the socket reason (`fetch failed — getaddrinfo
ENOTFOUND …`).

The first time the lanes appear on a machine, the extension says what they cost
and what never to send (Kilo may log prompts; OpenCode meters per session/IP).
It shows once, in an interactive session, and records that it was shown
(`notice-ack.json`; bump `NOTICE_VERSION` in `dist/`-equivalent source
`disclaimer.ts` to bring it back).

## `ofm` command

```bash
/ofm                    # ofm-kilo: N models · ofm-opencode: N models · chains: N
/ofm refresh            # re-fetch both live rosters
```

## Layout

```
pi-extension/
├── index.ts               factory: registers both providers, chains and /ofm
├── fingerprint.ts         the OpenCode v2 client fingerprint (tools, session, headers)
├── catalog.ts             live listing fetch, mapping to pi models, offline snapshots
├── lane.ts               shared stream plumbing: alias restore, error translation,
│                          credential-free fetch, session rotation, sseGuard
├── transport.ts          the host-free half of those guards: head sniff + replay,
│                          body fold, idle watchdog, DSML scrubber, error copy
├── opencode.ts           ofm-opencode provider
├── kilo.ts               ofm-kilo provider
├── chains.ts             fallback chains: normalize, capacity intersection, routing
├── chain-store.ts        durable chain storage (~/.our-free-model/chains.json)
├── disclaimer.ts         the one-time notice the free lanes owe the user
├── scripts/reverify-upstream.ts   live re-measurement of both lanes
├── dist/                 compiled output (`tsc`) — this is what `pi` loads
└── test/                offline unit + integration checks (Node type-strip)
```

## Tests

```bash
npm run test:pi-extension                 # build + unit + integration (integration needs `pi`)
npm run verify:pi-extension-upstream      # live: re-measure both lanes (network, spends free quota)
```

The build (`tsc`) runs under `strict` with `noImplicitAny`, so a type error fails
`npm run build` — that is the compatibility gate against the installed
`pi-ai`/`pi-coding-agent` types.

The integration scripts drive a real `pi` process against a loopback stand-in
gateway, asserting the fingerprint, the alias restore and the wire shape end to
end without touching an upstream. Where `pi` is absent they print
`SKIP <script> — the pi binary is not on PATH` and exit 0, so a contributor
without pi still runs the whole offline suite. The live verifier is not for CI:
it spends this egress's free quota.

The live verifier is the executable form of the periodic maintenance item: it
wears the fingerprint against `opencode.ai` (a `403 FreeTierError` means the
gate moved and `fingerprint.ts` must be re-measured against a current official
client; a `429` means the gate *passed* and this egress spent its quota), asks
Kilo's free pool with no credential, and diffs both live rosters against the
offline snapshot. It exits non-zero on drift; when it does, the response
procedure is in [`../docs/pi-extension-drift-runbook.md`](../docs/pi-extension-drift-runbook.md).

## Notes

- Region-gated models need an outbound proxy: `NODE_USE_ENV_PROXY=1` with
  `HTTPS_PROXY=...` routes both lanes through it.
- `OFM_DATA_DIR` relocates `chains.json` and `notice-ack.json`.
- `OFM_OPENECODE_BASE`, `OFM_OPENECODE_CHAT_BASE` and `OFM_KILO_BASE` override the
  endpoints (used by the tests; `OFM_OPENECODE_BASE` also moves the listing).
- Nothing here holds a private credential, account or token store. Both lanes
  carry only what the upstreams' public documentation describes.
- Kilo's free pool can train on prompts. Do not send credentials, keys, personal
  data, or anything you would not hand to a third party.

## Contributing

`pi-extension` is TypeScript. Edit the `*.ts` files, then `npm --prefix pi-extension run build`
before testing or installing — `pi` loads `dist/index.js`, not the sources. Keep
the fingerprint constants and their measuring comments intact, and re-run
`npm run verify:pi-extension-upstream` after touching `fingerprint.ts` or the
roster snapshots.
