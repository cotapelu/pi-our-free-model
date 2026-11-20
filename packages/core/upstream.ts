/**
 * Upstream wire for the免密 free lane.
 *
 * Every fact encoded here was verified against the live gateway: the public pooled
 * credential, the client fingerprint headers, the per-model endpoint split, the
 * free-tier tool-fingerprint gate, the per-session quota accounting, and the regional gate.
 *
 * Ported from dsh's `src/upstream.js`.
 *
 * @module pi-extension/upstream.js
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR_NAME, dataDir } from "@ofm/gateway/store";
import {
  BASE62_ALPHABET,
  CANONICAL_SESSION_RE,
  CLIENT_UA,
  DESCENDING_TIME_RE,
  O2A_VERSION,
  ToolRenameMap,
  canonicalSessionID,
  ensureChatUsage,
  ensureV2CompletionLimit,
  gatewayHeaders as o2aGatewayHeaders,
  injectOfficialPrompt,
  isOfficialSessionID,
  officialTool,
  phaseAgeMs,
  randomID,
  randomProjectID,
  renameAndCompleteTools,
  renamableToolName,
  sessionPhaseMs,
} from "./o2a.js";

export const UPSTREAM_BASE =
  process.env.OUR_FREE_MODEL_BASE ?? "https://opencode.ai";

export { CLIENT_UA };

/** Historical reference version retained for callers; see src/o2a/SYNC.md. */
export const O2A_PORTED_VERSION = O2A_VERSION;

const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const BASE62 = BASE62_ALPHABET;

/** The names the v2 gate validates verbatim. */
export const FINGERPRINT_TOOLS = ["read", "shell"];

/** Models served by /responses instead of /chat/completions. */
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
/** Models served by the Anthropic-shaped /messages endpoint. */
const MESSAGES_MODELS = new Set(["union-alpha"]);

export const SESSION_RE = CANONICAL_SESSION_RE;

export const SESSION_DESCENDING_RE = DESCENDING_TIME_RE;

const SESSION_PLAUSIBILITY_MS = 60 * 24 * 60 * 60 * 1000;

/** Whether `id` is a session the upstream free tier will accept as-is. */
export function isCanonicalSession(id: string): boolean {
  return (
    typeof id === "string" &&
    SESSION_RE.test(id.trim()) &&
    SESSION_DESCENDING_RE.test(id.trim().slice(4, 16))
  );
}

const SESSION_MAP_FILE = "session-map.json";
let sessions: Map<string, string> | undefined;

function sessionStorePath(): string | undefined {
  try {
    return path.join(path.resolve(dataDir(), DATA_DIR_NAME), SESSION_MAP_FILE);
  } catch {
    return undefined;
  }
}

function loadSessions(): Map<string, string> {
  if (sessions !== undefined) return sessions;
  sessions = new Map();
  try {
    const file = sessionStorePath();
    if (file === undefined) return sessions;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [seed, id] of Object.entries(parsed?.sessions ?? {})) {
      if (typeof id === "string" && SESSION_RE.test(id)) sessions.set(seed, id);
    }
  } catch {
    /* first run or unreadable store: start empty */
  }
  return sessions;
}

function rememberSession(seed: string, id: string) {
  loadSessions().set(seed, id);
  try {
    const file = sessionStorePath();
    if (file === undefined) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify(
        {
          version: 2,
          at: Date.now(),
          sessions: Object.fromEntries(sessions ?? []),
        },
        undefined,
        2,
      ),
    );
    fs.renameSync(temp, file);
  } catch {
    /* non-fatal */
  }
}

/**
 * Whether a canonical session's embedded time phase is inside the accepted
 * window.
 */
function plausibleSession(id: string): boolean {
  const phase = sessionPhaseMs(id);
  return phase !== null && phaseAgeMs(phase) < SESSION_PLAUSIBILITY_MS;
}

/**
 * Map one downstream conversation onto one stable upstream session.
 *
 * Mint once and persist the result. Never rotate IDs on retries or model
 * errors.
 */
