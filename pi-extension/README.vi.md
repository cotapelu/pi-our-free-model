# Our Free Model — API provider + phần mở rộng pi

**Một bộ code, hai cách mount.** Chạy như HTTP API provider để bất kỳ coding
agent nào trỏ `base-url` vào, hoặc cài như pi extension. Cả hai dùng chung
`dist/`, cùng phục vụ bốn lane model.

```
node pi-extension/dist/server.js --port 18900      # API provider, không cần host
pi install ./pi-extension                          # pi extension
```

| Lane | Upstream | Credential |
|---|---|---|
| `ofm-kilo` | Kilo AI public gateway — `api.kilo.ai` | **không cần gì** — pool miễn phí trả lời một request thật sự không có credential |
| `ofm-opencode` | OpenCode free tier công khai — `opencode.ai` | một credential công khai dùng chung (`Bearer public`) + client fingerprint |
| `ofm-eac` | lane đồng chi trả | seal AES-256-GCM chia ba mảnh |
| `ofm-aggregate` | **76 provider bên thứ ba** | key của bạn, mỗi provider, nhập ở trang cấu hình |
| `ofm-chain/<tên>` | chain dự phòng trên các lane | (một tên chọn được, không phải upstream) |

Hai lane đầu là lý do dự án này tồn tại: **không đăng nhập, không đăng ký,
không API key, không cấu hình gì.** Ba lane sau tồn tại vì một lane miễn phí
không đủ để làm provider.

## Giao thức server phục vụ

Tất cả sau một bearer key và CORS, bind loopback với port retry/scan, và stream.

| Route | Giao thức |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/messages`, `POST /v1/messages/count_tokens` | Anthropic Messages |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1beta/models/{model}:generateContent` | Gemini native |
| `GET /v1/models` | danh sách model (cả hai shape OpenAI và Gemini) |
| `GET /health` | còn sống |
| `GET /v1/announcements`, `POST /v1/announcements/ack` | feed thông báo |
| `GET /v1/picks` | số sao repo được giới thiệu, tươi sau route |
| `GET /v1/sponsor` | nội dung nhà tài trợ, dạng data chứ không phải markup |
| `GET /v1/events` | SSE push (snapshot hello + heartbeat) |

```bash
curl -s -H "authorization: Bearer ofm-demo" http://127.0.0.1:18900/v1/models
curl -s -X POST http://127.0.0.1:18900/v1/chat/completions \
  -H "authorization: Bearer ofm-demo" -H 'content-type: application/json' \
  -d '{"model":"ofm-kilo/kilo-auto-free","messages":[{"role":"user","content":"say pong"}]}'
```

Trỏ agent vào: `base-url = http://127.0.0.1:18900/v1`, `api-key = ofm-demo`.
Key là của **gateway này**, không phải của upstream — `ofm-kilo`/`ofm-opencode`
không cần key upstream.

## Cái giá phải trả

- **`ofm-kilo`** — slice `isFree` của Kilo trả lời không cần tài khoản, key hay
  trạng thái đăng nhập. Hai điều chỉnh: request phải **không** mang header
  Authorization (token giả là `401 INVALID_TOKEN`), và payload được chuẩn hóa về
  từ vựng của gateway (`reasoning`, không phải `reasoning_effort`; `max_tokens`,
  không phải `max_completion_tokens`). **Chính model card của Kilo nêu prompt
  pool miễn phí có thể bị log và dùng để cải thiện dịch vụ.** Coi lane này là
  việc dùng một lần.
- **`ofm-opencode`** — free tier sau một credential công khai *dùng chung* và
  một cổng **client fingerprint**. Không cần tài khoản, nhưng request phải trông
  giống CLI chính thức từng byte: UA, bốn header session cùng giá trị và không
  có `x-opencode-request` chỉ-v1; session id mint dạng descending
  `~(ts_ms << 12 | counter)` (id random hay sha256 bị từ chối 403); hai khai báo
  tool (`read`, `shell`) verbatim từ OpenCode v2.0.26, nên `read` của pi được
  đổi tên ra khỏi gate slot lúc request và trả lại lúc response; một block
  `<env>` bắt buộc trong system prompt; và không bao giờ `tool_choice: 'none'`.
  Cường độ suy nghĩ là menu `reasoning_effort` **model tự khai** — mức không
  khai thì không gửi (gateway trả 400), model không có menu thì không có picker.
  Đo theo session/IP: `429 FreeUsageLimitError` có thông báo hành động được và
  xoay session, `403 RegionError` chỉ ra egress.
