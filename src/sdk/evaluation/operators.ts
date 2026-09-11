/**
 * Clause operators (§9.6).
 *
 * Three rules govern everything in this file:
 *
 * 1. **Type mismatch is `false`** — never a throw, never a coercion.
 *    `greaterThan` against a string attribute is simply not a match.
 * 2. **Multi-valued attributes match if *any* element matches.**
 *    `groups: ["a","b"]` against `in: ["b"]` matches.
 * 3. **Nothing here throws.** A malformed rule that can throw into the
 *    customer's request path is worse than no flag library at all.
 *
 * `segmentMatch` is deliberately absent: it needs segment state, so it is
 * resolved one level up in `evaluate.ts`, where the unresolved third state
 * exists (§9.7).
 *
 * @see docs/evaluation/operators.md
 */

import type { Operator } from "./types.js";
import { compileSafeRegExp, MAX_REGEX_INPUT_LENGTH } from "./regex.js";

/* ─────────────────────────────── semver ─────────────────────────────── */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers, or `undefined` for a release version. */
  prerelease?: string;
}

/**
 * Accepts `major[.minor[.patch]][-prerelease][+build]`.
 *
 * Partial versions are allowed because real attributes carry them (`"17.2"`),
 * and missing components read as zero. Leading zeros are rejected, per semver.
 */
const SEMVER_RE = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemVer(input: string): SemVer | null {
  if (typeof input !== "string") return null;
  const m = SEMVER_RE.exec(input);
  if (m === null) return null;
  const prerelease = m[4];
  // A trailing `-` produces an empty identifier set, which is not a version.
  if (prerelease !== undefined && prerelease.length === 0) return null;
  const v: SemVer = {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
  };
  if (prerelease !== undefined) v.prerelease = prerelease;
  return v;
}

const NUMERIC_IDENTIFIER = /^\d+$/;

/** Negative if `a < b`, positive if `a > b`, zero if equal in precedence. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Build metadata is excluded from precedence, so it never reaches here.
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  // A prerelease has lower precedence than the release it precedes.
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;

  const ai = a.prerelease.split(".");
  const bi = b.prerelease.split(".");
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i];
    const y = bi[i];
    // A larger set of identifiers outranks a smaller one when all preceding
    // identifiers are equal: 1.0.0-alpha < 1.0.0-alpha.1.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = NUMERIC_IDENTIFIER.test(x);
    const yn = NUMERIC_IDENTIFIER.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/* ──────────────────────────── value helpers ─────────────────────────── */

/** Structural equality for `in`. Values come from JSON, so this is enough. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

/** A real, comparable number. Booleans are not numbers; NaN and ±∞ are not values. */
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * An instant, from either an ISO-8601 string or epoch milliseconds.
 * Booleans are excluded explicitly: `Date.parse` would happily coerce them.
 */
function asInstant(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/* ─────────────────────────────── dispatch ───────────────────────────── */

/** Compare one attribute value against one clause value. No arrays here. */
function matchOne(op: Operator, attr: unknown, value: unknown): boolean {
  switch (op) {
    case "in":
      return deepEqual(attr, value);

    case "startsWith":
      return typeof attr === "string" && typeof value === "string" && attr.startsWith(value);
    case "endsWith":
      return typeof attr === "string" && typeof value === "string" && attr.endsWith(value);
    case "contains":
      return typeof attr === "string" && typeof value === "string" && attr.includes(value);
    case "matches": {
      // Input length is capped before the pattern ever runs: backtracking cost
      // scales with the subject, and an attribute this long is not a country
      // code or a plan name (see `regex.ts`).
      if (typeof attr !== "string" || attr.length > MAX_REGEX_INPUT_LENGTH) return false;
      // Structurally checked and cached. A pattern that could backtrack
      // catastrophically compiles to `null` and the clause is false — the same
      // fail-closed outcome as a malformed pattern.
      const re = compileSafeRegExp(value);
      return re !== null && re.test(attr);
    }

    case "lessThan":
    case "lessThanOrEqual":
    case "greaterThan":
    case "greaterThanOrEqual": {
      const a = asNumber(attr);
      const b = asNumber(value);
      if (a === null || b === null) return false;
      if (op === "lessThan") return a < b;
      if (op === "lessThanOrEqual") return a <= b;
      if (op === "greaterThan") return a > b;
      return a >= b;
    }

    case "before":
    case "after": {
      const a = asInstant(typeof attr === "boolean" ? null : attr);
      const b = asInstant(typeof value === "boolean" ? null : value);
      if (a === null || b === null) return false;
      return op === "before" ? a < b : a > b;
    }

    case "semVerEqual":
    case "semVerLessThan":
    case "semVerGreaterThan": {
      if (typeof attr !== "string" || typeof value !== "string") return false;
      const a = parseSemVer(attr);
      const b = parseSemVer(value);
      if (a === null || b === null) return false;
      const c = compareSemVer(a, b);
      if (op === "semVerEqual") return c === 0;
      return op === "semVerLessThan" ? c < 0 : c > 0;
    }

    // `segmentMatch` needs segment state and the unresolved third state, so it
    // is handled in `evaluate.ts` and never reaches here.
    case "segmentMatch":
      return false;

    default:
      // An operator this SDK does not know about. Degrade to "no match" rather
      // than throw: a snapshot may legitimately be newer than the SDK reading it.
      return false;
  }
}

/**
 * Apply an operator to an attribute against a clause's value list.
 *
 * OR across the clause's values, and OR across the attribute's elements when
 * the attribute is multi-valued. Nested arrays are not flattened: an attribute
 * of `[["b"]]` does not match `in: ["b"]`.
 */
export function applyOperator(op: Operator, attr: unknown, values: readonly unknown[]): boolean {
  if (attr === undefined) return false;

  if (Array.isArray(attr)) {
    for (const element of attr) {
      if (Array.isArray(element)) continue;
      for (const value of values) {
        if (matchOne(op, element, value)) return true;
      }
    }
    return false;
  }

  for (const value of values) {
    if (matchOne(op, attr, value)) return true;
  }
  return false;
}
