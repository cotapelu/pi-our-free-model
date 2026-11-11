# AGENTS.md — port 100% `dsh-our-free-model/` sang `pi-extension/`

> **Thứ tự đọc:** file này → `GOAL.md` → `docs/TODO.md` → `BAOCAO.md`.
> File này là **luật làm việc**. Ba file sau là báo cáo trạng thái.

## 1. Mục tiêu

`pi-extension/` là **API provider LLM độc lập**, không phải plugin của một host
duy nhất. Nó phải:

1. **Chạy như HTTP server** (`node pi-extension/dist/server.js`) — mọi coding
   agent trỏ `base-url` vào là dùng: pi, Claude Code, Codex, Continue, Cline,
   Cursor, `curl`.
2. **Chạy như pi extension** (`pi install ./pi-extension`) — cùng một bộ code,
   hai cách mount.
3. **Là bản port đầy đủ của DSH** — mọi file code trong repo gốc đều có bản port
   tương ứng, **không có ngoại lệ**, kể cả UI, desktop, test script.

Nói cách khác: đích đến là *một API provider + console cho mọi agent và mọi
provider*, không phải *một plugin của một host*.

## 2. Đường dẫn — chỉ còn hai

| Gì | Ở đâu |
|---|---|
| **Code gốc (tham chiếu duy nhất)** | `./dsh-our-free-model/` — bản **2.8.3** vừa clone |
| **Bản port** | `./pi-extension/` |

Không còn bản gốc rải ở root nữa. Mọi đối chiếu, mọi trích dẫn "file gốc" đều
làm ở `./dsh-our-free-model/`. `./dsh-our-free-model/` **không** nằm trong git
(`.gitignore`), nên không bao giờ commit nhầm nó.

## 3. Trạng thái thật (2026-11-11)

Bản gốc **2.8.3**: **567 file code / 301.362 dòng**. Bản port `pi-extension/`
hiện có **~376 module `.ts`** + **64 file test** (số này là của **lần kiểm kê
2026-11-11**, sinh bằng `node scripts/audit-ports.mjs`).

| Nhóm | Gốc | Đã port | Còn lại |
|---|---|---|---|
| `src/` | 93 file | **90** | **3.130 dòng**: `extensions.js` (1.888) + `plugins.js` (1.240); phần mihomo của `egress.js` cố ý không port |
| `worker/` | 8 file | 7 | `worker/worker.js` entry CF |
| `packages/standalone/` | 55 file | 55 | `web/` cần tái sinh |
| `packages/desktop/` | 13 file | 12 | Rust giữ nguyên |
| `scripts/` | 191 file | 21 | ~170 |
| `client.js` | 8.599 dòng | ~1.100 | **~7.500 dòng** (14 trang/hạ tầng) |
| `vendor/` | 158 file | 158 | — |

**Chưa port: ~199 file / ~107.000 dòng** — trong đó `scripts/` chiếm 170 file
(~41.000 dòng, phần lớn là test script fake-kernel) và `client.js` ~7.500 dòng.

## 4. Quy tắc làm việc

1. **Không ghi `[x]` cho việc chưa xong.** Stub 10 dòng không phải port. "Đã đọc
   code" không phải "đã port". Muốn tick thì phải có: file tồn tại trên đĩa,
   build sạch, test chạy, và smoke thật.
2. **Mỗi task xong thì commit**, message nói rõ port cái gì, phát hiện bug gì,
   kiểm chứng bằng gì.
3. **Cập nhật `docs/TODO.md` trước hoặc cùng lúc** với thay đổi code — TODO là
   bản đồ, không phải sổ log viết sau.
4. **Mọi file `.md` liên quan phải được cập nhật** khi trạng thái đổi:
   `AGENTS.md`, `BAOCAO.md`, `GOAL.md`, `docs/TODO.md`, `PACKAGING.md`,
   `README*.md`.
5. **Test là bằng chứng, không phải trang trí.** Số check tăng phải tương ứng số
   hành vi được pin.
6. **Không tự quyết "ngoài scope".** Chỉ có 3 thứ thật sự không port được:
   binary không ship (magpie 68 MB), binary lậu (mihomo), và code Rust của Tauri
   shell. Mọi thứ khác đều port.

## 5. Thứ KHÔNG port — và lý do duy nhất

| Thứ | Lý do | Cách xử lý |
|---|---|---|
| `vendor/magpie/bin/` (68 MB) | Binary không ship trong package | `engine.json` pin sha256; `magpie-engine.ts` báo `unavailable` kèm cách khắc phục |
| `src/egress.js` phần mihomo/Clash | Cần binary lậu | `renderMihomoConfig`/`outletLabel` chỉ port khi user tự có clash |
| `packages/desktop/src-tauri/` phần Rust | Rust không chạy trong Node | Port **logic** sang TS, giữ Rust shell; ranh giới pin trong `pi-extension/packages/desktop/README.md` |

