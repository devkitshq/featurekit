/**
 * Configuration (§17).
 *
 * **The defaults are for laptops, never for prod.** Development starts
 * containers and binds to localhost; production start fails loudly on a missing
 * `DATABASE_URL`, `REDIS_URL`, `ADMIN_TOKEN`, or — if any client key exists —
 * `SECURE_MODE_SECRET`.
 *
 * Every missing variable is reported at once. Three restarts to discover three
 * missing variables is three outages.
 *
 * @see docs/control-plane/configuration.md
 */

import { z } from "zod";

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(logLevels).default("info"),
    /**
     * `0` means "let the OS choose an ephemeral port". Tests and some sandboxed
     * runtimes need it, and forbidding it buys nothing — a misconfigured port is
     * caught by the bind failing, not by this range.
     */
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    HOST: z.string().default("127.0.0.1"),
    DATABASE_URL: z
      .url()
      .default("postgres://featurekit:featurekit@localhost:5432/featurekit"),
    REDIS_URL: z.url().default("redis://localhost:6379"),
    /** TLS to a managed Redis. A `rediss://` URL implies it; this forces it. */
    REDIS_TLS: z.coerce.boolean().default(false),
    /** Off only for a self-signed certificate you have deliberately trusted. */
    REDIS_TLS_REJECT_UNAUTHORIZED: z.coerce.boolean().default(true),
    REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    /** Bounds any single Redis command, so a hung server cannot hang a request. */
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(50).max(30_000).default(2_000),
    /**
     * Consecutive Redis failures before commands fail fast.
     *
     * The last-known-good path is only useful if reaching it is fast. Without a
     * breaker every request during an outage pays a connection attempt and a
     * command timeout before falling back to a snapshot already in memory.
     */
    REDIS_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
    REDIS_CIRCUIT_RESET_MS: z.coerce.number().int().min(100).default(5_000),

    ADMIN_TOKEN: z.string().min(24).optional(),
    /**
     * Signs client-tier context HMACs. Comma-separated for rotation: sign with
     * the first, verify against all. Required in production once a client key
     * exists (§16).
     */
    SECURE_MODE_SECRET: z.string().min(32).optional(),
    /** Longest signature lifetime the server will honour, whatever was signed. */
    SECURE_MODE_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(604_800).default(86_400),

    /**
     * Origins allowed to call the client tier, comma-separated. Exact matches
     * only, and never `*`: the client tier answers with a browser's flag values
     * (§16). Empty means same-origin only, which is correct for a deployment
     * that serves its app and its flags from one host.
     */
    CORS_ALLOWED_ORIGINS: z.string().default(""),
    /**
     * Environment ids that may evaluate unsigned contexts even in production.
     * An explicit, auditable list — the default for a production environment is
     * to require a signature (§16).
     */
    UNSIGNED_CONTEXT_ENVIRONMENT_IDS: z.string().default(""),

    /** Per-identity request ceilings, per minute (§15, §22). */
    RATE_LIMIT_CLIENT_STATE_PER_MIN: z.coerce.number().int().min(1).default(600),
    RATE_LIMIT_SNAPSHOT_PER_MIN: z.coerce.number().int().min(1).default(240),
    RATE_LIMIT_STREAM_PER_MIN: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_EVENTS_PER_MIN: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_ADMIN_PER_MIN: z.coerce.number().int().min(1).default(300),
    /**
     * Login attempts per minute, per caller.
     *
     * Far lower than every other limit, because this is the one endpoint where
     * the cost of an attempt is paid by us (scrypt) and the value of guessing is
     * paid by everyone.
     */
    RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().min(1).default(10),
    /**
     * Per-environment rate limit overrides.
     *
     * `env:route:limit` triples, comma-separated — for example
     * `production:/v1/snapshot/:envKey:2000`. One customer's mobile fleet polls
     * harder than another's batch job, and a single global ceiling ends up set
     * by whoever complains loudest.
     */
    RATE_LIMIT_OVERRIDES: z.string().default(""),
    /** Share of a limit one node allows alone when Redis is unreachable. */
    RATE_LIMIT_DEGRADED_FACTOR: z.coerce.number().min(0.05).max(1).default(0.5),

    /**
     * Where the built dashboard lives, and whether to serve it.
     *
     * Empty means the package's own `dashboard/dist`. `off` disables the UI
     * entirely — for a deployment that puts its control plane on a network
     * where a browser has no business being.
     */
    DASHBOARD: z.string().default(""),
    DASHBOARD_PATH: z.string().default("/admin"),
    /**
     * The first account, created on start if it does not exist.
     *
     * How a fresh deployment gets a login without a shell. Both must be set;
     * the password obeys the same policy as one typed into the UI.
     */
    FEATUREKIT_ADMIN_EMAIL: z.string().optional(),
    FEATUREKIT_ADMIN_PASSWORD: z.string().optional(),

    /** Revocation bound for the SDK-key lookup cache (§16). */
    SDK_KEY_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
    /** How long a drain gets before sockets are closed (§16 rolling deploys). */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
    /** Below this many days of partition runway, readiness fails (§7.9). */
    PARTITION_RUNWAY_MIN_DAYS: z.coerce.number().int().min(0).default(2),

    SNAPSHOT_DEBOUNCE_MS: z.coerce.number().int().min(0).default(200),
    PATCH_HISTORY_DEPTH: z.coerce.number().int().min(0).default(200),
    MAX_STREAM_CONNECTIONS: z.coerce.number().int().min(1).default(10_000),
    MAX_CLIENT_CONNECTIONS: z.coerce.number().int().min(1).default(50_000),
    STREAM_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(30_000),

    SEGMENT_INLINE_MAX: z.coerce.number().int().min(0).default(50_000),
    /**
     * Most members a single compile will read for one segment.
     *
     * Beyond this the compile fails loudly and the previous snapshot keeps
     * serving. Truncating instead would build a membership filter from part of
     * the list, which answers "not a member" for real members — and under a
     * negated segment clause that grants the gated feature to exactly the wrong
     * people (§22.3).
     */
    SEGMENT_MEMBER_CEILING: z.coerce.number().int().min(1_000).default(2_000_000),
    /** Rows per round trip while reading segment members. */
    SEGMENT_MEMBER_PAGE_SIZE: z.coerce.number().int().min(1_000).max(100_000).default(25_000),
    SEGMENT_REFRESH_MS: z.coerce.number().int().min(1000).default(60_000),
    /** `"auto"` prefers roaring when the context key is integral (§9.7). */
    SEGMENT_FILTER: z.enum(["auto", "roaring", "cuckoo"]).default("auto"),
    /** 16 is byte-aligned (eps ~ 0.012%); 12 trades accuracy for ~25% space. */
    SEGMENT_CUCKOO_FINGERPRINT_BITS: z.coerce
      .number()
      .refine((n): n is 12 | 16 => n === 12 || n === 16, {
        message: "must be 12 or 16 — the cuckoo wire format is frozen (§9.7)",
      })
      .default(16),
    SEGMENT_CUCKOO_LOAD_FACTOR: z.coerce.number().min(0.5).max(0.9).default(0.8),
    /** Above this, an incremental patch is refused and a full re-encode emitted. */
    SEGMENT_CUCKOO_PATCH_CEILING: z.coerce.number().min(0.5).max(0.95).default(0.85),
    /** SDK-side: confirmed-membership LRU when a remote provider is used. */
    SEGMENT_CACHE_LRU_MAX: z.coerce.number().int().min(1_000).default(100_000),

    /**
     * How long a client connection handle stays resumable on another node.
     *
     * The record lives in Redis so any node can take over a stream (§11.5).
     * Long enough to survive a reconnect and a rolling deploy; short enough
     * that abandoned browsers do not accumulate.
     */
    CLIENT_CONNECTION_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),

    /** Client-tier fingerprint fan-out (§11.5). */
    CLIENT_EVAL_CACHE_MAX: z.coerce.number().int().min(100).default(50_000),
    CLIENT_FANOUT_BATCH: z.coerce.number().int().min(1).default(500),

    EVENT_BUFFER_MAX: z.coerce.number().int().min(1000).default(100_000),
    EVENT_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
    ROLLUP_SHARDS: z.coerce.number().int().min(1).default(8),
    ROLLUP_BUCKET_SECONDS: z.coerce.number().int().min(60).default(60),
    /** Written into partman.part_config at migration time — not read at runtime (§7.9). */
    ROLLUP_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
    ROLLUP_PARTITION_PREMAKE_DAYS: z.coerce.number().int().min(2).default(7),

    /** How often a node looks for scheduled changes that are due. */
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
    /**
     * How late a scheduled change may still fire.
     *
     * Past this it is marked failed instead. A change scheduled for 09:00 must
     * not turn a feature on at 15:00 because the fleet was down in between —
     * fires-late is worse than does-not-fire, because nobody is watching.
     */
    SCHEDULER_GRACE_MS: z.coerce.number().int().min(0).default(3_600_000),

    DB_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(10),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  })
  .refine(
    (c) => c.SEGMENT_CUCKOO_PATCH_CEILING > c.SEGMENT_CUCKOO_LOAD_FACTOR,
    {
      message:
        "SEGMENT_CUCKOO_PATCH_CEILING must exceed SEGMENT_CUCKOO_LOAD_FACTOR, or every segment patch is refused the moment the filter is built",
      path: ["SEGMENT_CUCKOO_PATCH_CEILING"],
    },
  );

