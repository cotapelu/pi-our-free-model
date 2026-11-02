# TODO — pi provider extension (pi-extension/)

Checklist phiên làm việc này. Trạng thái cập nhật sau mỗi bước.

## Đã xong

- [x] Phân tích bản chất repo dsh: 7 hệ thống (xem `docs/pi-extension-audit.md` §1)
- [x] Quét repo dsh: src/ đủ phần lane miễn phí + cấu trúc toàn bộ thư mục con
- [x] Viết `docs/pi-extension-audit.md`: repo làm gì + 14 gap (G1–G14) + mức độ + trạng thái
- [x] Sửa extension theo gap G1–G12 (env block, alias tool, capacity đo thực tế,
      effort không gửi ngoài menu, Kilo off `{enabled:false}`, sseGuard fold, idle
      watchdog, DSML scrub, chỉ map row chat-completions, thông báo lỗi)
- [x] **Port combo/fallback-chain** (`src/combos.js` → `pi-extension/chains.js` +
      `chain-store.js` + virtual model `ofm-chain` + `/ofm chain add|remove|enable|disable`):
      - normalize input không tin cậy, capacity = giao các link, round-robin sticky
      - failover khớp kiến trúc pi: advance trên retry (lỗi tạm thời) và trên
        **user turn kế tiếp** sau lỗi pi không retry (quota/region); không đổi
        model khi context overflow; giữ model trên continuation để bảo toàn prompt cache
      - 3 lỗi thật phát hiện bằng test: (1) thông báo 429 của extension làm pi-ai
        coi quota wall là retryable → giữ lại token `FreeUsageLimitError`;
        (2) `kilo.js` đổi `model.id` thành wire id làm transcript ghi nhận id lạ,
        hỏng đối chiếu address → chỉ đổi id trong payload; (3) state chain không
        reset `walks` vì `previous` không có trên mọi đường → suy ra từ transcript
- [x] Test 47 check PASS: `npm run test:pi-extension`
      (`catalog` 12 · `fingerprint` 10 · `chains` 18 · `fingerprint-integration` 15 ·
      `kilo-integration` 11 · `chain-integration` 3) — script integration lái `pi` thật
- [x] Smoke thật: `pi --list-models` (23 model lane + chain), Kilo `--thinking off/high`
      + tool, lane OpenCode 429 thân thiện, chain xuất hiện trong picker

## Còn lại

- [ ] Bảo trì định kỳ: upstream siết gate → đo lại fingerprint theo
      `docs/free-lane-wire.md` (TLS MITM + replay từng byte), cập nhật `fingerprint.js`
- [ ] Tùy chọn: `/ofm chain add` chưa nhận `strategy`/`stickyLimit` từ dòng lệnh
      (hiến đã, sửa tay file `chains.json`); UI cho state machine nếu cần
