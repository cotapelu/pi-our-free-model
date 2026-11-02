# Our Free Model — pi provider extension

Turns the two **keyless** free-model lanes this repository documents into pi model
providers, so `pi` selects them like any built-in provider: **no login, no
sign-up, no API key, nothing to configure.**

| Provider | Upstream | Credential |
|---|---|---|
| `ofm-kilo` | Kilo AI public gateway, `https://api.kilo.ai/api/gateway` | none — the free pool answers a genuinely credential-less request |
| `ofm-opencode` | OpenCode public free tier, `https://opencode.ai` | one pooled public credential (`Bearer public`) plus a client fingerprint |

Both rosters are fetched live from the upstream listing on every load; an offline
snapshot keeps the models present when the machine has no route upstream.
Tool calls, thinking deltas, usage accounting and cancellation behave exactly
like any other provider, because both lanes stream through pi-ai's
OpenAI-Completions implementation.

## Install

The folder is a pi package (a `pi.extensions` manifest, host packages in
`peerDependencies` only):

```bash
pi install ./pi-extension     # from this repository root
```

or try it for one invocation:

```bash
pi -e ./pi-extension
```

then pick a model:

```bash
pi --list-models | grep ofm
pi --model ofm-kilo/reflection-beam-free
pi --model ofm-opencode/deepseek-v4.1-flash-free --thinking high
pi --model ofm-chain/my-chain            # a fallback chain (see below)
```

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
/ofm chain edit <id|name>                  # wizard: name → links → strategy → sticky
/ofm chain set <id|name> links <provider/model> | <provider/model>
/ofm chain set <id|name> strategy fallback|round-robin[:sticky]
/ofm chain set <id|name> sticky <1..16>
/ofm chain enable|disable|remove <id>
```

`chain edit` is the wizard for the same edits, in an interactive session: it
asks for the name, the links (one per line, prefilled with the current ones), the
strategy and — for `round-robin` — the sticky window, then validates exactly like
`add` does before writing. Cancelling any step writes nothing; in a non-interactive
session it says so and points at the `set` forms and the file.

The trailing field of `add` is the strategy when it spells one — everything
between the name and that field is a link, and a link that is not
`provider/model` is refused rather than silently dropped. Links are also checked
against the live registry: an add whose links are all unresolvable is refused
with their spellings named (a typo, not a roster change), while an add with some
dead links is accepted and reports `1/2 links live … not resolving right now`.
`set` edits an existing chain without touching the file.

`fallback` (default) always starts at the head; `round-robin` rotates the start
per `stickyLimit` turns. The capacities shown for a chain are the intersection
of its links — the honest numbers, never the union: a chain whose head sees
images hands a text-only fallback nothing it cannot read.

How the failover works is a property of pi, not of this extension: pi routes
once per request, retries only *transient* failures, and deliberately does not
retry a quota wall (its own policy lists `FreeUsageLimitError` as an account
limit — retrying it spends the quota three times). So a chain advances on the
retry when pi retries, and on the **next user turn** after a failure pi refuses
to retry, always to the link after the one that failed. A continuation stays on
the model that answered, so prompt caches and thinking signatures survive, and a
walk is capped at `links - 1` moves per streak, so a chain of dead links fails
its turn instead of flapping forever. Chains persist in
`~/.our-free-model/chains.json` (`OFM_DATA_DIR` overrides).

## Why these models are free — and what that costs

- **`ofm-kilo`** — Kilo AI publishes an OpenAI-compatible gateway whose `isFree`
  slice answers with no account, key or login state at all. It is the simplest
  lane: the only adaptation is that the request must carry **no** Authorization
  header (a placeholder token is a `401 INVALID_TOKEN` on this pool), and the
  payload is normalised onto the gateway's parameter vocabulary (`reasoning`
  rather than `reasoning_effort`, `max_tokens` rather than `max_completion_tokens`).
  **The gateway's own model cards state that free-pool prompts may be logged by
  the upstream provider and used to improve its services.** Use this lane for
  throwaway work, never for secrets.
- **`ofm-opencode`** — OpenCode serves a free tier for its own users behind a
  *pooled public* credential and a **client fingerprint** gate. The gate is not
  an account check: it fingerprints the client, so the lane works without one —
  but the request must look like the official CLI, byte for byte:
  - User-Agent `opencode/latest/2.0.26/cli` (v2 shape, exact string);
  - four same-valued session headers (`x-opencode-session`,
    `x-opencode-session-id`, `x-session-affinity`, `x-session-id`) and **no**
    v1-only `x-opencode-request`;
  - a session id minted as the descending `~(ts_ms << 12 | counter)` value with
    counter 1–63 — a random or sha256 id is refused even when the shape is right;
  - an `<env>` block (working directory + platform) in the system prompt — a
    request without it is refused (429), measured live on the upstream;
  - two identity-metered tool renames (`subagent_fork` → `conversation_delegate`,
    `working_directory` → `workspace_directory`) with the mapping told to the
    model — those two names answer 429 otherwise;
  - two tool declarations (`read`, `shell`) verbatim from OpenCode v2.0.26, which
    means the caller's own `read` tool is renamed out of the gate slot on the
    request and restored on the response (see `fingerprint.js`, `lane.js`);
  - never `tool_choice: 'none'`.

  Thinking strength on this lane is the model's declared `reasoning_effort` menu:
  capacities are the **served** ones (the listing publishes a floor — the same
  upstream accepted ~1M-token prompts on `deepseek-v4.1-flash-free`), a level the
  model does not declare is never offered (the gateway validates the field and
  answers 400), and a model with no declared menu gets no picker at all.

  The lane meters per session/IP: a `429 FreeUsageLimitError` is translated into
  an actionable message and rotates the mapped session, and a `403 RegionError`
  points at egress. Failures are reported in plain language, not as raw bodies.

Nothing in this extension holds a private credential, an account or a token
store. Both lanes' requests carry only what the upstreams' public documentation
describes; usage and rosters stay in-process.

The first time the lanes appear on a machine, the extension says what they cost:
Kilo's free pool may log prompts upstream, OpenCode's free tier is metered per
session/IP, and nothing sensitive belongs on either. It shows once, in an
interactive session, and records that it was shown (`notice-ack.json`, next to
the chains); bumping `NOTICE_VERSION` in `disclaimer.js` makes it come back.

Both lanes also carry the transport guards these gateways require (ported from
the plugin's own issue trail): the body is read by **shape**, not
`Content-Type` — these gateways are observed answering 200 with a JSON
content-type over full SSE frames, and answering a stream request with one
complete JSON document, which pi's SDK would drop as an empty turn (the plugin:
issue #6); a stream that only sends keepalive comments dies on an idle deadline
instead of holding the turn open (issue #460); and DeepSeek v4's leaked
`<｜DSML｜…>` control markup is scrubbed from visible text. Kilo's off rung rides
the gateway's `reasoning: { enabled: false }`, and the families that answer 400
to an off request are not offered one.

## Layout

```
pi-extension/
├── index.js                 factory: registers both providers, chains and /ofm
├── fingerprint.js           the OpenCode v2 client fingerprint (tools, session, headers)
├── catalog.js               live listing fetch, mapping to pi models, offline snapshots
├── lane.js                  shared stream plumbing: alias restore, error translation,
│                            credential-free fetch, transport guards, session rotation
├── opencode.js               ofm-opencode provider
├── kilo.js                  ofm-kilo provider
├── chains.js                fallback chains: normalize, capacity intersection, routing
├── chain-store.js           durable chain storage (~/.our-free-model/chains.json)
└── test/                    offline integration + unit checks (node, no network)
    ├── fingerprint.test.mjs         payload fingerprint unit checks
    ├── catalog.test.mjs             mapping and effort-menu unit checks
    ├── chains.test.mjs              chain routing state machine unit checks
    ├── fingerprint-integration.mjs  stand-in gateway asserts the gate's checks;
    │                                pi must execute the aliased tool call, and a
    │                                no-menu model must carry no effort at all
    ├── kilo-integration.mjs         stand-in gateway asserts the Kilo wire shape,
    │                                the off rung and the non-SSE fold
    └── chain-integration.mjs        stand-in gateway drives a real pi run: a retryable
                                     failure fails over within the turn, a quota wall
                                     fails over on the next user turn
