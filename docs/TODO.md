# TODO — port 100% `./dsh-our-free-model/` sang `pi-extension/`

> **Quy tắc duy nhất của file này:** ghi đúng cái đang có. Không ghi `[x]` cho
> stub, không ghi "xong" khi chỉ đọc code chưa chạy. Sau mỗi task: chạy
> `npm --prefix pi-extension run build` + `node pi-extension/test/run-all.mjs`
> + smoke, rồi mới tick.
>
> **Gốc để đối chiếu: `./dsh-our-free-model/` — bản 2.8.3.**
> Bản gốc cũ ở root đã xóa. `./dsh-our-free-model/` không nằm trong git.

## 0. KIỂM KÊ TOÀN BỔN — sinh tự động từ bản 2.8.3

**555 file code / 301.865 dòng** trong `./dsh-our-free-model/`
(đã loại `node_modules`, `dist`, `docs`). 1.847 export symbol đã quét xem tên có
xuất hiện trong `pi-extension/` không.

> Số dưới đây lấy từ `node scripts/audit-ports.mjs` (lần chạy 2026-11-11, sau khi
> fix build). Script đó là **lượt 1** của AGENTS.md §8 và ghi
> `docs/audit-ports.md`; nó trả lời "có tên không", **không** trả lời "đúng hành vi
> không". Kết quả: **581 file code / 376 đã map / 199 thiếu / 63 tên export không
> thấy ở đâu**, và **233 file đã map nhưng có drift** cần đọc tay.

> Hai lớp nhiễu của audit đã được loại trong chính script: file nguồn là *bundle
> esbuild* (`src/o2a.js`, `src/core.js`, `src/http.js`, `src/forward.js`,
> `src/token-saver.js`) soi trên cả cụm module tương ứng, và các file đã được bản
> port dồn vào cụm thư mục khác (`src/anthropic.js` → `gateway/anthropic.ts`,
> `src/token-saver/rtk/*` → `token-saver/*`) đã có bảng alias tường minh.
> File `src/` mà audit còn báo thiếu chỉ còn **3**: `extensions.js`,
> `plugins.js`, và phần mihomo của `egress.js` (cố ý không port).

| Nhóm | File | Dòng | Đã port (trên đĩa) | Còn lại |
|---|---|---|---|---|
| `src/` | 93 | 30.067 | **90/93** | **3 file / 3.100 dòng**: `extensions.js`, `plugins.js`, + phần mihomo của `egress.js` (cố ý) |
| `vendor/channel-pack/` | 158 | 136.410 | **158/158** | — |
| `packages/standalone/` | 66 | 15.936 | **55/66** | **11 file** (frontend mới + web bundle mới) |
| `packages/desktop/` | 13 | 1.354 | **12/13** | `ui/titlebar.js` (copy verbatim — Rust `include_str!`) |
| `worker/` | 7 | 1.821 | **7/7** | — |
| `scripts/` | 191 | 47.359 | **14/191** | **177 file / ~42.000 dòng** |
| `adapter/`, `catalog/`, `feed/`, `locale/` | 9 | — | **9/9** | — |
| root (`client.js`, `index.js`) | 2 | 11.358 | 1 (thiết kế lại) | `client.js` 8.599 dòng |
| **TỔNG** | **~539** | **~245.000** | **~331** | **~208 file / ~114.000 dòng** |

Build/test hiện tại: `tsc` strict **0 lỗi** (hai project: node + client DOM);
**64 suite / 1.222 check / 0 fail**;
smoke thật (2026-11-11): `dist/server.js --port 18900` — `/health`, `/v1/models`,
`/v1/chat/completions` (stream SSE), `/v1/messages`, `/v1/responses`,
`/v1beta/...:generateContent` (Gemini), `/v1/events` (SSE hello) đều trả lời;
`dist/packages/standalone/cli.js --port 18901` — console HTML, `assets/app.js`
433 KB, `/api/management/summary` sau khi mở session, catalog 23 dòng (12
anonymous + 11 kilo).

### 0.1 `src/` — file chưa port, sau lượt soi 2026-11-11

