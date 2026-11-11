# BÁO CÁO TOÀN DIỆN — `dsh-our-free-model/` gốc → `pi-extension/`

> **Code gốc (tham chiếu duy nhất): `./dsh-our-free-model/` — bản 2.8.3.**
> Bản port: `./pi-extension/`. Bản gốc cũ ở root không còn và không dùng để đối
> chiếu nữa.
>
> Lần kiểm kê: **2026-11-11 (lần 6)**. Sinh bằng `scripts/audit-ports.mjs`, không đếm tay.

---

## 1. TỔNG QUAN — số thật

| Nhóm gốc | File | Dòng | Đã port | Còn lại |
|---|---|---|---|---|
| `src/` | 93 | 30.067 | **92/93 file** | phần mihomo của `egress.js` (~300 dòng, **cố ý** — cần binary lậu) |
| `vendor/channel-pack/` | 158 | 133.051 | 158/158 | — |
| `packages/standalone/` | 55 | 15.936 | 55/55 | `web/` cần tái sinh |
| `packages/desktop/` | 12 | 1.342 | 12/12 | Rust giữ nguyên |
| `worker/` | 8 | 2.170 | 7/8 | `worker.js` entry CF |
| `scripts/` | 191 | 47.359 | 21 | **170 file / ~41.000 dòng** |
| `client.js` | 1 | 8.599 | ~1.100 | **~7.500 dòng** |
| `adapter/`, `index.js`, data | ~12 | 2.700 | thiết kế lại có ý thức | — |
| `src/o2a/` | 10 | 1.414 | **9/9 module** | `src/o2a.js` là bundle esbuild sinh từ 9 module này — phần bundle thuộc về script (xem §2.3) |
| **TỔNG** | **~580** | **~301.000** | **~378** | **~197 file / ~104.000 dòng** |

Build/test tại thời điểm kiểm kê: `tsc` strict **0 lỗi** (hai project);
**66 suite / 1.284 check / 0 fail**. Smoke thật: 4 dialect + `/v1/models` +
`/v1/events` trên `dist/server.js`; console + `/api/management/summary` +
`assets/app.js` trên `standalone/cli.js`.

## 2. `src/` — chi tiết theo bản 2.8.3

### 2.1 Đã port và test xong (51 file)

Các file này khớp **hành vi** với bản 2.8.3 sau khi đã đối chiếu lại: upstream,
catalog, stream, messages, anthropic, gemini, http, egress (phần client),
store, forward (quả listener 4 dialect), recovery, reload, trust, feed, push,
updater, vault, subscriptions, magpie-policy, aggregate, providers, combos,
effort, token-saver + rtk + filters + prompts + inject, adapter (helper +
FreeModelAdapter), core/{completion,runtime,stats}, model-runtime, upstream,
fingerprint, eac*, kilo, picks, disclaimer, failure, channel, chan-relay,
loopback-fetch, model-test, open-external, engine-payload, image-pricing,
magpie-models/engine, probe, local-optimize, sponsor.

### 2.2 Chưa port — **chỉ còn phần cố ý**

| File gốc | Dòng | Vai trò |
|---|---|---|
| `src/egress.js` phần mihomo/Clash | ~300 | spawn binary lậu — **cố ý không port** (AGENTS.md §5) |

Nền tảng extension (toàn bộ là code mới của 2.8.3) đã xong trong lần soi này:

| File gốc | Dòng | Bản port | Ghi chú |
|---|---|---|---|
| `src/plugins.js` | 1.241 | `pi-extension/plugins.ts` | manifest, scan, descriptor, page bridge, `REGISTRY_FALLBACK` (495 dòng JSON carve nguyên, parse lại đối chiếu: identical) |
| `src/extensions.js` | 1.888 | `pi-extension/extensions.ts` | registry ký, install verify-then-write, sandbox worker, runtime |

