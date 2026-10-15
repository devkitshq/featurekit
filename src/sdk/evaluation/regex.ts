/**
 * Regex safety for the `matches` operator.
 *
 * **The threat is a customer's own rule.** `matches` runs a pattern that came
 * from a targeting rule against an attribute that came from a request, inside
 * the customer's request path, synchronously. JavaScript cannot interrupt a
 * running regex: there is no timeout, no cancellation, and no way to bound a
 * catastrophic backtrack once it has started. A single rule reading `^(a+)+$`
 * against a 40-character non-matching string is a hung event loop — not a slow
 * evaluation, a *stopped process*.
 *
 * Since the blowup cannot be stopped once started, it has to be prevented from
 * starting. Four layers, in order of how much they actually buy:
 *
 * 1. **Structural rejection of the two shapes that backtrack exponentially**: a
 *    quantifier nested inside a repeated group (`(a+)+`), and a repeated group
 *    whose alternatives can match the same text (`(a|a)*`). This is the real
 *    defence. The second shape was found by a test that ran for **291 seconds**
 *    against a guard that only handled the first.
 * 2. **Caps on pattern length and complexity**, so anything that slips past the
 *    structure check is at least small.
 * 3. **A cap on input length.** Backtracking cost scales with the subject, so a
 *    bounded subject bounds a polynomial blowup — though not an exponential
 *    one, which is why layer 1 carries the weight.
 * 4. **A compiled-pattern cache**, because recompiling a regex per evaluation
 *    is itself a cost on a path budgeted in nanoseconds.
 *
 * **What this does not do, stated plainly.** It is a heuristic, not a proof. A
 * determined author can still write a slow pattern this accepts — polynomial
 * backtracking through `(a*)b` shapes, for instance. Closing that properly needs
 * a linear-time engine (RE2), which is a native dependency this package will not
 * take. The honest position: the exponential shapes are rejected, everything
 * else is bounded by input length, and `matches` is documented as the one
 * operator whose cost a rule author controls.
 *
 * The bias is deliberate. A rejected pattern makes its clause **false** — the
 * same fail-closed outcome as a malformed pattern — and the management API
 * rejects it at write time with a message telling the author how to rewrite it.
 * A false rejection costs someone a rule rewrite. A false acceptance costs
 * everyone the process.
 */

/**
 * Longest regex a clause may carry. The dashboard complexity-checks patterns at
 * write time, but a snapshot is a wire format arriving over the network,
 * and the SDK does not get to assume the writer validated it.
 */
export const MAX_REGEX_LENGTH = 1_000;

/**
 * Longest string `matches` will test.
 *
 * A context attribute longer than this is not matched, rather than matched
 * slowly. Four kilobytes is far past any realistic `country`, `plan` or `email`,
 * and the client tier caps attribute length well below it anyway.
 */
export const MAX_REGEX_INPUT_LENGTH = 4_096;

/** More quantifiers than any legitimate targeting pattern needs. */
const MAX_QUANTIFIERS = 20;

/** Deeper nesting than any legitimate targeting pattern needs. */
const MAX_GROUP_DEPTH = 10;

export type RegexRejection =
  | "NOT_A_STRING"
  | "TOO_LONG"
  | "TOO_COMPLEX"
  | "NESTED_QUANTIFIER"
  | "AMBIGUOUS_ALTERNATION"
  | "INVALID";

export type RegexCheck = { ok: true } | { ok: false; reason: RegexRejection };

/**
 * Is this quantifier one that can repeat unboundedly?
 *
 * `?` is excluded deliberately: it repeats at most once and cannot produce the
 * exponential blowup this is looking for.
 */
function isUnboundedQuantifier(pattern: string, index: number): boolean {
  const c = pattern[index];
  if (c === "*" || c === "+") return true;
  if (c !== "{") return false;
  // `{n,}` and `{n,m}` repeat. `{n}` is a fixed count and cannot blow up alone,
  // but nested inside another quantifier it still can, so it counts here.
  const close = pattern.indexOf("}", index);
  return close !== -1 && /^\{\d*,?\d*\}$/.test(pattern.slice(index, close + 1));
}