| File | Dòng | Vai trò | Trạng thái |
|---|---|---|---|
| `src/extensions.js` | 1.889 | nền tảng extension của host (registry ký, manifest, runtime, `applyRequestHooks`) | **chưa port** — chặn `magpie-models.ts`, `packages/standalone/service.ts` (`extensionHookRuntime`), `management.ts` (plugin asset), `frontend/app.tsx` (trang plugin) |
| `src/plugins.js` | 1.241 | quản lý plugin của host (kinds, capabilities, quét page asset, `PAGE_ICONS`) | **chưa port** — chặn `shell.tsx` (`pageIcon`/`pageIdsFor`/`pageLabel`), `management.ts` (`servePluginAsset`), `frontend/plugins.tsx` |
| `src/egress.js` phần mihomo/Clash | ~300 | spawn binary lậu | **cố ý không port** (AGENTS.md §5) |
| `src/o2a.js` + `src/o2a/` | 994 + ~800 | đường one-to-all | **đã port**: 9 module khớp nguồn (chỉ khác annotation TS), asset byte-identical. `src/o2a.js` là *bundle* do `build-legacy-payload.mjs` sinh — bản port giữ dạng module, nên phần bundle còn thiếu là của **script** chứ không phải của lane |
| `src/semver.js` | 41 | so sánh phiên bản | **đã port** (`pi-extension/semver.ts`) |
| `src/engine-payload.js` | 100 | khôi phục engine từ shard | **đã port**, đối chiếu lại: không drift |

### 0.2 `scripts/` — 177 file chưa port

Đã port 14: `copy-registry.mjs`, `reverify-upstream.ts`,
`build-standalone-channels.mjs`, `lib/standalone-shared-ui.mjs`,
`prepare-desktop.mjs`, `build-channel-pack.mjs`, `lib/channel-pack-gate.mjs`,
`build-manifest.mjs`, `lib/published-bytes.mjs`, `build-legacy-payload.mjs`,
`pack-standalone.mjs`, `build-magpie-engine.mjs`, `lib/engine-binary.mjs`,
`install-local-magpie.mjs`, `mint-eac-seal.mjs`, `prepare-release.mjs`,
`refresh-revision.mjs`, `build-sponsor.mjs`, `build-standalone-ui.mjs`,
`client-lint.mjs`, `standalone-third-party.txt`.

Còn lại: **~130 test script** (chạy trên fake-kernel hoặc bắn UI) + **17 file
`probes/`** + `ui-preview.mjs`, `live-audit.mjs`, `live-feature-verify.mjs`,
`host-selftest.mjs`, `offline-test.mjs`, `_render-probe.mjs`.

### 0.3 Bức tranh phủ test (129 script test của 2.8.3)

- **53/129** script đã có suite TS phủ cùng module ported (bản đồ ở commit `3d9e30a`)
- **8 script module** đã port thành suite: open-external, fingerprint,
  session-map, speed-stat… (commit `beb3a51`)
- **~58 script nhóm UI** — bị chặn bởi `client.js` (mục 1)
- **~11 script fake-kernel cho plugin** — bị chặn bởi host composition
  (`forward-test`, `egress-test`, `recovery-test`, `subscription-*`,
  `aggregate-*`…)
- `probes/` 17 file + 5 script live — tốn quota, không chạy CI

---

## 1. DANH SÁCH ĐẦY ĐỦ TỪNG FILE

Cột "Port" = file đối ứng trong `pi-extension/`, **đã kiểm tra tồn tại trên đĩa**.
Cột "Thiếu" = tên export không thấy ở bất kỳ đâu trong pi-extension.

### 1.1 `src/` — 93 file / 30.067 dòng

Đã port đủ hành vi (75 file) theo bảng cũ ở git history; **18 file mới/chưa
đối chiếu** liệt kê ở §0.1. Khi port nhóm mới, đọc file ở
`./dsh-our-free-model/src/` — **không** đọc bản cũ đã xóa.

### 1.2 Các file đã port nhưng 2.8.3 đổi nội dung

Cần đọc lại và đối chiếu từng export (danh sách đầy đủ ở `BAOCAO.md` §6): 44 file
trong `src/`, `worker/`, `packages/` — trong đó nặng nhất:
`src/{forward,upstream,catalog,store,anthropic,updater,eac,egress}.js`,
`worker/gateway-node.mjs`, `packages/standalone/{service,management}.mjs`.

### 1.3 `client.js` — 8.599 dòng / 1 file

**Đã tách** (`pi-extension/client/`, ~1.100 dòng):

