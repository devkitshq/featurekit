import { describe, expect, it } from "vitest";
import { loadConfig, secureModeSecrets } from "../../src/config/index.js";

const PROD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@db:5432/featurekit",
  REDIS_URL: "redis://cache:6379",
  ADMIN_TOKEN: "a".repeat(24),
  SECURE_MODE_SECRET: "s".repeat(32),
};

describe("defaults are for laptops, never for prod", () => {
  it("starts with nothing configured in development", () => {
    const config = loadConfig({});
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.DATABASE_URL).toContain("localhost");
    expect(config.REDIS_URL).toContain("localhost");
  });

  it("coerces numeric env vars, which arrive as strings", () => {
    const config = loadConfig({ PORT: "8080", ROLLUP_SHARDS: "16" });
    expect(config.PORT).toBe(8080);
    expect(config.ROLLUP_SHARDS).toBe(16);
  });

  it("rejects an out-of-range port rather than binding somewhere surprising", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow();
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow();
  });

  it("rejects a malformed database url", () => {
    expect(() => loadConfig({ DATABASE_URL: "not a url" })).toThrow();
  });
});

describe("production start fails loudly", () => {
  it("accepts a fully configured production environment", () => {
    expect(() => loadConfig(PROD)).not.toThrow();
  });

  it.each(["DATABASE_URL", "REDIS_URL", "ADMIN_TOKEN"])(
    "refuses to start in production without %s",
    (key) => {
      const env: Record<string, string> = { ...PROD };
      delete env[key];
      expect(() => loadConfig(env)).toThrow(new RegExp(key));
    },
  );

  it("names every missing variable at once, not one per restart", () => {
    // Three restarts to discover three missing variables is three outages.
    let message = "";
    try {
      loadConfig({ NODE_ENV: "production" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("REDIS_URL");
    expect(message).toContain("ADMIN_TOKEN");
  });

  it("refuses a production default that leaks localhost", () => {
    // The dev defaults must never silently apply in production: a control
    // plane pointed at a localhost database is a control plane with no data.
    const env: Record<string, string> = { ...PROD };
    delete env["DATABASE_URL"];
    expect(() => loadConfig(env)).toThrow();
  });

  it("still starts in production without SECURE_MODE_SECRET when no client keys exist", () => {
    // Secure mode is required only once a client key exists. A
    // server-tier-only deployment should not be forced to configure it.
    const env: Record<string, string> = { ...PROD };
    delete env["SECURE_MODE_SECRET"];
    expect(() => loadConfig(env, { clientKeysExist: false })).not.toThrow();
  });

  it("requires SECURE_MODE_SECRET in production once a client key exists", () => {
    const env: Record<string, string> = { ...PROD };
    delete env["SECURE_MODE_SECRET"];
    expect(() => loadConfig(env, { clientKeysExist: true })).toThrow(/SECURE_MODE_SECRET/);
  });

  it("rejects a secure mode secret that is too short to be one", () => {
    expect(() => loadConfig({ ...PROD, SECURE_MODE_SECRET: "short" })).toThrow();
  });

  it("rejects an admin token short enough to guess", () => {
    expect(() => loadConfig({ ...PROD, ADMIN_TOKEN: "abc" })).toThrow();
  });
});

describe("secure mode secret rotation", () => {
  it("signs with the first secret and verifies against all of them", () => {
    const config = loadConfig({ ...PROD, SECURE_MODE_SECRET: `${"a".repeat(32)},${"b".repeat(32)}` });
    const secrets = secureModeSecrets(config);
    expect(secrets).toEqual(["a".repeat(32), "b".repeat(32)]);
  });

  it("trims whitespace around a rotated list", () => {
    const config = loadConfig({ ...PROD, SECURE_MODE_SECRET: `${"a".repeat(32)} , ${"b".repeat(32)}` });
    expect(secureModeSecrets(config)).toHaveLength(2);
  });

  it("is empty when unset, so callers must handle the unsigned case explicitly", () => {
    expect(secureModeSecrets(loadConfig({}))).toEqual([]);
  });

  it("caps the honoured signature lifetime regardless of what was signed", () => {
    // So a caller cannot mint a decade-long token and reintroduce the
    // never-expiring bearer credential r2 had.
    expect(loadConfig({}).SECURE_MODE_MAX_TTL_SECONDS).toBe(86_400);
    expect(() => loadConfig({ SECURE_MODE_MAX_TTL_SECONDS: "999999999" })).toThrow();
  });
});

describe("the documented knobs", () => {
  it("carries the documented defaults", () => {
    const c = loadConfig({});
    expect(c.SNAPSHOT_DEBOUNCE_MS).toBe(200);
    expect(c.PATCH_HISTORY_DEPTH).toBe(200);
    expect(c.MAX_STREAM_CONNECTIONS).toBe(10_000);
    expect(c.MAX_CLIENT_CONNECTIONS).toBe(50_000);
    expect(c.STREAM_HEARTBEAT_MS).toBe(30_000);
    expect(c.SEGMENT_INLINE_MAX).toBe(50_000);
    expect(c.SEGMENT_CUCKOO_FINGERPRINT_BITS).toBe(16);
    expect(c.SEGMENT_CACHE_LRU_MAX).toBe(100_000);
    expect(c.CLIENT_EVAL_CACHE_MAX).toBe(50_000);
    expect(c.CLIENT_FANOUT_BATCH).toBe(500);
    expect(c.EVENT_BUFFER_MAX).toBe(100_000);
    expect(c.ROLLUP_SHARDS).toBe(8);
    expect(c.ROLLUP_RETENTION_DAYS).toBe(90);
    expect(c.ROLLUP_PARTITION_PREMAKE_DAYS).toBe(7);
  });

  it("only accepts a 12- or 16-bit cuckoo fingerprint, because the format is frozen", () => {
    expect(loadConfig({ SEGMENT_CUCKOO_FINGERPRINT_BITS: "12" }).SEGMENT_CUCKOO_FINGERPRINT_BITS).toBe(12);
    expect(() => loadConfig({ SEGMENT_CUCKOO_FINGERPRINT_BITS: "8" })).toThrow();
  });

  it("requires at least two days of partition premake, matching the runway alert", () => {
    expect(() => loadConfig({ ROLLUP_PARTITION_PREMAKE_DAYS: "1" })).toThrow();
  });
});
