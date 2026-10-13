/**
 * What would this change actually do? (review PR-E2)
 *
 * **The question an operator has before pressing save is not "is this valid".**
 * It is "how many people does this move, and are they the ones I meant?" A
 * rollout edited from 10% to 15% sounds like it adds 5% — and if the bucketing
 * parameters changed underneath it, it can instead re-randomise the entire
 * population, keeping the *proportion* while swapping *who is in it*. Nothing in
 * a validation pass catches that, and nothing after the fact makes it visible
 * either: the numbers on the dashboard look exactly right.
 *
 * So a dry run compiles the proposed configuration, evaluates a sample of real
 * contexts against both snapshots, and reports the difference — including the
 * churn figure that separates "5% more people" from "the same 10%, different
 * people".
 *
 * The sample is supplied by the caller. Synthesising context keys would answer
 * a question about synthetic users, and this exists precisely because that is
 * not the question.
 */

import { evaluate, type EvaluationContext, type Snapshot } from "../sdk/index.js";

export interface DryRunChange {
  contextKey: string;
  before: unknown;
  after: unknown;
}

export interface DryRunResult {
  flagKey: string;
  sampled: number;
  /** Contexts whose value changes. */
  changed: number;
  /**
   * Contexts that move *between* variations rather than in or out of the flag.
   *
   * This is the number that catches an accidental re-bucketing: a rollout whose
   * totals are unchanged but whose membership churned completely reports 0 net
   * difference and a large `reassigned`.
   */
  reassigned: number;
  /** Value → how many contexts hold it, before and after. */
  distributionBefore: Record<string, number>;
  distributionAfter: Record<string, number>;
  /** A bounded sample of actual changes, for a human to eyeball. */
  examples: DryRunChange[];
}

export interface DryRunOptions {
  /** How many individual changes to return. The rest are counted, not listed. */
  maxExamples?: number;
}

function label(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Compare one flag across two snapshots for a sample of contexts.
 *
 * Both snapshots are evaluated with the same evaluator the SDKs use — not a
 * simulation of it. A dry run that models evaluation separately is a dry run
 * that can disagree with production, which is worse than not having one.
 */
export function dryRunFlag(
  flagKey: string,
  before: Snapshot,
  after: Snapshot,
  contexts: readonly EvaluationContext[],
  options: DryRunOptions = {},
): DryRunResult {
  const maxExamples = options.maxExamples ?? 20;
  const distributionBefore: Record<string, number> = {};
  const distributionAfter: Record<string, number> = {};
  const examples: DryRunChange[] = [];

  let changed = 0;
  let reassigned = 0;

  for (const context of contexts) {
    // `null` as the default so "the flag does not apply" is distinguishable
    // from any real variation value.
    const from = evaluate(flagKey, context, before, null as unknown);
    const to = evaluate(flagKey, context, after, null as unknown);

    const fromLabel = label(from.value);
    const toLabel = label(to.value);
    distributionBefore[fromLabel] = (distributionBefore[fromLabel] ?? 0) + 1;
    distributionAfter[toLabel] = (distributionAfter[toLabel] ?? 0) + 1;

    if (fromLabel === toLabel) continue;
    changed++;
    // Both sides served a real variation: this context moved between them
    // rather than gaining or losing the flag.
    if (from.variationIndex !== null && to.variationIndex !== null) reassigned++;

    if (examples.length < maxExamples) {
      const key =
        typeof (context as { key?: unknown }).key === "string"
          ? ((context as { key: string }).key)
          : "(multi)";
      examples.push({ contextKey: key, before: from.value, after: to.value });
    }
  }

  return {
    flagKey,
    sampled: contexts.length,
    changed,
    reassigned,
    distributionBefore,
    distributionAfter,
    examples,
  };
}

/**
 * The warning a dry run exists to produce.
 *
 * A change where nearly everything moved but the distribution barely did is
 * almost always an accidental re-bucketing — a changed salt, a changed seed, a
 * renamed flag whose rollout was not seeded. It is the one outcome that looks
 * fine on every chart and is catastrophic for anyone measuring the rollout.
 */
export function reassignmentWarning(result: DryRunResult): string | null {
  if (result.sampled === 0 || result.reassigned === 0) return null;

  const churn = result.reassigned / result.sampled;
  const netMoved = Object.keys({ ...result.distributionBefore, ...result.distributionAfter }).reduce(
    (total, key) =>
      total + Math.abs((result.distributionAfter[key] ?? 0) - (result.distributionBefore[key] ?? 0)),
    0,
  ) / (2 * result.sampled);

  if (churn > 0.2 && netMoved < churn / 2) {
    return (
      `${Math.round(churn * 100)}% of sampled contexts move between variations, but the ` +
      `overall split changes by only ${Math.round(netMoved * 100)}%. That is the signature of a ` +
      `re-bucketing rather than a resize: the same proportion of users, a different set of them. ` +
      `Check whether the bucketing salt, the rollout seed, or the flag key changed.`
    );
  }
  return null;
}