- **`ofm-eac`** — lane đồng chi trả; credential không bao giờ ở trong package
  dưới dạng đọc được.
- **`ofm-aggregate`** — key của bạn, quota của bạn, điều khoản của provider.

Lần đầu một lane miễn phí xuất hiện trên máy, extension nói rõ cái giá và cái
gì không bao giờ gửi. Hiện một lần, trong session tương tác, và ghi lại là đã
hiện (`notice-ack.json`; tăng `NOTICE_VERSION` trong `disclaimer.ts` để hiện lại).

## Transport guard

Cả hai lane free mang guard port từ issue trail: body đọc theo **hình dạng**,
không theo `Content-Type` (một 200 dán nhãn JSON trên cả một stream SSE, hoặc
một JSON document trả lời request stream, thì replay hoặc fold chứ không drop —
head được sniff nên stream sống không bị buffer đến cuối); stream chỉ gửi
comment keepalive thì chết trên idle deadline; markup điều khiển
`<｜DSML｜…>` bị rò rỉ của DeepSeek v4 được scrub; và lỗi transport nối thêm lý
do socket (`fetch failed — getaddrinfo ENOTFOUND …`).

## Token saver

Một turn agent dài phần lớn là output tool — diff, listing, kết quả tìm kiếm,
build log — gần như toàn bộ là dư thừa model không cần. Saver nén mười hai hình
dạng output tool và áp hai họ prompt, mỗi họ nhiều mức. **Mặc định tắt hết**:
nén làm đổi cái model đọc, họ prompt làm đổi cách model *viết* — cả hai đều là
quyền của người dùng. Bật bằng `/ofm saver`, xem đã đo gì bằng
`/ofm saver stats`.

## Lệnh `ofm`

```bash
/ofm                          # số model từng lane · chains
/ofm refresh                  # lấy lại roster live của mọi lane
/ofm chain [add|edit|set|remove|enable|disable]
/ofm provider [status|add-key|test|discover]
/ofm saver [rtk|caveman|ponytail]
/ofm feed [list|poll|ack <id>|ack all]
/ofm login|logout             # lane EAC đồng chi trả
```

## Cài đặt

```bash
pi install ./pi-extension      # hoặc: pi -e ./pi-extension
```

Tài nguyên project-local được **trust-gate**, nên session cần `--approve` cho
đến khi có quyết định được lưu (`/trust`, hoặc `~/.pi/agent/trust.json`). Chỉ
chạy `pi` từ một thư mục nếu extension nên được nạp từ đó — nó đọc từ **thư mục
làm việc hiện tại mà thôi**.

## Chọn model

`ofm-kilo/*` và `ofm-opencode/*` là hai lane không cần key. `ofm-chain/<tên>`
đi một chain dự phòng: link đầu tiên trả lời được thắng, nên quota wall ở một
lane thành retry mà người dùng không thấy. `ofm-eac/*` và
`ofm-aggregate/<provider>/<model>` xuất hiện khi đã cấu hình.

## Chain dự phòng

Một chain là một tên chọn được trên danh sách `provider/model` có thứ tự. Giới
hạn capability là **giao** của các link resolve được lúc này, nên chain không
bao giờ quảng cáo capability mà thành viên yếu nhất của nó không có. Pi thay
giới hạn bằng của model dispatched sau response đầu tiên.

## Chạy server độc lập

```bash
npm --prefix pi-extension run build
node pi-extension/dist/server.js --port 18900
```

Không cần cài thêm gì. Cổng mặc định 18900; bị chiếm thì server **tự chọn cửa
khác** và in ra cổng thật — đừng hard-code địa chỉ. Không truyền key thì server
tự mint và in ra.

| Cờ | Biến | Ý nghĩa |
|---|---|---|
| `--port N` | `OFM_GATEWAY_PORT` | cổng xin bind |
| `--key K` | `OFM_GATEWAY_KEY` | key gateway |
| — | `OFM_DATA_DIR` | nơi lưu mọi state, mặc định `~/.our-free-model` |
| — | `OFM_OPENECODE_BASE` / `OFM_KILO_BASE` | đổi endpoint (dùng cho test) |

