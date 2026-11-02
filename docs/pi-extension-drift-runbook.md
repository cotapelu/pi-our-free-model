# Runbook: khi lane free bị upstream siết (drift)

Áp dụng cho `pi-extension/`. Đây là quy trình phản ứng cho mục TODO duy nhất còn
lại — *khi* `npm run verify:pi-extension-upstream` báo FAIL. Mỗi bước ghi rõ
file/symbol phải sửa, vì một lần drift nhanh (chỉ vài dòng) đáng giá hơn một
lần đo lại từ đầu.

Quy trình **đo** chi tiết (TLS MITM + replay từng byte) nằm ở
[`free-lane-wire.md`](free-lane-wire.md) §判定方法 của plugin dsh — cùng một
upstream, cùng một gate, nên phương pháp đo giống nhau; tài liệu này chỉ trả lời
"đo xong thì sửa ở đâu, sửa sao, verify thế nào".

## 0. Triệu chứng → nghĩa là gì

| Verify báo / lỗi người dùng thấy | Nghĩa | Hành động |
|---|---|---|
| `chat … keeps the fingerprint — FINGERPRINT REFUSED (403)` (FreeTierError) | Gate đổi hình dạng client | Đo lại (bước 1–3), sửa `fingerprint.js` |
| `RegionError` / "not available in your country" | Egress bị chặn vùng | **Không sửa code** — hướng dẫn proxy (`README` §Notes) |
| `429 FreeUsageLimitError` | Gate PASS, hết quota theo session/IP | Không sửa code; extension đã xoay session |
| `no new free id` / `no snapshot id disappeared` FAIL | Roster đổi | Sửa `catalog.js` (bước 4) |
| `every free row is chat-wired` FAIL | Có model mới trên wire khác | Bổ sung wire trong `catalog.js` **hoặc** để ngoài roster (bước 4) |
| Kilo `401 INVALID_TOKEN` | Request lỡ mang credential | Sửa `kilo.js` (fetch wrapper) — lane này không được mang Authorization |
| Kilo `reasoning` bị 400 "mandatory" | Model mới thuộc family cấm tắt thinking | Thêm pattern vào `KILO_REASONING_MANDATORY` |

## 1. Bắt chước một client thật

Theo `free-lane-wire.md`: chạy **official CLI** (`opencode-ai`, version hiện tại)
một lượt thành công ⇒ gate là client-fingerprint chứ không phải account/quota.
Rồi bắt đúng byte nó gửi:

- Cách nhanh (không cần MITM): các dự án tham chiếu đã công bố shape hợp lệ —
  `9router` `open-sse/executors/opencode.js` + `open-sse/utils/opencodeFingerprint.js`,
  và `opencode2api` `internal/identity/request.go`. `src/upstream.js` của plugin dsh
  ghi cả hai nguồn này kèm ngày commit.
- Cách chắc: tự chạy CLI sau TLS MITM (`NODE_EXTRA_CA_CERTS` + proxy tự ký), đọc
  request thật. Cần thiết khi cả hai nguồn trên lỗi thời.

## 2. Replay từng byte để cô lập biến

Từ request thật, mỗi lần chỉ đổi **một** thứ, ghi 200/403:

1. User-Agent (v2 là **nguyên văn**, không tiền tố/hậu tố)
2. Bốn session header (`x-opencode-session`, `-session-id`, `x-session-affinity`,
   `x-session-id`) — thiếu/三异 giá trị là 403
3. Session id: shape `ses_` + 12 hex + 14 base62, **và** 12 hex phải là giá trị
   giảm dần `~(ts_ms<<12 | counter)`, counter 1–63
4. Tool `read`/`shell`: description + parameters phải **từng byte** đúng
5. Block `<env>` trong system prompt (thiếu → 429, không phải 403)
6. `tool_choice: 'none'` (v2 cấm), và `x-opencode-request` (v1 cấm)

`pi-extension/scripts/reverify-upstream.mjs` đã mặc định sẵn các yếu tố này; khi
một yếu tố đổi, sửa trong `fingerprint.js` rồi chạy lại script đó để tái lập。

## 3. Sửa ở đâu (theo thứ bốn yếu tố phía trên)