| File | Nội dung |
|---|---|
| `sanitizer.ts` | `parseSafeHtml`, `safeUrl`, `sanitizeStyle`, `htmlToDom`, `htmlToReact` (+ 26 check) |
| `sponsor-ui.ts` + css + jpg | `createSponsorUI` |
| `copy.ts` | `DICT` zh/en (1.466 key) |
| `css.ts` | `CSS` (1.073 dòng) |
| `api.ts` | `api()`, `kilo`, `ago`, `copy`, `legacy` |
| `hooks.tsx` | `useAsync` |
| `chrome.tsx` | 13 primitive + `buildHeatCells` + 4 biểu đồ SVG + roster |
| `toast.ts` | `toastHost`, `showToast`, `showUrgentModal`, `osNotify` |
| `pool.tsx` | `Tank`, `poolReading`, `capacityText`, `usePool` |
| `eac-auth.tsx` | `StarButton`, `useEacLogin`, `EacAuth` |
| `pages/*.tsx` | dashboard, forward, egress, preferences, news, upgrade, picks, ledger(+logs+gateway), aggregate, saver, routing, settings(+free+eac) |

**Còn lại** (số dòng theo 2.8.3, cần đọc lại từ `./dsh-our-free-model/client.js`):

- [ ] `useChannelRpc` + `ChannelsPage`
- [ ] `Shell` (khung 3 trang + điều hướng)
- [ ] `Announcement` + `AnnouncementGate`
- [ ] `index.ts` (facade: `apply`/`inject` + `__test` seams cho client-lint)
- [ ] wiring console vào `packages/standalone/frontend/`
- [ ] phần HTML mới của 2.8.3 (`plugins.tsx` 585 dòng, `plugin-page.tsx` 146)

### 1.4 `packages/standalone/` — 11 file còn lại

- [ ] `frontend/plugins.tsx` (585) — trang plugin MỚI của 2.8.3
- [ ] `frontend/plugin-page.tsx` (146) — trang plugin lồng nhau
- [ ] `frontend/plugin-page.css`, `frontend/plugins.css`
- [ ] `web/` — bundle mới (8 file, tên hash khác bản cũ): cần chạy
      `build-standalone-ui.mjs` tái sinh, hoặc copy nguyên thư mục
- [ ] `package-lock.json`
- [ ] `packages/desktop/ui/titlebar.js` — copy verbatim (Rust `include_str!`)

### 1.5 `worker/` — xong, còn entry

- [x] `worker/worker.js` → `worker/validation.ts` (core dùng chung)
- [x] `gateway-node.mjs` → `node-host.ts` + 5 module kèm
- [x] `auth-github.mjs`, `verify-deployment.mjs`, `entry.js`,
      `dashboard.html`, `wrangler.toml`
- [ ] `worker/worker.js` đường `export default { fetch }` cho Cloudflare
      (validation core đã có; còn entry + `wrangler.toml` deploy)

---

## 2. GAP THEO SYMBOL — bên trong file ĐÃ port

Quét 1.847 export của 2.8.3: **174 tên không thấy** trong `pi-extension/`. Phân
theo nhóm (đã loại nhiễu — tên nằm ở file lân cận cùng cụm):

| Nhóm | File | Thiếu thật |
|---|---|---|
| `src/` | 19 file | toàn bộ thuộc 5 file mới ở §0.1 + phần mihomo cố ý không port + `FreeModelAdapter`/`sessionForConversation` nằm ở `core/*` |
| `scripts/` | 14 file | các `verify*` trong test script chưa port |
| `vendor/` | 2 file | nằm trong bản copy byte-identical — nhiễu |
| `(root)` | 1 file | `index.js` (thiết kế lại) |

## 3. VIỆC THEO THỨ TỰ (làm từ trên xuống)

### A. `src/` mới của 2.8.3 — ưu tiên 1, còn 2 file
- [x] `src/o2a.js` + `src/o2a/` (9 file) — 2026-11-11: khớp nguồn, và **nối vào
      lane thật** (`applyFingerprintWire`), kèm fix bug assets không vào `dist/`
- [x] `src/semver.js` — 2026-11-11 (`pi-extension/semver.ts`)
- [x] `src/engine-payload.js` — đối chiếu lại, không drift
- [x] `src/catalog.js` phần kênh extension (2.8.3): `EXTENSION_CHANNEL`,
      `REPLACEABLE_LANES`, `EXTENSION_WIRES`, `extensionModelId`,
      `isExtensionEntry`, `extensionEntryOf`, `buildExtensionCatalog`,
      `extensionReplaces` + `EAC_LABELS`/`eacLabel`
