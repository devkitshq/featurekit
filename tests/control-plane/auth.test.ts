import { describe, expect, it } from "vitest";
import {
  checkKey,
  claimedKind,
  generateAccessToken,
  generateSdkKey,
  hashKey,
  safeEqual,
  storageFor,
  type KeyRecord,
} from "../../src/auth/keys.js";
import { signContext, verifyContext } from "../../src/auth/secure-mode.js";

describe("SDK key generation (§7.2)", () => {
  it("prefixes by tier, so a misused key is obvious in a log", () => {
    expect(generateSdkKey("server")).toMatch(/^tk_srv_/);
    expect(generateSdkKey("client")).toMatch(/^tk_clt_/);
    expect(generateSdkKey("mobile")).toMatch(/^tk_mob_/);
  });

  it("carries 256 bits of entropy and never repeats", () => {
    const keys = new Set(Array.from({ length: 1_000 }, () => generateSdkKey("server")));
    expect(keys.size).toBe(1_000);
    expect(generateSdkKey("server").length).toBeGreaterThan(40);
  });

  it("reads the claimed kind from the prefix", () => {
    expect(claimedKind(generateSdkKey("client"))).toBe("client");
    expect(claimedKind("garbage")).toBeNull();
  });
});

describe("key storage is asymmetric on purpose (§7.2)", () => {
  it("hashes a server key and never stores it in the clear", () => {
    const key = generateSdkKey("server");
    const stored = storageFor("server", key);
    expect(stored.keyPublic).toBeNull();
    expect(stored.keyHash).toBe(hashKey(key));
    expect(stored.keyHash).not.toContain(key);
  });

  it.each(["client", "mobile"] as const)("stores a %s key in the clear", (kind) => {
    // Public by construction: it ships in a JS bundle or an app binary, and the
    // dashboard has to display it. Hashing it would buy nothing and cost the UI.
    const key = generateSdkKey(kind);
    const stored = storageFor(kind, key);
    expect(stored.keyPublic).toBe(key);
    expect(stored.keyHash).toBeNull();
  });

  it("produces a stable hash for lookup", () => {
    const key = generateSdkKey("server");
    expect(hashKey(key)).toBe(hashKey(key));
    expect(hashKey(key)).not.toBe(hashKey(generateSdkKey("server")));
  });
});

describe("safeEqual", () => {
  it("compares equal and unequal secrets correctly", () => {
    expect(safeEqual("token", "token")).toBe(true);
    expect(safeEqual("token", "tokeN")).toBe(false);
  });

  it("handles different lengths without throwing a length oracle", () => {
    expect(safeEqual("short", "a-much-longer-token")).toBe(false);
  });
});

describe("checkKey", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  const record = (over: Partial<KeyRecord> = {}): KeyRecord => ({
    id: "k1",
    environmentId: "env-1",
    kind: "server",
    expiresAt: null,
    revokedAt: null,
    ...over,
  });

  it("accepts a live key", () => {
    expect(checkKey(record(), { now })).toEqual({ ok: true, record: record() });
  });

  it("rejects an unknown key", () => {
    expect(checkKey(null, { now })).toEqual({ ok: false, reason: "UNKNOWN_KEY" });
  });

  it("rejects a revoked key that is still in the table", () => {
    // Revoked keys are KEPT, not deleted -- the audit log references them -- so
    // "found in the database" is never sufficient on its own.
    const revoked = record({ revokedAt: new Date("2026-09-01T00:00:00Z") });
    expect(checkKey(revoked, { now })).toEqual({ ok: false, reason: "KEY_REVOKED" });
  });

  it("rejects an expired key", () => {
    const expired = record({ expiresAt: new Date("2026-09-01T00:00:00Z") });
    expect(checkKey(expired, { now })).toEqual({ ok: false, reason: "KEY_EXPIRED" });
  });

  it("accepts a key whose expiry is still ahead", () => {
    expect(checkKey(record({ expiresAt: new Date("2026-12-01T00:00:00Z") }), { now }).ok).toBe(true);
  });

  it("REFUSES a client key on a server-tier endpoint", () => {
    // The ruleset stream is server keys only. A client key reaching it would
    // hand a browser the rules the entire client tier exists to withhold.
    const client = record({ kind: "client" });
    expect(checkKey(client, { requireKind: "server", now })).toEqual({
      ok: false,
      reason: "WRONG_TIER",
    });
  });

  it("accepts client and mobile keys on a client-tier endpoint", () => {
    for (const kind of ["client", "mobile"] as const) {
      expect(checkKey(record({ kind }), { requireKind: ["client", "mobile"], now }).ok).toBe(true);
    }
  });

  it("refuses a server key on a client-tier endpoint too", () => {
    // Symmetry matters: a server key used from a browser is a leaked ruleset.
    expect(checkKey(record({ kind: "server" }), { requireKind: ["client", "mobile"], now })).toEqual({
      ok: false,
      reason: "WRONG_TIER",
    });
  });
});