## Bố cục

```
pi-extension/
├── index.ts               factory: pi provider, chain, /ofm
├── server.ts              entry API provider độc lập (cùng dist/)
├── transport.ts           nửa host-free của guard: sniff head, fold body,
│                          idle watchdog, DSML scrubber, copy lỗi
├── fingerprint.ts         client fingerprint OpenCode v2
├── catalog.ts             fetch listing live + snapshot offline + roster tĩnh
├── lane.ts                stream plumbing dùng chung: trả alias, dịch lỗi,
│                          fetch không credential, xoay session
├── opencode.ts            provider ofm-opencode
├── kilo.ts                provider ofm-kilo
├── eac.ts                 wire lane EAC đồng chi trả
├── eac-login.ts           giao login GitHub (chỉ host)
├── eac-user.ts            token per-user, 0600
├── eac-lane.ts            provider ofm-eac
├── vault.ts               mở seal (ba shard, AES-256-GCM)
├── vault-anchor.ts
├── vault-data.ts
├── aggregate.ts           wire 76 provider
├── providers/index.ts     registry, đọc từ registry.json
├── aggregate-lane.ts      provider + lane ofm-aggregate
├── aggregate-store.ts     aggregate.json, 0600, flush ngay
├── chains.ts              chain dự phòng: normalize, giao, routing
├── chain-store.ts         lưu chain bền (~/.our-free-model/chains.json)
├── chan-relay.ts          LAN relay cho gateway channel đã hấp thụ
├── subscriptions.ts       sidecar subscription riêng tư
├── subscription-adapter.ts
├── subscription-completion.ts
├── channel.ts             cầu SPSC producer→consumer
├── combos.ts              một catalog entry ảo thật ra là chain
├── messages.ts            từ vựng harness <-> ba wire shape
├── stream.ts              provider SSE -> StreamChunk của harness
├── upstream.ts            wire upstream cho lane không cần key
├── effort.ts              chính sách reasoning effort
├── magpie-policy.ts       kênh tài khoản bản build này không cung cấp
├── magpie-models.ts       catalog live của engine
├── magpie-engine.ts       host engine: resolve, không reject
├── engine-payload.ts      khôi phục engine từ part local, không network
├── image-pricing.ts       ước lượng vision token cùng host
├── model-test.ts          kiểm chứng text-test: timing, cancellation
├── loopback-fetch.ts      transport loopback
├── disclaimer.ts          thông báo một lần mà lane free nợ người dùng
├── open-external.ts       await launcher để lỗi vẫn khôi phục được
├── updater.ts             tự nâng cấp: manifest Ed25519, SHA-256 per file,
│                          backup, swap nguyên tử, rollback
├── reload.ts              tự hot-reload trên host **injected**
├── trust.ts              request fence: connection service của composition
│                          trước, replica loopback sau
├── feed.ts               feed thông báo: source theo thứ tự, từ chối redirect,
│                          xác thực cả document, ack thuộc caller
├── feed-ack.ts           người dùng đã đọc gì, bền, chỉ chủ sở hữu
├── push.ts               một stream SSE per bề mặt: hello, heartbeat, gỡ
│                          client lúc close
├── picks.ts              số sao của repo được giới thiệu
├── sponsor.ts            (stub — xem ../BAOCAO.md §4)
├── saver-store.ts        công tắc saver bền, mặc định tắt
├── saver-stats.ts        saver đo gì lần cuối, theo lane
├── token-saver/          nén output tool: 12 filter, autodetect, gate
│   ├── index.ts          compressRequest / compressText
│   ├── prompts.ts        hai họ prompt, bảy mức
│   ├── autodetect.ts     một blob là filter nào, từ header của chính nó
│   ├── registry.ts       tra filter theo tên (alias rg, fd ở đây)
│   ├── applyFilter.ts    chỗ duy nhất filter được phép fail
│   ├── hitLine.ts        parse output tìm kiếm, nhận biết drive
│   ├── constants.ts      mọi ngưỡng; là mặt tương thích, không phải nút
│   └── filters/          git-diff, git-status, git-log, ls, grep, find, tree,
│                         build-output, dedup-log, read-numbered, search-list,
│                         smart-truncate
├── gateway/              mặt HTTP độc lập
│   ├── server.ts         routing, key fence, CORS, bind port
│   ├── protocol.ts       bearer, CORS, body, envelope lỗi OpenAI
│   ├── loopback.ts       bind địa chỉ loopback, xếp hạng ứng viên LAN
│   ├── dispatch.ts       một performUpstream cho cả bốn dialect
│   ├── response-stream.ts stream giữ mở, heartbeat, fold/replay
│   ├── anthropic.ts      codec Anthropic Messages + SSE frame
│   ├── gemini.ts         route Gemini native + frame
│   ├── responses.ts      codec OpenAI Responses
│   ├── chain.ts          routing chain trên dispatch
│   ├── classify.ts       một từ vựng lỗi, forwardFailure cho ba dialect
│   ├── recovery.ts       khôi phục silent-stop
│   ├── optimize.ts       năm request trả lời không cần gọi provider
│   ├── probe.ts          probe availability + phát hiện egress
│   ├── egress.ts         outlet bật/tắt được (chỉ loopback)
│   └── store.ts          JsonStore, kế toán usage, day key
├── packages/             vỏ phân phối (chưa port — xem ../BAOCAO.md)
│   ├── standalone/README.md
│   └── desktop/README.md
├── worker/               gateway EAC tự host
│   ├── validation.ts    kiểm tra chữ ký/replay/relay mà CẢ HAI host chạy
│   ├── usage-scanner.ts đếm token từ body relayed, không parse hết
│   ├── rate-limiter.ts  giới hạn fixed-window, theo key
│   ├── analytics.ts     số liệu per-IP, muối, prune, ghi nguyên tử
│   └── (node host, cổng GitHub, dashboard — chưa port)
├── vendor/               channel-pack copy verbatim; magpie pin sha256
├── scripts/reverify-upstream.ts  đo lại live cả hai lane
├── scripts/copy-registry.mjs     copy registry.json vào dist/ (bắt buộc)
├── dist/                 output build — thứ thật sự chạy
└── test/                kiểm tra unit + integration offline (Node type-strip)
```

