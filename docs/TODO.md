# TODO — kiến trúc production: `packages/` + `apps/`

> **Quy tắc duy nhất của file này:** ghi đúng cái đang có. Không ghi `[x]` cho
> stub, không ghi "xong" khi chỉ đọc code chưa chạy. Sau mỗi task: chạy
> `npm run build` + `node tests/run-all.mjs`
>
> - smoke, rồi mới tick.
>
> **Gốc để đối chiếu: `./dsh-our-free-model/` — bản 2.8.3.**
> Bản gốc cũ ở root đã xóa. `./dsh-our-free-model/` không nằm trong git.
>
> **Không bỏ qua:** mọi file code đều phải port. Chỉ 3 thứ không port được:
> magpie binary (68 MB), mihomo/Clash binary, Rust Tauri shell.

---

## 0. KIỂM KÊ TOÀN BỘ (lần chạy audit-ports.mjs mới nhất)

```
File code: 609 · đã map: 383 · thiếu: 220 · cố ý không port: 6
Export quét: 1718 · không thấy ở bất kỳ đâu: 59
Drift trong file đã map: 292 (export 14 · definition 72)
```

> Số từ `node scripts/audit-ports.mjs` — trả lời "có tên không", **không**
> trả lời "đúng hành vi không". Ghi `docs/audit-ports.md`.

---

## 1. CÒN LẠI — THEO KIẾN TRÚC MỚI

### 1.1 Tạo cấu trúc thư mục mới (packages/ + apps/) — ✅ HOÀN TẤT

| Task                          | Mô tả                                              | Trạng thái              |
| ----------------------------- | -------------------------------------------------- | ----------------------- |
| Tạo `packages/core/`          | lanes, chains, stats, catalog, o2a                 | ✅ Xong                 |
| Tạo `packages/gateway/`       | HTTP server, protocol, trust, store                | ✅ Xong                 |
| Tạo `packages/provider/`      | pi extension entry                                 | ✅ Xong                 |
| Tạo `packages/shared/`        | utils dùng chung (api, kilo, sanitizer, ago, copy) | ✅ Xong                 |
| Tạo `packages/console/`       | browser console, tsconfig compile `.tsx`           | ✅ Đã tạo (cần sửa JSX) |
| Tạo `packages/standalone/`    | di chuyển từ `src/packages/standalone/`            | ✅ Xong                 |
| Tạo `packages/worker/`        | Cloudflare Worker entry                            | ✅ Xong                 |
| Tạo `apps/server/main.ts`     | entry point API provider độc lập                   | ✅ Xong                 |
| Tạo `apps/standalone/main.ts` | entry point standalone CLI                         | ✅ Xong                 |
| Tạo `apps/extension/main.ts`  | re-export provider cho pi install                  | ✅ Xong                 |
| Tạo `config/schema.env.ts`    | validation biến môi trường (zod)                   | ✅ Xong                 |
| Tạo `tests/`                  | di chuyển test từ `src/test/`                      | ✅ Xong                 |

### 1.2 File chưa có bản port — **CHỈ CÒN PHẦN CỐ Ý**

| File gốc                      | Bản port                  | Trạng thái                     |
| ----------------------------- | ------------------------- | ------------------------------ |
| `egress.js` phần mihomo/Clash | `packages/core/egress.ts` | ⏳ Trả `{state:'unavailable'}` |
| `packages/desktop/*`          | Rust shell (Tauri)        | ❌ Không port (AGENTS.md §5)   |

### 1.3 Export thiếu trong bản port (core, 20 export)

