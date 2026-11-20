/**
 * Default configuration values.
 * These are the fallback values used when environment variables are not set.
 */

export const DEFAULTS = {
  /** Default data directory */
  DATA_DIR: (() => {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    return `${home}/.our-free-model`;
  })(),

  /** Default gateway port */
  GATEWAY_PORT: 18900,

  /** Default gateway host */
  GATEWAY_HOST: "127.0.0.1",

  /** Default log level */
  LOG_LEVEL: "info" as const,

  /** Default LAN settings */
  LAN_ENABLED: false,
  LAN_PORT: 0,

  /** Default refresh behavior */
  NO_REFRESH: false,

  /** Timeouts */
  TIMEOUTS: {
    API_DEFAULT: 8_000,
    API_POST: 30_000,
    API_EAC_STATUS: 20_000,
    API_EAC_POOL: 25_000,
    API_BENCH: 300_000,
    API_UPDATE: 300_000,
  },

  /** File permissions */
  PERMISSIONS: {
    DATA_DIR: 0o700,
    SETTINGS_FILE: 0o600,
    KEY_FILE: 0o600,
  },

  /** Session durations (ms) */
  SESSION: {
    BOOTSTRAP: 10 * 60 * 1000, // 10 minutes
    MANAGEMENT: 8 * 60 * 60 * 1000, // 8 hours
  },

  /** Heartbeat interval (ms) */
  HEARTBEAT_MS: 15_000,

  /** Probe intervals */
  PROBE: {
    INTERVAL_MINUTES: 15,
    MIN_INTERVAL: 1,
    MAX_INTERVAL: 1440,
  },

  /** Token limits */
  TOKENS: {
    DEFAULT_MAX: 32768,
    MIN_MAX: 512,
    MAX_MAX: 131072,
  },
} as const;

export type Defaults = typeof DEFAULTS;
