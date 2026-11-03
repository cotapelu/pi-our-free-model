# TODO — pi provider extension (pi-extension/)

Checklist phiên làm việc này. Trạng thái cập nhật sau mỗi bước.

## Đã xong

- [x] Phân tích bản chất repo dsh: 7 hệ thống (xem `docs/pi-extension-audit.md` §1)
- [x] Quét repo dsh: src/ đủ phần lane miễn phí + cấu trúc toàn bộ thư mục con
- [x] Viết `docs/pi-extension-audit.md`: repo làm gì + 14 gap + kết quả đo lại upstream
- [x] Sửa extension theo gap G1–G12
- [x] Port combo/fallback-chain (G13) → `chains.js` + `chain-store.js` + virtual model
      `ofm-chain` + `/ofm chain add|set|remove|enable|disable`
- [x] Sửa 3 lỗi thật phát hiện bằng test (429 mất token FreeUsageLimitError; kilo.js đổi
      model.id phá address; previous thiếu → suy từ transcript)
- [x] `chain add` nhận `strategy`/`stickyLimit`; `chain set` sửa strategy/sticky/**links**
      (thay link chain đã có, cùng validate lúc thêm)
- [x] `chain add`/`set links` kiểm tra link lúc chạy lệnh (all-dead → từ chối)
- [x] **Đo lại upstream (2026-11-01)**: listing 200, 8 free id toàn chat-wired; chat 429
      (gate pass, không drift); Kilo 200 không credential — kết quả ghi ở audit §6
- [x] Smoke command qua pi RPC thật cho mọi nhánh của `/ofm chain`
- [x] Biến mục bảo trì thành lệnh chạy lại được: `pi-extension/scripts/reverify-upstream.mjs`
      (`npm run verify:pi-extension-upstream`) — đo fingerprint trên lane thật, phân biệt
      403 (drift) với 429 (gate pass), và **diff roster live với snapshot**; chạy đầu tiên
      đã phát hiện `big-pickle` thiếu trong snapshot offline → đã bù
- [x] Editor wizard `/ofm chain edit <id>` (name → links → strategy → sticky), dùng
      `buildChainEdit`/`parseLinkList` thuần + cùng validate lúc add; headless chỉ đường
      dùng `set`; RPC smoke: 4 bước, giữ id/enabled, ghi đúng chains.json

## Còn lại

- [x] Sửa lỗ hỏng thật do chính bài kiểm tra degenerate phát hiện: listing Kilo fail
      (5xx/timeout) trong khi chat vẫn chạy → snapshot offline phục vụ roster nhưng map
      wire-id KHÔNG được dựng lại → lượt gọi mang `reflection-beam-free` (safeId của pi)
      thay vì `reflection/beam-free` (id Kilo định tuyến) → "model not found" trên lane
      đang sống. Sửa: lưu `wire` trong mỗi row `STATIC_KILO_MODELS` + `staticUpstreamIds()`,
      `kiloModels()` dựng lại map trên mọi đường fallback. Unit test (15 id, round-trip
      safeId) + integration test (stand-in 500 cho /models, chat trả lời; payload phải
      mang wire id). Đã kiểm chứng test bắt lỗi: bỏ fix → FAIL `"reflection-beam-free"`
- [x] **Nối test extension vào CI** — ⚠ đã xong lúc viết, nhưng `.github/workflows/test.yml`
      (cùng 3 workflow macOS/release) **bị xoá ở `1552888`** (chủ repo) khi sang pi-extension-only
      → **CI không còn chạy ở checkout này** (đã phân loại: KHÔNG khôi phục, gỡ claim cho khớp
      thực tế). Còn giá trị & vẫn đúng: `test/preflight.mjs` cho 3 script integration **SKIP có
      lý do + exit 0** khi thiếu `pi` (đã mô phỏng: 4 unit PASS, 3 integration SKIP) nên
      contributor không có pi vẫn chạy hết phần offline; verifier live cố ý chạy tay (tiêu quota
      free egress). Khôi phục CI 1 bước nếu cần: `git show f4709c1:.github/workflows/test.yml`
- [x] Disclaimer một lần cho người dùng lane miễn phí (G14): `disclaimer.js` +
      `session_start` — nói rõ Kilo log prompt, OpenCode meter theo session/IP,\      đừng gửi dữ liệu nhạy cảm; hiện đúng một lần ở session tương tác
      (version-gate như dsh, ghi `notice-ack.json`). Smoke RPC: phiên 1 hiện 1
      lần, phiên 2 im. Smoke cũng phát hiện + sửa bug thật: `writeAck()` bỏ qua
      `OFM_DATA_DIR` nên ghi nhượng quyền vào home thật (đã dọn + test chống hồi quy)
- [x] Lấp lỗ hỏng test do chính fix `big-pickle` tạo ra: model KHÔNG có menu effort giờ
      có integration test qua `pi` thật — `--thinking high` trên `ofm-opencode/big-pickle`
      → không có `reasoning_effort` nào ra wire (upstream trả 400 nếu ngoài menu), block
      `<env>` + tool verbatim vẫn đủ, lượt hoàn thành. Đã kiểm chứng test có "răng":
      tạm cho big-pickle menu thì đúng FAIL với `"high"` trên wire
- [x] Viết runbook phản ứng drift: `docs/pi-extension-drift-runbook.md` — bảng
      triệu chứng→nghĩa, quy trình đo (tham chiếu `free-lane-wire.md`), bảng
      file·symbol phải sửa cho từng yếu tố (đã đối chiếu 18 symbol đều tồn tại),
      verify trước commit, và các bước sau khi sửa
- [x] **Lỗi thật do chính việc bảo trì định kỳ lộ ra**: đợt reverify 2026-11-02
      PASS cả hai lane, nhưng `chain-integration.mjs` flaky (2/8 lần FAIL). Không
      phải lỗi test: pi abort refresh của provider bằng AbortController theo
      *generation*, và abort đó rơi **sau** khi fetch đã thành công; nhánh `catch`
      của `kiloModels()` coi đó như thất bại và gọi `staticSnapshot()` — **thay**
      map `safeId → wire id` live bằng snapshot offline. Lượt Kilo kế tiếp mang
      `reflection-beam-free` thay vì `reflection/beam-free` → "model not found"
      trên lane đang sống. Sửa: `createKiloRoster()` trong `catalog.js` — map
      được **seed** từ snapshot và chỉ **thêm** không bao giờ mất, refresh bị
      abort/timeout/5xx giữ nguyên roster live cuối + mọi wire id đã học; chỉ có
      listing trả slice free **rỗng** mới degrade về snapshot. 5 unit check mới;
      đã kiểm chứng test có "răng" (khôi phục hành vi cũ → đúng 2 FAIL). Sau fix:
      `chain-integration.mjs` 15/15 PASS (trước đó ~25% fail). Lane OpenCode không
      có lỗ hổng tương đương (id không chứa `/` hay `:` nên safeId == wire id).
- [x] **Acceptance smoke qua `pi` thật với `-e ./pi-extension`** (runbook §5 —
      bước chưa từng chạy độc lập, 2026-11-02): `--list-models` thấy đủ **23 model**
      (15 Kilo + 8 OpenCode, khớp audit); một lượt thật `-nt -p "…pong" --model
      ofm-kilo/kilo-auto-free` → trả lời `pong`, exit 0. Chứng minh extension
      nạp/routing/turn hoạt động đầu-cuối trên lane miễn phí. OpenCode lane hết quota
      ở IP này nên lượt thật dùng Kilo; verifier đã xác nhận gate OpenCode vẫn PASS.
- [x] **Biến acceptance smoke #5 thành script chạy lại được trong CI** (hướng C):
      `pi-extension/test/acceptance-live.mjs` đứng stand-in loopback cho cả 2 lane
      (không tốn quota egress) rồi lái `pi` thật qua `--list-models` + một lượt mỗi
      lane; assert roster **live** (không phải snapshot) + cả hai lane trả lời
      đầu-cuối (`answered-by-kilo` / `answered-by-opencode`). Nối vào
      `test:pi-extension` (tự SKIP khi thiếu `pi` qua preflight; timeout 90s để treo
      thành FAIL). Teeth-check: đổi id listing OpenCode → assert roster đúng **FAIL**,
      Kilo vẫn PASS. Sau khi nối vào suite: **124 check / 9 script PASS**.
- [x] **Dọn `package.json` về chỉ-phục-vụ-pi-extension** (2026-11-02): giữ đúng 3
      script (`test` → `test:pi-extension`, `test:pi-extension` 9 script,
      `verify:pi-extension-upstream`); bỏ toàn bộ của dsh plugin — `files[]` 40 mục,
      `exports`, `main` host-half, `dsh.bundle/client`, peerDeps/devDeps `@deepseek-ai/*`
      + esbuild/typescript/undici, `overrides`, và 15 script standalone/magpie/channel/
      manifest/legacy. Suite vẫn **124/124 PASS** sau khi dọn. **Không cần `npm run
      build`**: `pi-extension/` là ESM thuần, pi nạp trực tiếp.
- [x] **Đối chiếu API extension/provider với gói `pi` 1.4.0 thật** (2026-11-02): đọc
      `@earendil-works/pi-coding-agent@1.4.0` + `pi-ai@1.4.0` (docs + `.d.ts` + `models.js`) và
      xác minh **khớp toàn bộ** — factory async, `registerProvider`+custom `streamSimple`,
      `refreshModels(context.signal)`, `ProviderConfig.api`/`models`, field `Model`
      (`thinkingLevelMap`/`compat`/`baseUrl`), `registerVirtualModel`+
      `route→{model,thinkingLevel,state}`, `registerCommand`, `ctx.hasUI/ui/modelRegistry`, và
      cơ chế refresh-abort-theo-generation (nền của `createKiloRoster`). Bảng bằng chứng:
      audit §7. **Không cần sửa code** — extension đã đúng.
- [x] **Kiểm chứng đường dùng thật của pi-extension (2026-11-02)**: `pi install
      ./pi-extension` (global) → `pi --list-models` **23 model** (không cần approve) + một
      lượt thật qua đường đã-cài `pi -p "…" --model ofm-kilo/kilo-auto-free` → **`pong`**,
      exit 0; `pi -e ./pi-extension` cùng hoạt động. **Phát hiện**: biến thể project-local
      `pi install ./pi-extension -l` bị pi **gate tin cậy** → không nạp tới khi `--approve`
      (23 model khi `--approve`, 0 khi không) → ghi vào README §Install. Đã dọn sạch install
      sau khi kiểm (`.pi/` nguyên trạng, git sạch).
- [x] **Sửa claim sai trong README (2026-11-02)**: mô tả wizard `/ofm chain edit` ghi
      "name … prefilled with the current" nhưng code chỉ **prefill thật ở links**
      (`ctx.ui.editor`); **name là placeholder** (`ctx.ui.input`) và để trống thì giữ nguyên
      (`buildChainEdit`, đã test `chains.test.mjs`). Sửa README §chains cho khớp code.
- [x] **Rà soát chính xác README ↔ `fingerprint.js` (2026-11-02)**: mọi khẳng định fingerprint
      (UA v2, 4 session header, session-id descending counter 1–63, 2 tool verbatim, 2 alias
      danh-tính, block `<env>`, cấm `tool_choice:'none'`) **khớp 1:1**; UA còn qua gate (429
      không 403). Không mismatch → không sửa code. Ghi ở audit §7.
- [x] **Chứng minh RUNTIME cơ chế provider (2026-11-02)**: đọc
      `pi-coding-agent/dist/core/provider-composer.js` → (a) `api` **bắt buộc** khi có
      `streamSimple` (L343–344 throw nếu thiếu); (b) model kế thừa `config.api` (L135); (c)
      `streamWith` chọn đúng stream của ext vì `model.api === extension.api`, không rơi vào
      nhánh "No API provider" (L378–392); (d) `baseUrl`/`apiKey` đáp ứng guard; (e) stream của
      ext tự set `api:'openai-completions'` cho lời gọi pi-ai. Ghi **invariant bảo trì**: đừng bỏ/
      đổi `api:'ofm-free-api'`. Không sửa code — extension đã đúng. Audit §7b.
- [x] **Chuyển toàn bộ pi-extension sang TypeScript + build `dist` + cài local kiểm chứng**
      (2026-11-02): `git mv` 10 file nguồn + 9 test + `reverify` sang `.ts` (giữ char-for-char,
      chỉ thêm type); `tsconfig.json` (NodeNext → `dist`); `package.json` 0.2.0 trỏ
      `pi.extensions → dist/index.js`; `tsc` **sạch 0 lỗi** với type `pi-ai`/`pi-coding-agent`
      1.4.0. **Phát hiện + sửa 1 bug thật** (`fingerprint.ts` `const alias` bị gán lại trong `for`
      → crash khi trụng slot gate) + test hồi quy có-răng. `npm run test:pi-extension` →
      **125/125 PASS**. **Cài local tại thư mục hiện tại kiểm chứng:** `pi install
      ./pi-extension -l --approve` → `--list-models` **23 model** + lượt thật **`installed-ok`**
      (đã gỡ cho repo sạch). Chi tiết: audit §8.
- [ ] (còn lại duy nhất, điều kiện — chờ trigger) Khi `npm run
      verify:pi-extension-upstream` báo FAIL → làm theo runbook trên. Lần đo gần
      nhất (2026-11-02 ~18:54, **post-migration TS** — vì vừa sửa `fingerprint.ts` nên phải đo
      lại gate): test offline **125/125 PASS (9 script)**; verify **ĐO LẠI cả hai lane PASS**
      (chạy từ `reverify-upstream.ts`) — listing OpenCode 200, 8 id toàn chat-wired, không lệch
      snapshot; chat 429 (gate PASS); Kilo 200 không credential. **Không drift** → sửa
      TS/fingerprint không hồi quy gate. (Cadence: chỉ chạy lại khi qua ngày, nghi drift, hoặc
      sau khi sửa `fingerprint.js`/roster — không lặp theo từng tin nhắn.)
  - ✅ Đã phân loại (2026-11-02): `1552888 "fix"` (chủ repo) **xoá cố ý cả 4 workflow**
    (test / build-macos / prepare-release / release-sign) khi sang pi-only → chọn phương án
    **(b) KHÔNG khôi phục**, mà **gỡ claim CI** khỏi README/TODO cho khớp thực tế. Nếu sau này
    cần CI lại: `git show f4709c1:.github/workflows/test.yml` rồi trỏ về `npm run
    test:pi-extension`.

---

## Việc cần làm — gap-analysis toàn bộ repo dsh → `pi-extension/` (2026-11-02)

Nguồn: đã **đọc/đối chiếu** code gốc nhóm lane-free (`src/http.js`, `src/upstream.js`, `src/effort.js`,
`src/kilo.js`; `src/stream.js`/`catalog.js`/`probe`/`recovery`/`combos` ở mức mapping) và **inventory toàn
bộ thư mục** (`src/**`, `index.js`, `client.js`, `adapter/`, `worker/`, `catalog/`, `feed/`, `locale/`,
`scripts/` 184 file, `vendor/` [channel-pack 148 TS + dsh-std + magpie], `packages/` [standalone + desktop
Tauri], `cordis.patch.yml`, `tsconfig.json`). Bản đồ 7 hệ thống: `docs/pi-extension-audit.md` §1.

### P0 — DRIFT roster 2026-11-02 ✅ ĐÃ XONG (`d411b4f`)
Verify bắt được roster live đổi: OpenCode +`pulse-alpha-free`; Kilo +3
(`thinkingmachines/inkling:free`, `thinkingmachines/inkling-small:free` — family **cấm tắt
thinking** → `canDisable:false`; `google/gemma-4-31b-it:free`).
Đã sửa `catalog.ts`: `FREE_ID_OVERRIDES['pulse-alpha-free']` (vision, 1M/131072, low|high|max);
bù cả 4 id vào `STATIC_*` (wire là dạng **hai-chấm `:free`** — đã sửa lại từ nhầm gạch-nối);
`KILO_REASONING_MANDATORY` đã có `/^thinkingmachines\//` nên off-rung `null` cả live+offline.
Thêm 2 check `catalog.test.ts` (wire-id chính xác + off-rung family). **127/9 suite PASS**;
`npm run verify:pi-extension-upstream` giờ **PASS** (snapshot khớp live 9 opencode + 18 kilo).

### P1 — Gap hành vi free-lane (từ đối chiếu code gốc; ảnh hưởng chất lượng lane)
- [x] **G-a (trung bình)** `lane.sseGuard`/`transport`: trên path body **SSE bị gán nhãn sai** (content-type
      JSON nhưng body là SSE) hiện `await response.text()` → **đệm toàn bộ** rồi mới phát lại, mất
      streaming tăng dần (dsh `http.js` chỉ sniff 4KB rồi `replayStream`). Port `readHead`+`replayStream`.
      **→ ĐÃ FIX (`0e2ca0a`)**: thêm `readHead`(4KB, có deadline+abort)/`replayStream`/`readRemainder`
      vào `transport.ts`; `sseGuard` dùng chúng (không còn `response.text()` cho path SSE); `sseResponse`
      nhận cả `ReadableStream`. Test: unit “readHead quyết SSE từ head, không đợi close”+“readRemainder
      stitching”; integration kilo `sse-mislabelled` replayed. Suite **130/9 PASS**.
- [x] **G-c (thấp)** `transportCause`: thêm lý do DNS/TLS (ENOTFOUND/ECONNRESET…) vào thông báo lỗi
      transport (`fetch failed — getaddrinfo ENOTFOUND …`), như `http.js transportCause`.
      **→ ĐÃ FIX (`3a78696`)**: port `transportCause` (đi tối đa 3 nhánh `cause`, dedupe) vào
      `transport.ts`; `errorMessageOf` (`lane.ts`) ghép vào `errorMessage`; test 4 nhánh.
- [ ] **G-b (thấp)** hint **empty-5xx + ảnh** (dsh issue #549): khi gateway trả 5xx body rỗng và request
      mang ảnh, nói rõ “có thể model không nhận vision”; cần `carriesImageContent`.
      **→ DEFERRED**: path empty-5xx do **pi-ai sở hữu** (extension trả nguyên response lỗi cho pi-ai); thêm
      hint đòi canh sửa thông báo lỗi của pi-ai (rủi ro hồi quy) hoặc pre-check `init.body` lúc fetch rồi
      rewrite lỗi. #549 là quirk gateway cũ — **chỉ làm nếu tái hiện được** trên lane OpenCode/Kilo hiện tại.
- [x] **Kilo envelope (thấp)** `friendlyMessage`/kilo path chưa xử lý envelope Kilo riêng:
      `PAID_MODEL_AUTH_REQUIRED` (id trả phí yêu cầu account → "không nằm ở free pool") và
      `moderation|flagged|filtered` (chặn nội dung) — dsh `classifyKilo` đã tách.
      **→ ĐÃ FIX (`6055c78`)**: thêm 2 nhánh vào `friendlyMessage` + test. (Không cần reshape
      envelope `error_type`/`error.code` riêng vì pi-ai đã stringify body vào `errorMessage`,
      nên regex trên text là đủ — khác cách dsh tự decode envelope.)
- [x] **session xuyên restart — đã chốt, KHÔNG persist**: dsh lưu `session-map.json` (ổn định upstream-session qua restart,
      nhận canonical id của caller); pi-extension giữ **in-process**. Hiện vẫn đúng (mint thời-gian-thật mỗi
      lần, gate chấp nhận) — **KHÔNG persist** (2026-11-02): trong 1 tiến trình `sessionFor` giữ session ổn định theo hội thoại (tránh mint-mỗi-request gây 429); qua restart mint lại bằng thời-gian-thật → gate chấp nhận (200, đã đo); chỉ là một session-ID khác cho quota per-session/IP, không phải lỗi. Không ghi-đĩa.
- [x] **(tuỳ chọn) rationale effort**: `src/effort.js` dùng **budget ladder** (gateway cũ bỏ qua
      `reasoning_effort`, chỉ ép `max_tokens`); pi-extension dùng **menu `reasoning_effort` do model khai
      báo** (đã đo lại: gateway hiện **honours** menu này + 400 nếu ngoài menu — audit §3 G4/G5). Ghi rationale vào
      README/audit để khỏi tưởng bug khi đối chiếu `effort.js`. **→ ĐÃ GHI** vào README §“Thinking strength …”.

### P2 — Hệ thống 2–7 (đã inventory; **out-of-scope v1** — chỉ port nếu chốt)
Mỗi dòng: hệ thống → thư mục/module gốc → cần gì cho pi → khuyến nghị.
- [ ] **EAC co-pay** (`src/eac*`, `worker/`) — kênh trả tiền, GitHub login+star, seal HMAC → pi không có;
      khuyến nghị **KHÔNG**.
- [ ] **10 kênh tài khoản** (`vendor/channel-pack/src/**` ~148 TS + 2 wasm) — OAuth/QR cho 10 IDE, gom
      credential, check-in → **rất lớn**, không keyless; khuyến nghị **KHÔNG trong v1** (nếu cần: provider
      per-IDE riêng, đòi login).
- [ ] **Engine account-pool** (`src/magpie*` + `vendor/magpie` binary Go 68MB `yetone/magpie`) → local OpenAI
      gateway 127.0.0.1:8326; pi tự chọn model; khuyến nghị **KHÔNG**.
- [ ] **Local gateway 3 protocol** (`src/forward.js`, `anthropic.js`, `gemini.js`, `chan-relay.js`, `combos.js`
      + LAN relay) — biến dsh thành server OpenAI/Anthropic/Gemini; **tuỳ chọn**: port nếu muốn dùng pi làm
      gateway cho tool khác; nếu không → **KHÔNG**.
- [ ] **Egress/proxy tự quản** (`src/egress.js`, `bun-fetch.js` — spawn mihomo/Clash, health-check) →
      pi-extension hiểu chỉ cần `NODE_USE_ENV_PROXY` + `HTTPS_PROXY` (README §Notes); mihomo/Clash là quá mức;
      khuyến nghị **KHÔNG**.
- [ ] **Vỏ sản phẩm** (`index.js` host + `client.js` UI 11 trang; `store/updater/reload/feed/push/trust/sponsor/picks`)
      → `/ofm` command + settings của pi đã đủ; khuyến nghị **KHÔNG** (trừ khi muốn dashboard usage trong pi).
- [ ] **Token-saver** (`src/token-saver/**` ~17 file, nén tool-result git/ls/grep/tree/read…) → **xem xét**:
      phù hợp để tiết kiệm token cho pi; cần thiết kế hook tool-result của pi (`registerToolRenderer`/
      `tool_result` event). Để **quyết định**.
- [ ] **Aggregate 76 provider** (`src/aggregate.js` + `src/providers/registry.json`) → thêm provider có-key;
      pi quản key/đăng nhập riêng; khuyến nghị **KHÔNG/optional**.
- [ ] **Phân phối/đóng gói** (`scripts/build-manifest*`, `catalog/*.json` ký, `packages/standalone+desktop+Tauri`,
      `updater` Ed25519) → cài qua `pi install ./pi-extension`; khuyến nghị phát hành bằng **git tag** (không cần
      manifest ký).

### P3 — Chất lượng mã
- [ ] Siết `strict:true` — **gate đã dựng** (`tsconfig.strict.json` + `npm run typecheck:strict`, non-gating; `npm run build` vẫn dùng `tsconfig.json` non-strict, đang xanh). Giảm 165→0 **theo module, mỗi lần một commit xanh**. **Tiến độ:** kilo (`8dea232`), opencode (`a9a84e9`), chain-store+disclaimer (`f99f2b1`), transport (`1d9b2b9`), lane (`80c8905`), catalog (`432f082`), index (`16c99e0`) → **165→75**. Còn: **fingerprint 27, chains 47** (hai cụm lớn — mutation payload động). Biên pi-API đã type thật; `notify(check.error ?? '')` phòng vệ cho trường tùy chọn; giữ `any` có chủ-đích ở payload/event động. Về 0 → bật strict ở build chính. Biên pi-API (opencode/kilo) đã type thật `Model`/`TranscriptContext`/`SimpleStreamOptions` — vừa siết type vừa tăng kiểm-tra tương thích; giữ `any` có chủ-đích ở payload gateway động và hàm event-manipulation. Về 0 → bật strict ở build chính.
- [x] `npm audit` pi-extension: 3 vuln (2 mod, 1 high) — **dev-only, không ship** (extension chỉ ship `dist/`,
      runtime do `pi` cấp pi-ai). Quyết định có `overrides` hay bỏ. **→ ĐÃ XONG (`0461cf4`)**: `overrides`
      vá `undici^8.12.3`+`minimatch^11.0.3`, giữ pi 1.4.0; audit **0 vuln**, build+suite xanh.

> Cách tiếp cận: mọi mục P2 là “đã phân tích → cần chủ ý port”, không phải “còn nợ âm thầm”. P0/P1 là việc
> thật, khả thi, có test.
