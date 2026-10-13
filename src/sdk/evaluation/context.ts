/**
 * Multi-context normalisation and attribute resolution.
 *
 * Multi-context exists from day one because retrofitting it is brutal, but
 * `"user"` is implicit and default everywhere so the simple case stays simple.
 *
 * Nothing here throws. Invalid input yields `null` or `undefined` and the
 * evaluator turns that into the caller's default with `reason: ERROR`.
 *
 * **This file is on the hot path and is written for it.** Normalisation used
 * to allocate a `Map` and copy every attribute into a fresh object, which
 * measured at ~290 ns — twenty times the entire evaluation budget.
 * Neither allocation is necessary; see `SingleKindContext` below.
 *
 * @see docs/evaluation/context.md
 */

import type { ContextAttributes, EvaluationContext, NormalizedContext } from "./types.js";

const hasOwn = Object.prototype.hasOwnProperty;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A key must be a non-blank string: it is hashed, indexed, and displayed. */
function validKey(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * The single-context case, without a `Map` and without copying attributes.
 *
 * Holds the caller's own object by reference. `kind` is filtered at read time
 * rather than stripped at build time — see `getAttribute`.
 */
class SingleKindContext implements NormalizedContext {
  constructor(
    private readonly contextKind: string,
    private readonly attributes: ContextAttributes,
  ) {}

  get(contextKind: string): ContextAttributes | undefined {
    return contextKind === this.contextKind ? this.attributes : undefined;
  }
}

/**
 * Normalise any accepted context shape into a `kind -> attributes` lookup.
 * Returns `null` if the context is unusable, which the evaluator reports as
 * `MALFORMED_CONTEXT` rather than throwing into the caller's request path.
 */
export function normalizeContext(context: EvaluationContext): NormalizedContext | null {
  if (!isPlainObject(context)) return null;

  const kind = context["kind"];

  if (kind === "multi") {
    const out = new Map<string, ContextAttributes>();
    for (const contextKind of Object.keys(context)) {
      if (contextKind === "kind") continue;
      const member = context[contextKind];
      if (!isPlainObject(member)) return null;
      if (!validKey(member["key"])) return null;
      out.set(contextKind, member as unknown as ContextAttributes);
    }
    return out.size > 0 ? out : null;
  }

  if (kind !== undefined && typeof kind !== "string") return null;
  if (!validKey(context["key"])) return null;

  return new SingleKindContext(kind ?? "user", context as unknown as ContextAttributes);
}

/**
 * Read an attribute off one context kind.
 *
 * `"key"` resolves to the context key. A missing kind yields `undefined`,
 * which is how "a clause naming an absent kind does not match" falls out for
 * free. A dot-separated path walks nested plain objects
 * (`"address.country"`) — but the dot is only looked for, never split on,
 * unless one is present: `split(".")` allocates an array on every attribute
 * read, and the overwhelming majority of attributes are flat.
 *
 * **`kind` is reserved and never readable as an attribute**, in any context
 * shape. In the single-context form it is the discriminator rather than data,
 * and a rule that could read it in one shape but not the other would be worse
 * than one that can read it in neither. A clause selects its context kind with
 * `contextKind`, which is what that field is for.
 *
 * Only own properties are ever read. A rule author writing `constructor`, or a
 * context deserialised from user-controlled JSON carrying `__proto__`, must
 * not reach `Object.prototype`.
 */
export function getAttribute(
  context: NormalizedContext,
  contextKind: string,
  attribute: string,
): unknown {
  const attrs = context.get(contextKind);
  if (attrs === undefined) return undefined;
  if (attribute === "key") return attrs.key;
  if (attribute === "kind") return undefined;

  if (attribute.indexOf(".") === -1) {
    return hasOwn.call(attrs, attribute) ? (attrs as Record<string, unknown>)[attribute] : undefined;
  }

  let cursor: unknown = attrs;
  let start = 0;
  for (;;) {
    const dot = attribute.indexOf(".", start);
    const segment = dot === -1 ? attribute.slice(start) : attribute.slice(start, dot);
    if (!isPlainObject(cursor) || !hasOwn.call(cursor, segment)) return undefined;
    cursor = cursor[segment];
    if (dot === -1) return cursor;
    start = dot + 1;
  }
}

/**
 * The string a rollout hashes for this context, or `null` if there isn't one.
 *
 * `null` means *excluded from the rollout*, not "assign to variation 0". A
 * context lacking the bucketing attribute cannot be bucketed consistently, and
 * silently dropping everyone who lacks it into the first variation is the kind
 * of skew nobody notices until the results are already wrong.
 */
export function bucketValue(
  context: NormalizedContext,
  contextKind: string,
  bucketBy: string,
): string | null {
  const raw = getAttribute(context, contextKind, bucketBy);
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  // Numbers and booleans have one unambiguous spelling across languages.
  // Objects and arrays do not — `JSON.stringify` is key-order dependent — so
  // they are excluded rather than bucketed inconsistently across SDKs.
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "boolean") return String(raw);
  return null;
}
