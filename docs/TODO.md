# TODO — pi provider extension (pi-extension/)

Checklist phiên làm việc này. Trạng thái cập nhật sau mỗi bước.

## Đã xong

- [x] Phân tích bản chất repo dsh: 7 hệ thống (xem `docs/pi-extension-audit.md` §1)
- [x] Quét repo dsh: src/ đủ phần lane miễn phí + cấu trúc toàn bộ thư mục con
- [x] Viết `docs/pi-extension-audit.md`: repo làm gì + 14 gap (G1–G14) + mức độ + trạng thái
- [x] Sửa extension theo gap G1–G12
- [x] Port combo/fallback-chain (G13) → `chains.js` + `chain-store.js` + virtual model
      `ofm-chain` + `/ofm chain add|set|remove|enable|disable`; failover khớp kiến trúc pi
      (advance trên retry và trên user-turn sau quota/region; không đổi model khi overflow)
- [x] Sửa 3 lỗi thật phát hiện bằng test (429 mất token FreeUsageLimitError → pi retry quota;
      kilo.js đổi model.id phá address; previous thiếu → suy từ transcript)
- [x] `/ofm chain add` nhận `strategy` + `stickyLimit` (`round-robin:3`), `/ofm chain set` sửa
      chain đã có — parser thuần `parseChainAdd` + unit test + round-trip store
- [x] Smoke command qua RPC thật: add giữ đúng 2 link + `round-robin:2`; set đổi strategy,
      giữ sticky (kiểm tra `chains.json` sau lệnh)
- [x] Test PASS: `npm run test:pi-extension` — 6 file
      (catalog 12 · fingerprint 10 · chains 23 · fingerprint-integration 15 ·
      kilo-integration 11 · chain-integration 3)
- [x] Smoke thật: `pi --list-models` 23 model, Kilo `--thinking off/high` + tool,
      OpenCode 429 thân thiện, chain xuất hiện trong picker

## Còn lại

- [ ] Bảo trì định kỳ: upstream siết gate → đo lại fingerprint theo
      `docs/free-lane-wire.md` (TLS MITM + replay từng byte), cập nhật `fingerprint.js`
- [ ] Tùy chọn: `chain add` chưa kiểm tra link có resolve không tại thời điểm add
      (chỉ ⚠ trong `/ofm chain` list); editor TUI cho chains nếu cần