export function sessionForConversation(sessionId: string): string {
  if (typeof sessionId === "string" && isCanonicalSession(sessionId))
    return sessionId.trim();
  const seed =
    typeof sessionId === "string" && sessionId.trim()
      ? sessionId.trim()
      : "global";
  const remembered = loadSessions().get(seed);
  if (
    remembered !== undefined &&
    isCanonicalSession(remembered) &&
    plausibleSession(remembered)
  )
    return remembered;
  const minted = canonicalizeSession(seed);
  rememberSession(seed, minted);
  return minted;
}

/** Strip a trailing "(level)" thinking suffix so lookups hit the base id. */
export function baseModelId(model: string | undefined): string {
  return String(model ?? "")
    .replace(/\([^()]+\)\s*$/, "")
    .trim();
}

function isMuseSpark(modelId: string): boolean {
  const clean = baseModelId(modelId);
  const base = (clean.includes("/") ? clean.split("/").pop() : clean) as string;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}

export function isResponsesModel(modelId: string): boolean {
  return RESPONSES_MODELS.has(baseModelId(modelId)) || isMuseSpark(modelId);
}

export function isMessagesModel(modelId: string): boolean {
  return MESSAGES_MODELS.has(baseModelId(modelId));
}

/** Which upstream path serves this model. */
export function endpointFor(modelId: string): string {
  if (isResponsesModel(modelId)) return "/inference/openai/v1/responses";
  if (isMessagesModel(modelId))
    return "/inference/anthropic/v1/messages?beta=true";
  return "/inference/openai/v1/chat/completions";
}

/** The wire shape one endpoint speaks; drives request encoding and response parsing. */
export function wireFor(modelId: string): string {
  if (isResponsesModel(modelId)) return "responses";
  if (isMessagesModel(modelId)) return "messages";
  return "chat";
}

const TITLE_MARKERS =
  /generate a title|write a title|create a title|come up with a title|title (?:for|of) (?:this|the) (?:conversation|chat|session|exchange|request)|conversation title|summarize (?:this|the) conversation/i;

export function isTitleRequest(body: any, style: boolean | "claude"): boolean {
  if (!body || typeof body !== "object") return false;
  if (
    body.tool_choice !== undefined ||
    (Array.isArray(body.tools) && body.tools.length) ||
    (Array.isArray(body.functions) && body.functions.length)
  )
    return false;
  const shape = shapeOf(style);
  const rows = shape === "flat" ? body.input : body.messages;
  if (!Array.isArray(rows)) return false;
  const containsTitle = (value: any): boolean => {
    if (typeof value === "string") return TITLE_MARKERS.test(value);
    if (!Array.isArray(value)) return false;
    return TITLE_MARKERS.test(
      value.map((block: any) => block?.text ?? "").join("\n"),
    );
  };
  let matches = containsTitle(
    shape === "flat"
      ? body.instructions
      : shape === "claude"
        ? body.system
        : "",
  );
  let count = 0;
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      (shape === "flat" && typeof row.role !== "string")
    )
      continue;
    if (++count > 3 || !["user", "system", "developer"].includes(row.role))
      return false;
    matches = containsTitle(row.content) || matches;
  }
  return count > 0 && matches;
}

function definitionOf(
  entry: any,
  shape: string,
): { description: string; schema: any } | null {
  if (!entry || typeof entry !== "object") return null;
  const wrapper = shape === "chat" ? entry.function : entry;
  if (wrapper === null || wrapper === undefined || typeof wrapper !== "object")
    return null;
  const schema = shape === "claude" ? wrapper.input_schema : wrapper.parameters;
  return { description: wrapper.description, schema };
}

function shapeOf(style: boolean | "claude"): string {
  return style === true ? "flat" : style === "claude" ? "claude" : "chat";
}

/** The Anthropic API version the Messages lane sends. */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** A fresh per-request project id, exposed for callers that want to pin the same id across a retried turn. */
export function randomProjectId(): string {
  return randomProjectID();
}

/** Restore the caller's tool spelling in a streaming delta or a final payload. */
export function restoreToolName(
  name: string | undefined,
  map?: Map<string, string>,
): string {
  if (!map || map.size === 0 || !name) return name ?? "";
  return map.get(name) ?? name;
}

/** Session-scoped identity used to pick a decoy out of a real tool call. */
export function declaredToolNames(body: any): Set<string> {
  const names = new Set<string>();
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const n = toolNameOf(tool);
    if (n) names.add(n);
  }
  return names;
}

