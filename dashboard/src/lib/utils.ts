import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { FlagKind, Variation } from "./api";

/** Tailwind-aware class join: a later `px-3` beats an earlier `px-2`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * A variation as a person reads it.
 *
 * The name if it has one, otherwise the value — because `[true, false]` with no
 * names is the common case and "variation 1" tells nobody anything.
 */
export function variationLabel(variation: Variation | undefined, kind?: FlagKind): string {
  if (variation === undefined) return "—";
  if (variation.name !== null && variation.name.length > 0) return variation.name;
  return valueLabel(variation.value, kind);
}

export function valueLabel(value: unknown, kind?: FlagKind): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  if (kind === "json" || typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  return String(value);
}

/** "3m ago", "yesterday". Absolute time is in the `title`, where it belongs. */
export function relativeTime(iso: string | Date | null | undefined): string {
  if (iso === null || iso === undefined) return "never";
  const then = typeof iso === "string" ? new Date(iso) : iso;
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 45) return "just now";
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "second"],
    [3600, "minute"],
    [86_400, "hour"],
    [604_800, "day"],
    [2_629_800, "week"],
    [31_557_600, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let previous = 1;
  for (const [limit, unit] of units) {
    if (seconds < limit) return format.format(-Math.round(seconds / previous), unit);
    previous = limit;
  }
  return then.toLocaleDateString();
}

export function absoluteTime(iso: string | Date | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return date.toLocaleString();
}

/**
 * Parse a variation value typed into a form, for the flag's kind.
 *
 * Throws with a message a form can render: a JSON flag whose value does not
 * parse must not be saved as the string somebody typed.
 */
export function parseValue(raw: string, kind: FlagKind): unknown {
  switch (kind) {
    case "boolean": {
      const normalised = raw.trim().toLowerCase();
      if (normalised === "true") return true;
      if (normalised === "false") return false;
      throw new Error("a boolean variation is `true` or `false`");
    }
    case "number": {
      const value = Number(raw.trim());
      if (!Number.isFinite(value)) throw new Error("not a number");
      return value;
    }
    case "json":
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new Error("not valid JSON");
      }
    case "string":
    default:
      return raw;
  }
}

export function stringifyValue(value: unknown, kind: FlagKind): string {
  if (kind === "json") return JSON.stringify(value, null, 2);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** The clause operators the evaluator implements, grouped for a select. */
export const OPERATORS: Array<{ value: string; label: string; group: string; arity: "many" | "one" }> = [
  { value: "in", label: "is one of", group: "equality", arity: "many" },
  { value: "startsWith", label: "starts with", group: "string", arity: "many" },
  { value: "endsWith", label: "ends with", group: "string", arity: "many" },
  { value: "contains", label: "contains", group: "string", arity: "many" },
  { value: "matches", label: "matches regex", group: "string", arity: "one" },
  { value: "lessThan", label: "<", group: "number", arity: "one" },
  { value: "lessThanOrEqual", label: "≤", group: "number", arity: "one" },
  { value: "greaterThan", label: ">", group: "number", arity: "one" },
  { value: "greaterThanOrEqual", label: "≥", group: "number", arity: "one" },
  { value: "before", label: "before", group: "date", arity: "one" },
  { value: "after", label: "after", group: "date", arity: "one" },
  { value: "semVerEqual", label: "semver =", group: "semver", arity: "one" },
  { value: "semVerLessThan", label: "semver <", group: "semver", arity: "one" },
  { value: "semVerGreaterThan", label: "semver >", group: "semver", arity: "one" },
  { value: "segmentMatch", label: "is in segment", group: "segment", arity: "many" },
];

export const operatorLabel = (op: string): string =>
  OPERATORS.find((entry) => entry.value === op)?.label ?? op;

/** Value inputs differ by operator: a date picker for `before`, a number for `<`. */
export function operatorInputKind(op: string): "text" | "number" | "date" | "segment" {
  if (op === "segmentMatch") return "segment";
  if (["lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual"].includes(op)) {
    return "number";
  }
  if (op === "before" || op === "after") return "date";
  return "text";
}

/** A stable colour per environment when nobody has chosen one. */
export function environmentTint(key: string, color: string | null): string {
  if (color !== null && color.length > 0) return color;
  const palette = ["#4f7cff", "#12a594", "#e5484d", "#f5a524", "#8e4ec6", "#0091ff"];
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}
