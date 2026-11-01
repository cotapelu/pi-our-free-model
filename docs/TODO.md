# TODO — pi provider extension (pi-extension/)

Checklist phiên làm việc này. Trạng thái cập nhật sau mỗi bước.

## Đã xong

- [x] Phân tích bản chất repo dsh: 7 hệ thống (xem `docs/pi-extension-audit.md` §1)
- [x] Quét src/: upstream, http, kilo, catalog, effort, stream, adapter, messages, probe,
      recovery, egress, store, trust, combos, aggregate, forward, anthropic, gemini, chan-relay…
      (đủ để đối chiếu hành vi lane miễn phí)
- [x] Quét cấu trúc vendor/channel-pack, vendor/magpie, packages/, scripts/, worker/, adapter/,
      catalog/, feed/, locale/ (bản đồ + vai trò, audit §1)
- [x] Viết `docs/pi-extension-audit.md`: repo làm gì + 14 gap (G1–G14) + mức độ + trạng thái
- [x] Sửa extension theo gap:
      G1 env block `<env>` · G2 alias `subagent_fork`/`working_directory` + note map tên ·
      G3 retarget tool_choice · G4 capacity/menu đo thực tế (deepseek 1M/384K…) ·
      G5 model không menu → không gửi reasoning_effort · G6 `max` trong effortMap ·
      G7 Kilo off = `{enabled:false}` + family mandatory-thinking ·
      G8 sseGuard (fold JSON→SSE + document→delta frames, HTML→lỗi) ·
      G9 idle watchdog (không reset bởi keepalive) · G10 DSML scrubber ·
      G11 chỉ map row `chat-completions` · G12 thông báo lỗi đầy đủ
- [x] Sửa 3 bug tự phát hiện khi test: map đổi tên history/tool_choice sai chiều; bảng static
      dùng nhầm `maxTokens`/`maxOutput`; fold JSON document phải tái sinh delta-frames
      (SDK không đọc shape non-stream)
- [x] Test: `fingerprint.test.mjs` (10), `catalog.test.mjs` (12), `fingerprint-integration.mjs`
      (15, gồm assert `<env>`), `kilo-integration.mjs` (18, gồm off-rung + fold JSON) — **38/38 PASS**
      (`npm run test:pi-extension`)
- [x] Smoke thật: `pi --list-models` (23 model), Kilo `--thinking off` + `high` + tool `ls`,
      lane OpenCode báo 429 thân thiện (fingerprint pass, quota theo IP)
- [x] Cập nhật `pi-extension/README.md` (env block, menu, guards)

## Còn lại

- [ ] (không còn) — nếu upstream siết gate: đo lại fingerprint theo `docs/free-lane-wire.md`
      (TLS MITM + replay từng byte) rồi cập nhật `pi-extension/fingerprint.js`
- [ ] Tùy chọn: port combo/fallback-chain qua `pi.registerVirtualModel` (xem `src/combos.js`)
