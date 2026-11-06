# TODO — pi-extension làm API provider đầy đủ

Checklist. Cập nhật trạng thái sau mỗi bước.

## Hướng (quyết định 2026-11-05)

pi-extension phát triển thành **api provider đầy đủ** (HTTP server độc lập) cho mọi coding
agent (pi, Claude Code, Codex, Continue, curl…), không chỉ pi. Mọi thứ cần từ dsh sẽ được
port vào. pi-extension vẫn chạy được như pi extension (`pi.extensions`).

Chi tiết phân tích: `BAOCAO.md` Phần 7 và `docs/pi-extension-audit.md`.

## Đã xong (pi provider extension — chạy tốt, ~124 check PASS)

- [x] Đọc/toàn soát luồng dsh: `task-adapter`, `flow-rule`, `http.js` guard, `upstream.js`
      fingerprint v2, `catalog.js`, `effort.js`, `kilo.js`, `stream.js`, `messages.js`
- [x] Port lane free sang TS strict: `diagnose` (catalog/fingerprint/transport/lane/opencode/kilo)
- [x] Provider `ofm-opencode` + `ofm-kilo` stream qua `openAICompletionsApi().streamSimple`
- [x] Fingerprint OpenCode v2: UA, 4 session header, session mint, 2 tool verbatim, aliases, `<env>`
- [x] Transport guard: sseGuard, foldToSse, readHead/replayStream, withIdleTimeout, DSML scrubber
- [x] Catalog: live listing + offline snapshot, effortMap, kiloEffortMap, createKiloRoster
- [x] Chain fallback + round-robin: `chains.ts`, `chain-store.ts`, virtual model ofm-chain
- [x] Token saver RTK 12 filters + prompt family (caveman/ponytail) — OFF mặc định
- [x] Disclaimer một lần (version-gate, notice-ack.json)
- [x] Reverify upstream script + drift runbook
- [x] 12 suite test (~124 check) PASS, 4 script integration chạy thật qua `pi`
- [x] Fix bug thật: `lane.ts` readHead deadline khi `OFM_STREAM_IDLE_MS=0`
- [x] Đối chiếu API extension/provider với pi 1.4.0 (provider-composer, models.js)

## Trạng thái hiện tại (2026-11-05)

- Build: `tsc` strict **sạch 0 lỗi** (`tsconfig.json` include `gateway/**/*.ts`)
- Test: **20/20 script PASS**, 362 check `ok`, 0 FAIL — kể cả 5 script integration/live
  (chạy thật qua `pi`, không SKIP)
- Smoke thật: `node pi-extension/dist/server.js --port 18941` → `/v1/models` 20 model live,
  1 lượt `ofm-kilo/kilo-auto-free` trả lời `pong` (cả stream lẫn non-stream)
- Smoke 3 giao thức trên live Kilo: OpenAI `pong` · Anthropic `message`/`end_turn`/`pong`/
  usage · Gemini `candidates`/`STOP`/`pong`/`usageMetadata`
- Route đang sống: `GET /v1/models`, `POST /v1/chat/completions` (stream + non-stream),
  `POST /v1/messages` + `/v1/messages/count_tokens` (Anthropic),
  `POST /v1beta/models/{model}:generateContent|streamGenerateContent` + `GET /v1beta/models`
  (Gemini), `/health`, CORS
- File mới: `gateway/{protocol,loopback,dispatch,response-stream,anthropic,gemini,server}.ts`,
  `server.ts`, `test/gateway.test.ts` (29 check)
- Pi extension mode vẫn nguyên: `pi -e ./pi-extension`, `/ofm`, chain, saver

## Việc cần làm — cho full api provider (ưu tiên theo thứ tự)

### P0 — HTTP server (lõi api provider) ✅ ĐÃ XONG (2026-11-05)
- [x] `gateway/protocol.ts`: key auth (`generateKey`/`keyMatches` constant-time),
      bounded body, CORS, OpenAI error envelope