function toolNameOf(tool: any): string | null {
  const name = tool?.function?.name ?? tool?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

export function canonicalizeSession(seed: string): string {
  return canonicalSessionID(seed);
}

/** Adapt a request to the free-lane wire contract using OFM-authored prompts and tool schemas. */
export function applyFingerprint(
  body: any,
  style: boolean | "claude",
): ToolRenameMap {
  const shape = shapeOf(style);
  if (!body || typeof body !== "object") return new ToolRenameMap();

  // 0. Title requests ship unshaped
  if (isTitleRequest(body, style)) return new ToolRenameMap();

  // 1. Official system prompt
  injectOfficialPrompt(body, shape);

  // 2.+3. Tool pass: rename client tools, append the official set
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const keep = new Set<string>();
  for (const tool of tools) {
    const name = renamableToolName(shape, tool);
    if (name !== null && carriesOfficialDefinition(tool, name, shape)) {
      keep.add(name);
    }
  }
  const { renames, injected } = renameAndCompleteTools(body, shape, { keep });

  // 4b. The injected officials need the placeholder note.
  if (injected.length > 0) noteInjectedTools(body, shape, injected);

  // 5. Never ship tool_choice none; default the Responses wire to auto.
  if (
    body.tool_choice === "none" ||
    (body.tool_choice !== null &&
      typeof body.tool_choice === "object" &&
      body.tool_choice.type === "none")
  ) {
    delete body.tool_choice;
  }
  if (shape === "flat" && !body.tool_choice) body.tool_choice = "auto";

  // 6. The chat body's own constants.
  ensureChatUsage(body, shape);
  ensureV2CompletionLimit(body, shape);
  return renames;
}

function carriesOfficialDefinition(
  entry: any,
  name: string,
  shape: string,
): boolean {
  const own = definitionOf(entry, shape);
  if (own === null) return false;
  const rendered = officialTool(shape, name);
  const wrapper = shape === "chat" ? rendered.function : rendered;
  if (!wrapper) return false;
  return (
    own.description === wrapper.description &&
    JSON.stringify(own.schema) === JSON.stringify(wrapper.parameters)
  );
}

function placeholderNote(names: string[]): string {
  const list = names.map((name) => `\`${name}\``).join(", ");
  return `The tools ${list} are part of the host CLI's own toolset and are placeholders in this session; they do nothing here. Use the other tools you have been given instead.`;
}

function appendSystemContext(body: any, shape: string, note: string) {
  if (shape === "flat") {
    body.instructions =
      typeof body.instructions === "string" && body.instructions.trim() !== ""
        ? `${body.instructions}\n\n${note}`
        : note;
    return;
  }
  if (shape === "claude") {
    body.system = Array.isArray(body.system)
      ? [...body.system, { type: "text", text: note }]
      : typeof body.system === "string" && body.system !== ""
        ? `${body.system}\n\n${note}`
        : note;
    return;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [
      { ...first, content: `${first.content}\n\n${note}` },
      ...messages.slice(1),
    ];
    return;
  }
  if (first?.role === "system" && Array.isArray(first.content)) {
    body.messages = [
      { ...first, content: [...first.content, { type: "text", text: note }] },
      ...messages.slice(1),
    ];
    return;
  }
  body.messages = [{ role: "system", content: note }, ...messages];
}

function noteInjectedTools(body: any, shape: string, names: string[]) {
  appendSystemContext(body, shape, placeholderNote(names));
}

/** Ensure free-lane environment context is present in the request body. */
export function ensureFreeLaneEnvironment(
  body: any,
  style: boolean | "claude",
  environment: Record<string, any> = {},
) {
  const shape = shapeOf(style);
  const textOf = (value: any) =>
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map((part: any) => part?.text ?? "").join("\n")
        : "";
  const existing =
    shape === "flat"
      ? textOf(body.instructions)
      : shape === "claude"
        ? textOf(body.system)
        : (Array.isArray(body.messages) ? body.messages : [])
            .filter(
              (message: any) =>
                message?.role === "system" || message?.role === "developer",
            )
            .map((message: any) => textOf(message.content))
            .join("\n");
  if (/<env>[\s\S]*?<\/env>/i.test(existing)) return;
  const line = (value: any) => String(value).replace(/[\r\n<>]/g, " ");
  const cwd = environment.directory ?? process.cwd();
  const platform = environment.platform ?? process.platform;
  appendSystemContext(
    body,
    shape,
    `Here is some useful information about the environment you are running in:\n<env>\n  Working directory: ${line(cwd)}\n  Platform: ${line(platform)}\n</env>`,
  );
}

/** Error codes used by the upstream wire. */
export const CODE = {
  server: "SERVER_ERROR",
  client: "CLIENT_ERROR",
  region: "REGION_BLOCKED",
  aborted: "ABORTED",
  empty: "EMPTY_RESPONSE",
  transport: "TRANSPORT_ERROR",
  timeout: "TIMEOUT",
  quota: "QUOTA_EXCEEDED",
  laneLocked: "LANE_LOCKED",
  credential: "CREDENTIAL_REFUSED",
} as const;

/** Custom error for upstream failures with a machine-readable code. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly extra?: { status?: number },
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Generate a unique request ID for streaming. */
export function mintRequestId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Post a streamed request to the upstream free lane.
 * Accepts either (url, body, options) or a single options object with path/body/session/etc.
 */
export async function postStreamed(
  urlOrOptions:
    | string
    | {
        path: string;
        body: any;
        session?: string;
        attributionUserAgent?: string;
        signal?: AbortSignal;
        timeoutMs?: number;
        onData?: (payload: string) => void;
      },
  body?: any,
  options: RequestInit = {},
): Promise<Response> {
  let url: string;
  let requestBody: any;
  let requestOptions: RequestInit = {};

  if (typeof urlOrOptions === "string") {
    url = urlOrOptions;
    requestBody = body;
    requestOptions = options;
  } else {
    url = UPSTREAM_BASE + urlOrOptions.path;
    requestBody = urlOrOptions.body;
    requestOptions = {
      signal: urlOrOptions.signal,
      headers: urlOrOptions.attributionUserAgent
        ? { "user-agent": urlOrOptions.attributionUserAgent }
        : undefined,
    } as RequestInit;
  }

  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...requestOptions.headers },
    body: JSON.stringify(requestBody),
    signal: requestOptions.signal,
  });
}

