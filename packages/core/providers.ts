/**
 * Provider registry helpers for the aggregate lane.
 *
 * These are small utilities that the aggregate lane uses to resolve provider
 * endpoints, headers, and model ids. They are kept separate from the lane
 * itself so the same helpers can be used by both the pi provider and the
 * standalone service.
 */

export type Provider = {
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  chatUrl?: string;
  modelsUrl?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  auth?: { kind: string; url?: string };
  format?: string;
};

export type ProviderModelId = string;

/** All known provider ids. */
export const PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "cohere",
  "mistral",
  "groq",
  "together",
  "fireworks",
  "perplexity",
  "deepseek",
  "moonshot",
  "zhipu",
  "baichuan",
  "minimax",
  "stepfun",
  "01-ai",
  "yi",
  "qwen",
  "deepseek",
] as const;

/** Known provider id set for fast membership checks. */
export const PROVIDER_IDS = new Set(PROVIDERS);

/** Supported auth kinds. */
export const AUTH_KINDS = ["api-key", "oauth", "adc", "none"] as const;

/** Category values for provider categorization. */
export const CATEGORY_VALUES = ["free", "paid", "byok"] as const;

/** Supported wire format values. */
export const FORMAT_VALUES = ["openai", "anthropic", "google", "custom"] as const;

/** Providers offered in the aggregate lane. */
export const OFFERED_PROVIDERS = [...PROVIDERS];

/** Resolve the chat endpoint URL for a provider. Falls back to baseUrl + /chat/completions. */
export function chatEndpoint(provider: { chatUrl?: string; baseUrl?: string }): string | null {
  if (provider.chatUrl) return provider.chatUrl;
  if (provider.baseUrl)
    return `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return null;
}

/** Resolve the models listing endpoint for a provider. */
export function modelsEndpoint(provider: { modelsUrl?: string; baseUrl?: string }): string | null {
  if (provider.modelsUrl) return provider.modelsUrl;
  if (provider.baseUrl) return `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  return null;
}

/** Build the full namespaced model id: `providerId/modelId`. */
export function providerModelId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Parse a `provider/model` string into its components. */
export function parseProviderModelId(value: string): { provider: string; model: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** Default headers for a provider request. */
export function defaultHeaders(
  provider: { headers?: Record<string, string> },
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (provider.headers) Object.assign(headers, provider.headers);
  return headers;
}

/** Look up a provider by id from the registry. */
export function getProvider(id: string): Provider | null {
  // The registry is loaded from providers/registry.json at runtime.
  // This is a stub - the real implementation reads from the registry file.
  return null;
}

/** List all registered providers. */
export function listProviders(): string[] {
  return [...PROVIDERS];
}
