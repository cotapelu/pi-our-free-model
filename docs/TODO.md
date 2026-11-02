# TODO — pi provider extension (pi-extension/)

Checklist phiên làm việc này. Trạng thái cập nhật sau mỗi bước.

## Đã xong

- [x] Phân tích bản chất repo dsh: 7 hệ thống (xem `docs/pi-extension-audit.md` §1)
- [x] Quét repo dsh: src/ đủ phần lane miễn phí + cấu trúc toàn bộ thư mục con
- [x] Viết `docs/pi-extension-audit.md`: repo làm gì + 14 gap (G1–G14) + mức độ + trạng thái
- [x] Sửa extension theo gap G1–G12
- [x] Port combo/fallback-chain (G13) → `chains.js` + `chain-store.js` + virtual model
      `ofm-chain` + `/ofm chain add|set|remove|enable|disable`; failover khớp kiến trúc pi
- [x] Sửa 3 lỗi thật phát hiện bằng test (429 mất token FreeUsageLimitError → pi retry quota;
      kilo.js đổi model.id phá address; previous thiếu → suy từ transcript)
- [x] `/ofm chain add` nhận `strategy` + `stickyLimit`; `/ofm chain set` sửa chain đã có
- [x] `chain add` kiểm tra link lúc thêm (`evaluateAdd`): all-dead → từ chối + liệt kê link
      chết; một phần chết → nhận và báo `1/2 links live`; `/ofm chain list` hiện live/total
- [x] Smoke command qua pi RPC thật: add giữ link + strategy, set đổi strategy giữ sticky,
      add typo bị từ chối (xác nhận qua chains.json + extension_ui_request)

## Còn lại

- [ ] Bảo trì định kỳ: upstream siết gate → đo lại fingerprint theo
      `docs/free-lane-wire.md` (TLS MITM + replay từng byte), cập nhật `fingerprint.js`
- [ ] Tùy chọn: editor TUI cho chains nếu cần
