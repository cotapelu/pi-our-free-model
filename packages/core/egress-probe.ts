/**
 * Availability probing, in the catalog-row vocabulary the service entries speak.
 *
 * The gateway does not disclose which models this egress may use: the model
 * listing is a flat id list, and exclusion only appears when a request is
 * refused with a `RegionError`. Availability is therefore established by asking,
 * with the smallest request that can produce a verdict.
 *
 * Egress is watched alongside it because the answer is a property of the
 * network path, not of the account: turning a VPN on changes which models exist
 * for the user, and the picker has to follow without a restart. The cheapest
 * reliable signal is the public address the gateway itself sees.
 *
 * This is the `src/probe.js` half the extension's own prober
 * (`gateway/probe.ts`) does not cover: that one drives pi's turn loop and speaks
 * the wire's verdict codes, while this one drives the *service* runtime and
 * speaks the upstream classification vocabulary of `core/upstream.ts`. The
 * verdict strings themselves (`STATE`) are shared, because they are what the
 * picker reads in both entries.
 *
 * Ported from dsh's `src/probe.js`.
 *
 * @module pi-extension/core/egress-probe.js
 */

import { applyFingerprintWire } from "@ofm/core/fingerprint";
import {
  CODE,
  UpstreamError,
  endpointFor,
  postStreamed,
  sessionForConversation,
  wireFor,
  UPSTREAM_BASE,
} from "./upstream.js";
import { STATE } from "@ofm/gateway/probe";
import type { LaneModels } from "@ofm/gateway/dispatch";
import { ROUTE_MAIN, ROUTE_REGION } from "./catalog.js";

export { STATE };

/** Public-echo sources, tried in order; any one answering is enough. */
const ECHO_SOURCES: Array<{
  url: string;
  pick: (payload: any) => unknown;
  extra?: (payload: any) => unknown;
}> = [
  { url: "https://api.ipify.org?format=json", pick: (payload) => payload?.ip },
  {
    url: "https://ipinfo.io/json",
    pick: (payload) => payload?.ip,
    extra: (payload) => payload?.country,
  },
  {
    url: "https://ipapi.co/json/",
    pick: (payload) => payload?.ip,
    extra: (payload) => payload?.country_code,
  },
];

const PING_PROMPT = "ping";

/**
 * Ask the gateway for one model, once.
 *
 * Each model gets its own upstream session: the quota is accounted per session,
 * so one session for a whole round lets the first model eat the quota and every
 * later model read as 429 (issue #561).
 */
export async function probeModel(
  model: any,
  {
    attributionUserAgent,
    signal,
    timeoutMs = 45000,
  }: {
    attributionUserAgent?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<{
  state: string;
  detail?: string;
  latencyMs: number;
  ttftMs?: number;
}> {
  const started = Date.now();
  const session = sessionForConversation("probe:our-free-model:" + model.id);
  const wire = wireFor(model.id);
  const body = buildPing(model.id, wire);
  // 三条线各有自己的工具形状：Responses 是扁平项，Messages 是 Claude 的
  // `input_schema`，Chat 是 `{function:{…}}`。传错形状会让注入的指纹工具不合规。
  applyFingerprintWire(
    body,
    wire === "responses" ? true : wire === "messages" ? "claude" : false,
  );

  try {
    await postStreamed(UPSTREAM_BASE + endpointFor(model.id), body, { signal });
  } catch (error) {
    return {
      state: stateOf(error),
      detail:
        typeof (error as Error)?.message === "string"
          ? (error as Error).message.slice(0, 200)
          : String(error),
      latencyMs: Date.now() - started,
    };
  }
  return {
    state: STATE.available,
    latencyMs: Date.now() - started,
    ttftMs: undefined,
  };
}

function buildPing(modelId: string, wire: string): any {
  if (wire === "responses") {
    return {
      model: modelId,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: PING_PROMPT }],
        },
      ],
      stream: true,
      store: false,
      max_output_tokens: 16,
    };
  }
  if (wire === "messages") {
    return {
      model: modelId,
      messages: [{ role: "user", content: PING_PROMPT }],
      stream: true,
      max_tokens: 16,
    };
  }
  return {
    model: modelId,
    messages: [{ role: "user", content: PING_PROMPT }],
    stream: true,
    max_tokens: 16,
  };
}