| Yếu tố | File · symbol |
|---|---|
| UA | `pi-extension/fingerprint.js` → `CLIENT_UA` |
| Tool verbatim | `fingerprint.js` → `FINGERPRINT_TOOL_DEFINITIONS` (không diễn cảm, không format lại) |
| Tên tool bị meter theo danh tính | `fingerprint.js` → `FREE_LANE_TOOL_ALIASES` |
| Session header | `fingerprint.js` → `gatewayHeaders()` (giữ nguyên thứ tự + `Bearer public`) |
| Mã hóa session id | `fingerprint.js` → `SESSION_RE`, `SESSION_DESCENDING_RE`, `mintSessionId()` |
| Block env | `fingerprint.js` → `ensureFreeLaneEnvironment()` |
| Thứ tự/alias trong payload | `fingerprint.js` → `applyFingerprint()` (bước 1–7, giữ comment giải thích từng bước) |

Nguyên tắc: giữ mỗi constant kèm comment ghi *ngày đo* và *bằng chứng* (dsh giữ
cách này trong `src/upstream.js`) — lần drift sau cần biết lần trước đổi gì.

## 4. Sửa roster (`catalog.js`)

- Model mới/lề đường: `FREE_ID_OVERRIDES` (theo id, ưu tiên cao nhất) hoặc
  `FREE_CAPABILITIES` (theo family). Capacity là **số đo thật**, không phải số
  listing — listing là floor (xem audit §3: deepseek 1M/384K vs listing 200K/32K).
- Menu effort: chỉ những rung model **tự khai báo**; thiếu rung → `null` để pi
  không gửi (upstream trả 400 nếu ngoại lệ). `effortMap()` lo việc map; thêm
  `max`/`xhigh` nếu model khai báo.
- Model không menu → `reasoning: false` (không gửi effort), giữ nguyên output
  window cho phần trả lời.
- Wire khác (`/responses`, `/messages`, base_url anthropic/google): extension nói
  **một** wire. Hoặc bổ sung wire (theo kiểu `src/stream.js` của plugin), hoặc để
  ngoài roster và ghi chú — `opencodeModel()` hiện lọc theo
  `api['chat-completions']`.
- Snapshot offline (`STATIC_OPENECODE_MODELS`, `STATIC_KILO_MODELS`): bù chính id
  vừa đổi, kèm số đo + menu. **Đây là lỗi đã xảy ra một lần** (`big-pickle`),
  nên cả hai test `catalog.test.mjs` chống hồi quy phải PASS.
- Kilo off rung: `KILO_REASONING_MANDATORY` / `KILO_NO_DISABLE_IDS` +
  `kiloEffortMap()`.

## 5. Verify trước khi commit

```bash
npm run test:pi-extension                    # 86 check offline, không được FAIL
npm run verify:pi-extension-upstream         # phải PASS; mọi mục trong bảng §0 xanh
pi -e ./pi-extension --list-models | grep ofm-   # roster đúng như đo
# một lượt thật trên lane vừa sửa (hoặc lane còn lại nếu lane này hết quota):
pi -e ./pi-extension -p "ping" --model ofm-kilo/kilo-auto-free
```

Chấp nhận được khi: (a) verify PASS, (b) unit test PASS, (c) một lượt `pi` thật
trả lời qua lane vừa sửa (hoặc thông báo lỗi đúng loại: quota/region/proxy).
Với lane OpenCode bị chặn quota/IP thì (c) chấp nhận thông báo 429 thân thiện —
điều đó chứng minh gate đã pass.

## 6. Sau khi sửa

1. Cập nhật `docs/pi-extension-audit.md` §6/§6b: ngày đo, yếu tố đổi, nguồn hình
   dạng mới (commit/project tham chiếu).
2. Cập nhật `docs/TODO.md`: mục điều kiện giữ nguyên, thay dòng "lần đo gần nhất".
3. Commit theo khuôn `fix(pi-extension): …` kèm bảng yếu tố cũ → mới, giống các
   commit trước trong repo.
4. Nếu upstream đổi **quyền** (không còn free, hoặc free pool cần account): dừng,
   ghi vào README §Disclaimer và cân nhắc tắt provider mặc định — đừng giữ code
   làm khách.
