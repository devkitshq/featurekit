/**
 * SDK keys and access tokens (§7.2, §16).
 *
 * The asymmetry here is the whole design, and it is not an oversight:
 *
 * - **Server keys are hashed at rest.** They grant the full ruleset, so a
 *   database leak must not yield usable keys. They are shown exactly once, at
 *   creation, and are unrecoverable afterwards.
 * - **Client and mobile keys are stored in the clear.** They are public by
 *   construction — they ship in a JS bundle or an app binary — and the
 *   dashboard has to be able to display them. A public client key is not a
 *   vulnerability here, because it buys evaluated values for a context the
 *   holder can prove, not the ruleset (§11.5).
 *
 * **The tier split is the security boundary**, not a filter applied at
 * serialisation time — which is a filter someone eventually forgets on a new
 * endpoint.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type SdkKeyKind = "server" | "client" | "mobile";

const PREFIX: Record<SdkKeyKind, string> = {
  server: "fk_srv_",
  client: "fk_clt_",
  mobile: "fk_mob_",
};

/** 256 bits of entropy, url-safe. */
function secret(): string {
  return randomBytes(32).toString("base64url");
}

export function generateSdkKey(kind: SdkKeyKind): string {
  return `${PREFIX[kind]}${secret()}`;
}

/**
 * The kind a key claims to be, from its prefix.
 *
 * Used to route a lookup, never to grant anything: the kind that matters is the
 * one stored in the database next to the key, and a caller could write any
 * prefix it likes.
 */
export function claimedKind(key: string): SdkKeyKind | null {
  for (const [kind, prefix] of Object.entries(PREFIX)) {
    if (key.startsWith(prefix)) return kind as SdkKeyKind;
  }
  return null;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * How a key is stored, given its kind.
 *
 * Returns exactly one of `keyHash` / `keyPublic`, matching the two nullable
 * columns in §7.2. Storing a server key in the clear, or hashing a client key
 * the dashboard then cannot display, are both one typo away without this.
 */
export function storageFor(
  kind: SdkKeyKind,
  key: string,
): { keyHash: string; keyPublic: null } | { keyHash: null; keyPublic: string } {
  return kind === "server"
    ? { keyHash: hashKey(key), keyPublic: null }
    : { keyHash: null, keyPublic: key };
}

export function generateAccessToken(): string {
  return `fk_pat_${secret()}`;
}

/**
 * Constant-time string comparison.
 *
 * `===` on a secret leaks its prefix through timing. `timingSafeEqual` throws
 * on a length mismatch — which would itself be a length oracle — so both sides
 * are hashed to a fixed width first.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export interface KeyRecord {
  id: string;
  environmentId: string;
  kind: SdkKeyKind;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export type KeyRejection = "UNKNOWN_KEY" | "KEY_REVOKED" | "KEY_EXPIRED" | "WRONG_TIER";

/**
 * Whether a looked-up key may be used, and for what.
 *
 * A revoked key is kept rather than deleted — the audit log references it — so
 * "found in the database" is never sufficient on its own.
 */
export function checkKey(
  record: KeyRecord | null,
  options: { requireKind?: SdkKeyKind | SdkKeyKind[]; now?: Date } = {},
): { ok: true; record: KeyRecord } | { ok: false; reason: KeyRejection } {
  if (record === null) return { ok: false, reason: "UNKNOWN_KEY" };
  const now = options.now ?? new Date();
  if (record.revokedAt !== null && record.revokedAt <= now) {
    return { ok: false, reason: "KEY_REVOKED" };
  }
  if (record.expiresAt !== null && record.expiresAt <= now) {
    return { ok: false, reason: "KEY_EXPIRED" };
  }
  if (options.requireKind !== undefined) {
    const allowed = Array.isArray(options.requireKind) ? options.requireKind : [options.requireKind];
    // The ruleset stream is server keys only. A client key reaching it would
    // hand a browser the rules the whole client tier exists to withhold.
    if (!allowed.includes(record.kind)) return { ok: false, reason: "WRONG_TIER" };
  }
  return { ok: true, record };
}
