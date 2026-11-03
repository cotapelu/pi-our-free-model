# Our Free Model — extension provider cho pi

Biến hai làn model miễn phí **không cần khoá** thành provider cho `pi`, để `pi`
chọn chúng như mọi provider built-in: **không đăng nhập, không đăng ký, không API
key, không cần cấu hình gì.** Viết bằng TypeScript; `pi` chạy bản build `dist/`.

| Provider | Upstream | Thông tin xác thực |
|---|---|---|
| `ofm-kilo` | Gateway công khai Kilo AI — `https://api.kilo.ai/api/gateway` | không — free pool trả lời request thật-sự không có credential |
| `ofm-opencode` | Bậc miễn phí công khai của OpenCode — `https://opencode.ai` | một credential công khai dùng chung (`Bearer public`) + client fingerprint |
| `ofm-chain` | chuỗi fallback trên cả hai làn | (một tên model chọn được, không phải upstream) |

Cả hai roster được lấy **live** từ listing upstream mỗi lần nạp. Một snapshot
offline giữ model hiện diện khi máy không có đường ra upstream, và một lần
refresh không lấy được listing thì **giữ nguyên roster vừa phục vụ** — kèm đúng
chính tả upstream đã học, nên một lượt không bao giờ mang safe-id của `pi` tới
một làn đang sống. Tool-call, delta thinking, tính usage và hủy hoạt động như
mọi provider khác, vì cả hai làn đều stream qua bản OpenAI-Completions của pi-ai.

## Cài đặt

Thư mục này là một package của pi. Nó là **TypeScript**, và `pi` nạp
`dist/index.js` đã biên dịch, nên build một lần trước khi cài — và lại mỗi khi
sửa nguồn:

```bash
npm --prefix pi-extension install     # dev deps (typescript, @types/node, các gói type của pi)
npm --prefix pi-extension run build   # tsc → pi-extension/dist  (cũng tự chạy qua "prepare")
```

rồi cài:

```bash
pi install ./pi-extension     # từ gốc repo — nạp ở mọi phiên `pi`, không cần approve
```

hoặc thử trong một lần gọi:

```bash
pi -e ./pi-extension
```

Dạng project-local `pi install ./pi-extension -l` ghi package vào
`.pi/settings.json` để chỉ kích hoạt trong repo này. pi **gate tin cậy** tài
nguyên project-local, nên nó **không nạp** tới khi truyền `--approve` lúc chạy
`pi` trong repo.

## Chọn model

```bash
pi --list-models | grep ofm                    # hai roster + mọi chain
pi --model ofm-kilo/reflection-beam-free       # một model free của Kilo
pi --model ofm-opencode/deepseek-v4.1-flash-free --thinking high
pi --model "ofm-opencode/deepseek-v4.1-flash-free:high"   # dạng :<thinking>
pi --model ofm-chain/my-chain                  # một chuỗi fallback
```

Tương tác: chạy `pi`, dùng Ctrl+P để đổi model, hoặc truyền `--models`/`--model`.
`/ofm` báo roster hiện tại; `/ofm refresh` lấy lại cả hai listing.

## Chuỗi fallback (chain)

Một chain là một tên model chọn được, các link của nó là model thật, thử lần
lượt — link đầu trả lời được thì thắng. Nó tồn tại cho các lỗi hai làn thường
gặp: hết quota ở một link trong khi làn kia còn chỗ, từ chối vùng, hoặc 5xx.

```bash
/ofm chain add Ten Chain | ofm-kilo/reflection-beam-free | ofm-opencode/beam-free
/ofm chain add RR | ofm-kilo/a | ofm-kilo/b | round-robin:2
/ofm chain                                  # liệt kê, live/tổng mỗi chain
/ofm chain edit <id|name>                   # wizard: tên → links → strategy → sticky
/ofm chain set <id|name> links <provider/model> | <provider/model>
/ofm chain set <id|name> strategy fallback|round-robin[:sticky]
/ofm chain set <id|name> sticky <1..16>
/ofm chain enable|disable|remove <id>
```

`chain edit` là wizard tương tác cho cùng các sửa: hỏi tên (tên hiện tại hiện
dạng placeholder — để trống thì giữ nguyên), các link (mỗi dòng một link, đã
prefill sẵn link hiện tại), strategy, và — với `round-robin` — cửa sổ sticky,
rồi kiểm tra y như `add`. Huỷ bất kỳ bước thì không ghi gì; ở phiên không tương
tác nó chỉ đường dùng `set` hoặc file chains.

