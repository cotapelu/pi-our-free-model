bối cảnh: 
toàn bộ mọi file code trong thư mục này. là của cái extension dsh-our-free-model. tao nhắc lại là thư mục gốc của dự án, có nhiều thư mục con, mày phải đọc hết. chứ không phải chỉ mỗi ./src đâu nhé. nhớ chưa đồ ngu. có nhiều thư mục con tại thư mục gốc của dự án dsh này lắm. trừ thư mục pi-extension/ là tao bắt chước để viets full lại extension provider cho pi coding agent, chứ không phải là dsh nữa. phải nhớ sục sạo mọi dòng code gốc. xem nó làm gì? vì sao nó nhiều code vậy? tao nhắc lại là toàn bộ thư mục gốc dự án và toàn bộ các thư mục con của nó nhé. mày phải sục sạo hết. mới biết vì sao nó nhiều code vậy? bắt chước sang bên provider extension cho pi coding agent nằm ở thư mục ./pi-extension thì có thiếu gì không? mục tiêu là tao cần pi-extension/ để tao dùng với pi coding agent chứ tao không dùng dsh. hiểu chưa.

CẬP NHẤT MỚI (2026-11-05): hướng phát triển đã thay đổi. pi-extension không còn chỉ là pi provider extension đơn giản nữa — nó sẽ được phát triển thành một **API provider đầy đủ (HTTP server độc lập)**, phục vụ mọi coding agent (pi, Claude Code, Codex, Continue, curl…), không nhất thiết phải pi. Mọi thứ cần từ dsh sẽ được port vào nếu thiết yếu:

- HTTP server: forward.js (loopback bind, key auth, CORS, routes /v1/chat/completions, /v1/messages, /v1/responses, /v1/models, LAN relay, port retry/scan)
- Anthropic Messages codec: anthropic.js
- Gemini wire: gemini.js
- Provider Adapter / turn orchestration: adapter.js (chain走位, commit rule, recovery)
- Recovery: recovery.js (interrupted, silent-stop, max-tokens continuation)
- Failure classification: route/classify.js
- Store/JsonStore: store.js
- Local optimize 5 câu trả lời: local-optimize.js
- Egress + bun-fetch: egress.js, bun-fetch.js
- Probe/availability: probe.js

Không port: EAC co-pay (cần gateway server + seal), 10 kênh tài khoản (OAuth/QR mỗi IDE), egress mihomo spawn (pi dùng HTTPS_PROXY sẵn), magpie binary Go 68MB, updater Ed25519, UI 11 trang, client.js dictionary UI, packages/desktop Tauri, vendor/channel-pack 148 file.

đọc file AGENTS.md BAOCAO.md, và docs/TODO.md. sau đó làm tiếp.
