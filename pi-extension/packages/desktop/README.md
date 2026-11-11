# `pi-extension/packages/desktop/` — Tauri shell quanh standalone service

> **Trạng thái: Rust shell copy verbatim (không port sang ngôn ngị khác); phần
> logic Node đã port.** Ranh giới pin ở cuối file. Xem `../../BAOCAO.md` §4.4.

## Cái gì ở đâu

| DSH | Ở đây | Cách xử lý |
|---|---|---|
| `src-tauri/**` (11 file: 5 `.rs`, `Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `capabilities/`, `permissions/`, icons, NSIS hooks) | copy **byte-for-byte** (đã `diff -r` sạch) | Rust không chạy trong Node — shell giữ nguyên, chỉ port logic |
| `splash/splash.html`, `splash/error.html` | copy verbatim | tài nguyên shell |
| `ui/titlebar.css` | copy verbatim | bị `lib.rs` `include_str!` lấy thẳng |
| `ui/titlebar.js` | copy verbatim (`ui/titlebar.js`) | **cố ý không đổi tên**: `src-tauri/src/lib.rs:58` `include_str!("../../ui/titlebar.js")` — đổi tên sang `.ts` là hỏng build Rust. Đây là code của shell, thuộc ranh giới Rust |
| `service-host.mjs` | **`service-host.ts`** (port) | lớp dựng service dưới sự điều khiển của shell |
| `package.json`, `package-lock.json` | copy verbatim | |

## `service-host.ts` — hợp đồng một dòng JSON

Shell spawn file này bằng Node và nói chuyện qua stdin/stdout:

- shell → host: `shutdown` (một dòng) hoặc **đóng stdin** (shell chết không kịp nói);
- host → shell: một dòng `ofm-desktop-ready/v1` (`product`, `pid`, `port`,
  `managementUrl`) hoặc `ofm-desktop-error/v1` (`DATA_DIRECTORY_IN_USE` khi
  `service.lock` đã bị chiếm, `START_FAILED` cho mọi lỗi khác).

Hai quy tắc được giữ nguyên từ bản gốc:

1. **Lỗi chỉ mang mã.** Không message, không stack — khởi động thất bại không
   được đẩy account/API key/login token vào log của shell.
2. **Đóng stdin là dừng.** Service không được sống sót sau cửa sổ shell; cổ
   nghe lại bị chiếm là lần khởi động sau bind hỏng.

## Ranh giới Rust (pin — sai là hỏng)

- `src-tauri/src/lib.rs:78` trỏ cứng `resources/service/packages/desktop/service-host.mjs`.
  Bản stage trong repo gốc (`scripts/prepare-desktop.mjs` — port ở `docs/TODO.md`
  G11) chép `*.mjs` vào đúng đường đó. Ở pi-extension, `tsc` phát
  `dist/packages/desktop/service-host.js`, nên **bước stage phải map `.js` →
  `.mjs`** để đường dẫn Rust không đổi. Rust không bị sửa.
- `ui/titlebar.js` là `include_str!` của `lib.rs` — đừng đổi tên, đừng "port"
  sang `.ts` khi chưa sửa cả `lib.rs`.
- `src-tauri/src/{service,update,external,lib,main}.rs` quyết: chu kỳ sống của
  child, quyền auto-update, mở link ngoài, titlebar. Logic tương ứng đã có bản
  TS trong `packages/standalone/` (`service.ts`, `desktop-update.ts`,
  `open-external.ts`); Rust giữ vai trò shell, không bị thay bằng TS.

## Việc còn thiếu (thuộc G11, không thuộc port này)

- [ ] `scripts/prepare-desktop.mjs` → stage `dist/` thành `resources/service/`
      (map `.js` → `.mjs`, giữ nguyên đường dẫn Rust ở trên).
- [ ] `scripts/desktop-test.mjs`, `scripts/desktop-update-test.mjs` → test suite.
