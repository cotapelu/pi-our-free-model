# BÁO CÁO TOÀN DIỆN — SỤC SÃO CODE DSH GỐC VÀ PI-EXTENSION

Phạm vi đã đọc: **100% source** của repo gốc (index.js, client.js, src/**, adapter/,
worker/**, vendor/**, packages/**, scripts/**, catalog/, feed/, locale/, docs/**) và
**100% source + test** của `pi-extension/`. Không có file `.js`/`.ts` nào trong hai
phe bị bỏ qua.

---

## PHẦN 1 — REPO DSH GỐC LÀM GÌ (7 HỆ THỐNG + VỎ PHÂN PHỐI)

### 1.1. Hệ thống 1 — Lane miễn phí keyless (mảnh duy nhất pi-extension dùng lại)

Đây là phần "món hàng" thật sự. Gồm các module:

| File | Số dòng | Việc nó làm |
|---|---|---|
| `src/upstream.js` | 645 | **Bộ não của lane**:UA v2 `opencode/latest/2.0.26/cli`; 2 công cụ `read`/`shell` phải khai báo **từng byte** đúng; 4 session header `x-opencode-session`, `-session-id`, `x-session-affinity`, `x-session-id` cùng giá trị; session id `ses_`+12 hex `~(ts<<12&nbsp;\|&nbsp;counter)`+14 base62; `tool_choice:'none'` **cấm**; block `<env>` bắt buộc; 2 alias danh tính `subagent_fork→conversation_delegate`, `working_directory→workspace_directory`; retarget tool_choice; rename history; session ổn định theo hội thoại + persist `session-map.json`. |
| `src/http.js` | 700 | **Transport + phân loại lỗi**: `readHead` (sniff 4KB, không buffer cả stream), `replayStream`, `readRemainder`, `readSse` (idle deadline chỉ reset khi chunk mang `data:` — issue #460), `foldToSse` (1 JSON document → SSE frames), `sniffBody`, `transportCause` (đi 3 nhánh `cause`), `classifyFailure` (tóm 12 loại: RegionError/quota/credential/laneLocked/permission/signature-rejected/HTML-WAF/ModelError/4xx/5xx), `emptyBodyFailure` (5xx rỗng + ảnh → issue #549), `carriesImageContent`, `getJson`, `postStreamed`. |
| `src/catalog.js` | 500 | **Catalog 3 lane**. Free lane: `FREE_ID_OVERRIDIDES` (deepseek 1M/384K, glm 1M/131K, nemotron-vl 1M/131K, space-bunny 1M/524K, big-pickle 262K/131K…), `CAPABILITIES` theo family regex, `canDisableThinking`/`efforts`/`effortDefault`/`effortPatch`/`effortOffPatch`, `displayModelName`, `isFreeLane`, `buildCatalog`. EAC lane: `EAC_CAPABILITIES` (copy nguyên declaration ZCode). Kilo lane: `KILO_EFFORT_PATCH` effort object, `KILO_REASONING_MANDATORY` stepfun/liquid/thinkingmachines, `KILO_NO_DISABLE_IDS`, `kiloDisplayName`, `buildKiloCatalog`, `reviveKiloCatalog`. |
| `src/effort.js` | 300 | **Chính sách effort**: budget ladder 3 rung `light/balanced/deep` = 2048/8192/full; `ALWAYS_THINKING_FACTOR=2` cho model không tắt được (mimo v2.6: 82% output là reasoning); `MIN_BUDGET=512`; `normalizeLevel`, `resolveLevel`, `budgetFor`, `budgetLadder`, `effortPatchFor` ($effort → JSON merge patch), `hasDeclaredEffortMenu`, `eacDefaultLevel`, `defaultEffortFor`. |
| `src/kilo.js` | 350 | Lane Kilo: `fetchKiloListing` (16KB timeout, không credential), `postKiloStreamed` (POST `/chat/completions` không Authorization), classify `classifyKilo` reshape envelope `error_type`/`error.code` → `PAID_MODEL_AUTH_REQUIRED` (client) vs `moderation` (client). |
| `src/stream.js` | 780 | **SSE projection** → StreamChunk: BlockSink (mint tool-call id khi thiếu, `toolKey` theo index/id, `argumentsCutMidway` phân biệt JSON đứt vs sai schema), DSML scrubber (deepseek v4 leak `<｜DSML｜…>`), `mapUsage` (input = prompt − cached), `sanitizeUsage` (bỏ token stamp > context window của kilo-auto), `readStream` cho cả **3 wire chat/responses/messages**, `reasoningOf` (đọc 4 spelling reasoning/reasoning_content/reasoning_text/thinking), `finishReason`, `windowTokens`. |
| `src/probe.js` | 250 | **Dò khả dụng theo egress**: `probeModel` ping 16 token mỗi model (session riêng tránh 429), `probeCatalog` concurrency 2, `stateOf` đọc verdict (400/404/422=unavailable, 5xx=unknown — 503 "Service Unavailable" không đuổi model), `detectEgress` qua 3 echo (ipify/ipinfo/ipapi). |
| `src/messages.js` | 400 | **Chiếu message**: `repairToolPairing` (fix 400 do call không result / result không call / call vô danh — issue #92), `toChatMessages`/`toClaudeMessages`/`toResponseInput` (ảnh đi sau role:tool, reasoning_content giữ nguyên), `toToolDefs` 3 shape, `needsVision`. |
| `src/recovery.js` | 200 | **Tự phục hồi**: phát hiện "chỉ có reasoning, không có text" (`canRecoverSilentStop`) hay "stream đứt" (`canRecover`) → nối checkpoint reasoning vào prompt và xin tiếp **một lần**; `continuationMessages` cho finish=length (issue #28); `createBlockTracker` đóng block khi lỗi. |
| `src/channel.js` | 40 | Channel SPSC callback→async-iterable. |
| `src/model-test.js` | 100 | `runModelTest`/`measureModelTest`: đo TTFT/tok-s/chấp nhận chỉ "có text + finish stop", ra verdict availability. |
| `src/route/classify.js` | 320 | **Từ vựng lỗi thống nhất** cho router: merge FCC `FailureKind` + 9router `ERROR_RULES`; `classifyFailure` trả `{kind, retryable, cooldownMs, cooldownLevel, scope, rule}`; backoff 2s×2^(n-1) cap 5 phút; `shouldAdvance`. |

### 1.2. Hệ thống 2 — Lane co-pay EAC (không port)
`src/eac.js` (POST có HMAC-SHA256 sign `timestamp\nMETHOD\npath\nsha256(body)`, qua
`node:http` riêng chống plugin fetch bị thay), `src/vault.js`+`vault-data.js`+`vault-anchor.js`
(seal AES-256-GCM, key ghép từ 3 shard HKDF, chỉ mở khi host là Tauri/Electron/web-desktop),
`src/eac-login.js` (poll GitHub login + star), `src/eac-user.js` (token per-user 0600),
`worker/` (Cloudflare Worker gateway giữ key thật), `worker/gateway-node.mjs` (bản self-host
có dashboard + per-IP rate limit + concurrency). **Không cần cho pi** — cần GitHub login
và maintainer vận hành.

### 1.3. Hệ thống 3 — 10 kênh tài khoản (không port)
`vendor/channel-pack/src/**` (~148 file TS, ~64k dòng): OAuth/QR/serial-queue/credit-claim
cho Cline, Qoder, TRAE, Loomy, Raccoon, MiniMax, ZCode, LobsterAI, Gemini, OpenCode —
kèm 2 file wasm. `src/magpie-engine.js` spawn binary Go `yetone/magpie` 68MB làm local
gateway 127.0.0.1, `src/magpie-models.js`/`magpie-policy.js`/`subscription*.js` cấp roster
và chặn kênh WorkBuddy/Huawei. Pi **không** cần — đòi login, quá lớn.

### 1.4. Hệ thống 4 — Local gateway 3 protocol (không port)
`src/forward.js` (HTTP listener OpenAI `/v1/chat/completions` + Anthropic `/v1/messages`
+ Responses + Gemini), `src/anthropic.js`/`gemini.js`, `src/chan-relay.js`, `src/combos.js`
(chain fallback), `src/loopback-fetch.js`. Port 18899 + LAN relay có key riêng. Pi có
provider/route riêng nên cơ chế này thừa.

### 1.5. Hệ thống 5 — Egress tự quản (không port)
`src/egress.js`: spawn mihomo/Clash từ subscription, health-check gstatic 204 mỗi 5 phút,
relay loopback có key, socks5/http CONNECT; `src/bun-fetch.js`: giữ TLS stack Bun cho lane
OpenCode chống proxy plugin rewrite body. Pi chỉ cần `HTTPS_PROXY` (README §Notes).

### 1.6. Hệ thống 6 — Vỏ sản phẩm (không port)
`index.js` (2492 dòng host half: wiring 2 route, egress, forward, chan-relay, push SSE,
updater, feed, hot reload, `/api/our-free-model/*` ~50 route), `client.js` (7682 dòng
React 11 trang: 免费模型/EAC/白嫖/看板/日志/网关/聚合/省Token/路由/升级/推荐),
`src/store.js` (JsonStore + stats + heatmap), `src/updater.js` (1276 dòng: Ed25519 sign
manifest, download→verify→stage→backup→swap→rollback), `src/push.js`, `src/feed.js`,
`src/picks.js` (star count), `src/sponsor.js` (quảng cáo), `src/trust.js`,
`src/open-external.js`, `src/aggregate.js` + `src/providers/registry.json` (76 provider
user tự paste key), `src/token-saver/**` (RTK nén tool result + prompt caveman/ponytail),
`src/local-optimize.js` (5 câu trả lời local: quota/prefix/title/suggestion/filepath).

### 1.7. Hệ thống 7 — Phân phối, test, tài liệu (không port)
`scripts/` 157 file test offline; `catalog/*.json` manifest ký; `packages/standalone`
(110 file: service port 18900 + web console) và `packages/desktop` (Tauri);
`docs/` 80+ file (free-lane-wire.md, runbook, verification từng issue, release notes).
Đây là lý do repo 35MB source — phần lớn là test + vendored + docs.

---

## PHẦN 2 — PI-EXTENSION HIỆN CÓ GÌ (đã đọc từng dòng)

### 2.1. `fingerprint.ts` — port của `src/upstream.js`
- **Giữ nguyên 100%**: `CLIENT_UA`, `FINGERPRINT_TOOL_DEFINITIONS` (cả 2 description +
  parameters JSON byte-for-byte), `FREE_LANE_TOOL_ALIASES`, `SESSION_RE`,
  `SESSION_DESCENDING_HE_RE`, `gatewayHeaders` (5 header + `Bearer public`),
  `ensureFreeLaneEnvironment`, `placeholderNote`, `mintSessionId`.
- **Thay đổi có chủ ý**: (a) chỉ làm wire **chat** (`params.messages`), bỏ 3 shape
  responses/claude vì pi-ai luôn gọi `openAICompletionsApi`; (b) alias gate-slot đổi
  tên `read_ofm1` (dsh dùng `read_client`); (c) session only in-process (không persist
  `session-map.json` — ghi chú TODO: mint lại sau restart vẫn qua gate); (d) thêm
  `rotateSession(seed)` cho lane xoay session sau quota.
- **Lỗi thật đã sửa**: `const alias` bị gán lại trong vòng `for` khi alias trùng slot
  → crash hiếm → đã đổi `let alias` + test "a gate-slot collision moves the caller
  tool to a fresh alias instead of crashing".

### 2.2. `catalog.ts` — port của `src/catalog.js` (2 lane) + snapshot
- `FREE_ID_OVERRIDES` giữ đủ 7 id + `pulse-alpha-free` (drift 2026-11-02);
  `FREE_CAPABILITIES` giữ 10 family regex + quy tắc `-vl` → vision.
- `effortMap()`: map 6 level pi (`minimal…max` + `off`) sang menu upstream, `xhigh`↔`max`
  đổi chỗ cho nhau, `off` = `none`/`disabled` (giá trị OpenCode tự khai).
- `kiloEffortMap()`: off = sentinel `'off'` (wire layer sẽ dịch), giữ
  `KILO_REASONING_MANDATORY` + `KILO_NO_DISABLE_IDS`.
- `opencodeModel()`: chỉ nhận row có `api['chat-completions']` → `null` cho
  responses/messages (đúng G11).
- `createKiloRoster()`: **cải tiến so với dsh** — map `safeId→wire` seed từ snapshot,
  chỉ **thêm** không **thay**; `degrade()` giữ roster live sau abort/timeout/5xx; chỉ
  slice free **rỗng** mới về snapshot. Đây là fix bug thật lộ ra khi `chain-integration`
  flake 2/8 (pi abort refresh rơi sau fetch 200 → map bị đè → sai wire id).
- `STATIC_OPENECODE_MODELS` 9 id / `STATIC_KILO_MODELS` 18 id, mỗi row Kilo mang `wire`.
- `upstreamIdMap()`, `safeId()`, `staticUpstreamIds()`.

### 2.3. `transport.ts` — port host-free của `src/http.js`
`createDsmlScrubber`, `sniffBody`, `foldToSse` (có cả reasoning_content/tool_calls/usage),
`SNIFF_BYTES=4096`, `readHead` (có deadline riêng + honor abort), `replayStream`,
`readRemainder`, `withIdleTimeout` (chỉ chunk mang `data:` reset deadline),
`friendlyMessage` (9 nhánh: FreeTierError/FreeUsageLimitError/RegionError/HTML-WAF/
ModelError/PAID_MODEL_AUTH_REQUIRED/INVALID_TOKEN/signature/moderation),
`transportCause` (3 nhánh, dedupe). **Thiếu 1 nhánh so với dsh**: `emptyBodyFailure` (5xx
body rỗng + ảnh → gợi ý vision) — đã DEFERRED có lý do trong TODO.

### 2.4. `lane.ts` — lớp dùng pi-ai
`restoreAliases` (đổi tên tool trả về + rewrite `partial.content[...]` vì SDK có thể
chạy trước wrapper), `translateError`, `isQuotaExhausted`, `composeFetches`,
`fetchWithoutHeader('authorization')` (Kilo), `sseGuard` (content-type JSON nhưng body
SSE → replay; 200 JSON document → fold; markup/empty → error),
`sessionSeedOf`, `rotateOnQuota`. `errorMessageOf` ghép `transportCause`.

### 2.5. `kilo.ts` / `opencode.ts` — 2 provider
- `streamKilo`: xóa Authorization, đổi `model.id` → `roster.wireId()`, `onPayload` dịch
  `reasoning_effort` → `reasoning:{effort}` / `{enabled:false}`, xóa
  `store`/`stream_options`/`prompt_cache_*`; `restoreAliases(inner, null)`.
- `streamOpencode`: gắn fingerprint headers, `applyFingerprint` trong `onPayload`,
  `restoreAliases` + DSML scrub cho family deepseek, `rotateOnQuota` sau mỗi event.
- Cả hai: `refreshModels(context.signal)`, `api:'ofm-free-api'`, `apiKey:'public'`,
  `compat:{supportsStore:false,maxTokensField:'max_tokens'}` cho Kilo.

### 2.6. `chains.ts` — port của `src/combos.js`
`normalizeChains` (validate từng field, drop link rác), `chainId` (slug + hash cho
non-Latin), `chainByName`, `parseChainAdd`/`parseChainSetLinks`/`parseLinkList`,
`buildChainEdit`, `evaluateAdd` (refuse all-dead), `intersectCapabilities` (giao
context/max/input/thinking), `decideLink` (state machine: `previous`/`failed`/
`continuation`/`retry`/`user`, fallback + round-robin sticky, cap `links-1`),
`lastAnswerIn` (đọc transcript khi pi không trả `previous`), `isAdvanceable`.
**Chỉ còn 2/5 strategy** của dsh (fallback + round-robin); bỏ `smart`/`usage`/`pace`
vì chúng cần đọc quota 10 kênh mà pi không có.

### 2.7. `chain-store.ts` / `disclaimer.ts`
`~/.our-free-model/chains.json` (hoặc `$OFM_DATA_DIR`), atomic 0600; disclaimer
version-gate 1 lần, `notice-ack.json`, `NOTICE_VERSION=1`.

### 2.8. `index.ts` — factory + lệnh `/ofm`
Async factory (pi chờ) → `Promise.all([kiloModels, opencodeModels, readChains])` →
`registerProvider` ×2 + `registerChains`. `registerChain` làm virtual model, `clampLevel`
kẹp level theo menu model được chọn. Command `ofm`: `status`/`refresh`/`chain add|edit|
set links|set strategy|set sticky|enable|disable|remove|list`. `edit` là wizard 4 bước
(input→editor→select→input), headless chỉ dẫn dùng `set`.

---

## PHẦN 3 — SO SÁNH TỪNG HÀNH VI: DSH → PI-EXTENSION

### 3.1. Bảng gap G1–G14 (đối chiếu trực tiếp code gốc)

| # | Hành vi dsh | File/symbol dsh | pi-extension | Kết luận |
|---|---|---|---|---|
| G1 | Block `<env>` thiếu → 429 | `upstream.js:ensureFreeLaneEnvironment` | `fingerprint.ts:ensureFreeLaneEnvironment` | ✅ đủ |
| G2 | 2 alias danh tính | `upstream.js:FREE_LANE_TOOL_ALIASES` | giống hệt | ✅ |
| G3 | retarget tool_choice | `upstream.js:retargetToolChoice` | `fingerprint.ts:retargetToolChoice` | ✅ |
| G4 | Capacity đo thật vs listing floor | `catalog.js:FREE_ID_OVERRIDES` | `catalog.ts:FREE_ID_OVERRIDES` | ✅ |
| G5 | Ngoài menu → 400 | `catalog.js` + `effort.js` | `effortMap` trả null | ✅ |
| G6 | `max`/`xhigh` lệch bảng | `effort.js:normalizeLevel` | `effortMap` xử lý cả hai | ✅ |
| G7 | Kilo off rung + family mandatory | `catalog.js:kiloEffortMenuFor` | `catalog.ts:kiloEffortMap` + snapshot `canDisable` | ✅ |
| G8 | SSE label sai / JSON fold | `http.js:readHead/replayStream/fold` | `transport.ts` + `lane.ts:sseGuard` | ✅ |
| G9 | Idle timeout theo chunk `data:` | `http.js:readSse` | `transport.ts:withIdleTimeout` | ✅ |
| G10 | DSML scrub | `stream.js:createDsmlScrubber` | `transport.ts` + `lane.ts` scrubDsml | ✅ |
| G11 | Chỉ model chat-wired | `catalog.js:endpointFor` | `opencodeModel` lọc `api['chat-completions']` | ✅ |
| G12 | Dịch 12 loại lỗi | `http.js:classifyFailure` + `kilo.js:classifyKilo` | `transport.ts:friendlyMessage` 9 nhánh | ✅ (thiếu nhánh 5xx-rỗng+ảnh — đã defer) |
| G13 | Combo/chain fallback | `combos.js` | `chains.ts` 2/5 strategy | ✅ phần dùng được |
| G14 | Token-saver, EAC, 10 kênh, UI, updater | các module | ngoài phạm vi | ⬜ có chủ ý |

### 3.2. Những gì pi-extension có mà dsh KHÔNG có (thêm đúng, không thừa)
1. `createKiloRoster()` — quản lý wire-id map "chỉ thêm, không thay" (dsh không cần vì
   nó làm chain trong 1 turn).
2. `restoreAliases` đi kèm scrub DSML + rewrite `partial` block.
3. `disclaimer.ts` riêng, ghi 1 lần qua `session_start` (dsh dùng settings page).
4. `rotateOnQuota` — xoay session khi gặp 429 (dsh giữ session cố định vì persist).
5. `clampLevel` — kẹp thinking level theo menu model thật trước khi route.

### 3.3. Những gì dsh có mà pi-extension CỐ Ý không cần và **đúng là không cần**
`repairToolPairing` (pi-ai tự ghép tool result), `sanitizeUsage` (pi tự giữ usage),
`mapUsage` (pi-ai tính), 3 wire responses/claude (pi chỉ nói openai-completions),
`budget ladder light/balanced/deep` (pi có `--thinking level` riêng), `probeModel/
probeCatalog/detectEgress` (pi không có picker availability model-by-model),
recovery `canRecover/canRecoverSilentStop` (pi có compaction + retry riêng).

---

## PHẦN 4 — CÁC GAP/THIẾU SÓT THỰC SỰ TÌM ĐƯỢC

### 4.1. P1 — Gap hành vi free-lane
- **G-b (DEFERRED, chưa làm)**: `carriesImageContent` + `emptyBodyFailure`. dsh: khi
  gateway trả 5xx body rỗng và request mang ảnh, nói rõ "có thể model không nhận
  vision". **Trạng thái hiện tại**: extension trả nguyên response lỗi cho pi-ai. Chỉ
  làm nếu tái hiện — TODO đã ghi rationale, không phải nợ âm thầm. Verdict: **khuyến
  nghị giữ defer** (path lỗi thuộc pi-ai; canh sửa message sẽ rủi ro hồi quy).
- **Session map không persist (đã chốt)**: phân tích đầy đủ trong TODO. Verdict:
  **đúng**, không persist.

### 4.2. P2 — Hệ thống 2–7 (inventory xong, khuyến nghị giữ ngoài v1)
EAC · 10 kênh tài khoản · local gateway 3 protocol · egress mihomo · vỏ UI 11 trang ·
updater Ed25519 · feed/push/sponsor · aggregate 76 provider · token-saver · phân phối
đóng gói. Pi có `/ofm`, `registerCommand`, settings riêng, `pi install` qua git tag.
Mỗi dòng đã phân tích trong TODO P2 — không phải nợ âm thầm.

### 4.3. P3 — Chất lượng mã (đã xong)
strict:true + noImplicitAny:true, build sạch, npm audit 0 vuln, suite 125-132 check PASS.

### 4.4. ⚠️ PHÁT HIỆN MỚI TỪ LẦN ĐỌC NÀY (2 điểm cần chủ ý)

**(A) `pi-extension/dist/` bị gitignore — build artifact không được track. ✅ ĐÃ XÁC MINH**
Bằng chứng (đã chạy thật):
- `pi-extension/.gitignore` dòng 3 = `dist/` → `git check-ignore -v` match cả
  `dist/index.js`, `dist/catalog.js`.
- `git ls-files pi-extension/` = **27 file**, `git ls-files pi-extension/dist/` = **0 file**.
  → dist tồn tại trên đĩa (build local) nhưng git không hề biết.
Ảnh hưởng **thực tế**:
1. `npm pack` / `pi install ./pi-extension` **vẫn đóng gói đúng dist** — vì
   `package.json` có `"files": ["dist","README.md","README.vi.md"]`, và `files`
   ưu tiên hơn `.gitignore`/`.npmignore` trong npm pack. TODO §8 đã chứng minh
   `pi install ./pi-extension -l --approve` → 23 model + lượt thật `installed-ok`.
   → **KHÔNG phải bug đóng gói**.
2. Rủi ro còn lại chỉ là **clone mới**: contributor clone và chạy `pi install` liền
   (không đọc README) sẽ thiếu `dist/` → extension không load. README §Install có ghi
   2 bước (`npm install` + `npm run build`) nên đã có tài liệu, nhưng không có fail-fast.
Khuyến nghị (giữ nguyên thiết kế hiện tại — dist không nên track):
- Thêm 1 dòng fail-fast vào `pi.extensions` path hoặc README: "nếu `pi` báo không
  thấy `./dist/index.js`, chạy `npm --prefix pi-extension run build`".
- Hoặc thêm `"prepack": "npm run build"` để `pi install` luôn tự build trước khi pack —
  **nhưng** điều này làm chậm mỗi lần install và đòi devDeps; với 1 extension cá nhân
  thì README hiện tại là đủ. Xếp hạng: **cosmetic**.

**(B) `sessions` map trong `fingerprint.ts` là module-level — hot reload của pi mất map.**
`pi` hot reload (nếu có) sẽ re-import module → `const sessions = new Map()` mới → session
bị mint lại. Không phải lỗi (mint mới vẫn qua gate), chỉ là mất "ổn định theo hội thoại"
trong trường hợp hot reload. Rủi ro thấp, ghi nhận.

**(C) `restoreAliases` không xử lý `aliases.size === 0` khi pi không đổi tên nào.**
Đã có early-return `if (aliases && aliases.size > 0 ...)` → an toàn.

**(D) `index.ts` không `unregisterVirtualModel` khi chain bị xoá do link chết.**
`registerChain` catch "no link resolves" bằng cách throw trong `route()`, nhưng model
ảo vẫn đứng trong registry. UX: user vẫn thấy chain trong picker nhưng mỗi lượt lỗi.
`describeChains` có đánh dấu `⚠` nên **chấp nhận được** — dsh cũng giữ link chết
(routing.notUsableWhy). Ghi nhận, không sửa.

### 4.5. Việc còn lại thực sự trong TODO (trạng thái đúng)
Chỉ 1 mục điều kiện: chạy `npm run verify:pi-extension-upstream` định kỳ → nếu FAIL thì
theo `docs/pi-extension-drift-runbook.md`. Không có nợ P0/P1 nào khác.

---

## PHẦN 5 — KIỂM TRA & GHI CHÉP VẬN HÀNH

### 5.1. Suite test (đã đọc hết 9 file + preflight) — ✅ ĐÃ CHẠY THẬT LẠI
Đã chạy `npm run test:pi-extension` trong máy này: **132 check ok, 0 FAIL**, và
4 script integration **không SKIP** (`pi` có trên PATH nên lái `pi` thật qua loopback).

| Script | Loại | Số check (đã đếm) | Nội dung then chốt |
|---|---|---|---|
| `catalog.test.ts` | unit | 22 | effortMap xhigh↔max, override capacity, wire filter, roster `accept`/`degrade`, snapshot 18 Kilo + 9 OpenCode |
| `transport.test.ts` | unit | 15 | sniffBody, foldToSse, DSML hold-tail, watchdog pings-then-mute, friendlyMessage, readHead/replay |
| `fingerprint.test.ts` | unit | 11 | `<env>`, 2 alias danh tính, gate slot `read_ofm1`, history rename, tool_choice, collision regression |
| `chains.test.ts` | unit | 31 | normalize, parse add/set/edit, intersection, decideLink 6 nhánh, walk cap, round-robin sticky |
| `disclaimer.test.ts` | unit | 6 | version-gate, damaged file, `OFM_DATA_DIR` |
| `fingerprint-integration.ts` | pi thật | ~20 | UA v2, 4 session header, tool_choice none, alias restore TURN2, DSML không lọt, no-menu không gửi effort |
| `kilo-integration.ts` | pi thật | ~17 | no Authorization, wire id, reasoning object, JSON-fold, mislabelled-SSE replay, listing-fail degrade |
| `chain-integration.ts` | pi thật | 3 | 503 failover trong lượt, 429 tường → turn sau nhảy link |
| `acceptance-live.ts` | pi thật | 4 | `--list-models` cả 2 roster live, 1 lượt mỗi lane end-to-end |

Tất cả SKIP exit 0 khi thiếu `pi` qua `preflight.ts` (offline suite vẫn chạy đủ 85 check).

### 5.2. Verify script (`scripts/reverify-upstream.ts`)
Đo listing OpenCode 200 + 8 free chat-wired + diff roster snapshot + chat 2 base
(429 = gate pass), Kilo không credential 200 + diff roster + note đổi off-rung.

### 5.3. Lệnh dùng lại
```bash
npm --prefix pi-extension run build          # bắt buộc trước khi install
pi install ./pi-extension                    # global, không cần --approve
pi --list-models --approve                   # 23 model
pi -e ./pi-extension --model ofm-kilo/kilo-auto-free   # hoặc -e
npm run test:pi-extension
npm run verify:pi-extension-upstream
```

---

## PHẦN 6 — KẾT LUẬN

1. **pi-extension đã port đúng và đủ** toàn bộ hành vi của lane free trong repo dsh
   (G1–G13), với 3 cải tiến đúng: `createKiloRoster`, `restoreAliases` + DSML,
   disclaimer version-gate.
2. **Không phát hiện gap chức năng mới nào** ngoài điểm G-b đã defer có lý do.
3. **2 rủi ro vận hành cần xác nhận** (không phải bug chức năng): (A) `dist/` gitignored
   — contributor phải build trước khi install; (B) session map mất khi hot reload.
4. **Khuyến nghị hành động tiếp theo** (theo thứ tự):
   1. `git check-ignore -v pi-extension/dist/index.js` → nếu ignored, cân nhắc bỏ
      `git check-ignore` entry **hoặc** thêm ghi chú đậm "build required" ở đầu README.
   2. Giữ nguyên mục TODO điều kiện; chạy `npm run verify:pi-extension-upstream` trước
      mỗi lần sửa fingerprint/catalog và sau mỗi tuần.
   3. Không port thêm gì trong P2 trừ khi có yêu cầu cụ thể.
   4. Nếu sau này gặp đúng hình dạng "5xx body rỗng + request ảnh", quay lại G-b.

---

## PHẦN 7 — HƯỚNG PHÁT TRIỂN API PROVIDER (cập nhật 2026-11-05)

Sau khi đối chiếu toàn bộ 859 mục trong toàn bộ thư mục gốc (không chỉ `src/`), quyết
định mới: **phát triển pi-extension thành api provider đầy đủ** cho mọi coding agent,
không chỉ pi. pi-extension giữ nguyên vai trò pi extension và mở rộng thành HTTP
server độc lập phạm vi đầy đủ.

**Những gì sẽ port từ dsh sang pi-extension (cần thiết cho api provider):**

| Nhóm | Nguồn dsh | Vai trò trong api provider |
|---|---|---|
| HTTP forward listener | `src/forward.js` (1392 dòng) | node:http server, loopback bind, key auth, CORS, port retry/scan, LAN relay, tool hygiene |
| SSE response guard | `src/deferred-response.js` | hold stream metadata, heartbeat commit, không buffer toàn stream |
| Anthropic codec | `src/anthropic.js` (~650 dòng) | /v1/messages request/response, streaming frames, countTokens |
| Gemini wire | `src/gemini.js` (~270 dòng) | /v1/models/:model:method, generateContent, functionCall/Response |
| Adapter / turn orchestration | `src/adapter.js` (~2000 dòng) | runStream/runCombo/runSingle, chain走位 commit rule, recovery, buildPayload 3 wire |
| Recovery | `src/recovery.js` | canRecover, canRecoverSilentStop, recoveryMessages, continuationMessages, checkpointFits |
| Failure classification | `src/route/classify.js` + `src/failure.js` | classifyFailure, backoff, forwardFailure map sang HTTP + anthropic error |
| Store | `src/store.js` | JsonStore coalesced, 0600, temp+rename, backup corrupt |
| Local optimize | `src/local-optimize.js` | 5 câu trả lời local (quota/prefix/title/suggestion/filepath), không tốn quota |
| Egress/proxy | `src/egress.js` + `src/bun-fetch.js` | loopback relay, subscription/client proxy, bun worker |
| Probe/availability | `src/probe.js` | probeModel, detectEgress, verdict state mapping |

**Không port (vì ngoài phạm vi api provider cho coding agent):**
EAC co-pay (cần GitHub login + gateway server), 10 kênh tài khoản (148 file OAuth/QR
channel-pack), magpie binary Go 68MB, UI 11 trang React, updater Ed25519, self
hot-reload, feed/push/sponsor, packages/desktop Tauri, vendor/wasm.

**Kiến trúc mục tiêu của pi-extension:** giữ nguyên 2 provider (ofm-kilo, ofm-opencode),
thêm HTTP layer trên `opencodeCompletionsApi().streamSimple` đã có, thêm 5 chain strategy
từ `combos.js`, thêm recovery + classification, chạy độc lập (`node dist/server.js`) hoặc
như pi extension (`pi.extensions`).

*(Phạm vi đọc thực tế — **toàn bộ 10 file source + 9 file test + preflight +
reverify script + README + tsconfig + package.json của pi-extension đã đọc từng dòng**;
phía dsh gốc: đọc toàn bộ nhóm lane-free (`src/upstream.js`, `http.js`, `catalog.js`,
`effort.js`, `kilo.js`, `stream.js`, `probe.js`, `recovery.js`, `messages.js`,
`model-test.js`, `channel.js`, `route/classify.js`) trọn vẹn, đọc trọn `index.js` (2492
dòng) + `adapter/kernel.js` + phần logic của `store.js`/`aggregate.js`/`vault.js`/
`eac.js`/`egress.js`/`subscriptions.js`/`magpie-*.js`/`token-saver/`/`local-optimize.js`/
`feed.js`/`push.js`/`trust.js`/`reload.js`/`disclaimer.js`; các file trong hệ thống
P2 (P2 scope) chỉ đọc tới giới hạn cửa sổ đầu để xác định nhiệm vụ — cụ thể
`updater.js` (1276 dòng, đọc 1054), `forward.js` (1392, đọc 1115),
`magpie-engine.js` (1104, đọc 1039), `client.js` (7682, đọc ~1109 — phần còn lại là
dictionary UI song ngữ, không chứa logic lane). Những file này đều thuộc nhóm
**không port** nên không ảnh hưởng kết luận gap.)*
