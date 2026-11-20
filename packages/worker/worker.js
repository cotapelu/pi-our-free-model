/**
 * EAC co-paid lane gateway — Cloudflare Worker entry.
 *
 * Sits in front of the upstream relay. Verifies signed requests from the plugin,
 * forwards with the real relay credential (lives only here in the Worker's
 * environment secrets).
 *
 * Ported from dsh's `worker/worker.js`. The validation core lives in
 * `worker/validation.ts`; this file is the thin Cloudflare entry.
 *
 * Environment:
 *   UPSTREAM_URL        secret. The relay base, e.g. https://relay.example/v1
 *   UPSTREAM_API_KEY    secret. The relay credential, forwarded as Bearer.
 *   SIGNING_SECRETS     secret. Comma-separated accepted signing secrets.
 *   MODELS              var (optional). Comma-separated model allowlist.
 *   MOUNT_PREFIX        var (optional). Serve under a sub-path.
 *   CLOCK_SKEW_SECONDS  var (optional). Replay window, default 600.
 *   MAX_BODY_BYTES      var (optional). Request body cap, default 8 MiB.
 *
 * @module pi-extension/worker/worker.js
 */

const JSON_ERROR = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const PASS_HEADERS = ["content-type", "retry-after"];

function relayUrl(raw) {
  const cleaned = String(raw ?? "").replace(/\/+$/, "");
  if (!/\/v1$/.test(cleaned)) return null;
  const url = new URL(cleaned);
  if (url.protocol === "https:") return url;
  if (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
  )
    return url;
  return null;
}

function bytesToHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const encoder = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(sig);
}

function parseSignedRequest(req) {
  const ts = req.headers.get("x-ofm-timestamp");
  const sig = req.headers.get("x-ofm-signature");
  if (!ts || !sig) return null;
  return { ts: Number(ts), sig };
}

async function verifySignature(secrets, ts, method, path, body, sig) {
  const message = `${ts}\n${method}\n${path}\n${bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(body ?? "")))}`;
  for (const secret of secrets
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const expected = await hmacHex(secret, message);
    if (timingSafeEqual(expected, sig)) return true;
  }
  return false;
}

async function handleRequest(req) {
  const url = new URL(req.url);
  const mountPrefix = MOUNT_PREFIX || "";
  const pathname = url.pathname;
  if (mountPrefix && !pathname.startsWith(mountPrefix)) {
    return JSON_ERROR(404, "not found");
  }
  const relay = relayUrl(UPSTREAM_URL);
  if (!relay) {
    return JSON_ERROR(503, "relay not configured");
  }

  // Health
  if (req.method === "GET" && pathname === (mountPrefix || "") + "/health") {
    return new Response("ok", { headers: { "cache-control": "no-store" } });
  }

  // Verify signature for all other routes
  const parsed = parseSignedRequest(req);
  if (!parsed) {
    return JSON_ERROR(401, "missing signature");
  }

  const now = Date.now();
  const skew = Number(CLOCK_SKEW_SECONDS ?? 600) * 1000;
  if (Math.abs(now - parsed.ts) > skew) {
    return JSON_ERROR(401, "timestamp outside replay window");
  }

  const secrets = SIGNING_SECRETS || "";
  const body = await req.text().catch(() => "");
  const ok = await verifySignature(
    secrets,
    parsed.ts,
    req.method,
    pathname,
    body,
    parsed.sig,
  );
  if (!ok) {
    return JSON_ERROR(401, "invalid signature");
  }

  // Forward to relay
  const target = new URL(pathname, relay.toString());
  target.search = url.search;
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${UPSTREAM_API_KEY}`);
  headers.set("x-forwarded-host", url.host);
  headers.delete("x-ofm-timestamp");
  headers.delete("x-ofm-signature");

  try {
    const resp = await fetch(target.toString(), {
      method: req.method,
      headers,
      body: body ? body : undefined,
    });
    const respHeaders = new Headers(resp.headers);
    for (const h of PASS_HEADERS) {
      if (respHeaders.has(h)) headers.set(h, respHeaders.get(h));
    }
    return new Response(resp.body, {
      status: resp.status,
      headers: respHeaders,
    });
  } catch (err) {
    return JSON_ERROR(502, "upstream unavailable");
  }
}

addEventListener("fetch", (event) => {
  event.respondWith(
    handleRequest(event.request).catch(() => JSON_ERROR(500, "internal error")),
  );
});

const UPSTREAM_URL = __ENV__.UPSTREAM_URL;
const UPSTREAM_API_KEY = __ENV__.UPSTREAM_API_KEY;
const SIGNING_SECRETS = __ENV__.SIGNING_SECRETS;
const MOUNT_PREFIX = __ENV__.MOUNT_PREFIX || "";
const CLOCK_SKEW_SECONDS = __ENV__.CLOCK_SKEW_SECONDS || "600";
const MAX_BODY_BYTES = Number(__ENV__.MAX_BODY_BYTES ?? 8388608);
