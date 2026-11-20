/**
 * Environment variable schema validation.
 * Uses zod for runtime validation of all environment variables.
 */

import { z } from "zod";

export const EnvSchema = z.object({
  /** Data directory for storing settings, cache, keys, etc. */
  OFM_DATA_DIR: z.string().default(() => {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    return `${home}/.our-free-model`;
  }),

  /** Gateway server port */
  OFM_GATEWAY_PORT: z.coerce
    .number()
    .int()
    .positive()
    .max(65535)
    .default(18900),

  /** Gateway server host */
  OFM_GATEWAY_HOST: z.string().default("127.0.0.1"),

  /** Gateway API key (generated if not provided) */
  OFM_GATEWAY_KEY: z.string().min(8).optional(),

  /** Enable LAN relay */
  OFM_LAN_ENABLED: z.coerce.boolean().default(false),

  /** LAN relay port (0 = auto) */
  OFM_LAN_PORT: z.coerce.number().int().min(0).max(65535).default(0),

  /** Log level */
  OFM_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  /** Skip automatic refresh on startup */
  OFM_NO_REFRESH: z.coerce.boolean().default(false),

  /** Desktop version for auto-update */
  OFM_DESKTOP_VERSION: z.string().optional(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Validates and parses environment variables.
 * Throws a formatted error if validation fails.
 */
export function validateEnv(): EnvConfig {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${errors}`);
  }
  return result.data;
}

/**
 * Gets validated environment config, with defaults applied.
 * Caches the result after first call.
 */
let cachedEnv: EnvConfig | null = null;
export function getEnv(): EnvConfig {
  if (!cachedEnv) cachedEnv = validateEnv();
  return cachedEnv;
}
