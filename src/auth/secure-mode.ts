/**
 * Client-tier secure mode.
 *
 * Because the server evaluates *as* a claimed identity, an unsigned context key
 * would let anyone evaluate as anyone — including reading flags targeted at a
 * specific named account. Production environments therefore reject unsigned
 * contexts unless explicitly opted out.
 *
 * **The signature carries an expiry, and that is the point.** r2 signed the key
 * alone — `HMAC_SHA256(userId, SECRET)` — which makes the signature a bearer
 * credential that never expires. Captured once from a proxy log, an error
 * report carrying request headers, an APM trace, or a shared browser session, it
 * grants permanent ability to poll `/v1/client/state` as that user. The only
 * revocation would be rotating the secret, which invalidates *every* user
 * simultaneously and so is never done in response to one leak. A credential
 * whose only revocation mechanism is a global outage is not revocable.
 *
 * **This bounds replay rather than preventing it.** A captured signature is
 * usable until `expiresAt`. Closing that window entirely needs a server-side
 * nonce per connection — per-connection write state on a tier explicitly
 * designed not to have any, to defend a payload that is already only *this*
 * user's flag values. A bounded, rotatable window matching ordinary session
 * lifetimes is the right trade, and it is stated here so nobody mistakes it for
 * something stronger.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureRejection =
  | "SIGNATURE_MISSING"
  | "SIGNATURE_INVALID"
  | "SIGNATURE_EXPIRED"
  | "SIGNATURE_TTL_TOO_LONG";

export interface SignedContext {
  key: string;
  expiresAt: number;
  signature: string;
  attributesHash?: string;
}

/** The exact bytes signed. One spelling, used by both sign and verify. */
function payload(key: string, expiresAt: number, attributesHash?: string): string {
  return attributesHash !== undefined ? `${key}:${expiresAt}:${attributesHash}` : `${key}:${expiresAt}`;
}

/**
 * Sign a context key, on the customer's own server where the session is
 * already trusted. Signing always uses the **first** secret.
 */
export function signContext(
  key: string,
  expiresAt: number,
  secrets: readonly string[],
  attributesHash?: string,
): string {
  const signing = secrets[0];
  if (signing === undefined) throw new Error("featurekit: no SECURE_MODE_SECRET configured");
  return createHmac("sha256", signing).update(payload(key, expiresAt, attributesHash), "utf8").digest("hex");
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface VerifyOptions {
  secrets: readonly string[];
  /** Longest lifetime honoured, regardless of what was signed. */
  maxTtlSeconds: number;
  nowSeconds?: number;
}

/**
 * Verify a signed context.
 *
 * `SIGNATURE_EXPIRED` is deliberately distinct from `SIGNATURE_INVALID`,
 * because the SDK's response differs: expired triggers `onSignatureExpiring`
 * and a re-identify **while the last known values keep serving**, whereas
 * invalid drops to caller defaults.
 */
export function verifyContext(
  signed: Partial<SignedContext> | null | undefined,
  options: VerifyOptions,
): { ok: true } | { ok: false; reason: SignatureRejection } {
  if (
    signed === null ||
    signed === undefined ||
    typeof signed.key !== "string" ||
    typeof signed.signature !== "string" ||
    typeof signed.expiresAt !== "number" ||
    !Number.isFinite(signed.expiresAt)
  ) {
    return { ok: false, reason: "SIGNATURE_MISSING" };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Order matters: reject an over-long TTL before checking the HMAC, so a
  // validly-signed decade-long token is refused rather than accepted. Otherwise
  // a caller could mint one and reintroduce the never-expiring credential.
  if (signed.expiresAt - now > options.maxTtlSeconds) {
    return { ok: false, reason: "SIGNATURE_TTL_TOO_LONG" };
  }
  if (signed.expiresAt <= now) return { ok: false, reason: "SIGNATURE_EXPIRED" };

  const expected = payload(signed.key, signed.expiresAt, signed.attributesHash);
  for (const secretValue of options.secrets) {
    // Verification tries ALL secrets. Rotation is then two ordinary deploys:
    // add the new secret second, deploy; promote it to first, deploy.
    const candidate = createHmac("sha256", secretValue).update(expected, "utf8").digest("hex");
    if (equalHex(candidate, signed.signature)) return { ok: true };
  }

  // Backwards compatibility: if an attributesHash was checked and failed, also check
  // if this is a legacy key-only signature
  if (signed.attributesHash !== undefined) {
    const legacyExpected = payload(signed.key, signed.expiresAt);
    for (const secretValue of options.secrets) {
      const candidate = createHmac("sha256", secretValue).update(legacyExpected, "utf8").digest("hex");
      if (equalHex(candidate, signed.signature)) return { ok: true };
    }
  }

  return { ok: false, reason: "SIGNATURE_INVALID" };
}