Trường cuối của `add` là strategy khi nó đọc được một strategy; mọi thứ giữa
tên và trường đó là link, và link không dạng `provider/model` thì bị từ chối
chứ không âm thầm bỏ. Link được đối chiếu với registry live: add mà mọi link
không resolve thì bị từ chối kèm chính tả (lỗi gõ, không phải đổi roster), còn
add có vài link chết thì nhận và nêu rõ. `set` sửa chain có sẵn không cần động
file.

`fallback` (mặc định) luôn bắt đầu ở đầu; `round-robin` xoay điểm bắt đầu mỗi
`stickyLimit` lượt. Tường lực chain quảng cáo là **giao** của các link — số
trung thực, không phải hợp. Chain lưu ở `~/.our-free-model/chains.json`
(`OFM_DATA_DIR` ghi đè).

Việc failover tiến thế nào là tính chất của `pi`, không phải extension: `pi`
định tuyến một lần mỗi request, chỉ retry lỗi *transient*, và cố ý **không**
retry bức tường quota (`FreeUsageLimitError` là hạn mức tài khoản trong policy
của nó). Nên chain tiến link khi `pi` retry, và ở **lượt người-dùng kế tiếp**
sau một lỗi mà `pi` không retry. Một lượt tiếp nối ở lại model đã trả lời, nên
prompt cache và chữ ký thinking được giữ, và một chuỗi bị chặn tối đa `links - 1`
bước mỗi streak.

## Vì sao model này miễn phí — và cái giá

- **`ofm-kilo`** — Kilo public gateway tương thích OpenAI, lát cắt `isFree` trả
  lời không cần tài khoản/key/đăng nhập. Chỉ một điểm khác: request **không được**
  mang header Authorization (token giả chỗ là `401 INVALID_TOKEN`), và payload
  được chuẩn hoá sang từ-vựng của gateway (`reasoning` thay `reasoning_effort`,
  `max_tokens` thay `max_completion_tokens`). **Model card của gateway nói rõ
  prompt free-pool có thể bị upstream log và dùng để cải thiện dịch vụ.** Coi làn
  này là việc dùng-một-lần, đừng gửi bí mật.
- **`ofm-opencode`** — OpenCode phục vụ bậc miễn phí sau credential công khai
  dùng chung và một cổng **client fingerprint**. Làn chạy được không cần tài
  khoản, nhưng request phải giống CLI chính thức từng byte: User-Agent
  `opencode/latest/2.0.26/cli`; bốn session header đồng giá trị và không có header
  v1 `x-opencode-request`; session-id mint theo dạng giảm-dần
  `~(ts_ms << 12 | counter)` (id ngẫu nhiên hay sha256 bị 403); hai khai báo tool
  (`read`, `shell`) verbatim từ OpenCode v2.0.26, nên tool `read` của `pi` bị
  đổi tên khỏi gate-slot lúc gửi và khôi phục ở response; block `<env>` bắt buộc
  trong system prompt; và không bao giờ `tool_choice: 'none'`. Sức thinking là
  **menu `reasoning_effort` do model khai báo** — mức model không khai báo thì
  không gửi (gateway trả 400), và model không có menu thì không có picker.
  Làn đo per session/IP: `429 FreeUsageLimitError` sẽ được thông báo khả-thi và
  xoay session đã map, `403 RegionError` chỉ đường egress.

Hai làn cũng mang các guard transport port từ lịch-sử issue của plugin: body
được đọc theo **hình dạng**, không theo `Content-Type` (200 gán nhãn JSON nhưng
body là SSE, hoặc một document JSON trả lời cho request stream, sẽ được replay
hoặc fold chứ không bị rơi — chỉ sniff phần đầu nên stream live không bị đệm tới
cuối); stream chỉ gửi comment keepalive thì chết theo hạn idle; markup điều-khiển
`<｜DSML｜…>` của DeepSeek v4 bị scrub; và lỗi transport thêm lý do socket
(`fetch failed — getaddrinfo ENOTFOUND …`).

Lần đầu các làn xuất hiện trên máy, extension nói chúng đắt giá những gì và
không được gửi gì (Kilo có thể log prompt; OpenCode đo per session/IP). Nó hiện
một lần, trong phiên tương tác, và ghi đã hiện (`notice-ack.json`; tăng
`NOTICE_VERSION` trong nguồn `disclaimer.ts` để hiện lại).

