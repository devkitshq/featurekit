/**
 * `featurekit-server/secure-mode` — everything a customer's backend needs to mint a
 * signed context, and nothing else (§16).
 *
 * ```ts
 * import { signContext, contextHash } from "featurekit-server/secure-mode";
 *
 * app.get("/api/featurekit-signature", requireSession, (req, res) => {
 *   const context = { key: req.user.id, plan: req.user.plan };
 *   const expiresAt = Math.floor(Date.now() / 1000) + 3600;
 *   res.json({
 *     signature: signContext(context.key, expiresAt, SECRETS, contextHash(context)),
 *     expiresAt,
 *   });
 * });
 * ```
 *
 * **A separate entry point because of what it does not load.** `featurekit`'s
 * main entry is the control plane: importing it pulls Drizzle, a Postgres
 * driver, ioredis, pino and prom-client into the process. A service whose only
 * involvement with flags is signing a context for its logged-in user has no
 * business paying that at import time — in a Lambda it is the difference
 * between a cold start you notice and one you do not. This module reaches
 * `node:crypto` and two files that do the same.
 *
 * **Pass the `attributesHash`.** `signContext` accepts a signature over the key
 * alone, and the server still verifies those, because deployments exist that
 * minted them. It is the weaker form: it authenticates *who* the context claims
 * to be and nothing about what it claims to be true. A user holding a valid
 * signature for their own key can then send `{ key: "u-ana", plan: "enterprise" }`
 * and be evaluated as an enterprise customer. Binding `contextHash(context)`
 * closes that, and costs one function call.
 *
 * **The expiry bounds replay; it does not prevent it.** A captured signature
 * works until `expiresAt`, which is why signing the key alone with no expiry —
 * a bearer credential revocable only by rotating the secret for every user at
 * once — was rejected. Keep the TTL near your session length; the server caps
 * it at `SECURE_MODE_MAX_TTL_SECONDS` (24h by default) regardless of what you
 * signed.
 *
 * @see docs/client-tier/http.md#secure-mode
 */

export { signContext, verifyContext } from "./auth/secure-mode.js";
export type { SignedContext, SignatureRejection, VerifyOptions } from "./auth/secure-mode.js";

/**
 * The canonical context hash, exported so a backend does not have to
 * reimplement the sorted-key canonicalisation and discover the mismatch as a
 * 401 in production.
 */
export { contextHash, canonicalize } from "./contracts/context-hash.js";