describe("access tokens", () => {
  it("are distinguishable from SDK keys", () => {
    expect(generateAccessToken()).toMatch(/^tk_pat_/);
    expect(claimedKind(generateAccessToken())).toBeNull();
  });
});

/* ───────────────────────────── secure mode ──────────────────────────── */

describe("secure mode signatures (§16)", () => {
  const SECRET = "s".repeat(32);
  const NOW = 1_800_000_000;
  const opts = { secrets: [SECRET], maxTtlSeconds: 86_400, nowSeconds: NOW };

  it("verifies a well-formed signature", () => {
    const expiresAt = NOW + 3_600;
    const signature = signContext("usr_1", expiresAt, [SECRET]);
    expect(verifyContext({ key: "usr_1", expiresAt, signature }, opts)).toEqual({ ok: true });
  });

  it("signs the key AND the expiry together", () => {
    // Signing the key alone makes the signature a bearer credential that never
    // expires. Moving the expiry must invalidate the signature.
    const expiresAt = NOW + 3_600;
    const signature = signContext("usr_1", expiresAt, [SECRET]);
    expect(verifyContext({ key: "usr_1", expiresAt: expiresAt + 1, signature }, opts)).toEqual({
      ok: false,
      reason: "SIGNATURE_INVALID",
    });
  });

  it("refuses a signature for a different user", () => {
    const expiresAt = NOW + 3_600;
    const signature = signContext("usr_1", expiresAt, [SECRET]);
    expect(verifyContext({ key: "usr_2", expiresAt, signature }, opts).ok).toBe(false);
  });

  it("returns SIGNATURE_EXPIRED, distinctly from SIGNATURE_INVALID", () => {
    // The SDK's response differs: expired keeps serving the last known values
    // while it refreshes; invalid drops to caller defaults (§14).
    const expiresAt = NOW - 1;
    const signature = signContext("usr_1", expiresAt, [SECRET]);
    expect(verifyContext({ key: "usr_1", expiresAt, signature }, opts)).toEqual({
      ok: false,
      reason: "SIGNATURE_EXPIRED",
    });
  });

  it("refuses a validly-signed but over-long TTL", () => {
    // Otherwise a caller mints a decade-long token and reintroduces exactly the
    // never-expiring credential the expiry exists to prevent.
    const expiresAt = NOW + 10 * 365 * 86_400;
    const signature = signContext("usr_1", expiresAt, [SECRET]);
    expect(verifyContext({ key: "usr_1", expiresAt, signature }, opts)).toEqual({
      ok: false,
      reason: "SIGNATURE_TTL_TOO_LONG",
    });
  });

  it("checks the TTL cap BEFORE the HMAC, so a valid over-long token is still refused", () => {
    const expiresAt = NOW + 10 * 365 * 86_400;
    const signature = signContext("usr_1", expiresAt, [SECRET]);
    const result = verifyContext({ key: "usr_1", expiresAt, signature }, opts);
    expect(result).not.toEqual({ ok: true });
  });

  it("reports a missing or malformed signature separately", () => {
    expect(verifyContext(null, opts)).toEqual({ ok: false, reason: "SIGNATURE_MISSING" });
    expect(verifyContext({ key: "usr_1" }, opts)).toEqual({ ok: false, reason: "SIGNATURE_MISSING" });
    expect(verifyContext({ key: "usr_1", expiresAt: NaN, signature: "x" }, opts)).toEqual({
      ok: false,
      reason: "SIGNATURE_MISSING",
    });
  });

  it("does not throw on a non-hex signature", () => {
    const expiresAt = NOW + 60;
    expect(verifyContext({ key: "usr_1", expiresAt, signature: "not hex!!" }, opts).ok).toBe(false);
  });

  it("rotates without a flag day: sign with the first, verify against all", () => {
    const OLD = "o".repeat(32);
    const NEW = "n".repeat(32);
    const expiresAt = NOW + 3_600;

    // Deploy 1: new secret added second. Old signatures still verify.
    const oldSignature = signContext("usr_1", expiresAt, [OLD]);
    expect(
      verifyContext({ key: "usr_1", expiresAt, signature: oldSignature }, { ...opts, secrets: [OLD, NEW] }).ok,
    ).toBe(true);

    // Deploy 2: new secret promoted to first. Both still verify.
    const newSignature = signContext("usr_1", expiresAt, [NEW, OLD]);
    expect(newSignature).not.toBe(oldSignature);
    for (const signature of [oldSignature, newSignature]) {
      expect(verifyContext({ key: "usr_1", expiresAt, signature }, { ...opts, secrets: [NEW, OLD] }).ok).toBe(true);
    }

    // Deploy 3: old secret dropped. Old signatures stop verifying.
    expect(
      verifyContext({ key: "usr_1", expiresAt, signature: oldSignature }, { ...opts, secrets: [NEW] }).ok,
    ).toBe(false);
  });

  it("throws when asked to sign with no secret configured", () => {
    expect(() => signContext("usr_1", NOW + 60, [])).toThrow(/SECURE_MODE_SECRET/);
  });
});