## Lệnh `/ofm`

```bash
/ofm                    # ofm-kilo: N model · ofm-opencode: N model · chain: N
/ofm refresh            # lấy lại cả hai roster live
```

## Cấu trúc

```
pi-extension/
├── index.ts               factory: đăng ký cả hai provider, chain và /ofm
├── fingerprint.ts         client fingerprint v2 của OpenCode (tool, session, header)
├── catalog.ts             lấy listing live, map sang model pi, snapshot offline
├── lane.ts                ống dẫn stream dùng chung: khôi phục alias, dịch lỗi,
│                          fetch không credential, xoay session, sseGuard
├── transport.ts          nửa không phụ thuộc host của các guard: sniff+replay head,
│                          fold body, watchdog idle, scrub DSML, copy lỗi
├── opencode.ts           provider ofm-opencode
├── kilo.ts               provider ofm-kilo
├── chains.ts             chain fallback: normalize, giao tường lực, định tuyến
├── chain-store.ts        lưu chain bền (~/.our-free-model/chains.json)
├── disclaimer.ts         thông báo một-lần mà các làn free nợ người dùng
├── scripts/reverify-upstream.ts   đo lại live cả hai làn
├── dist/                 output biên dịch (`tsc`) — cái mà `pi` nạp
└── test/                 kiểm unit + integration offline (Node type-strip)
```

## Kiểm thử

```bash
npm run test:pi-extension                 # build + unit + integration (integration cần `pi`)
npm run verify:pi-extension-upstream      # live: đo lại cả hai làn (mạng, tốn quota free)
```

Build (`tsc`) chạy với `strict` + `noImplicitAny`, nên lỗi type sẽ làm hỏng
`npm run build` — đó là cổng kiểm-tra tương thích với type của `pi-ai`/
`pi-coding-agent` đang cài.

Các script integration lái một tiến trình `pi` thật trên gateway đứng-thế
loopback, khẳng định fingerprint, khôi phục alias và hình-dạng wire đầu-cuối mà
không chạm upstream. Khi không có `pi`, chúng in
`SKIP <script> — the pi binary is not on PATH` và exit 0, nên contributor không
có pi vẫn chạy toàn bộ phần offline. Verifier live không dành cho CI vì nó tốn
quota free của egress.

Verifier live là dạng chạy-được của mục bảo trì định kỳ: nó độ fingerprint lên
`opencode.ai` (`403 FreeTierError` nghĩa là gate đã đổi và `fingerprint.ts` phải
đo lại với client chính thức hiện tại; `429` nghĩa là gate *đã pass* và egress này
hết quota), hỏi free pool Kilo không credential, và diff cả hai roster live với
snapshot offline. Nó exit khác-0 khi drift; khi đó quy trình nằm ở
[`../docs/pi-extension-drift-runbook.md`](../docs/pi-extension-drift-runbook.md).

## Ghi chú

- Model bị chặn vùng cần proxy ra ngoài: `NODE_USE_ENV_PROXY=1` kèm
  `HTTPS_PROXY=...` định tuyến cả hai làn qua nó.
- `OFM_DATA_DIR` đổi chỗ `chains.json` và `notice-ack.json`.
- `OFM_OPENECODE_BASE`, `OFM_OPENECODE_CHAT_BASE`, `OFM_KILO_BASE` ghi đè endpoint
  (test dùng; `OFM_OPENECODE_BASE` cũng đổi listing).
- Không gì ở đây giữ credential riêng, tài khoản hay token store. Cả hai làn chỉ
  mang thứ tài-liệu công khai của upstream mô tả.
- Free pool Kilo có thể train trên prompt. Đừng gửi credential, khoá, dữ liệu cá
  nhân, hay gì mày không trao cho bên thứ ba.

## Đóng góp

`pi-extension` là TypeScript. Sửa các file `*.ts`, rồi
`npm --prefix pi-extension run build` trước khi test hoặc cài — `pi` nạp
`dist/index.js`, không phải nguồn. Giữ nguyên các hằng fingerprint và comment ghi
lần đo của chúng, và chạy lại `npm run verify:pi-extension-upstream` sau khi chạm
`fingerprint.ts` hoặc snapshot roster.