/** Fetch JSON from a URL with timeout. */
export async function getJson(
  url: string,
  options: RequestInit & {
    timeout?: number;
    session?: string;
    attributionUserAgent?: string;
  } = {},
): Promise<any> {
  const {
    timeout = 10_000,
    session,
    attributionUserAgent,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        ...(attributionUserAgent ? { "user-agent": attributionUserAgent } : {}),
        ...(fetchOptions as any)?.headers,
      } as Record<string, string>,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Truncate a session id to MAX_SESSION_LENGTH characters. */
function truncateSession(value: any): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > MAX_SESSION_LENGTH
    ? trimmed.slice(0, MAX_SESSION_LENGTH)
    : trimmed;
}

/** Harness tool schemas -> the shape each provider expects. */
export function toToolDefs(
  tools: any[],
  style: "chat" | "claude" | "flat" = "chat",
): any[] {
  const list: any[] = [];
  for (const tool of tools ?? []) {
    const source =
      tool &&
      typeof tool.function === "object" &&
      tool.function !== null &&
      !Array.isArray(tool.function)
        ? tool.function
        : tool;
    const name = String(source?.name ?? "").trim();
    if (!name) continue;
    const parameters =
      source.parameters &&
      typeof source.parameters === "object" &&
      !Array.isArray(source.parameters)
        ? source.parameters
        : { type: "object", properties: {} };
    const description =
      typeof source.description === "string" ? source.description : "";
    if (style === "claude")
      list.push({
        name: name.slice(0, MAX_TOOL_NAME_LEN),
        description,
        input_schema: parameters,
      });
    else if (style === "flat")
      list.push({
        type: "function",
        name: name.slice(0, MAX_TOOL_NAME_LEN),
        description,
        parameters,
      });
    else
      list.push({
        type: "function",
        function: {
          name: name.slice(0, MAX_TOOL_NAME_LEN),
          description,
          parameters,
        },
      });
  }
  return list;
}

/** Does this content list need an image-capable model? */
export function needsVision(messages: any[] | undefined): boolean {
  return (messages ?? []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (block: any) => block?.type === "image" && block.offloaded !== true,
      ),
  );
}