Ngoài ba thứ đó, **không có gì được coi là ngoài phạm vi**.

## 6. Lệnh dùng lại

```bash
# build (tsc strict cho HAI project: node + client DOM; rồi copy assets —
# bao gồm o2a/assets/* mà lane đọc bằng node:fs)
npm --prefix pi-extension run build

# kiểm kê drift giữa bản gốc và bản port (file + export + definition)
node scripts/audit-ports.mjs        # ghi docs/audit-ports.md

# toàn bộ test offline (spawn mỗi suite, không dùng && chain)
node pi-extension/test/run-all.mjs

# API provider độc lập
node pi-extension/dist/server.js --port 18900
OFM_DATA_DIR=/tmp/ofm node pi-extension/dist/server.js --port 18900 --key ofm-xxx

# standalone service (console + 4 dialect + LAN relay)
node pi-extension/dist/packages/standalone/cli.js --port 18900

# cài như pi extension
pi install ./pi-extension
```

## 7. Ranh giới đã pin (sai là hỏng)

- **Chain chỉ fold khi được yêu cầu** — truyền cả `fold` lẫn `toResult` vào
  `runChain` làm mọi turn stream bị fold thành JSON với `headers: {}` (mất
  content-type).
- **`registry.json` phải được copy vào `dist/`** — `providers/index.ts` đọc nó
  bằng `node:fs`, `tsc` chỉ phát `.js`/`.d.ts` → ENOENT lúc import nếu thiếu.
  `scripts/copy-registry.mjs` chạy trong `build` + `prepare`.
- **`JsonStore` unref flush timer** — nếu không flush ngay, CLI exit sẽ rơi write.
- **400 vs 404**: địa chỉ `provider/model` sai hình (không có slash) = 400;
  provider/model không tồn tại = 404.
- **`updater.ts`**: publisher ký **hình đã parse** (`parseManifest(...)`), verifier
  recompute chữ ký trên reconstruction đó. Ký document thô → release không apply
  được. `minSupported` có chữ ký; chỉ field không ký (vd `distributor`) mới thêm
  sau được.
- **`reload.ts`**: `canSafelyHotReload` phải xét cả đường restore (`set`). Cache
  purge được mà không ghi lại được = đổi install đang chạy lấy install chết.
- **`trust.ts`**: Host service *có* mà nói "không từ chối" thì authoritative;
  service *không có* thì rơi xuống replica fence; service **throw** ra thì 503,
  không bao giờ bypass browser auth.
- **`feed.ts`**: `timestamp()` nhận cả ISO string (publisher viết) lẫn epoch ms
  (cache tự ghi) — chỉ nhận một kiểu làm mọi `expiresAt` bị xoá sau restart.
- **`push.ts`**: `attach()` ghi comment đầu cũng phải qua guard — client rớt giữa
  lúc race là THƯỜNG, không phải ngoại lệ.
- **Standalone service tự chứa**: đồ thị import của `service.js` không được chạm
  `@earendil-works/*` — nếu chạm, bản stage cho desktop phải kéo `node_modules`.
- **`JsonStore` nhận options object**, không phải 3 tham số định vị của DSH.

## 8. Kiểm kê — soi cả bên trong file đã port

Kiểm kê file-level không đủ: một file được tick nhưng mất nửa thân hàm vẫn đọc
là "đã port". Ba lượt, mỗi lượt sâu hơn:

1. **File + export**: mọi file gốc có bản port trên đĩa; mọi export symbol có tên
   xuất hiện ở `pi-extension/`.
2. **Đích đến**: mỗi file gốc có đích đã biết (bảng trong `docs/TODO.md` §1).
3. **Từng definition**: mọi `function`/`class`/`method` của DSH có mặt trong bản
   port. Lượt 3 tìm ra: egress thiếu ~600 dòng SOCKS5/tunnel, magpie-engine thiếu
   ~700 dòng host HTTP, `migrateStats` làm mất nửa reset.

Sau khi port xong một nhóm: chạy lại cả ba lượt, cập nhật số vào `BAOCAO.md`.

## 9. Cảnh báo upstream drift

`./dsh-our-free-model/` là bản **2.8.3**, còn port hiện dựa trên **2.7.4**.
Chênh lệch đã kiểm kê: **~5.000 dòng code mới** (`extensions.js`, `plugins.js`,
`core.js`, `o2a.js`, `src/o2a/`, `semver.js`) + **44 file trong `src/`, `worker/`,
`packages/` đã đổi nội dung**. Bất kỳ port nào của nhóm đó phải đọc **bản 2.8.3**,
không đọc lại bản cũ đã xóa. Chỉ những gì đã port và test xong mới được coi là
xong; phần còn lại coi như **chưa port**, kể cả khi bản cũ từng có.