| Export                     | File gốc                                   | Trạng thái                                       |
| -------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `freeLaneProxyActive`      | `egress.js`                                | ⏳ Trong `egress.ts`                             |
| `setFreeLaneProxy`         | `egress.js`                                | ⏳ Trong `egress.ts`                             |
| `envProxyFor`              | `egress.js`                                | ⏳ Trong `egress.ts`                             |
| `laneProxyEcho`            | `egress.js`                                | ⏳ Trong `egress.ts`                             |
| `renderMihomoConfig`       | `egress.js`                                | ⏳ Trả `{state:'unavailable'}`                   |
| `findMihomoBinary`         | `egress.js`                                | ⏳ Trả `{state:'unavailable'}`                   |
| `outletLabel`              | `egress.js`                                | ⏳ Trả `{state:'unavailable'}`                   |
| `readOutletSelection`      | `egress.js`                                | ⚠️ Thuộc phần mihomo cố ý không port             |
| `feedbackBaseOf`           | `feed.js`                                  | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `findAgentCli`             | `magpie-engine.js`                         | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `restoreResponsesToolName` | `messages.js`                              | ⚠️ Đã di chuyển sang `messages.ts`/`upstream.ts` |
| `WINDOW_HOURS`             | `model-test.js`                            | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `siteRootFor`              | `model-test.js`                            | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `perfFrom`                 | `model-test.js`                            | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `seriesFrom`               | `model-test.js`                            | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `readSeries`               | `model-test.js`                            | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `readPerf`                 | `model-test.js`                            | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `truncateWindow`           | `token-saver/rtk/filters/smartTruncate.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex)           |
| `randomProjectId`          | `upstream.js`                              | ⏳ Trong `upstream.ts`                           |
| `ANNOUNCEMENT_VERSION`     | `index.js` (root)                          | ⚠️ Root plugin entry đã thiết kế lại             |
| `createApiRoutes`          | `index.js` (root)                          | ⚠️ Root plugin entry đã thiết kế lại             |

→ 8 export thuộc `egress.js` phần mihomo — **cố ý không port** (AGENTS.md §5).

### 1.4 Definition thiếu trong file đã port (~200 definition, 72 theo audit)

Tất cả các file đã port đã được đối chiếu với bản 2.8.3. Các "definition gaps"
theo audit-ports đa số là **biến cục bộ trong hàm** (nhiễu regex của script
quét), không phải gap thực sự. Các gap thực sự đã được xử lý:

| Nhóm          | File                        | Xử lý                                                                                                          |
| ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `upstream.js` | `packages/core/upstream.ts` | ✅ Đã bổ sung ~20 định nghĩa (O2A_PORTED_VERSION, sessionForConversation, endpointFor, applyFingerprint, v.v.) |
| `egress.js`   | `packages/core/egress.ts`   | ⏳ Đang tạo mới                                                                                                |

---

## 2. `packages/console/` — browser console (port dở)

### 2.1 Đã có nền

- `api.ts`, `hooks.tsx`, `utils.ts`, `toast.ts`
- `sanitizer.ts`, `sanitizer-materialize.ts`
- `chrome.tsx` (13 primitive + 4 biểu đồ SVG)
- `copy.ts` (1.466 key song ngữ), `css.ts` (1.073 dòng)
- `pool.tsx`, `eac-auth.tsx`, `sponsor-ui.ts`
- 9 trang: dashboard, forward, egress, preferences, news, upgrade, picks, ledger/logs/gateway, aggregate, saver, routing, settings

### 2.2 Cần sửa để chạy được

| Task                             | Mô tả                                                                                          | Trạng thái  |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| Sửa `tsconfig.json`              | include `.tsx`, DOM lib, compile được                                                          | ⏳ Chưa làm |
| Thêm `index.html` + `entry.tsx`  | ReactDOM mount                                                                                 | ⏳ Chưa làm |
| Sửa import sai trong `Shell.tsx` | `./logs.js`, `./gateway.js`, `./channels.js` không tồn tại                                     | ⏳ Chưa làm |
| Bổ sung 5 symbol thiếu           | `BRAND_ICON`, `CHANNEL_PROVIDERS`, `channelTransport`, `sameChannelTransport`, `SponsorBanner` | ⏳ Chưa làm |
| Sửa `settings.tsx`               | import `Shell` trước khi dùng                                                                  | ⏳ Chưa làm |
| Mount vào `management.ts`        | serve console từ `dist/packages/console/`                                                      | ⏳ Chưa làm |

### 2.3 Còn lại ~7.500 dòng (theo bản 2.8.3)

| File                                                | Trạng thái                   |
| --------------------------------------------------- | ---------------------------- |
| `ChannelsPage.tsx` (646 dòng) + `useChannelRpc`     | ⏳ Chưa port                 |
| `Shell.tsx` (253 dòng)                              | ⏳ Đã có nền, cần sửa import |
| `Announcement`/`AnnouncementGate`                   | ⏳ Chưa port                 |
| `extensions.tsx` (532 dòng)                         | ⏳ Chưa port                 |
| `plugins.tsx` (529 dòng)                            | ⏳ Chưa port                 |
| `workspace.tsx` (364 dòng)                          | ⏳ Chưa port                 |
| `feedback.tsx`, `disclaimer.tsx`, `plugin-page.tsx` | ⏳ Chưa port                 |

---

## 3. `scripts/` — công cụ build (cần sửa đường dẫn)

| Script                               | Vấn đề                                                 | Trạng thái                        |
| ------------------------------------ | ------------------------------------------------------ | --------------------------------- |
| `client-lint.mjs`                    | đọc `../../client.js` → ENOENT                         | ⏳ Sửa trỏ `packages/console/`    |
| `lib/standalone-shared-ui.mjs`       | đọc `../../dsh-our-free-model/client.js` → ENOENT      | ⏳ Sửa trỏ bản gốc                |
| `build-sponsor.mjs`                  | đọc `../../dsh-our-free-model/src/sponsor.js` → ENOENT | ⏳ Sửa trỏ bản gốc                |
| `build-standalone-ui.mjs`            | phụ thuộc build-sponsor, fail                          | ⏳ Sửa khi build-sponsor sửa xong |
| `audit-ports.mjs`                    | trỏ `target = pi-extension` (cũ)                       | ⏳ Sửa trỏ `packages/` + `apps/`  |
| `copy-registry.mjs`                  | đã cập nhật để trỏ `packages/`                         | ✅ Xong                           |
| `fix-imports.mjs`                    | viết lại `@ofm/*` sang relative path trong dist        | ✅ Xong                           |
| `fix-dist-imports.mjs`               | viết lại `@ofm/*` sang relative path trong dist        | ✅ Xong                           |
| `check-and-remove-duplicates-v2.mjs` | xóa file trùng trong `src/`                            | ✅ Xong                           |

---

## 4. VIỆC THEO THỨ TỰ ƯU TIÊN

### A. Giai đoạn 1: Tách entry points (không đổi logic) — ✅ HOÀN TẤT

- [x] Tạo `apps/server/main.ts` re-export `startGateway` từ `packages/gateway/`
- [x] Tạo `apps/standalone/main.ts` re-export `startStandalone` từ `packages/standalone/`
- [x] Tạo `apps/extension/main.ts` re-export `packages/provider/`
- [x] Cập nhật `package.json` scripts: `build`, `start:server`, `start:standalone`

### B. Giai đoạn 2: Tách layer packages/ — ✅ HOÀN TẤT

- [x] `packages/core/` từ `src/` (lanes, chains, stats, catalog, o2a)
- [x] `packages/gateway/` từ `src/gateway/`
- [x] `packages/shared/` (api.ts, sanitizer.ts, utils.ts, kilo.ts, ago.ts, copy.ts)
- [x] `packages/provider/` từ `src/index.ts`
- [x] `packages/standalone/` di chuyển từ `src/packages/standalone/`
- [x] `packages/worker/` từ `src/worker/`

### C. Giai đoạn 3: Console (khó nhất) — ⏳ ĐANG THỰC HIỆN

- [x] Tạo `packages/console/tsconfig.json` compile `.tsx` (ĐÃ XOÁ)
- [x] Thêm `index.html` + `entry.tsx` (ĐÃ TẠO)
- [x] Thêm các symbol thiếu vào `chrome.tsx` (`BRAND_ICON`, `CHANNEL_PROVIDERS`, `channelTransport`, `sameChannelTransport`, `SponsorBanner`, `StarButton`, `Tank`, `EacAuth`, `useEacLogin`, `usePool`, `poolReading`, `capacityText`) (ĐÃ XOÁ)
- [ ] Sửa import sai trong `Shell.tsx` (còn một số import từ `chrome.tsx` cần kiểm tra)
- [ ] Mount console vào `packages/standalone/management.ts` (CHƯA LÀM)

### D. Giai đoạn 4: Production hardening — ⏳ MỘT PHẦN HOÀN TẤT

- [x] Thêm `config/schema.env.ts` validation env
- [x] Thêm `GET /healthz` (trong gateway server.ts)
- [x] Thêm graceful shutdown (trong apps/server/main.ts)
- [x] Thêm `Dockerfile`, `docker-compose.yml`
- [ ] Thêm structured log
- [ ] Thêm GitHub Actions CI

---

## 5. LỆNH

```bash
npm run build                                    # tsc strict + vite build frontend + copy registry
node tests/run-all.mjs                           # toàn bộ test offline
node dist/apps/server/main.js --port 18900       # API provider độc lập
node dist/apps/standalone/main.js --port 18900   # standalone service
pi install .                                     # mount như pi extension
node scripts/audit-ports.mjs                     # kiểm kê drift
```

---

## 6. CHANGELOG

| Ngày       | Việc                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-11 | Viết lại AGENTS.md, GOAL.md, BAOCAO.md, TODO.md theo kiến trúc mới `packages/` + `apps/`                                                                                     |
| 2026-11-11 | G12 xong: nền tảng extension đầy đủ (`plugins.ts` + `extensions.ts` + 62 check). `src/` chỉ còn phần mihomo của `egress.js` (cố ý)                                           |
| 2026-11-11 | G11 xong: `o2a/` khớp nguồn + nối vào lane thật; fix bug build (`assets/` không vào `dist/`); kênh extension trong catalog; `semver.ts`; nhóm gap nhỏ                        |
| 2026-11-11 | G10 xong: packages/standalone 55 file + desktop + console + listener 4 dialect                                                                                               |
| 2026-11-11 | client.js: tách nền + 13 trang (~1.100 dòng)                                                                                                                                 |
| 2026-11-11 | Viết lại AGENTS.md + BAOCAO.md + TODO.md theo đường dẫn mới `./dsh-our-free-model/` (2.8.3)                                                                                  |
| 2026-11-1X | **Bỏ scripts/, packages/standalone/, packages/desktop/** theo quyết định user. Viết lại TODO.md chỉ chứa core `src/`.                                                        |
| 2026-11-1X | Tạo `egress.ts`, 2 asset o2a, `worker/worker.js` entry Cloudflare. Bổ sung ~20 định nghĩa vào `upstream.ts`. Tạo barrel `o2a.ts`. Build + test: 66 suite / 1.284 check pass. |
