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
- [ ] (còn lại duy nhất, điều kiện — chờ trigger) Khi `npm run
      verify:pi-extension-upstream` báo FAIL → làm theo runbook trên. Lần đo gần
      nhất (2026-11-01, sau khi bù big-pickle): cả hai lane PASS.