/**
 * The characters a branch can start with, as far as we can tell.
 *
 * `null` means "could be anything", which is what an alternative beginning with
 * a group, a dot, an anchor or a negated class gets. Two branches are treated as
 * overlapping if either is unknown or their sets intersect.
 */
type FirstSet = Set<string> | null;

/** Characters a predefined class can begin with, approximated by a sample. */
const CLASS_SAMPLES: Record<string, string> = {
  d: "0123456789",
  w: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_",
  s: " \t\n\r\f\v",
};

function firstSetOf(branch: string): FirstSet {
  // An empty alternative matches at any position, so it overlaps everything.
  if (branch.length === 0) return null;

  const c = branch[0]!;

  if (c === "\\") {
    const next = branch[1];
    if (next === undefined) return null;
    const sample = CLASS_SAMPLES[next.toLowerCase()];
    if (sample !== undefined) {
      // An uppercase class (\D, \W, \S) is a complement — too broad to model.
      return next === next.toLowerCase() ? new Set(sample) : null;
    }
    // Hex, unicode, control, property and backreference escapes stand for
    // something other than their letter, so they cannot be modelled.
    if (/[0-9A-Za-z]/.test(next)) return null;
    return new Set([next]);
  }

  if (c === "[") {
    const close = branch.indexOf("]", 1);
    if (close === -1) return null;
    const body = branch.slice(1, close);
    if (body.startsWith("^")) return null; // negated: a complement

    const chars = new Set<string>();
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch === "\\") {
        const sample = CLASS_SAMPLES[(body[i + 1] ?? "").toLowerCase()];
        if (sample === undefined) chars.add(body[i + 1] ?? "");
        else for (const s of sample) chars.add(s);
        i++;
        continue;
      }
      // A range covers every character between its endpoints, not just the
      // endpoints: [a-z] overlaps "m". Expand small ranges; give up on large
      // ones (or escaped endpoints) rather than under-approximate.
      if (body[i + 1] === "-" && body[i + 2] !== undefined && body[i + 2] !== "]") {
        const end = body[i + 2]!;
        if (end === "\\") return null;
        const from = ch.codePointAt(0)!;
        const to = end.codePointAt(0)!;
        if (to < from || to - from > 512) return null;
        for (let code = from; code <= to; code++) chars.add(String.fromCodePoint(code));
        i += 2;
        continue;
      }
      chars.add(ch);
    }
    return chars;
  }

  // A group, dot, anchor, or a leading quantifier: unknown.
  if (c === "(" || c === "." || c === "^" || c === "*" || c === "+" || c === "?") return null;
  return new Set([c]);
}

/** Split a group body on top-level `|`, respecting nesting, classes and escapes. */
function splitAlternatives(body: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = "";

  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") {
      current += c + (body[i + 1] ?? "");
      i++;
      continue;
    }
    if (inClass) {
      current += c;
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      current += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "|" && depth === 0) {
      branches.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  branches.push(current);
  return branches;
}

/**
 * Can two of these alternatives match the same text?
 *
 * `(a|b)+` is safe: at every position exactly one branch can apply, so there is
 * one way to match and nothing to backtrack through. `(a|a)+` and `(a|ab)+` are
 * not: the engine must try both branches at every position, and against a
 * failing input it tries all 2^n combinations.
 */
function alternativesOverlap(body: string): boolean {
  const branches = splitAlternatives(body);
  if (branches.length < 2) return false;

  const sets = branches.map(firstSetOf);
  for (let i = 0; i < sets.length; i++) {
    const a = sets[i];
    if (a === null || a === undefined) return true; // unknown: assume the worst
    for (let j = i + 1; j < sets.length; j++) {
      const b = sets[j];
      if (b === null || b === undefined) return true;
      for (const ch of a) if (b.has(ch)) return true;
    }
  }
  return false;
}

/**
 * Structural check for the two catastrophic-backtracking shapes.
 *
 * Rejected: `(a+)+`, `(a*)*`, `(\d+|x)+`, `((ab)+)*` — a quantifier inside a
 * repeated group — and `(a|a)*`, `(a|ab)+`, `(x|.)*` — a repeated group whose
 * alternatives can match the same text.
 *
 * Accepted: `(abc)+`, `(a|b)+`, `(foo|bar)*`, `[ab]+`, `\d{3}-\d{4}`. None of
 * these gives the engine more than one way to match the same input.
 *
 * The scan is a single left-to-right pass tracking group boundaries — no regex
 * is used to analyse the regex, which would be its own small joke.
 */