- [ ] `src/extensions.js` (1.889) — **chặn**: `magpie-models.ts`
      (`inferenceFetch`/`extensionRuntime`), `standalone/service.ts`
      (`extensionHookRuntime`), `standalone/management.ts` (`servePluginAsset`),
      `frontend/app.tsx` (`pluginPages`)
- [ ] `src/plugins.js` (1.241) — **chặn**: `frontend/components/shell.tsx`
      (`pageIdsFor`/`pageLabel`/`pageIcon`), `management.ts` (`injectPluginBridge`),
      `frontend/plugins.tsx`
- [x] `src/core.js` — soi xong: bản port đã dồn vào `core/runtime.ts` +
      `core/{completion,stats}.ts`; phần thiếu còn lại là `laneRow`,
      `setLaneState`, `laneGate`, `clearLaneBreaker`, `recordPassiveResult`,
      `noteFreeLaneOutcome`, `extensionCatalog`, `replacedLane` — **làm sau khi
      `extensions.ts` có**, vì `extensionCatalog`/`replacedLane` là đầu ra của nó
- [ ] đối chiếu lại 44 file đã port nhưng 2.8.3 đổi: **1/44 xong**
      (`engine-payload.js`). Còn 43; danh sách export thiếu thật ở
      `docs/audit-ports.md` §2, definition thiếu ở §3

### B. `client.js` còn lại (~7.500 dòng)
- [ ] các mục ở §1.3

### C. `packages/standalone/` 11 file
- [ ] các mục ở §1.4

### D. `scripts/` 177 file
- [ ] ~130 test script (theo nhóm: transport, EAC/vault, aggregate, channel-pack,
      standalone, magpie, updater/packaging, probe, tương thích, probes, lib)
- [ ] quyết của user: port thành suite TS trong `test/`, hay giữ dạng script?

### E. `worker/worker.js` entry CF

### F. Quyết định còn treo (chặn việc khác)
1. **`feed/manifest.json` cho in-app updater** — `build-manifest --check` báo
   `dist/` vượt budget 80 file của legacy upgrader. Chọn: (a) bundle qua
   `build-legacy-payload.mjs`, (b) nâng cap trong `updater.ts`, (c) manifest chỉ
   mô tả bản bundle
2. **`magpie-engine` phần spawn child** (~300 dòng) — port tiếp = quyết định
   chạy binary 68MB
3. **`client.js`** — trang UI nào mount vào console, trang nào chỉ có ở plugin

### G. Việc vụn đã biết
- [ ] `stub-upstream` chưa có suite riêng
- [ ] `copy.ts` chưa kiểm song ngữ đủ key
- [ ] `chrome.tsx`/`pages/*` chưa typecheck (cần tsconfig bao gồm `../../client/**`)

---

## 4. LỆNH

```bash
npm --prefix pi-extension run build                    # tsc strict + copy assets
node pi-extension/test/run-all.mjs                     # 64 suite / 1.222 check
node pi-extension/dist/server.js --port 18900          # API provider độc lập
node pi-extension/dist/packages/standalone/cli.js      # service + console
node scripts/audit-ports.mjs                           # kiểm kê (nếu đã viết)
```

## 5. CHANGELOG

| Ngày | Việc | Commit |
|---|---|---|
| 2026-11-11 | **G11 xong**: `o2a/` khớp nguồn + nối vào lane thật; fix bug build (`assets/` không vào `dist/`); kênh extension trong catalog; `semver.ts`; nhóm gap nhỏ (tool-name buffering, `profileDirOf`, `holdSeconds`, tick xuyên ngày, `postCompatibleStreamed`, `restrictPermissions` SID-first); thêm `scripts/audit-ports.mjs` | 5c8945d, 7e1ee9a, 311cba2 |
| 2026-11-11 | **G10 xong**: packages/standalone 55 file + desktop + console + listener 4 dialect + lấp ~20 gap `src/` | adc60d8e |
| 2026-11-11 | egress ~600 dòng + magpie host ~700 dòng + 4 suite + 2 bug thật | a81b543, beb3a51 |
| 2026-11-11 | scripts build/packaging 18 file (chạy thật được) | b945994 |
| 2026-11-11 | client.js: tách nền + 13 trang (~1.100 dòng) | — |
| 2026-11-11 | **Viết lại AGENTS.md + BAOCAO.md + TODO.md** theo đường dẫn mới `./dsh-our-free-model/` (2.8.3), ghi +5.000 dòng mới + 44 file đổi | — |
