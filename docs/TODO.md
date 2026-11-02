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
- [x] Nối test extension vào CI (`.github/workflows/test.yml`, job `test / pi-extension`):
      cài `@earendil-works/pi-coding-agent@^1.4.0` rồi chạy `npm run test:pi-extension`;
      thêm `test/preflight.mjs` để 3 script integration **SKIP có lý do + exit 0** khi
      thiếu `pi` (đã mô phỏng: 4 unit PASS, 3 integration SKIP), nên contributor
      không có pi vẫn chạy được toàn bộ phần offline; verifier live cố ý để ngoài CI
      vì nó tiêu quota free của egress
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
- [ ] (còn lại duy nhất, điều kiện — chờ trigger) Khi `npm run
      verify:pi-extension-upstream` báo FAIL → làm theo runbook trên. Lần đo gần
      nhất (2026-11-02 ~11:50, sau fix wire-id): test offline **124/124 PASS (9 script)**,
      ổn định không còn flake; verify **ĐO LẠI cả hai lane PASS** — listing OpenCode
      200, 8 id toàn chat-wired, không lệch snapshot; chat 429 (gate PASS); Kilo
      200 không credential. **Không drift** → không phải sửa gì.
  - ⚠ Phát hiện liên quan: item "[x] Nối CI (`.github/workflows/test.yml`)" KHÔNG còn
    đúng ở checkout này — `.github/` không còn trong cây HEAD; lần chạm cuối lên
    `test.yml` trên nhánh HEAD là `1552888` (file có ở `f4709c1`, tổ tiên HEAD). Cần
    quyết định: khôi phục file CI, hoặc gỡ claim CI khỏi audit/TODO.