export function checkRegexPattern(pattern: unknown): RegexCheck {
  if (typeof pattern !== "string") return { ok: false, reason: "NOT_A_STRING" };
  if (pattern.length === 0 || pattern.length > MAX_REGEX_LENGTH) {
    return { ok: false, reason: "TOO_LONG" };
  }

  /** Open groups: where each began, and whether its body holds a quantifier. */
  // `alternations` collects the bodies of every group with `|` nested inside
  // this one, so that repeating an outer group also checks them: ^((a|aa))+$
  // repeats an inner alternation the outer body's split never sees.
  const stack: Array<{ start: number; hasQuantifier: boolean; alternations: string[] }> = [];
  let quantifiers = 0;
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;

    if (c === "\\") {
      i++; // escaped: the next character is a literal, whatever it looks like
      continue;
    }
    // Inside `[...]` a `*` or `+` is a literal, not a quantifier.
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }

    if (c === "(") {
      stack.push({ start: i, hasQuantifier: false, alternations: [] });
      if (stack.length > MAX_GROUP_DEPTH) return { ok: false, reason: "TOO_COMPLEX" };
      continue;
    }

    if (c === ")") {
      const group = stack.pop();
      if (group === undefined) continue; // unbalanced; `new RegExp` will reject it

      const next = i + 1;
      const repeated = next < pattern.length && isUnboundedQuantifier(pattern, next);
      // Group prefixes are stripped so the body is the part that matches.
      let body = pattern.slice(group.start + 1, i);
      for (const prefix of ["?:", "?=", "?!", "?<=", "?<!"]) {
        if (body.startsWith(prefix)) {
          body = body.slice(prefix.length);
          break;
        }
      }
      if (splitAlternatives(body).length > 1) group.alternations.push(body);
      const parent = stack[stack.length - 1];
      if (repeated) {
        // Shape 1: a quantifier inside a repeated group.
        if (group.hasQuantifier) return { ok: false, reason: "NESTED_QUANTIFIER" };

        // Shape 2: a repeated group containing, at any depth, alternatives that
        // can match the same text.
        for (const alternation of group.alternations) {
          if (alternativesOverlap(alternation)) return { ok: false, reason: "AMBIGUOUS_ALTERNATION" };
        }

        // The group's own repetition counts toward the enclosing group's body.
        if (parent !== undefined) parent.hasQuantifier = true;
      }
      if (parent !== undefined) parent.alternations.push(...group.alternations);
      continue;
    }

    if (isUnboundedQuantifier(pattern, i)) {
      if (++quantifiers > MAX_QUANTIFIERS) return { ok: false, reason: "TOO_COMPLEX" };
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.hasQuantifier = true;
    }
  }

  try {
    new RegExp(pattern);
  } catch {
    return { ok: false, reason: "INVALID" };
  }
  return { ok: true };
}

/**
 * Compiled-pattern cache.
 *
 * Patterns come from a snapshot, so their cardinality is bounded by the number
 * of rules — but "bounded by customer configuration" is not bounded, so the
 * cache has a ceiling and clears rather than growing. `null` is cached too: a
 * rejected pattern must not be re-analysed on every evaluation.
 */
const CACHE_CEILING = 500;
const cache = new Map<string, RegExp | null>();

export function compileSafeRegExp(pattern: unknown): RegExp | null {
  if (typeof pattern !== "string") return null;

  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;

  const checked = checkRegexPattern(pattern);
  let compiled: RegExp | null = null;
  if (checked.ok) {
    try {
      compiled = new RegExp(pattern);
    } catch {
      compiled = null;
    }
  }

  if (cache.size >= CACHE_CEILING) cache.clear();
  cache.set(pattern, compiled);
  return compiled;
}

/** Exposed for tests; nothing on the evaluation path should need it. */
export function clearRegexCache(): void {
  cache.clear();
}