/**
 * Map one probe failure onto a verdict.
 *
 * The line that matters is whether the gateway *named this model as something it
 * will not route*. Only those readings come from the answer itself: a refusal
 * whose message is about the model (`Model is unavailable`, `not supported`,
 * `no such model`), or a status whose whole meaning is the identifier in the body
 * we sent — 400 for a model it rejects, 404 for one it no longer has, 422 for a
 * route that refuses the pair. Those read as unavailable and the picker drops the
 * model.
 *
 * Everything else says nothing about the model and must not move it:
 * - 5xx, including 503, is the gateway's own trouble. It is the single most
 *   common thing an overloaded pooled account says, and this lane's own history
 *   has it returning 5xx for reasons that had nothing to do with the model.
 *   Its *words* must not be read as a verdict either: a reverse proxy answers a
 *   503 with the reason phrase "Service Unavailable", and matching that text
 *   took a working model out of the picker.
 * - 401/403/407 is the pooled credential, and 408/425/429 is capacity or
 *   transport — the next window can answer.
 * - no status at all (transport, abort, timeout, a stream that died before any
 *   header) means no answer was received.
 *
 * The asymmetry is deliberate: a stale entry in the picker costs the user one
 * failed turn they can retry, while a model that vanished on a hiccup costs the
 * `reprobe`-then-wait cycle the user has no visibility into.
 */
const ROUTING_REFUSAL_STATUS = new Set([400, 404, 422]);

function stateOf(error: any): string {
  switch (error?.code) {
    case CODE.region:
      return STATE.regionBlocked;
    case CODE.quota:
      return STATE.throttled;
    case CODE.laneLocked:
      return STATE.unavailable;
    case CODE.credential:
      return STATE.unavailable;
    default:
      break;
  }
  const message = String(error?.message ?? "");
  const gatewayTrouble = Number.isInteger(error?.status) && error.status >= 500;
  const named =
    error?.unavailable === true ||
    (!gatewayTrouble &&
      /unavailable|unsupported|not supported|no such model|unknown model|invalid model/i.test(
        message,
      ));
  if (named) return STATE.unavailable;
  if (
    Number.isInteger(error?.status) &&
    ROUTING_REFUSAL_STATUS.has(error.status)
  )
    return STATE.unavailable;
  return STATE.unknown;
}

/**
 * Resolve the public address the gateway will see, plus its country when an echo
 * discloses one. Fail-open: an absent answer simply means "no egress signal".
 */
