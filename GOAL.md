# MỤC TIÊU DỰ ÁN — API provider đa coding agent, đa LLM provider

đọc các file md sau: 
> File này nói **đích đến**. Trạng thái thực ở `BAOCAO.md`, việc còn làm ở
> `docs/TODO.md`, luật làm việc ở `AGENTS.md`.

## 1. Một câu

`pi-extension/` là **một API provider LLM độc lập**: chạy `node
pi-extension/dist/server.js` là có ngay một endpoint OpenAI/Anthropic/Gemini/
Responses-compatible, khóa API, CORS, 4 lane model và console quản lý — dùng cho
**mọi** coding agent, **mọi** provider LLM, không phụ thuộc pi hay bất kỳ host
nào. Đồng thời nó vẫn mount được như pi extension.

## 2. Vì sao lại sinh ra từ DSH

Dự án gốc `./dsh-our-free-model/` là một plugin nằm trong một host duy nhất
(DeepSeek Harness): nó có host half (`index.js`), browser half (`client.js`),
một relay worker, một app desktop Tauri. Chừng nào nó còn nằm trong host đó, chỉ
có người dùng host đó dùng được.

Việc cần làm là **tháo toàn bộ giá trị đó ra khỏi host** và gói lại thành một
dịch vụ đứng riêng:

| DSH (trong host) | pi-extension (dịch vụ đứng riêng) |
|---|---|
| `index.js` — plugin entry, gọi API host | `index.ts` — pi provider + `/ofm`; `server.ts` — HTTP server độc lập |
| `client.js` — UI nhúng slot của host | console phục vụ bởi gateway (bất kỳ trình duyệt nào) |
| `src/forward.js` — listener cho harness khác | `gateway/server.ts` — cùng listener, không cần host |
| `worker/` — gateway EAC tự host | `pi-extension/worker/` — cùng gateway, chạy trong Node |
| `packages/standalone/` — app console riêng | `pi-extension/packages/standalone/` — cùng app, TS |
| `packages/desktop/` — Tauri shell | `pi-extension/packages/desktop/` — cùng shell, ranh giới Rust giữ nguyên |
| `adapter/kernel.js` — seam duy nhất vào host | `adapter.ts` — attribution UA, không còn seam bắt buộc |

## 3. Đích đến cụ thể

### 3.1 Giao thức (đã có)

- `POST /v1/chat/completions` — OpenAI Chat Completions (cả streaming)
- `POST /v1/messages` + `POST /v1/messages/count_tokens` — Anthropic Messages
- `POST /v1/responses` — OpenAI Responses
- `POST /v1beta/models/{model}:generateContent` — Gemini native
- `GET /v1/models` — danh sách model (OpenAI + Gemini shape)
- `GET /health` — sống/chết
- `GET /v1/announcements`, `POST /v1/announcements/ack` — thông báo
- `GET /v1/events` — SSE push (hello snapshot + heartbeat)

Tất cả sau **key fence + CORS**, bind loopback với port retry/scan.

### 3.2 Model lane (4 lane)

| Lane | Đặc điểm |
|---|---|
| `ofm-kilo` | Kilo AI free pool — **không cần gì cả**: không key, không login, không fingerprint |
| `ofm-opencode` | OpenCode free tier — pooled credential + client fingerprint |
| `ofm-eac` | Co-paid lane — seal AES-256-GCM, 3 shard, mở per call frame |
| `ofm-aggregate` | **76 provider** bên thứ ba, mỗi cái mở bằng key của user |

`ofm-chain/<tên>` là virtual model: chain các lane theo thứ tự, link đầu tiên
trả lời được thắng.

## 4. Nguyên tắc thiết kế

1. **Host là injected, không phải import.** `reload.ts` nhận host làm tham số,
   không import module host. Composition không reload được vẫn có câu trả lời
   hiển thị được ("restart the host") thay vì crash. Không pin version host.
2. **Fail-open đúng chỗ, fail-closed đúng chỗ.** Feed/thống kê: fail-open (giữ
   copy cũ). Auth/trust/updater: fail-closed (503/từ chối, không bao giờ bypass).
3. **Số không bao giờ được bịa.** Star count không hợp lệ → `0` + `stale: true`,
   không phải một số trông có vậy đúng.
4. **State của người dùng thuộc người dùng.** Ack announcement, saver switch,
   chain — đều ghi 0600 atomic write, và feed không bao giờ ghi đè ack history.
5. **Transport muốn kiểm được thì phải có seam.** `fetchImpl`, `now()`, `logger`,
   host — inject được hết, không đo bằng network thật.
6. **Binary không ship thì nói rõ, đừng giả vậy có.** `magpie-engine` trả
   `{state:'unavailable'}` kèm cách khắc phục, không `try/catch` cho câu hỏi đã
   biết đáp án.

## 5. Thứ KHÔNG bao giờ port

| Thứ | Lý do |
|---|---|
| `vendor/magpie/bin/` 68 MB | Binary, `engine.json` đã pin sha256 thay cho nó |
| `src/egress.js` mihomo/Clash spawn | Cần binary lậu |
| Rust shell của Tauri (trong `packages/desktop/`) | Rust không chạy trong Node — chỉ port logic, giữ shell |

Ngoài ba thứ đó, **không có gì được coi là ngoài phạm vi.**

## 6. Lệnh

```bash
npm --prefix pi-extension run build              # tsc strict + copy registry
node pi-extension/test/run-all.mjs               # 45 suite / 923 check hiện tại
node pi-extension/dist/server.js --port 18900    # API provider độc lập
pi install ./pi-extension                        # mount như pi extension
npm run verify:pi-extension-upstream             # đo drift (tốn quota)
```
