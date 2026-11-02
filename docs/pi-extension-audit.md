# Repo audit + pi-extension gap review

Mục đích: (1) trả lời "repo dsh này làm gì mà nhiều code thế"; (2) đối chiếu từng hành vi
của plugin dsh với `pi-extension/` để tìm những gì extension còn thiếu/sai.

Phạm vi quét: toàn bộ `src/` (87 file, ~22.7k dòng), `index.js` + `client.js` (10.2k),
`vendor/` (channel-pack 135 file TS ~64k dòng, dsh-std, magpie Go binary 68MB),
`packages/` (standalone 67k dòng + desktop), `scripts/` (184 file, 131 test),
`worker/`, `adapter/`, `catalog/`, `feed/`, `locale/`, `docs/`.

## 1. Repo làm gì — 7 hệ thống trong một repo

| Hệ thống | Thư mục/file | Làm gì |
|---|---|---|
| **1. Làn free lane** | `src/upstream.js`, `src/http.js`, `src/catalog.js`, `src/probe.js`, `src/effort.js`, `src/kilo.js` | Gọi model miễn phí qua 2 lane: OpenCode (`Bearer public` + fingerprint v2) và Kilo (không credential). Cả `http.js` quy định sniff body, idle-timeout, phân loại lỗi; `probe.js` dò khả dụng theo egress; `effort.js`/`catalog.js` quy định menu thinking + capacity đo thực tế |
| **2. Làn co-pay (EAC)** | `src/eac.js`, `src/eac-login.js`, `src/eac-user.js`, `src/vault*.js`, `worker/` | Kênh trả tiền chung do maintainer vận hành; plugin chỉ giữ seal HMAC, gateway Cloudflare Worker giữ key thật; mở khóa bằng GitHub login + star repo (desktop only) |
| **3. Mười kênh tài khoản** | `vendor/channel-pack/src/**` (~64k dòng TS), `src/subscriptions*.js`, `src/magpie-engine.js`, `src/magpie-models.js`, `src/magpie-policy.js`, `vendor/magpie/bin/magpie-win32-x64.exe` | Đăng nhập OAuth/QR vào 10 IDE (Cline, Gemini/Code Assist, LobsterAI, Loomy, MiniMax, OpenCode, Qoder, Raccoon, TRAE, ZCode), gom credential vào account pool, auto check-in lĩnh credit, rồi phục vụ qua **engine Go 68MB** (`yetone/magpie`) mở local OpenAI gateway `127.0.0.1:8326` |
| **4. Local gateway** | `src/forward.js`, `src/anthropic.js`, `src/gemini.js`, `src/chan-relay.js`, `src/combos.js` | Biến plugin thành OpenAI/Anthropic/Gemini-compatible server cho tool khác trên máy (base URL + key), có relay LAN, có combo = chuỗi fallback |
| **5. Egress** | `src/egress.js`, `src/bun-fetch.js` | Mọi request upstream đi qua 1 outlet: proxy do user chỉ định, hoặc **tự spawn mihomo (Clash)** từ subscription, health-check 5 phút/lần, relay loopback có key; lane OpenCode bắt buộc qua Bun worker để giữ TLS stack riêng |
| **6. Vỏ sản phẩm** | `index.js` (host half), `client.js` (browser half 11 trang: 免费模型/EAC/白嫖/看板/日志/网关/聚合/省Token/路由/升级/推荐), `src/store.js`, `src/updater.js` (1275 dòng: ký Ed25519 + SHA-256 + backup/rollback), `src/reload.js`, `src/feed.js`, `src/push.js`, `src/trust.js`, `src/sponsor.js`, `src/picks.js`, `src/token-saver.js` (1268 dòng: nén tool result), `src/local-optimize.js` (5 câu trả lời local), `src/aggregate.js` (76 provider nhập key) | Settings UI, dashboard usage, upgrade/app reload, announcement feed, bảo mật route, tiết kiệm token |
| **7. Phân phối & test** | `scripts/` (131 test), `packages/standalone` (bản không cần dsh, cùng tính năng), `packages/desktop` (Tauri), `catalog/*.json` (manifest ký + integrity), `docs/` | Standalone service port 18900; desktop; signed release manifest; bộ test offline rất lớn (đó là lý do `scripts/` có 43k dòng) |

