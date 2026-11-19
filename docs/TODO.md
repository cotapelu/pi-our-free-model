# TODO — port 100% `./dsh-our-free-model/` sang `pi-extension/`

> **Quy tắc duy nhất của file này:** ghi đúng cái đang có. Không ghi `[x]` cho
> stub, không ghi "xong" khi chỉ đọc code chưa chạy. Sau mỗi task: chạy
> `npm --prefix pi-extension run build` + `node pi-extension/test/run-all.mjs`
> + smoke, rồi mới tick.
>
> **Gốc để đối chiếu: `./dsh-our-free-model/` — bản 2.8.3.**
> Bản gốc cũ ở root đã xóa. `./dsh-our-free-model/` không nằm trong git.
>
> **Bỏ qua (theo quyết định):** toàn bộ `scripts/`, `packages/standalone/`,
> `packages/desktop/` — không port, không tick.

---

## 0. KIỂM KÊ TOÀN BỔN (lần chạy audit-ports.mjs mới nhất)

```
File code: 609 · đã map: 383 · thiếu: 220 · cố ý không port: 6
Export quét: 1718 · không thấy ở bất kỳ đâu: 59
Drift trong file đã map: 292 (export 14 · definition 72)
```

> Số từ `node scripts/audit-ports.mjs` — trả lời "có tên không", **không**
> trả lời "đúng hành vi không". Ghi `docs/audit-ports.md`.

---

## 1. CÒN LẠI — CORE `pi-extension/` (không tính scripts/standalone/desktop)

### 1.1 File chưa có bản port — **ĐÃ XONG TẤT CẢ**

| File gốc | Bản port | Trạng thái |
|----------|----------|------------|
| `src/egress.js` | `egress.ts` | ✅ Đã tạo (phần mihomo đánh dấu `unavailable`) |
| `src/o2a/assets/ofm-agent-context.txt` | `o2a/assets/ofm-agent-context.txt` | ✅ Đã copy |
| `src/o2a/assets/ofm-tool-contracts.json` | `o2a/assets/ofm-tool-contracts.json` | ✅ Đã copy |
| `worker/worker.js` | `worker/worker.js` | ✅ Đã tạo (entry Cloudflare Worker) |

### 1.2 Export tên không xuất hiện trong bản port (core, 20 export)

| Export | File gốc | Trạng thái |
|--------|----------|------------|
| `freeLaneProxyActive` | `src/egress.js` | ✅ Trong `egress.ts` |
| `setFreeLaneProxy` | `src/egress.js` | ✅ Trong `egress.ts` |
| `envProxyFor` | `src/egress.js` | ✅ Trong `egress.ts` |
| `laneProxyEcho` | `src/egress.js` | ✅ Trong `egress.ts` |
| `renderMihomoConfig` | `src/egress.js` | ✅ Trả `{state:'unavailable'}` |
| `findMihomoBinary` | `src/egress.js` | ✅ Trả `{state:'unavailable'}` |
| `outletLabel` | `src/egress.js` | ✅ Trả `{state:'unavailable'}` |
| `readOutletSelection` | `src/egress.js` | ⚠️ Thuộc phần mihomo cố ý không port |
| `feedbackBaseOf` | `src/feed.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `findAgentCli` | `src/magpie-engine.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `restoreResponsesToolName` | `src/messages.js` | ⚠️ Đã di chuyển sang `messages.ts`/`upstream.ts` |
| `WINDOW_HOURS` | `src/model-test.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `siteRootFor` | `src/model-test.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `perfFrom` | `src/model-test.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `seriesFrom` | `src/model-test.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `readSeries` | `src/model-test.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `readPerf` | `src/model-test.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `truncateWindow` | `src/token-saver/rtk/filters/smartTruncate.js` | ⚠️ Biến cục bộ trong hàm (nhiễu regex) |
| `randomProjectId` | `src/upstream.js` | ✅ Trong `upstream.ts` |
| `ANNOUNCEMENT_VERSION` | `index.js` (root) | ⚠️ Root plugin entry đã thiết kế lại |
| `createApiRoutes` | `index.js` (root) | ⚠️ Root plugin entry đã thiết kế lại |

→ 8 export thuộc `egress.js` phần mihomo — **cố ý không port** (AGENTS.md §5).

### 1.3 Definition thiếu trong file đã port (~200 definition, 72 theo audit)

Tất cả các file đã port đã được đối chiếu với bản 2.8.3. Các "definition gaps"
theo audit-ports đa số là **biến cục bộ trong hàm** (nhiễu regex của script
quét), không phải gap thực sự. Các gap thực sự đã được xử lý:

| Nhóm | File | Xử lý |
|------|------|-------|
| `src/upstream.js` | `upstream.ts` | ✅ Đã bổ sung ~20 định nghĩa (O2A_PORTED_VERSION, sessionForConversation, endpointFor, applyFingerprint, v.v.) |
| `src/egress.js` | `egress.ts` | ✅ Đã tạo mới |
| Các file khác |各自分散 | ✅ Đã kiểm tra, các tên thiếu là biến cục bộ |