## Test

```bash
npm --prefix pi-extension run test:pi-extension   # build + mọi suite offline
```

56 suite / 1.151 check ở lần chạy gần nhất. Build chạy dưới `strict` với
`noImplicitAny`, nên một lỗi type là fail `npm run build` — đó là cổng tương
thích với type `pi-ai`/`pi-coding-agent` đã cài.

Verifier live không dành cho CI: nó tiêu quota miễn phí của egress này. Nó exit
khác không khi drift, và quy trình xử lý ở
[`../docs/pi-extension-drift-runbook.md`](../docs/pi-extension-drift-runbook.md).

## Ghi chú

- Model bị giới hạn vùng cần proxy ra ngoài: `NODE_USE_ENV_PROXY=1` với
  `HTTPS_PROXY=...` định tuyến cả hai lane qua nó.
- `OFM_DATA_DIR` chuyển chỗ lưu `chains.json`, `feed.json`, `notice-ack.json`,
  `saver.json`, `gateway.json` và vòng key aggregate.
- `OFM_OPENECODE_BASE`, `OFM_OPENECODE_CHAT_BASE`, `OFM_KILO_BASE` đổi endpoint.
- Ở đây không giữ credential, tài khoản hay kho token riêng tư nào. Cả hai lane
  không cần key chỉ mang đúng cái tài liệu công khai của upstream mô tả.
- Pool miễn phí của Kilo có thể train trên prompt. Không gửi credential, key,
  dữ liệu cá nhân, hay bất kỳ thứ gì bạn không trao cho bên thứ ba.

## Trạng thái port

Thư mục này là bản **port đầy đủ** của `dsh-our-free-model`, không chỉ phần API
provider. Bản kiểm kê đã xác minh — từng file bản gốc, đã port hay chưa — nằm ở
[`../BAOCAO.md`](../BAOCAO.md), việc còn lại ở [`../docs/TODO.md`](../docs/TODO.md).
Hai file đó được sinh từ lần quét cả hai cây, nên tin chúng hơn văn xuôi ở đây.