Vì sao nhiều code: 4 lane × 3 wire shape (chat/responses/messages) × (request conversion,
stream projection, error classifier, recovery/continuation) cộng thêm 10 kênh OAuth mỗi kênh
một bộ auth/credits/models, một gateway 3 protocol, một lớp egress tự quản proxy, và một bộ
test tương ứng. Hai lane miễn phí mà `pi-extension/` tái sử dụng chỉ là **một mảnh** của nó.

## 2. Đối chiếu pi-extension — thiết kế

Extension tái dùng: `openAICompletionsApi().streamSimple` của pi-ai (conversion, tool-call,
usage, abort) và chỉ chèn: (a) headers fingerprint qua `options.headers`, (b) biến đổi payload
qua `options.onPayload`, (c) đổi tên tool trùng gate và khôi phục ở response (`lane.js`),
(d) bỏ Authorization trên lane Kilo bằng `fetch` wrapper.

## 3. Gap tìm được (trước khi sửa)

| # | Hành vi dsh | File dsh | Mức | Đã xử lý |
|---|---|---|---|---|
| G1 | Free lane **bắt buộc** có block `<env>` (Working directory/Platform) trong system prompt; thiếu → 429 | `src/upstream.js` `ensureFreeLaneEnvironment` (control 2026-10-28) | **Chí mạng** — mọi request free lane sẽ 429 | ✅ thêm vào `fingerprint.js` |
| G2 | Hai tên tool bị meter theo danh tính: `subagent_fork`→`conversation_delegate`, `working_directory`→`workspace_directory` (+ note map tên cho model); thiếu → 429 | `src/upstream.js` `FREE_LANE_TOOL_ALIASES` (control 2026-10-30) | **Chí mạng** khi transcript chứa các tên này | ✅ thêm |
| G3 | `tool_choice` trỏ tới tool bị đổi tên phải được retarget sang alias | `src/upstream.js` `retargetToolChoice` | Cao | ✅ thêm |
| G4 | Capacity/menu **đo thực tế** khác listing: deepseek 1M/384K (listing 200K/32K), glm 1M/131K, nemotron-vl 1M/131K, mimo 1M/131K | `src/catalog.js` `FREE_ID_OVERRIDES` + `CAPABILITIES` | Cao (context sai → lỗi/cắt cụt) | ✅ port override table |
| G5 | Model **không có menu** thì gửi `reasoning_effort` sẽ bị 400 (upstream validate giá trị); dsh dùng budget ladder, không gửi effort | `src/catalog.js` chú thích + `src/effort.js` | Cao | ✅ set `reasoning:false` khi không có menu |
| G6 | `max` là một level của pi (`--thinking max`) nhưng map thiếu key → gửi 'max' cho model không khai báo → 400 | `src/effort.js` `normalizeLevel` | Trung bình | ✅ effortMap có `max` |
| G7 | Kilo: off = `reasoning:{enabled:false}` (không phải bỏ field); family stepfun/liquid/thinkingmachines và 2 auto-router **không** có rung off (400 nặng) | `src/catalog.js` `kiloEffortMenuFor`, `KILO_EASONING_MANDATORY`, `KILO_NO_DISABLE_IDS` | Cao | ✅ port |
| G8 | Gateway từng trả 200 với `Content-Type` không phải SSE nhưng body là SSE, hoặc trả **một JSON document** cho request stream; openai SDK nuốt dòng JSON → stream rỗng → phiên fail | `src/http.js` sniff/fold (issue #6), `src/kilo.js` fold | Cao | ✅ `sseGuardFetch` |
| G9 | Không có idle-timeout theo chunk: stream treo im lặng (chỉ comment keepalive) sẽ treo lượt mãi mãi; dsh có deadline không reset bởi comment | `src/http.js` `readSse` (issue #460) | Trung bình | ✅ watchdog theo chunk chứa `data:` |
| G10 | DeepSeek v4 leak markup `<｜DSML｜…>` vào visible text | `src/stream.js` `createDsmlScrubber` | Trung bình | ✅ scrubber cho model deepseek |
| G11 | Model free lane chỉ là **một phần** của lane: muse-spark/union-alpha trả trên `/responses`, `/messages`; một số id chỉ có base_url anthropic/google — gửi chat/completions sẽ sai | `src/upstream.js` `endpointFor`, listing `api.*` | Thấn (roster hiện tại toàn chat) | ✅ chỉ map row `chat-completions` |
| G12 | Dịch lỗi: HTML page/WAF, `ModelError` "Model is unavailable", `INVALID_TOKEN` của Kilo | `src/http.js` `classifyFailure` | Trung bình | ✅ `friendlyMessage` |
| G13 | Không có retry/fallback theo kiểu dsh (combo, continuation, recovery) | `src/adapter.js`, `src/combos.js`, `src/recovery.js` | Không cần — pi có retry/compaction riêng; ghi chú trong README | — |
| G14 | Token-saver (nén tool result), local-optimize (5 câu local), aggregate (76 provider), EAC, 10 kênh tài khoản, settings UI, updater, feed | các module tương ứng | Ngoài phạm vi v1 (pi có cơ chế riêng; ghi ở README) | — |

Không phát hiện vấn đề bảo mật trong extension: không hardcode credential (chỉ `Bearer public`
và chuỗi sentinel cho Kilo bị wrapper fetch xóa trước khi ra wire), không ghi log secret,
không mthể ghi log secret, listener loopback do pi quản.

## 4) Còn hạn chế có chủ ý (ghi trong README)

- Lane OpenCode cần egress không bị chặn vùng; region gate chỉ có thể đổi bằng proxy của user
  (`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`).
- Bun transport của dsh (chống proxy plugin rewrite body) chưa port; extension dùng Node fetch,
  đã được xác minh pass gate tại thời điểm test.
- Không có auto-continue khi bị cắt giữa lượt (dsh có); pi tự xử lý tiếp.

## 5) Trạng thái sau khi sửa (2026-11-01)

- 38/38 check PASS: `npm run test:pi-extension`
  (`fingerprint.test.mjs` 10 · `catalog.test.mjs` 12 · `fingerprint-integration.mjs` 15
  · `kilo-integration.mjs` 18). Hai script integration lái `pi` thật qua stand-in
  gateway trên loopback, nên khớp cả phần pi-ai xử lý SSE/tool-call.
- Smoke thật: `pi --list-models` thấy 23 model; Kilo chạy với `--thinking off/high`
  và tool-call; lane OpenCode tại IP này trả 429 quota thay vì 403 (fingerprint pass).
- Bug tự phát hiện trong quá trình test (đã sửa): map đổi tên history/tool_choice bị
  ngược chiều; bảng static nhầm trường `maxTokens`/`maxOutput`; fold JSON document
  phải tái sinh delta-frames vì SDK chỉ đọc `choices[].delta` (shape non-stream bị
  SDK nuốt thành stream rỗng).
- Việc còn lại chỉ là bảo trì: khi upstream siết gate thì đo lại fingerprint theo
  `docs/free-lane-wire.md` và cập nhật `pi-extension/fingerprint.js`.

## 6) Đo lại upstream (bảo trì định kỳ) — 2026-11-01

Đo trực tiếp `opencode.ai` với chính xác các byte extension gửi:

- `GET /inference/v1/models` dưới header fingerprint → **200**, 8 id free
  (`big-pickle`, `beam-free`, `flint-40b-free`, `mimo-v2.6-flash-free`,
  `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`,
  `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`), **tất cả chat-wired**
  (`api.chat-completions`) — không xuất hiện row Responses/Messages mới, nên bộ
  lọc `chat-completions` trong `catalog.js` vẫn đúng.
- `POST /inference/v1/chat/completions` và `/inference/openai/v1/chat/completions`
  với đủ UA v2, 4 session header, session id minted, tool `read`/`shell` verbatim,
  block `<env>`, không `tool_choice` → **429 FreeUsageLimitError** (quota của IP,
  gate ĐÃ PASS) chứ không phải 403 → fingerprint chưa bị siết.
- Kilo `kilo-auto/free` không credential → **200**, SSE thật.

Kết luận: không drift; `fingerprint.js` không cần sửa. Lần đo lại tiếp theo làm
theo đúng quy trình trên (script tương đương `docs/free-lane-wire.md`: TLS MITM
+ replay từng byte nếu cần bắt chước client mới).

### 6b) Đo lại có tự động hóa (2026-11-01)

Quy trình đo lại giờ là lệnh: `npm run verify:pi-extension-upstream`
(`pi-extension/scripts/reverify-upstream.mjs`). Nó không chỉ kiểm tra fingerprint
mà còn **diff roster live với snapshot offline** — và lần chạy đầu đã phát hiện
một drift thật: `big-pickle` (id free không hậu tố `-free`, vốn nằm trong
`ALWAYS_FREE` của `catalog.js` nên đường live có map đúng) **thiếu trong
`STATIC_OPENECODE_MODELS`**, nghĩa là máy không có mạng mất một model lane vẫn
phục vụ. Đã bù vào snapshot kèm 2 unit test chống hồi quy; chạy lại: cả hai lane
PASS, không drift khác.

### 6c) Bảo trì 2026-11-02 — drift không có, nhưng lộ ra một lỗi wire-id (2026-11-02)

Chạy lại `npm run verify:pi-extension-upstream` và toàn bộ bộ test offline:

- Cả hai lane **PASS**: listing OpenCode 200, 8 id free toàn chat-wired, không
  có id lệch so với snapshot; chat hai base trả **429** (`FreeUsageLimitError`,
  gate ĐÃ PASS); Kilo không credential trả **200** SSE thật. Không drift.
- Bộ test offline: **120 check PASS** trên 8 script.
- Nhưng `chain-integration.mjs` **flaky** (2/8 lần FAIL) — mà flaky ở đây là
  tín hiệu, không ph nhiễu: nguyên nhân nằm trong extension, không phải test.

**Cơ chế.** pi làm mới roster của một provider bằng `AbortController` theo
*generation* (`pi-ai/dist/models.js`: `beginProviderRefresh` + `AbortSignal.any`),
nên refresh cũ bị abort khi refresh mới bắt đầu; đo thực tế, abort đó **rơi sau
khi fetch listing đã trả 200**. Nhánh `catch` của `kiloModels()` coi mọi
exception là thất bại và gọi `staticSnapshot()`, hàm này **thay** map
`safeId → wire id` bằng bản của snapshot offline — map 2 entry live (đang đúng)
bị đè thành 15 entry static, không có model lane vừa phục vụ. Từ đó mọi lượt
Kilo mang `reflection-beam-free` (safeId của pi) thay vì
`reflection/beam-free` (id Kilo định tuyến) → "model not found" trên lane đang
sống. Đúng lỗi đã sửa ở `f972eec`, nhưng lần trước chỉ lấp đường *listing fail*;
đường *abort* thì lại phá hỏng.

**Sửa.** `createKiloRoster()` (`pi-extension/catalog.js`): map wire-id được
**seed** từ snapshot khi module load và chỉ **thêm** entry mới, không bao giờ
thay cả map; refresh bị abort / timeout / 5xx **giữ nguyên** roster live cuối và
mọi wire id đã học (`degrade()`); chỉ khi listing trả slice free thật sự **rỗng**
mới degrade về snapshot (đó là upstream nói rõ "không còn gì free").
`kilo.js` chỉ còn giữ một instance roster và dùng `roster.wireId()`.

**Bằng chứng.** `chain-integration.mjs` sau fix: **15/15 PASS** (trước ~25%
fail). 5 unit check mới trong `catalog.test.mjs`; tạm khôi phục hành vi cũ thì
dúng **2 check FAIL** nên test có răng. Lane OpenCode không có lỗ hỏng tương
tự: id của làn đó không chứa `/` hay `:`, nên `safeId` == wire id, và payload
không bị đổi tên model.

Lần bảo trì tiếp: chạy `npm run verify:pi-extension-upstream`; nếu FAIL thì
theo `docs/pi-extension-drift-runbook.md`.

### 6d) Đo lại xác nhận fix wire-id ổn định (2026-11-02 ~11:50)

Chạy lại đúng quy trình bảo trì ngay sau đợt §6c (cùng ngày), để xác nhận fix
wire-id không chỉ gỡ được vụ flake một lần mà còn giữ được lâu dài:

- **Bộ test offline: 120/120 check PASS trên 8 script**, `chain-integration.mjs`
  không còn flake (lần đo §6c trước fix còn ~25% fail; sau fix và lần xác nhận
  này thì sạch). Suite chạy `pi` thật qua loopback nên không SKIP.
- **Cả hai lane verified**: listing OpenCode 200, 8 id free toàn chat-wired,
  không có id mới/mất so với snapshot; chat 2 base trả `429 FreeUsageLimitError`
  (gate ĐÃ PASS, chỉ hết quota IP); Kilo không credential trả 200 SSE thật.
  **Không drift**, `fingerprint.js` không cần sửa.

Kết luận: trạng thái "sạch" của §6c được giữ; mục điều kiện trong TODO vẫn chờ
trigger (một lần verify FAIL thật) chứ không tự tắt.

### 6e) Acceptance end-to-end thành script chạy-trong-CI được (2026-11-02)

Runbook §5 có nửa "chấp nhận" chỉ từng chạy tay (smoke #5: `pi -e ./pi-extension
--list-models` + một lượt thật). Biến nó thành `pi-extension/test/acceptance-live.mjs`
nhằm làm cổng end-to-end **không tốn quota egress** (cả 2 lane trỏ loopback qua
`OFM_*` override). Lưu ý: chính bản workflow CI (`.github/workflows/test.yml`) đã bị
xoá ở `1552888` khi sang pi-only, nên hiện nó là gate **chạy ở local/contributor**;
khôi phục CI = `git show f4709c1:.github/workflows/test.yml` (xem README §Tests):

- `--list-models` phải hiện roster **live** của cả 2 provider (`ofm-opencode`,
  `ofm-kilo`) — tức roster từ listing, không phải snapshot;
- một lượt thật trên **mỗi** lane phải được stand-in trả lời qua đúng provider
  (marker `answered-by-kilo` / `answered-by-opencode`) — nửa mà smoke tay không
  với tới được ở egress bị quota (OpenCode 429) nay được đậy qua loopback.

Nối vào `test:pi-extension` (tự SKIP khi thiếu `pi` qua `preflight.mjs`; timeout
90s để một lần treo thành FAIL chứ không đơ test). Teeth-check: đổi id listing
OpenCode trong bản sao → assert roster đúng **FAIL**, còn Kilo PASS. Sau khi thêm:
**124 check / 9 script PASS** (không SKIP trên máy có `pi`).

### 6f) Đo lại lần #2 cùng ngày (2026-11-02 ~13:56)

Chạy lại `npm run verify:pi-extension-upstream` lần thứ hai trong ngày (trước đó §6d
~11:50). Kết quả y nguyên: cả hai lane **PASS** — listing OpenCode 200, 8 id free toàn
chat-wired, không id mới/mất so với snapshot; chat 2 base trả `429 FreeUsageLimitError`
(gate pass, hết quota IP); Kilo không credential trả 200 SSE. **Không drift**, `fingerprint.js`
không cần sửa. Mục điều kiện trong TODO giữ nguyên, không tự tắt.

## 7. Đối chiếu API với gói `pi` thật (kiểm chứng, không đoán) — 2026-11-02

Đối chiếu từng bề mặt API extension dùng với package **đang cài** mà binary `pi` 1.4.0
thực sự nạp: `@earendil-works/pi-coding-agent@1.4.0` (`$PI/dist`) +
`@earendil-works/pi-ai@1.4.0` (bản lồm trong `pi-coding-agent/node_modules`). Kết luận:
**khớp toàn bộ — không có điểm nào lệch, không cần sửa code.** Bằng chứng:

| Extension dùng | Bằng chứng trong gói | Verdict |
|---|---|---|
| `export default async (pi)=>{…}`; `pi` chờ factory async | `dist/docs/custom-provider.md` · `ExtensionAPI` (`dist/core/extensions/types.d.ts`) | ✓ |
| `registerProvider(name, ProviderConfig)` + `registerProvider(Provider)` | `ExtensionAPI.registerProvider` (type, 2 overload) | ✓ |
| Provider `{name,baseUrl,api,apiKey,models,refreshModels,streamSimple}` | `ProviderConfig` (`…/extensions/types.d.ts`): `streamSimple?`, `refreshModels?(context:RefreshModelsContext)`, `models:ProviderModelConfig[]` ("replaces all existing models") | ✓ |
| `refreshModels` đọc `context.signal` | `pi-ai/dist/models.js` `runProviderRefreshPhase` gọi `provider.refreshModels({signal,publish})` | ✓ (signal + publish đều có) |
| Custom stream tái dùng `openAICompletionsApi()` từ `@earendil-works/pi-ai/compat`; stream phải gọi `options.onPayload` và dùng replacement | `pi-ai/dist/compat.d.ts` re-export `openai-completions.lazy.ts` (`openAICompletionsApi:()=>ProviderStreams`); chú thích `ProviderConfig.streamSimple` (“must invoke options.onPayload … use any returned replacement”) — compose `onPayload` của ext đúng quy tắc | ✓ |
| Provider `api:'ofm-free-api'` (không phải api builtin) | `pi-ai/dist/types.d.ts:21` `Api = KnownApi | (string & {})`; doc: “If streamSimple is provided: registers a custom API stream handler” → tự định nghĩa api, đảm bảo `pi` dùng đúng `streamSimple` của mình chứ không thay bằng builtin | ✓ (có chủ đích) |
| Model có `thinkingLevelMap`, `compat{supportsStore,maxTokensField}`, `baseUrl`, `contextWindow`, `maxTokens`, `cost`, `input`, `reasoning` | `pi-ai/dist/types.d.ts` `Model` (655 `thinkingLevelMap`, 664 `compat`); `providers/compat-schema.d.ts` (`supportsStore:boolean`, `maxTokensField:"max_tokens"|…`); `custom-provider.md` (các field bắt buộc của chat model) | ✓ |
| `registerVirtualModel(ExtensionVirtualModel)`; `route→{model,thinkingLevel,state}`; đọc `request.{state,previous,failed,reason,thinkingLevel,messages}` | `pi-ai`→pi `dist/core/virtual-models.d.ts`: `VirtualModelDefinition{provider,id,name,thinkingLevels?,contextWindow?,maxTokens?,input?,route}`; `ModelRoute{model,thinkingLevel,state}`; `ModelRouteRequest{model,thinkingLevel,reason,previous?,failed?,state?,messages,signal?}` | ✓ |
| `unregisterVirtualModel(provider,id)`, `unregisterProvider(name)` | `ExtensionAPI` | ✓ |
| `registerCommand('ofm',{description,handler})` | `RegisteredCommand{handler(args,ctx),description?}` | ✓ |
| `on('session_start',(e,ctx)=>ctx.hasUI?ctx.ui.notify…)`; `ctx.modelRegistry.find(p,id)` / `getModelsOfType('chat',provider)`; `ctx.ui.input/editor/select/notify` | `ExtensionContext{hasUI,ui:ExtensionUIContext,modelRegistry}`; `ExtensionUIContext{input,editor,select,notify}`; `ModelRegistry{find,getModelsOfType}` (`dist/core/model-registry.d.ts`) | ✓ |
| Cơ sở `createKiloRoster`: refresh bị **abort sau khi fetch thành công** thì giữ roster live + wire-id đã học | `pi-ai/dist/models.js`: `supersedeProviderRefresh`→`previous.abort()` (128–135), `beginProviderRefresh` (137), `signal=AbortSignal.any([callerSignal,controller.signal])` (190), `publishProviderModels` chặn khi `signal.aborted‖generation đổi` (147/155) | ✓ (thiết kế phòng thủ là thật, không phải giả thuyết) |

Ghi chú nhỏ (không phải lỗi): wizard `/ofm chain edit` hỏi tên qua `ctx.ui.input(title,
placeholder?)` (chỉ có placeholder, không prefill). Không hỏng vì `buildChainEdit` tự giữ
`current.name` khi người dùng để trống (`chains.js`). Lần sau nếu muốn prefill thật thì dùng
`ctx.ui.editor(title, prefill)`.