```

## Tests

```bash
npm run test:pi-extension              # unit + integration; integration needs `pi`
npm run verify:pi-extension-upstream   # live: re-measure both lanes (network)
```

The integration scripts drive a real `pi` process. Where the binary is absent
they print `SKIP <script> — the `pi` binary is not on PATH` and exit 0, so a
contributor machine without pi still gets the whole offline suite, and CI runs
the same command in both shapes (`npm i -g
@earendil-works/pi-coding-agent@^1.4.0` turns the skips into real runs). The live
verifier is deliberately not in CI: it spends this egress's free quota.

The live verifier is the executable form of the periodic maintenance item: it
wears the fingerprint against `opencode.ai` (a `403 FreeTierError` means the
gate moved and `fingerprint.js` must be re-measured per the plugin's
`docs/free-lane-wire.md`; a `429` means the gate *passed* and this egress spent
its quota), asks Kilo's free pool with no credential, and diffs both live
rosters against the offline snapshot — a model that appears, disappears, moves
to another wire, or changes its declared thinking menu is reported instead of
silently changing what `pi --list-models` offers. It exits non-zero on drift.

When it does fail, the response procedure — symptom → meaning, what to measure,
which file and symbol to edit, and what must pass before a commit — is written
down in [`../docs/pi-extension-drift-runbook.md`](../docs/pi-extension-drift-runbook.md).

The two integration scripts stand up a loopback stand-in gateway (recording
exactly what the provider sends) and drive a real `pi` run against it, so the
fingerprint, the alias restore and the wire shape are asserted end to end
without touching either upstream. They need `pi` on `PATH`.

## Notes

- Region-gated models need an outbound proxy: `NODE_USE_ENV_PROXY=1` with
  `HTTPS_PROXY=...` routes both lanes through it.
- `OFM_OPENECODE_BASE`, `OFM_OPENECODE_CHAT_BASE` and `OFM_KILO_BASE` override the
  endpoints (used by the tests; `OFM_OPENECODE_BASE` also moves the listing).
- The upstream gate changes without notice; if the free lane starts answering
  `403 FreeTierError`, the fingerprint in `fingerprint.js` must be re-measured
  against a current official client. This repository's `docs/free-lane-wire.md`
  records the method (TLS man-in-the-middle plus byte-for-byte replay).
- Kilo's free pool can train on your prompts. Do not send credentials, keys,
  personal data or anything you would not hand to a third party.