export async function detectEgress({
  signal,
  timeoutMs = 8000,
}: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<
  { ip: string; country?: string } | undefined
> {
  for (const source of ECHO_SOURCES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const relayAbort = () => controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      const response = await fetch(source.url, {
        signal: controller.signal,
        redirect: "error",
        headers: { accept: "application/json" },
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as Record<string, any>;
      const ip = source.pick(payload);
      if (typeof ip !== "string" || ip === "") continue;
      const extra = source.extra?.(payload);
      const country =
        typeof extra === "string" && extra !== ""
          ? extra.toUpperCase()
          : undefined;
      return { ip, country };
    } catch {
      /* next source */
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relayAbort);
    }
  }
}

/**
 * Build the catalog membership from probe results and the live listing.
 *
 * `models` is the gateway's full roster (from `modelRows`). `probes` is the
 * per-model verdict from `probeModel`. The membership says which route a model
 * belongs to (`main` or `region`), and which models exist at all right now.
 *
 * The fold is the part that needs explaining. When *every* free-lane model comes
 * back region-blocked, the roster is not trimmed to the paid lanes — it is served
 * in full under the main route. A machine whose VPN is off otherwise shows an
 * empty picker, which reads as "this extension is broken" rather than "your egress
 * changed"; and a device that has genuinely lost access to a model would learn
 * that from the turn's own failure, which is where the information is actionable.
 */
export function computeMembership(
  models: any[],
  probes: Map<
    string,
    { state: string; detail?: string; latencyMs: number; ttftMs?: number }
  >,
): {
  "our-free-model": string[];
  "our-free-model-region": string[];
  egress?: { ip: string; country?: string };
} {
  const main: string[] = [];
  const region: string[] = [];
  let allRegionBlocked = true;
  let hasAvailable = false;

  for (const model of models) {
    const result = probes.get(model.id);
    if (result === undefined) continue;
    const state = result.state;
    if (state === STATE.available) {
      hasAvailable = true;
      allRegionBlocked = false;
      main.push(model.id);
    } else if (state === STATE.regionBlocked) {
      region.push(model.id);
    } else if (state === STATE.throttled) {
      main.push(model.id);
    } else if (state === STATE.unavailable) {
      // skip
    } else {
      allRegionBlocked = false;
      main.push(model.id);
    }
  }

  if (allRegionBlocked && !hasAvailable && main.length > 0) {
    // Every model that answered is region-blocked — serve all under main so the
    // picker is not empty.
    const all: string[] = [];
    for (const model of models) {
      const result = probes.get(model.id);
      if (result !== undefined && result.state !== STATE.unavailable)
        all.push(model.id);
    }
    return { "our-free-model": all, "our-free-model-region": [] };
  }

  return { "our-free-model": main, "our-free-model-region": region };
}

/**
 * Scan the egress once and probe every model in the listing.
 *
 * The round is single-pass: the listing comes from the gateway's own cache,
 * which is the truth for "what models exist right now". We don't re-fetch the
 * listing mid-round; a new listing is a new round.
 */
export async function probeCatalog(
  models: any[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    attributionUserAgent?: string;
  } = {},
  onProgress?: (
    id: string,
    result: {
      state: string;
      detail?: string;
      latencyMs: number;
      ttftMs?: number;
      startedAt?: number;
    },
  ) => void,
): Promise<{
  membership: {
    "our-free-model": string[];
    "our-free-model-region": string[];
    egress?: { ip: string; country?: string };
  };
  probes: Map<
    string,
    { state: string; detail?: string; latencyMs: number; ttftMs?: number }
  >;
  results: Record<
    string,
    { state: string; detail?: string; latencyMs: number; startedAt?: number }
  >;
  egress?: { ip: string; country?: string };
}> {
  const { signal, timeoutMs = 45000, attributionUserAgent } = options;
  const { modelRows } = await import("@ofm/gateway/dispatch");
  const laneModels: LaneModels = {};
  const allModels = modelRows(laneModels);
  const egress = await detectEgress({ signal, timeoutMs: 8000 });

  const probes = new Map<
    string,
    { state: string; detail?: string; latencyMs: number; ttftMs?: number }
  >();
  const results: Record<
    string,
    { state: string; detail?: string; latencyMs: number; startedAt?: number }
  > = {};

  for (const model of models) {
    if (signal?.aborted) break;
    const startedAt = Date.now();
    const result = await probeModel(model, {
      attributionUserAgent,
      signal,
      timeoutMs,
    });
    const entry: {
      state: string;
      detail?: string;
      latencyMs: number;
      ttftMs?: number;
      startedAt?: number;
    } = {
      state: result.state,
      latencyMs: result.latencyMs,
      startedAt,
    };
    if (result.detail !== undefined) entry.detail = result.detail;
    if (result.ttftMs !== undefined) entry.ttftMs = result.ttftMs;
    probes.set(model.id, result);
    results[model.id] = entry;
    onProgress?.(model.id, {
      ...entry,
      detail: entry.detail,
      ttftMs: entry.ttftMs,
    });
  }

  const membership = computeMembership(allModels, probes);
  return { membership, probes, results, egress };
}
