/**
 * Production dry run (review PR-E2).
 *
 * The failure this exists to catch is the one that looks fine on every chart:
 * a rollout whose *proportion* is unchanged but whose *membership* churned
 * completely. Ten percent before, ten percent after, a different ten percent —
 * and every measurement of the rollout is now comparing two unrelated
 * populations without anybody noticing.
 */

import { describe, expect, it } from "vitest";
import { compileSnapshot, type CompilerInput } from "../../src/snapshot/compile.js";
import { dryRunFlag, reassignmentWarning } from "../../src/snapshot/dry-run.js";
import { evaluate, type EvaluationContext } from "../../src/sdk/index.js";
import { applyFlagConfigToInput, type ResolvedTarget } from "../../src/repositories/flags.js";
import type { Database } from "../../src/db/client.js";

const contexts: EvaluationContext[] = Array.from({ length: 2_000 }, (_, i) => ({
  key: `user-${i}`,
  country: ["NL", "DE", "FR"][i % 3]!,
}));

function input(over: {
  salt?: string;
  weight?: number;
  enabled?: boolean;
  rule?: boolean;
}): CompilerInput {
  const weight = over.weight ?? 10_000;
  return {
    environment: { id: "env-1", key: "production", bucketSalt: over.salt ?? "salt-a" },
    flags: [{ id: "f1", key: "checkout", kind: "boolean", archivedAt: null, clientAvailable: true }],
    variations: [
      { id: "v0", flagId: "f1", idx: 0, value: false },
      { id: "v1", flagId: "f1", idx: 1, value: true },
    ],
    flagEnvironments: [
      {
        id: "fe1",
        flagId: "f1",
        environmentId: "env-1",
        enabled: over.enabled ?? true,
        offVariationId: "v0",
        fallthroughVariationId: null,
        fallthroughRollout: {
          variations: [
            { variationIndex: 1, weight },
            { variationIndex: 0, weight: 100_000 - weight },
          ],
        },
        version: 1,
      },
    ],
    targets: [],
    rules: over.rule
      ? [{ id: "r1", flagEnvironmentId: "fe1", idx: 0, variationId: "v1", rollout: null }]
      : [],
    clauses: over.rule
      ? [
          {
            ruleId: "r1",
            idx: 0,
            contextKind: "user",
            attribute: "country",
            op: "in",
            values: ["NL"],
            negate: false,
          },
        ]
      : [],
    prerequisites: [],
    segments: [],
    segmentMembers: [],
    segmentRules: [],
    segmentRuleClauses: [],
  };
}

const snapshot = (over: Parameters<typeof input>[0], version = 1) =>
  compileSnapshot(input(over), { version });

describe("dryRunFlag", () => {
  it("reports nothing changed when nothing changed", () => {
    const result = dryRunFlag("checkout", snapshot({}), snapshot({}, 2), contexts);
    expect(result.changed).toBe(0);
    expect(result.reassigned).toBe(0);
    expect(result.examples).toEqual([]);
  });

  it("counts who moves when a rollout is widened", () => {
    const result = dryRunFlag(
      "checkout",
      snapshot({ weight: 10_000 }),
      snapshot({ weight: 20_000 }, 2),
      contexts,
    );
    // About 10% of 2,000 more users get the feature.
    expect(result.changed).toBeGreaterThan(120);
    expect(result.changed).toBeLessThan(280);
    expect(result.examples.length).toBeGreaterThan(0);
    expect(result.examples[0]).toHaveProperty("contextKey");
  });

  it("shows the distribution on both sides", () => {
    const result = dryRunFlag(
      "checkout",
      snapshot({ weight: 10_000 }),
      snapshot({ weight: 50_000 }, 2),
      contexts,
    );
    expect(result.distributionBefore["true"]).toBeLessThan(result.distributionAfter["true"]!);
    expect(result.sampled).toBe(2_000);
  });

  it("counts a turned-off flag as changed but not reassigned", () => {
    // Losing the flag is not the same as moving between its variations, and the
    // distinction is what makes the churn warning meaningful.
    const result = dryRunFlag(
      "checkout",
      snapshot({ enabled: true, weight: 100_000 }),
      snapshot({ enabled: false, weight: 100_000 }, 2),
      contexts,
    );
    expect(result.changed).toBeGreaterThan(0);
  });

  it("handles a flag that does not exist in either snapshot", () => {
    const result = dryRunFlag("no-such-flag", snapshot({}), snapshot({}, 2), contexts);
    expect(result.changed).toBe(0);
  });
});