**Phát hiện quan trọng của lần soi này:** `src/o2a/` (9 file) đã port và khớp
nguồn, nhưng **không có module nào import nó** — lane thật vẫn chạy shaping của
2.7.4 trong `fingerprint.ts`. Đã nối lại (§2.3).

### 2.3 Đã nối và đã sửa trong lần soi này

| Việc | Bug/lỗi mà nó là |
|---|---|
| `applyFingerprintWire` chạy bộ của 2.8.3 (`isTitleRequest` → `injectOfficialPrompt` → `renameAndCompleteTools` → `ensureChatUsage`/`ensureV2CompletionLimit`) | shaping cũ **không gửi system prompt chính thức** — gate của free tier kiểm tra cả prompt, chỉ bù tool là không đủ; và tool mang từ vựng lạ vẫn đi nguyên spelling lên wire, hình dạng mà free tier trả 403/429 |
| `scripts/copy-registry.mjs` copy `o2a/assets/*` vào `dist/` | **bug im lặng**: `asset-source.ts` đọc bằng `node:fs` URL tính so với file đã biên dịch, nên `dist/` — thứ chạy thật và thứ test import — luôn rơi về prompt rỗng và *không có định nghĩa tool nào*: mọi caller tool bị đổi thành `clint_…` mà không có tool chính thức nào được bù. Không throw nên không ai thấy. Cùng lớp bug AGENTS.md §7 đã pin cho `registry.json` |
| `semver.ts` | `src/semver.js` chưa từng có bản port |
| `catalog-rows.ts`: `EAC_LABELS`/`eacLabel` + cả kênh extension | bản port chỉ giữ một label đặc biệt và làm mất cách hiển thị `-free` → `highspeed`; kênh extension (producer thứ tư, `ext:<plugin>/<model>`) chưa có |
| `stream.ts`: `toolNameFragment` + `#resolveRawName` | gateway cắt `rea` + `d` qua hai delta frame sẽ cho ra cuộc gọi tên `rea` — tool không tồn tại, và `repairToolPairing` giữ lại làm hỏng mọi turn sau |
| `gateway/store.ts` re-export `restrictPermissions` từ `open-external.ts` | bản copy cũ `/grant:r` theo **tên account trần** — đúng lỗi dsh #738: `icacls` phân giải cả account database lẫn computer account, computer account thắng khi chỉ khác hoa/thường, ACE đặt SID không token nào mang, `/inheritance:r` đã xoá ACE kế thừa ⇒ file không đọc/ghi/xoá được |
| `updater.ts`: `profileDirOf` | bản cũ đếm hai cấp (`dirname(dirname(…))`), sai với install scoped `@scope/name`: trỏ về thư mục `@scope`, đọc chẳng thấy lockfile, nên bản copy do pnpm sở hữu bị coi là bare |
| `feed.ts`: `holdSeconds` | announcement xin khoá nút đóng 5 giây bị đóng được ngay |
| `auto-checkin.ts`: `AUTO_CHECKIN_TICK_MS` + `AUTO_CHECKIN_RETRY_MS` + `lastAttemptAt` | chỉ có chạy-bù lúc `start()`: dịch vụ chạy qua nửa đêm không bao giờ check-in lại — chính lỗi 2026-10-27 upstream ghi trong comment |
| `aggregate.ts`: tách `postCompatibleStreamed`; `loopback-fetch.ts`, `open-external.ts` port đủ | hơn 1.000 dòng bị thiếu/stub |

## 3. Kiểm kê sâu — soi từng definition

78 cặp file đã soi tới mức `function`/`class`/`method`. Kết qu sau khi loại nhiễu:
**2 gap thật đã lấp** (egress ~600 dòng tunnel/relay; magpie-engine ~700 dòng
guard/key/UI-rewrite), **1 gap thật mới tìm ra khi viết test**
(`migrateStats` làm mất nửa reset sample; `STATS_INITIAL` thiếu `logical`).

