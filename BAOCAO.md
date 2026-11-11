# BÁO CÁO TOÀN DIỆN — `dsh-our-free-model/` gốc → `pi-extension/`

> **Code gốc (tham chiếu duy nhất): `./dsh-our-free-model/` — bản 2.8.3.**
> Bản port: `./pi-extension/`. Bản gốc cũ ở root không còn và không dùng để đối
> chiếu nữa.
>
> Lần kiểm kê: **2026-11-11 (lần 4)**. Sinh bằng script, không đếm tay.

---

## 1. TỔNG QUAN — số thật

| Nhóm gốc | File | Dòng | Đã port | Còn lại |
|---|---|---|---|---|
| `src/` | 56 | 27.000 | ~51 file | **~5.000 dòng mới của 2.8.3** |
| `vendor/channel-pack/` | 158 | 133.051 | 158/158 | — |
| `packages/standalone/` | 55 | 15.936 | 55/55 | `web/` cần tái sinh |
| `packages/desktop/` | 12 | 1.342 | 12/12 | Rust giữ nguyên |
| `worker/` | 8 | 2.170 | 7/8 | `worker.js` entry CF |
| `scripts/` | 168 | 43.902 | 18 | **150 file / ~42.000 dòng** |
| `client.js` | 1 | 8.599 | ~1.100 | **~7.500 dòng** |
| `adapter/`, `index.js`, data | ~12 | 2.700 | thiết kế lại có ý thức | — |
| **TỔNG** | **~370** | **~235.000** | **~240** | **~130 file / ~110.000 dòng** |

Build/test tại thời điểm kiểm kê: `tsc` strict **0 lỗi**;
**63 suite / 1.206 check / 0 fail**.

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

### 2.2 Chưa port — **toàn bộ là code mới của 2.8.3**

| File gốc | Dòng | Vai trò |
|---|---|---|
| `src/extensions.js` | 1.888 | hệ cơ sở extension của host |
| `src/plugins.js` | 1.240 | quản lý plugin của host |
| `src/o2a.js` + `src/o2a/` (10 file) | 993 + ~800 | đường "one-to-all" (mount một API ra nhiều dialect) |
| `src/core.js` | 838 | lõi thứ hai của host |
| `src/semver.js` | 40 | so sánh phiên bản |
| `src/engine-parts/` | — |分片 engine (dữ liệu, không phải code tay) |

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

**Đã tách** (`pi-extension/client/`, ~1.100 dòng): sanitizer, sponsor UI,
copy (1.466 key song ngữ), css (1.073 dòng), api, hooks, chrome (13 primitive +
4 biểu đồ SVG), toast, pool, eac-auth, + 9 trang (dashboard, forward, egress,
preferences, news, upgrade, picks, ledger/logs/gateway, aggregate, saver,
routing, settings).

**Còn lại ~7.500 dòng** (số dòng theo bản 2.8.3, cần đọc lại):
`useChannelRpc` + `ChannelsPage`, `Shell`, `Announcement`/`AnnouncementGate`,
facade `index.ts`, wiring console vào `frontend/` của standalone.

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
| File mới chưa port | `src/{extensions,plugins,o2a,core,semver}.js` + `src/o2a/` |
| File đã port nhưng nội dung 2.8.3 đổi | 44 (trong `src/`, `worker/`, `packages/`) |

## 7. Cảnh báo

Không được dùng bản gốc cũ (2.7.4) để đối chiếu nữa — nó sẽ bị xóa. Mọi port mới
phải đọc `./dsh-our-free-model/`. Phần đã port + test xong của 2.7.4 vẫn giữ
nguyên giá trị (các luật pin ở `AGENTS.md` §7 vẫn đúng); phần chưa port coi như
**chưa có**, kể cả khi bản cũ từng có.
