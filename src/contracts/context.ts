/**
 * Evaluation-context validation and resource caps (§15, §16).
 *
 * **This is a memory-safety boundary, not a politeness check.** The client tier
 * accepts a context from a browser, hashes it, normalises it, evaluates every
 * client-available flag against it, and — for a streaming connection — *retains
 * it for the life of the connection* (§11.5). Every one of those steps is
 * proportional to the size of an object an untrusted caller chose.
 *
 * Without a cap, a single request carrying a 4 MB context with 100k attributes
 * costs the control plane a hash over 4 MB, a normalisation pass allocating a
 * Map per kind, an evaluation per flag against it, and then holds it resident
 * until the socket closes. Fifty such connections is the node.
 *
 * The limits are deliberately generous against real usage — the largest honest
 * context anyone has is a dozen attributes — and deliberately finite.
 */

/** A validated context is nothing more than "one that passed these caps". */
export interface ContextLimits {
  maxKinds: number;
  maxAttributes: number;
  maxKeyLength: number;
  maxStringLength: number;
  maxArrayLength: number;
  maxDepth: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxKinds: 5,
  maxAttributes: 60,
  maxKeyLength: 512,
  maxStringLength: 1_024,
  maxArrayLength: 100,
  maxDepth: 5,
};

export type ContextRejection =
  | "CONTEXT_NOT_OBJECT"
  | "CONTEXT_KEY_MISSING"
  | "CONTEXT_KEY_TOO_LONG"
  | "CONTEXT_TOO_MANY_KINDS"
  | "CONTEXT_TOO_MANY_ATTRIBUTES"
  | "CONTEXT_VALUE_TOO_LONG"
  | "CONTEXT_ARRAY_TOO_LONG"
  | "CONTEXT_TOO_DEEP"
  | "CONTEXT_VALUE_UNSUPPORTED";

export type ContextCheck = { ok: true } | { ok: false; reason: ContextRejection };

function fail(reason: ContextRejection): ContextCheck {
  return { ok: false, reason };
}

/**
 * Depth-limited value walk.
 *
 * Recursion is bounded by `maxDepth` before it is bounded by the stack, which
 * matters because a 10,000-deep JSON object is a stack overflow — and a stack
 * overflow is an uncatchable crash, not an exception the route can turn into a
 * 400 (§15 "deeply nested JSON").
 */
function checkValue(value: unknown, limits: ContextLimits, depth: number): ContextCheck {
  if (depth > limits.maxDepth) return fail("CONTEXT_TOO_DEEP");

  if (value === null || typeof value === "boolean") return { ok: true };
  if (typeof value === "number") {
    // NaN and Infinity survive neither JSON nor a comparison operator sensibly.
    return Number.isFinite(value) ? { ok: true } : fail("CONTEXT_VALUE_UNSUPPORTED");
  }
  if (typeof value === "string") {
    return value.length <= limits.maxStringLength ? { ok: true } : fail("CONTEXT_VALUE_TOO_LONG");
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) return fail("CONTEXT_ARRAY_TOO_LONG");
    for (const item of value) {
      const r = checkValue(item, limits, depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.maxAttributes) return fail("CONTEXT_TOO_MANY_ATTRIBUTES");
    for (const [key, item] of entries) {
      if (key.length > limits.maxKeyLength) return fail("CONTEXT_KEY_TOO_LONG");
      const r = checkValue(item, limits, depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  // Functions, symbols and undefined cannot arrive over JSON, but this function
  // is also called on in-process contexts.
  return fail("CONTEXT_VALUE_UNSUPPORTED");
}

/**
 * Validate a context in either shape the SDK accepts: single-kind
 * (`{ key, ...attrs }`) or multi-context (`{ kind: "multi", user: {...} }`).
 *
 * Returns a reason rather than throwing: the caller decides whether that is a
 * 400 (client tier) or a dropped evaluation (server tier).
 */
export function checkContext(
  context: unknown,
  limits: ContextLimits = DEFAULT_CONTEXT_LIMITS,
): ContextCheck {
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    return fail("CONTEXT_NOT_OBJECT");
  }
  const record = context as Record<string, unknown>;

  if (record["kind"] === "multi") {
    const kinds = Object.entries(record).filter(([k]) => k !== "kind");
    if (kinds.length > limits.maxKinds) return fail("CONTEXT_TOO_MANY_KINDS");
    if (kinds.length === 0) return fail("CONTEXT_KEY_MISSING");
    for (const [, value] of kinds) {
      if (value === null || typeof value !== "object") return fail("CONTEXT_NOT_OBJECT");
      const key = (value as Record<string, unknown>)["key"];
      if (typeof key !== "string" || key.length === 0) return fail("CONTEXT_KEY_MISSING");
      if (key.length > limits.maxKeyLength) return fail("CONTEXT_KEY_TOO_LONG");
      const r = checkValue(value, limits, 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  const key = record["key"];
  if (typeof key !== "string" || key.length === 0) return fail("CONTEXT_KEY_MISSING");
  if (key.length > limits.maxKeyLength) return fail("CONTEXT_KEY_TOO_LONG");
  return checkValue(record, limits, 1);
}