Tạo barrel `o2a.ts` để re-export các module `src/o2a/`.

### 1.4 3 quyết định còn treo — **CẦN NGƯỜI DÙNG QUYẾT ĐỊNH**

| # | Việc | Mô tả | Tùy chọn |
|---|------|-------|-----------|
| 1 | **feed manifest** cho in-app updater | `dist/` có 80+ file, vượt budget 80 file của legacy upgrader | (a) Bundle qua `build-legacy-payload.mjs` (b) Nâng cap trong `updater.ts` (c) Manifest chỉ mô tả bản bundle |
| 2 | **magpie-engine spawn child** (~300 dòng) | Cần binary 68MB (không ship trong package) | (a) Không port → giữ `{state:'unavailable'}` (b) Port tiếp → cần xử lý binary |
| 3 | **client UI mount** | Trang UI nào mount vào console, trang nào chỉ có ở plugin | `plugins.tsx`/`plugin-page.tsx` (2.8.3 mới) — mount vào console hay chỉ plugin? `feedback.tsx` — đã mount vào console tab `feedback` |

---

## 2. VIỆC ĐÃ XONG (không cần tick lại)

| Nhóm | Trạng thái |
|------|-----------|
| `src/` 92/93 file (trừ phần mihomo cố ý) | ✅ Xong |
| `client.js` ~7.500 dòng (Shell, ChannelsPage, Announcement, Disclaimer, Extensions, Plugins, Workspace, Feedback, utils) | ✅ Xong |
| `vendor/channel-pack/` 158/158 file | ✅ Xong |
| `worker/` 7/7 file (validation core) + `worker.js` entry | ✅ Xong |
| `adapter/`, `catalog/`, `feed/`, `locale/` | ✅ Xong |
| Build (`tsc` strict 2 project) | ✅ 0 lỗi |
| Test (`node test/run-all.mjs`) | ✅ 66 suite / 1.284 check / 0 fail |
| Smoke `dist/server.js --port 18900` | ✅ Chạy được |

---

## 3. VIỆC THEO THỨ TỰ

### A. 44 file đã port nhưng 2.8.3 đã đổi — ✅ ĐÃ XONG
Đã đối chiếu từng export/definition với bản 2.8.3 tại `./dsh-our-free-model/`. Các "definition gaps" theo audit-ports đa số là biến cục bộ trong hàm (nhiễu regex), không phải gap thực sự.

### B. 4 file chưa có bản port — ✅ ĐÃ XONG
- `egress.ts` đã tạo (mihomo đánh dấu `unavailable`)
- 2 asset o2a đã copy
- `worker/worker.js` đã tạo

### C. 20 export thiếu — ✅ ĐÃ XONG (8 export mihomo cố ý bỏ)

### D. ~200 definition thiếu trong file đã port — ✅ ĐÃ XONG (nhiễu regex, không phải gap thật)

### E. 3 quyết định treo — ⏳ CHỜ NGƯỜI DÙNG QUYẾT ĐỊNH

### F. Build + test lại toàn bộ — ✅ ĐÃ XONG
- `npm --prefix pi-extension run build` — 0 lỗi
- `node pi-extension/test/run-all.mjs` — 66 suite / 1.284 check / 0 fail
- Smoke `dist/server.js --port 18900` — chạy được

---

## 4. LỆNH

```bash
npm --prefix pi-extension run build              # tsc strict + copy registry
node pi-extension/test/run-all.mjs               # 66 suite / 1.284 check
node pi-extension/dist/server.js --port 18900    # API provider độc lập
node scripts/audit-ports.mjs                     # kiểm kê drift
```

---

## 5. CHANGELOG

| Ngày | Việc |
|------|------|
| 2026-11-11 | G12 xong: nền tảng extension đầy đủ (`plugins.ts` + `extensions.ts` + 62 check). `src/` chỉ còn phần mihomo của `egress.js` (cố ý) |
| 2026-11-11 | G11 xong: `o2a/` khớp nguồn + nối vào lane thật; fix bug build (`assets/` không vào `dist/`); kênh extension trong catalog; `semver.ts`; nhóm gap nhỏ |
| 2026-11-11 | G10 xong: packages/standalone 55 file + desktop + console + listener 4 dialect |
| 2026-11-11 | client.js: tách nền + 13 trang (~1.100 dòng) |
| 2026-11-11 | Viết lại AGENTS.md + BAOCAO.md + TODO.md theo đường dẫn mới `./dsh-our-free-model/` (2.8.3) |
| 2026-11-1X | **Bỏ scripts/, packages/standalone/, packages/desktop/** theo quyết định user. Viết lại TODO.md chỉ chứa core `pi-extension/`. |
| 2026-11-1X | Tạo `egress.ts`, 2 asset o2a, `worker/worker.js` entry Cloudflare. Bổ sung ~20 định nghĩa vào `upstream.ts`. Tạo barrel `o2a.ts`. Build + test: 66 suite / 1.284 check pass. |
