# `pi-extension/worker/` — gateway EAC tự host

> **Trạng thái: CHƯA PORT (0/7 file / 2.050 dòng).**
> File này là kế hoạch, không phải báo cáo đã xong. Xem `../../BAOCAO.md` §4.3.

## Cái gì cần port

| File DSH | Dòng | Vai trò |
|---|---|---|
| `worker/worker.js` | 205 | Cloudflare Worker đứng trước relay EAC |
| `worker/gateway-node.mjs` | 744 | **Node host của cùng một validation core** |
| `worker/auth-github.mjs` | 698 | cổng authorization GitHub |
| `worker/entry.js` | 61 | nhúng sidebar vào panel New API |
| `worker/dashboard.html` | 198 | trang dashboard |
| `worker/verify-deployment.mjs` | 108 | tự kiểm tra sau khi deploy |
| `worker/wrangler.toml` | 29 | cấu hình Cloudflare |

## Vì sao việc này khả thi trong Node

Tôi từng tưởng `worker.js` chỉ chạy được trên Cloudflare vì nó nói
`fetch(request, env, ctx)`. Sai: **`gateway-node.mjs` chính là bằng chứng ngược**
— nó là một shim chỉ adapt HTTP server của Node sang Web
`fetch(request, env, ctx)` contract, và phần *validation* là **cùng một module**
Cloudflare chạy. Một request có chữ ký vì thế được validate giống hệt nhau ở cả
hai host.

Nên bản port sẽ là một module TypeScript chạy trong Node, và lớp Cloudflare chỉ
là một adapter mỏng bên trên nếu ai muốn deploy lên edge.

## Mô hình bảo mật cần giữ nguyên

Plugin **không** mang credential của relay. Seal của plugin chỉ mang URL gateway
này + một signing secret dùng chung. Mỗi request tới đều có chữ ký:

```
x-ofm-timestamp:  <unix ms>
x-ofm-signature:  HMAC-SHA256( timestamp \n METHOD \n path \n sha256(body) )
```

Vì vậy: seal bị rò khỏi package là một entry **gián tiếp**, gateway có thể thu hồi
được (xoay secret nó chấp nhận). GitHub login + verdict sao được mint phía server,
cũng thu hồi được ở đó.

## Việc phải làm

- [ ] `worker/validation.ts` — phần lõi validate chữ ký, replay window, so sánh
      thời gian an toàn. Port từ `worker.js`, dùng `node:crypto` cho HMAC/SHA-256.
- [ ] `worker/node-host.ts` — adapt HTTP server của Node sang
      `fetch(request, env, ctx)`, port từ `gateway-node.mjs`.
- [ ] `worker/auth-github.ts` — cổng GitHub: state, callback, verdict sao,
      phiên. Port từ `auth-github.mjs` (698 dòng).
- [ ] `worker/entry.ts` + `worker/dashboard.html` — surface quản trị.
- [ ] `worker/verify.ts` — tự kiểm tra sau khi gateway lên, ký hai route plugin
      nói và xác nhận relay trả lời.
- [ ] `wrangler.toml` — chỉ khi ai muốn deploy edge; không bắt buộc cho bản Node.
- [ ] test mỗi file: chữ ký đúng/đặt sai/thời gian lệch ngoài cửa sổ/body bị
      sửa sau khi ký — tất cả offline, không dial relay.

## Không port

`worker/worker.js` phần runtime-specific của Cloudflare (KV, `caches`, edge
binding) chỉ cần khi deploy edge; phiên bản Node không cần chúng.