Các khoảng "thiếu" sau khi điều tra là **nhiễu regex**, không phải gap: 5 `*Answer`
(port dạng method trong `ANSWERERS`); `harnessImage`/`toolResultBlocks`/
`assistantBlocks` (xử lý inline trong `fromAnthropicRequest`); 15 tên filter
(flatten ở `token-saver/filters/`); `lastDelay`/`controllerJson` (thuộc mihomo,
cố ý không port).

## 4. `client.js` — console (đang port dở)

**Đã tách** (`pi-extension/client/`, ~1.100 dòng, 13 trang `.tsx`) — và lần soi
này build sạch được nó: `client/` có project riêng (`tsconfig.client.json`, lib
DOM) vì nó là nửa trình duyệt, nên một lần gõ nhầm `document` trong gateway vẫn
là lỗi biên dịch. Vì `feed.ts` import `./client/sanitizer.js` (parser announcement
chạy trên node), `sanitizer.ts` giữ nguyên phần node-safe và hai hàm materialize
(`htmlToDom`, `htmlToReact`) chuyển sang `client/sanitizer-materialize.ts`.

Ba bug thật trong nhóm này: `api.ts` gọi `\`\${API}\${path}\`` với biến không tồn
tại (mọi `api()` của console sẽ throw ReferenceError); `toast.ts` import
`htmlToDom` không tồn tại cộng thêm 3 dòng lệnh ở cấp trên cùng (throw lúc import);
`showUrgentModal` mất cả bộ đếm ngược `holdMs`/`holdHint` nên announcement bắt đọc
bị bấm đóng được ngay. `client/*.tsx` vẫn chưa typecheck (thiếu `@types/react` ở
gốc — deps nằm ở `packages/standalone/`, chưa cài).

**Đã tách** (`pi-extension/client/`, ~1.100 dòng): sanitizer, sponsor UI,
copy (1.466 key song ngữ), css (1.073 dòng), api, hooks, chrome (13 primitive +
4 biểu đồ SVG), toast, pool, eac-auth, + 9 trang (dashboard, forward, egress,
preferences, news, upgrade, picks, ledger/logs/gateway, aggregate, saver,
routing, settings).

**Còn lại ~7.500 dòng** (số dòng theo bản 2.8.3, cần đọc lại):
`useChannelRpc` + `ChannelsPage`, `Shell`, `Announcement`/`AnnouncementGate`,
facade `index.ts`, wiring console vào `frontend/` của standalone. Đây là khối
**lớn nhất còn lại ngoài `scripts/`** và chưa ai đụng tới.

## 5. Hai bug im lặm tìm ra khi viết test (đã fix)

1. **`node-host.test.ts` flaky** — hai `Date.now()` độc lập (header timestamp và
   signature) → 401 đúng logic sai ý định test. Lần thứ tư cùng lớp bug này.
2. **`egress-relay.test.ts` chạy song song** — `check()` bắn microtask đồng thời,
   relay giữ module-global nên hai check ghi đè nhau. Sửa: `running.then(...)`
   tuần tự. Lần thứ năm.

## 6. Số liệu thật của bản 2.8.3 (để đối chiếu)

| Chỉ số | Giá trị |
|---|---|
| File code (trừ node_modules/dist/docs) | **567** |
| Dòng code | **301.362** |
| File mới chưa port | — (`src/` chỉ còn phần mihomo của `egress.js`, cố ý) |
| File đã port nhưng nội dung 2.8.3 đổi | 44 (trong `src/`, `worker/`, `packages/`) |

## 7. Cảnh báo

Không được dùng bản gốc cũ (2.7.4) để đối chiếu nữa — nó sẽ bị xóa. Mọi port mới
phải đọc `./dsh-our-free-model/`. Phần đã port + test xong của 2.7.4 vẫn giữ
nguyên giá trị (các luật pin ở `AGENTS.md` §7 vẫn đúng); phần chưa port coi như
**chưa có**, kể cả khi bản cũ từng có.