describe("reassignmentWarning", () => {
  it("fires when the salt changes underneath a rollout", () => {
    // The disaster case: same 10%, completely different people. Every chart
    // looks unchanged; every running experiment is now nonsense.
    const result = dryRunFlag(
      "checkout",
      snapshot({ salt: "salt-a", weight: 50_000 }),
      snapshot({ salt: "salt-b", weight: 50_000 }, 2),
      contexts,
    );

    expect(result.reassigned).toBeGreaterThan(result.sampled * 0.3);
    const warning = reassignmentWarning(result);
    expect(warning).toContain("re-bucketing rather than a resize");
    expect(warning).toContain("bucketing salt");
  });

  it("stays quiet for an ordinary widening", () => {
    // Users only join the rollout; nobody is swapped out. This must not warn,
    // or the warning becomes noise and stops being read.
    const result = dryRunFlag(
      "checkout",
      snapshot({ weight: 10_000 }),
      snapshot({ weight: 20_000 }, 2),
      contexts,
    );
    expect(reassignmentWarning(result)).toBeNull();
  });

  it("stays quiet when nothing moved at all", () => {
    const result = dryRunFlag("checkout", snapshot({}), snapshot({}, 2), contexts);
    expect(reassignmentWarning(result)).toBeNull();
  });

  it("stays quiet for a targeting change that genuinely moves people", () => {
    // Adding a rule for NL moves a third of the sample into the flag. That is a
    // real change with a real distribution shift, not a re-bucketing.
    const result = dryRunFlag(
      "checkout",
      snapshot({ weight: 0 }),
      snapshot({ weight: 0, rule: true }, 2),
      contexts,
    );
    expect(result.changed).toBeGreaterThan(500);
    expect(reassignmentWarning(result)).toBeNull();
  });
});

describe("applyFlagConfigToInput: the patch a dry run compiles", () => {
  const target: ResolvedTarget = {
    projectId: "p1",
    environmentId: "env-1",
    environmentKey: "production",
    isProduction: true,
    flagId: "f1",
    flagKey: "checkout",
    flagEnvironmentId: "fe1",
    version: 1,
    variationIds: ["v0", "v1"],
    variationIndexById: new Map([
      ["v0", 0],
      ["v1", 1],
    ]),
  };
  /** Any query is a failure: without prerequisites a dry run must not touch the database. */
  const noDb = new Proxy({}, {
    get() {
      throw new Error("dry run touched the database");
    },
  }) as unknown as Database;

  it("compiles the patched configuration without touching the database", async () => {
    const base = input({ rule: true });
    const patched = await applyFlagConfigToInput(noDb, base, target, {
      fallthroughVariation: 0,
      rules: [
        {
          clauses: [
            { contextKind: "user", attribute: "country", op: "in", values: ["DE"], negate: false },
          ],
          variation: 1,
        },
      ],
      targets: [{ contextKind: "user", variation: 1, keys: ["user-0"] }],
    });
    const after = compileSnapshot(patched, { version: 2 });
    const value = (ctx: EvaluationContext) => evaluate("checkout", ctx, after, false).value;
    expect(value({ key: "user-0", country: "NL" })).toBe(true); // targeted
    expect(value({ key: "user-1", country: "DE" })).toBe(true); // new rule
    expect(value({ key: "user-2", country: "NL" })).toBe(false); // old rule gone
    // The loaded input is left as it was.
    expect(base.rules.map((r) => r.id)).toEqual(["r1"]);
    expect(base.flagEnvironments[0]!.fallthroughVariationId).toBeNull();
  });

  it("rejects what a real save would reject", async () => {
    await expect(
      applyFlagConfigToInput(noDb, input({}), target, { offVariation: 7 }),
    ).rejects.toMatchObject({ code: "UNKNOWN_VARIATION" });
    await expect(
      applyFlagConfigToInput(noDb, input({}), target, {
        fallthroughRollout: { variations: [{ variation: 1, weight: 10 }] },
      }),
    ).rejects.toMatchObject({ code: "ROLLOUT_WEIGHTS" });
  });
});
