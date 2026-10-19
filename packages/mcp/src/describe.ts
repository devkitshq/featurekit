/**
 * Flags in words, and the arithmetic behind "roll this out to 20%".
 *
 * A model reads tool results as text. Weights out of 100,000 and variation
 * indices are what the API speaks; "20% get true, 80% get false" is what a
 * person asked for and what the model has to confirm back to them.
 */

import {
  WEIGHT_SCALE,
  type FlagConfig,
  type FlagRow,
  type RolloutBody,
  type Variation,
  type WireRollout,
} from "./api.js";

/** Percent (0–100, up to three decimals) as a weight out of 100,000. */
export function percentToWeight(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`percentage must be between 0 and 100, got ${percent}`);
  }
  return Math.round(percent * (WEIGHT_SCALE / 100));
}

export function weightToPercent(weight: number): string {
  const percent = (weight / WEIGHT_SCALE) * 100;
  return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(3))}%`;
}

export function valueLabel(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
}

export function variationLabel(variations: readonly Variation[], idx: number | null | undefined): string {
  if (idx === null || idx === undefined) return "nothing (the caller's default)";
  const variation = variations.find((v) => v.idx === idx);
  if (variation === undefined) return `variation ${idx}`;
  const name = variation.name !== null && variation.name.length > 0 ? ` (${variation.name})` : "";
  return `${valueLabel(variation.value)}${name}`;
}

/**
 * Which variation a request means.
 *
 * Accepts an index, a value (`true`, `"blue"`), or a variation name. For a
 * boolean flag with nothing given, the rollout is of `true`: "roll out to 20%"
 * means 20% get the feature.
 */
export function resolveVariation(
  variations: readonly Variation[],
  kind: string,
  wanted: string | number | boolean | undefined,
): Variation {
  if (wanted === undefined) {
    if (kind === "boolean") {
      const on = variations.find((v) => v.value === true);
      if (on !== undefined) return on;
    }
    throw new Error(
      `this ${kind} flag has ${variations.length} variations; say which one to roll out: ` +
        variations.map((v) => `${v.idx} = ${variationLabel(variations, v.idx)}`).join(", "),
    );
  }
  const match =
    variations.find((v) => v.value === wanted) ??
    (typeof wanted === "number" ? variations.find((v) => v.idx === wanted) : undefined) ??
    (typeof wanted === "string"
      ? variations.find((v) => v.name !== null && v.name.toLowerCase() === wanted.toLowerCase()) ??
        variations.find((v) => String(v.value) === wanted) ??
        (/^\d+$/.test(wanted) ? variations.find((v) => v.idx === Number(wanted)) : undefined)
      : undefined) ??
    (typeof wanted === "string" && kind === "boolean" && /^(true|false)$/i.test(wanted)
      ? variations.find((v) => v.value === (wanted.toLowerCase() === "true"))
      : undefined);
  if (match === undefined) {
    throw new Error(
      `no variation matches ${JSON.stringify(wanted)}; the flag has: ` +
        variations.map((v) => `${v.idx} = ${variationLabel(variations, v.idx)}`).join(", "),
    );
  }
  return match;
}

/**
 * The fallthrough rollout that serves `percent` of contexts `on` and the rest
 * `rest`.
 *
 * Bucketing is kept from the existing rollout — its context kind, attribute,
 * seed, and the order of its variations. The order matters: buckets are a
 * cumulative ladder, so keeping `on` where it was means raising 10% to 20% adds
 * people to the ones already in, rather than reshuffling who is in.
 */
export function buildRollout(
  existing: WireRollout | undefined,
  on: number,
  rest: number,
  percent: number,
): RolloutBody {
  const onWeight = percentToWeight(percent);
  const restWeight = WEIGHT_SCALE - onWeight;
  const existingOrder = existing?.variations.map((v) => v.variationIndex) ?? [];
  const keepsOrder =
    existingOrder.length === 2 && existingOrder.includes(on) && existingOrder.includes(rest);
  const order = keepsOrder ? existingOrder : [on, rest];
  return {
    ...(existing?.contextKind !== undefined ? { contextKind: existing.contextKind } : {}),
    ...(existing?.bucketBy !== undefined ? { bucketBy: existing.bucketBy } : {}),
    ...(existing?.seed !== undefined ? { seed: existing.seed } : {}),
    variations: order.map((variation) => ({
      variation,
      weight: variation === on ? onWeight : restWeight,
    })),
  };
}

function describeRollout(variations: readonly Variation[], rollout: WireRollout): string {
  const parts = rollout.variations
    .filter((v) => v.weight > 0)
    .map((v) => `${weightToPercent(v.weight)} get ${variationLabel(variations, v.variationIndex)}`);
  const by = `${rollout.contextKind ?? "user"}.${rollout.bucketBy ?? "key"}`;
  return `${parts.join(", ")} (bucketed by ${by})`;
}

/** What everyone not matched by a target or rule receives. */
export function describeDefault(variations: readonly Variation[], config: FlagConfig): string {
  if (config.fallthroughRollout !== undefined) return describeRollout(variations, config.fallthroughRollout);
  return `everyone gets ${variationLabel(variations, config.fallthroughVariation)}`;
}

/** A flag's configuration in one environment, as a few lines a person can check. */
export function describeConfig(variations: readonly Variation[], config: FlagConfig): string {
  const lines = [`${config.flagKey} in ${config.environmentKey} (version ${config.version}):`];
  if (!config.enabled) {
    lines.push(`- OFF: everyone gets ${variationLabel(variations, config.offVariation)}`);
    lines.push(`- when turned on, the default would be: ${describeDefault(variations, config)}`);
  } else {
    lines.push("- ON");
    for (const target of config.targets) {
      lines.push(
        `- ${target.keys.length} ${target.contextKind} key(s) targeted to ${variationLabel(variations, target.variation)}`,
      );
    }
    config.rules.forEach((rule, i) => {
      const when = rule.clauses
        .map(
          (c) =>
            `${c.contextKind}.${c.attribute} ${c.negate ? "not " : ""}${c.op} ${JSON.stringify(c.values)}`,
        )
        .join(" and ");
      const serves =
        rule.rollout !== undefined
          ? describeRollout(variations, rule.rollout)
          : variationLabel(variations, rule.variation);
      lines.push(`- rule ${i + 1}${rule.description ? ` "${rule.description}"` : ""}: if ${when || "always"} → ${serves}`);
    });
    lines.push(`- everyone else: ${describeDefault(variations, config)}`);
  }
  if (config.prerequisites.length > 0) {
    lines.push(
      `- prerequisites: ${config.prerequisites.map((p) => `${p.flagKey} must serve variation ${p.variation}`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** One line per flag, for a list. */
export function describeRow(row: FlagRow): string {
  const state = row.environment;
  const head = `${row.key} — "${row.name}" (${row.kind}${row.archived ? ", archived" : ""})`;
  if (state === null) return `${head}: not configured in this environment`;
  if (!state.enabled) return `${head}: OFF`;
  const serving =
    state.fallthroughRollout !== null
      ? state.fallthroughRollout
          .filter((v) => v.weight > 0)
          .map((v) => `${weightToPercent(v.weight)} ${variationLabel(row.variations, v.variation)}`)
          .join(" / ")
      : variationLabel(row.variations, state.fallthroughVariation);
  const extras = [
    state.ruleCount > 0 ? `${state.ruleCount} rule(s)` : null,
    state.targetCount > 0 ? `${state.targetCount} target(s)` : null,
  ].filter((x) => x !== null);
  return `${head}: ON, default ${serving}${extras.length > 0 ? `, plus ${extras.join(", ")}` : ""}`;
}

/**
 * How well a flag matches a phrase like "cart v2 page".
 *
 * People name flags the way they talk; keys are `cart-v2-page`,
 * `cartV2Page` or `checkout.cart_v2`. Both sides are reduced to lowercase
 * words and scored by how many of the phrase's words the flag has. 0 is no
 * match.
 */
export function matchScore(query: string, row: { key: string; name: string; description?: string | null; tags?: string[] }): number {
  const words = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0);
  const wanted = words(query);
  if (wanted.length === 0) return 1;
  const compact = (s: string) => words(s).join("");
  if (compact(row.key) === wanted.join("") || compact(row.name) === wanted.join("")) return 100;
  const haystack = new Set([
    ...words(row.key),
    ...words(row.name),
    ...words(row.description ?? ""),
    ...(row.tags ?? []).flatMap(words),
  ]);
  const joined = [...haystack].join(" ");
  let hits = 0;
  for (const word of wanted) {
    if (haystack.has(word)) hits += 2;
    else if (joined.includes(word)) hits += 1;
  }
  return hits === 0 ? 0 : Math.round((hits / (wanted.length * 2)) * 90);
}