- [x] `gateway/loopback.ts`: resolve DNS + kiểm tra mọi IP là loopback (issue #19),
      `bindGatewayPort` retry + scan cổng kế cận, `rankLanAddresses`
- [x] `gateway/dispatch.ts`: resolve `provider/model` → lane, build payload, wire-id Kilo,
      fingerprint OpenCode, `sseGuard` transport, stream + non-stream fold
- [x] `gateway/response-stream.ts`: `deferStreamResponse` (heartbeat commit),
      alias restore + DSML scrub trên SSE frame, `foldSseAnswer` → chat.completion
- [x] `gateway/server.ts`: node:http, key fence, CORS, health, `/v1/models`,
      `POST /v1/chat/completions`
- [x] `server.ts`: standalone entry — `node pi-extension/dist/server.js
      [--port N] [--host] [--key]`, env `OFM_GATEWAY_PORT/HOST/KEY`
- [x] 17 unit check `gateway.test.ts` qua loopback stand-in (không tốn quota)
- [ ] Tool hygiene: renumber `tool_calls[].index` từ 0, suppress fingerprint decoys

### P1 — đa giao thức (mọi coding agent) ✅ ĐÃ XONG (2026-11-05)
- [x] `gateway/anthropic.ts`: fromAnthropicRequest (system→message, text/image/tool_use/
      tool_result, `thinking` + `redacted_thinking` bị drop), toAnthropicMessage,
      countTokens estimate, toàn bộ frame renderer (message_start/content_block_*/
      message_delta/message_stop/error)
- [x] Route `POST /v1/messages` + `POST /v1/messages/count_tokens` → dispatchAnthropicChat
- [x] 5 unit check Anthropic qua stand-in: message shape, tool_use round-trip, system,
      stream frames, count_tokens không dispatch
- [x] Sửa 1 lỗi thật tìm ra bằng test: `dispatchAnthropicChat` gọi `getReader()` hai lần
      trên cùng body (rewrite + fold) → stream bị lock; fold giờ đọc stream đã rewrite
- [x] `gemini.ts`: geminiRoute, geminiError, fromGeminiRequest (contents/systemInstruction/
      tools/toolConfig, functionCall/functionResponse pairing, schema uppercase→lowercase),
      toGeminiResponse (`candidates`/`usageMetadata`), geminiFrameStream
- [x] Route `POST /v1beta/models/{model}:generateContent|streamGenerateContent` +
      `GET /v1beta/models` + countTokens; 5 unit check qua stand-in
- [x] Sửa 3 lỗi thật tìm ra bằng test: `functionResponse` không dùng `id` của chính nó khi
      không có call trước đó; schema không đệ quy; biến `parts` trùng tên
- [ ] Route `POST /v1/responses` → gọi qua adapter chung
- [ ] Failure map `forwardFailure`: HTTP status + OpenAI/Anthropic error type (`failure.ts`)

### P2 — adapter / turn orchestration ✅ ĐÃ XONG (2026-11-05)
- [x] `gateway/chain.ts`: `runChain` + commit rule port từ `src/adapter.js` `runCombo`
- [x] Commit rule: giữ frames đến frame mang đáp án; reasoning **KHÔNG** commit; candidate
      không có đáp án bị bỏ nguyên khối, chuyển link trong suốt với caller
- [x] `dispatchChainChat` + route `ofm-chain/<name>` trên cả HTTP; `GET /v1/models` liệt kê
      chain đang bật; standalone entry nạp `chains.json` qua `readChains`
- [x] `performUpstream` gom transport guard dùng chung cho cả 4 dialect
- [x] 6 unit check chain qua stand-in: 404 chain lạ, chain chết không dispatch, failover 429,
      reasoning-only bị bỏ, chain kiệt cùng 502 có lý do từng link
- [x] Sửa 1 lỗi thật tìm ra bằng test: commit giữa buffer **mất phần đuôi** của body một-chunk
      → frames còn lại trong buffer phải đi kèm
- [x] Cycle detection + round-robin sticky: `smart`/`usage`/`pace` cần quota probe (P3) nên
      tạm rơi về thứ tự fallback — ghi rõ trong `orderLinks`
- [ ] `savingsFields` + token saver record trong usage response

### P3 — recovery + classification ✅ ĐÃ XONG (2026-11-05)
- [x] `gateway/recovery.ts` port đầy đủ `src/recovery.js`: RECOVERY_DEFAULTS, recoveryPolicy,
      canRecover, canRecoverSilentStop, recoveryMessages, continuationMessages, checkpointFits,
      addUsage, createBlockTracker, MIN_BUDGET
- [x] `recoverTurn` trong dispatch: nhận diện (a) stream đứt không có finish frame,
      (b) stop sạch chỉ có reasoning, (c) answer bị cắt ở `length` → tiếp một lần với
      budget còn lại, ghép nội dung cho trường hợp (c)
- [x] 22 unit check `recovery.test.ts` + 2 check end-to-end qua gateway (có replay + floor)
- [x] Sửa 1 lỗi thật tìm ra bằng test: guard budget so `remaining` với `maxOutputTokens`
      (8192) thay vì floor 512 → mọi lượt < 8192 token không bao giờ được recover
- [x] Ghi chú: `checkpointTruncated` luôn false ở gateway (chưa cắt buffer reasoning) —
      có thể siết sau bằng checkpointLimit
- [x] `classify.ts` port đầy đủ `src/route/classify.js` (543 dòng): FAILURE_KIND/FAILURE_SCOPE,
      ERROR_RULES (text trước status), MARKER_RULES (gRPC spelling), CODE_VERDICTS,
      OVERLOAD_STATUSES, CONTEXT_WINDOW codes+markers, `backoffFor` (2s×2^(n-1), guard
      `level-1`, cap 5 phút), `classifyFailure`, `shouldAdvance`, `describeVerdict`
- [x] `runChain` dùng classify để quyết định advance: request-scoped 4xx và context
      overflow **không** chuyển link mà trả nguyên lỗi thật cho caller
- [x] 29 unit check `classify.test.ts` + 1 check chain end-to-end (400 không advance)
- [x] Sửa 1 lỗi thật do chính việc móc nối: `exhausted()` trả 502 giả cho mọi link chết,
      trong khi refusal request-scoped phải trả nguyên status + message của upstream
- [ ] `failure.ts` port: `forwardFailure` map code → HTTP status + OpenAI/Anthropic error
      type cho từng dialect (hiện gateway dùng `friendlyMessage` của transport.ts — 9 nhánh)

### P4 — hạ tầng ✅ ĐÃ XONG (2026-11-05)
- [x] `gateway/store.ts` port `src/store.js`: `JsonStore` (coalesce 800ms, temp+rename 0600,
      `restrictPermissions` cả Windows `icacls`, giữ file hỏng thay vì ghi đè),
      `dataDir`, `dayKey`, `decodeWindow` + 2 bounds, `accumulateSavings`, `recordUsage`
      (ngày/model/lifetime + ring 400 mẫu + marker `truncated`/`noUsage`), `pruneDays`
- [x] `server.ts` entry dùng JsonStore cho `gateway.json` (key) thay vì ad-hoc
- [x] 20 unit check `store.test.ts`: persist/reload, corrupt retained, flush retry không mất
      thay đổi, 0600, `edit` trả giá trị, `dispose` khoá store, decode bounds, audit marker
- [x] Sửa 1 lỗi thật tìm ra bằng smoke: `key = a ?? b ?? minted` giữ chuỗi rỗng (không mints)
      → đổi sang `||`; smoke xác nhận key mints, `0600`, **tồn tại qua restart**
- [x] `gateway/optimize.ts` port `src/local-optimize.js`: 5 detector (quota/prefix/title/
      suggestion/filepath), `shellWords` (escape trong ngoặc kép khác ký ngoài),
      `extractCommandPrefix` (chặn substitution), `extractFilepathsFromCommand`
      (grep pattern≠path), `toMessagesResponse`, `localAnswerId`
- [x] `localAnswerFor` móc vào `dispatchAnthropicChat`: quota probe / prefix / title /
      suggestion / filepath trả lời **không tốn quota lane**; `OFM_LOCAL_OPTIMIZE=off` tắt
- [x] 25 unit check `optimize.test.ts` + 2 check end-to-end (local không gọi lane, câu hỏi
      thật vẫn qua lane)
- [x] Sửa 1 lỗi thật tìm ra bằng test: escape `\n` ngoài ngoặc — `n` không nằm trong
      ESCAPABLE nên backslash phải giữ nguyên, không phải `an\nb`
- [x] `gateway/egress.ts`: loopback relay (key per start, 401 trước khi dial, hop-by-hop
      strip, target qua URL không phải socket-writer), `isOfficialFreeLane` (chỉ lane
      opencode.ai/inference được dùng Bun), `findBunExecutable`, `bunFetch` (Bun worker
      inline qua `-e`, payload JSON trên stdin, body base64 trên stdout, abort kill child),
      `egressRequestHeaders`
- [x] 10 unit check `egress.test.ts`: lane gate, header strip, repeated header join,
      relay 401 không key, outlet tắt không mở relay
- [x] Sửa 2 lỗi thật tìm ra khi build: `generateKey` từ `node:crypto` cần 3 argument
      (phải `randomBytes`); `bunFetch` spawn một file `fetch.mjs` không tồn tại → đổi
      sang worker inline
- [x] Ghi chú: **mihomo/Clash subscription spawn không port** (cần binary không ship) —
      caller chạy mihomo riêng và trỏ `OFM_EGRESS_URL` vào mixed port
- [x] `gateway/probe.ts` port `src/probe.js`: STATE, CODE, ROUTING_REFUSAL_STATUS, `stateOf`
      (code → message → status, **5xx không đọc là refusal có tên**), `aggregate`,
      `prefer`, `createProber` (cache theo verdict: healthy 15 phút, refused 5 phút),
      `publicAvailability`
- [x] 22 unit check `probe.test.ts`: verdict precedence, routing status, 5xx carve-out,
      aggregate/prefer, cache, per-model session, persist, report change một lần
- [x] Sửa 3 lỗi thật tìm ra bằng test: return `timeoutMs` không khai báo (build); regex
      thiếu `unsupported`; test dùng `assert.equal` cho array → `deepEqual`
- [x] Ghi chú: `probeModel` (dial 16 token + egress echo `detectEgress`) **chưa port** —
      cần dial thật; `createProber` nhận `doProbe` nên test không tốn quota. `publicAvailability`
      tách rõ "no measurement" (picker) khỏi "advance walker" (chain)

### P5 — trình chạy + test
- [ ] Entry: chạy được `node dist/server.js` (standalone) và `pi install ./pi-extension`
- [ ] `/ofm` command thêm `provider on|off`, `provider status` (port/endpoint/models)
- [ ] Unit test cho: server routes, anthropic codec, gemini codec, adapter commit rule,
      recovery, classify, store, local-optimize, egress relay
- [ ] Integration test qua loopback stand-in cho cả 3 giao thức (không tốn quota upstream)
- [ ] Smoke: `pi -e ./pi-extension` vẫn chạy, `pi --list-models` vẫn thấy roster

## Không port (đã phân loại)

EAC co-pay (cần gateway server + seal HMAC), 10 kênh tài khoản (148 file OAuth/QR + wasm),
magpie binary Go 68MB, UI 11 trang React + client.js dictionary, updater Ed25519, self
hot-reload, feed/push/sponsor, packages/standalone + packages/desktop Tauri, aggregate 76
provider (pi/agent tự quản key qua login riêng — thêm storage thứ 2 là rủi ro).

## Cảnh báo upstream (chạy verify 2026-11-05 — cần quyết định)

`npm run verify:pi-extension-upstream` báo **4 check fail vì lane free upstream đã drift**
(không phải lỗi code — đúng việc script tồn tại để bắt):

| Hiện tượng | Chi tiết |
|---|---|
| Row mới trên wire khác | `crouton-alpha-free` (OpenCode) đăng ký `wire: 'responses'` — gateway chỉ nói chat-completions, nên row này hiện **không phục vụ được** |
| Id mới | `crouton-alpha-free` (OpenCode), `stealth-crouton-alpha` (Kilo) |
| Id hết miễn phí | 5 id Kilo rời pool: `recursive-flint-v1.0-free`, `xingchen-agi-xing4.0-29b-a4b-free`, `liquid-lfm-2.5-2.6b-free`, `nvidia-nemotron-3.5-content-safety-free`, `inclusionai-lick-3.1-flash-1019-free`, `thinkingmachines-inkling-free`, `thinkingmachines-inkling-small-free`, `google-gemma-4-31b-it-free` |
| Effort menu đổi | `crouton-alpha-free` giờ là `minimal\|low\|medium\|high\|xhigh\|max` |

Quyết định cần chờ user (không tự đổi — là chính sách về dữ liệu phục vụ):
1. Có thêm road Responses wire cho `crouton-alpha-free` không? (nếu không → để ngoài snapshot)
2. Bỏ 5 id đã trả phí khỏi snapshot (`catalog.ts`) — để lại sẽ trả lỗi cho caller.
3. Thêm 2 id chat-wired mới + cập nhật effort menu theo runbook §3.

Tham khảo: `docs/pi-extension-drift-runbook.md`.

## Lệnh dùng lại

```bash
npm --prefix pi-extension install        # dev deps
npm --prefix pi-extension run build      # tsc strict → dist/
npm run test:pi-extension                # unit + integration
npm run verify:pi-extension-upstream     # live re-measure cả 2 lane
node pi-extension/dist/server.js         # chạy api provider (khi xong P0)
```
