# `pi-extension/packages/standalone/` — app console độc lập

> **Trạng thái: CHƯA PORT (0/55 file / 15.936 dòng).**
> File này là kế hoạch, không phải báo cáo đã xong. Xem `../../BAOCAO.md` §4.2.

## Cái gì cần port

| File DSH | Dòng | Vai trò |
|---|---|---|
| `service.mjs` | 394 | `startStandalone`, process guard, service lock, data dir |
| `workbench.mjs` | 346 | engine nhúng trong workspace |
| `management.mjs` | 490 | API quản lý (model, kênh, cấu hình) |
| `library.mjs` | 474 | thư viện model |
| `client-terminal.mjs` | 556 | terminal login cho client |
| `providers.mjs` | 103 | provider registry phía standalone |
| `routing.mjs` | 83 | routing request |
| `eac.mjs` | 122 | lane EAC phía standalone |
| `open-external.mjs` | 19 | mở link ngoài |
| `desktop-update.mjs` | 166 | tự cập nhật bản cài |
| `login-terminal.mjs` | 66 | terminal login |
| `channels/contracts.mjs` | 41 | interface kênh |
| `channels/credentials.mjs` | 47 | kho credential standalone, atomic write |
| `channels/images.mjs` | 44 | ảnh chỉ sống trong RAM của request |
| `channels/runtime.mjs` | 139 | một Worker per instance |
| `channels/worker.mjs` | 157 | host cho worker |
| `frontend/` 11 trang `.tsx` | ~1.600 | UI console |
| `frontend/` 6 file data `.mjs` | ~290 | filter/sort/theme |
| `vite.config.mjs` | 22 | build frontend |

> `channels/business.mjs` (2,6 MB / 62.254 dòng) và `web/` (1,4 MB) là **bundle
> sinh tự động** bởi `scripts/build-standalone-channels.mjs` và
> `scripts/build-standalone-ui.mjs`. Không phải code tay — tái sinh từ
> `vendor/channel-pack/src` và `frontend/`.

## Việc phải làm

- [ ] `service.ts` — `startStandalone` + process guard + service lock. Ranh giới
      bảo mật: một instance một data dir, không đọc file DSH, lock bị chiếm thì
      báo lỗi chứ không giành.
- [ ] `channels/` (6 file) — contracts, credentials (atomic write, 0600), images
      (chỉ trong RAM), runtime (một Worker per instance để không lẫn account),
      worker host.
- [ ] `management.ts`, `library.ts`, `providers.ts`, `routing.ts`,
      `workbench.ts`, `client-terminal.ts`, `login-terminal.ts`,
      `desktop-update.ts`, `open-external.ts`, `eac.ts`
- [ ] `frontend/` 11 trang + 6 file data — đây là nửa console mà gateway sẽ phục
      vụ; port trùng với nhiệm vụ `client.js` ở `docs/TODO.md` §3-A.
- [ ] test mỗi module: quyền file, cô lập account, atomic write, không rò secret.

## Ranh giới

Bản standalone **không** được gộp thành pi extension. Nó là một cách chạy khác
của cùng một bộ lane, dùng chung `gateway/` và `providers/`.