export type FeaturekitConfig = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
  /**
   * Whether the deployment has any client or mobile SDK key. Secure mode is
   * required in production only once one exists (§16) — a server-tier-only
   * deployment should not be forced to configure a secret it cannot use.
   */
  clientKeysExist?: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Variables with a laptop-shaped default that must never silently apply in prod. */
const REQUIRED_IN_PRODUCTION = ["DATABASE_URL", "REDIS_URL", "ADMIN_TOKEN"] as const;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): FeaturekitConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`featurekit: invalid configuration\n${issues}`);
  }
  const config = parsed.data;

  if (config.NODE_ENV === "production") {
    // Collected, not thrown one at a time: three restarts to discover three
    // missing variables is three outages.
    const missing = REQUIRED_IN_PRODUCTION.filter((key) => env[key] === undefined);
    if (options.clientKeysExist === true && env["SECURE_MODE_SECRET"] === undefined) {
      // Because the server evaluates *as* a claimed identity, an unsigned
      // context key would let anyone evaluate as anyone — including reading
      // flags targeted at a specific named account.
      missing.push("SECURE_MODE_SECRET" as (typeof REQUIRED_IN_PRODUCTION)[number]);
    }
    if (missing.length > 0) {
      throw new ConfigError(
        `featurekit: NODE_ENV=production requires these to be set explicitly, ` +
          `and the development defaults must never silently apply:\n` +
          missing.map((k) => `  ${k}`).join("\n"),
      );
    }
  }

  return config;
}

/** Comma-separated env var to a trimmed, non-empty list. */
export function commaList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The secure-mode secrets, newest first.
 *
 * Rotation without a flag day: signing uses the first, verification tries all,
 * so rotation becomes two ordinary deploys (§16).
 */
export function secureModeSecrets(config: FeaturekitConfig): string[] {
  return commaList(config.SECURE_MODE_SECRET);
}
