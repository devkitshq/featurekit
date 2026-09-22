/**
 * The canonical hash of an evaluation context (§11.5, §16).
 *
 * Two callers, and they must agree byte for byte or the second one is a
 * security hole rather than a mismatch:
 *
 * - The **client tier** echoes it on every `/v1/client/state` response, so an
 *   SDK can tell that a reply belongs to the context it currently holds.
 * - **Secure mode** binds it into the signed payload, so a signature proves the
 *   *attributes* as well as the identity. Without that, a user holding a valid
 *   signature for their own key can send any attributes they like and be
 *   evaluated as, say, an enterprise plan.
 *
 * It lives here rather than beside either caller because a customer's own
 * backend is a third implementation of it — that backend is what mints
 * signatures — and a hash whose definition is buried in the fan-out service is
 * one that gets reimplemented slightly wrong. `featurekit/secure-mode` exports
 * this function so nobody has to.
 *
 * Imports `node:crypto` and nothing else.
 */

import { createHash } from "node:crypto";

/**
 * Stable hash of a context. Includes the key: this identifies the whole
 * context, unlike a fan-out fingerprint, which deliberately excludes it.
 *
 * Truncated to 32 hex characters (128 bits) — long past the point where a
 * collision is a concern for identifying which of a session's own contexts a
 * response belongs to.
 */
export function contextHash(context: unknown): string {
  return createHash("sha256").update(canonicalize(context)).digest("hex").slice(0, 32);
}

/**
 * Key order must not change the hash, so object keys are sorted at every level.
 *
 * This is the whole specification, and it is short enough to reimplement in any
 * language: `JSON.stringify` for primitives, arrays canonicalised elementwise,
 * objects emitted as sorted `"key":value` pairs with no whitespace. Sorting is
 * by UTF-16 code unit, which is what JavaScript's `<` gives.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}
