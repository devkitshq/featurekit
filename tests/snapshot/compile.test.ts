import { describe, expect, it } from "vitest";
import { CompileError, clientFlagKeys, compileSnapshot } from "../../src/snapshot/compile.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";
import { CuckooFilter } from "../../src/sdk/index.js";
import { RoaringBitmap } from "../../src/sdk/index.js";

const ENV = { id: "env-1", key: "production", bucketSalt: "s4lt" };

/** A minimal well-formed input; each test overrides the parts it cares about. */
function input(over: Partial<CompilerInput> = {}): CompilerInput {
  return {
    environment: ENV,
    flags: [],
    variations: [],
    flagEnvironments: [],
    targets: [],
    rules: [],
    clauses: [],
    prerequisites: [],
    segments: [],
    segmentMembers: [],
    segmentRules: [],
    segmentRuleClauses: [],
    ...over,
  };
}

/** One boolean flag, off-variation false / fallthrough true, fully wired. */
function booleanFlag(key: string, over: Partial<CompilerInput> = {}): CompilerInput {
  const flagId = `flag-${key}`;
  return input({
    flags: [{ id: flagId, key, kind: "boolean", archivedAt: null, clientAvailable: false }],
    variations: [
      { id: `${flagId}-v0`, flagId, idx: 0, value: false },
      { id: `${flagId}-v1`, flagId, idx: 1, value: true },
    ],
    flagEnvironments: [
      {
        id: `fe-${key}`,
        flagId,
        environmentId: ENV.id,
        enabled: true,
        offVariationId: `${flagId}-v0`,
        fallthroughVariationId: `${flagId}-v1`,
        fallthroughRollout: null,
        version: 3,
      },
    ],
    ...over,
  });
}

describe("compileSnapshot - shape", () => {
  it("carries the environment key, salt and a version", () => {
    const snap = compileSnapshot(booleanFlag("f"), { version: 42 });
    expect(snap.environmentKey).toBe("production");
    expect(snap.salt).toBe("s4lt");
    expect(snap.version).toBe(42);
  });

  it("emits variations positionally, ordered by idx", () => {
    const snap = compileSnapshot(booleanFlag("f"), { version: 1 });
    expect(snap.flags["f"]!.variations).toEqual([false, true]);
  });

  it("resolves variation uuids to positional indices", () => {
    // Rules reference variations by id in Postgres; the wire format uses the
    // index. Getting this mapping wrong is silent and total.
    const snap = compileSnapshot(booleanFlag("f"), { version: 1 });
    const flag = snap.flags["f"]!;
    expect(flag.offVariation).toBe(0);
    expect(flag.fallthrough).toEqual({ variation: 1 });
  });

  it("carries the per-flag version through for patch ordering", () => {
    expect(compileSnapshot(booleanFlag("f"), { version: 1 }).flags["f"]!.version).toBe(3);
  });

  it("maps `enabled` to `on`", () => {
    const off = booleanFlag("f");
    off.flagEnvironments[0]!.enabled = false;
    expect(compileSnapshot(off, { version: 1 }).flags["f"]!.on).toBe(false);
  });
});

describe("compileSnapshot - what it drops", () => {
  it("drops archived flags", () => {
    const i = booleanFlag("f");
    i.flags[0]!.archivedAt = new Date();
    expect(compileSnapshot(i, { version: 1 }).flags["f"]).toBeUndefined();
  });

  it("drops a flag with no configuration in this environment", () => {
    // A flag exists once at the project level; its configuration exists once
    // per environment. With no config row there is nothing to serve, and
    // inventing one would be the compiler guessing. The SDK reports
    // FLAG_NOT_FOUND and the caller's default is served.
    const i = booleanFlag("f");
    i.flagEnvironments = [];
    expect(compileSnapshot(i, { version: 1 }).flags["f"]).toBeUndefined();
  });

  it("ignores configuration belonging to another environment", () => {
    const i = booleanFlag("f");
    i.flagEnvironments[0]!.environmentId = "env-other";
    expect(compileSnapshot(i, { version: 1 }).flags["f"]).toBeUndefined();
  });
});

describe("compileSnapshot - targeting", () => {
  it("groups individual targets by context kind and variation", () => {
    const i = booleanFlag("f", {});
    i.targets = [
      { flagEnvironmentId: "fe-f", variationId: "flag-f-v1", contextKind: "user", contextKey: "usr_1" },
      { flagEnvironmentId: "fe-f", variationId: "flag-f-v1", contextKind: "user", contextKey: "usr_2" },
      { flagEnvironmentId: "fe-f", variationId: "flag-f-v0", contextKind: "organization", contextKey: "org_9" },
    ];
    const targets = compileSnapshot(i, { version: 1 }).flags["f"]!.targets;
    expect(targets).toEqual([
      { contextKind: "organization", variation: 0, keys: ["org_9"] },
      { contextKind: "user", variation: 1, keys: ["usr_1", "usr_2"] },
    ]);
  });

  it("orders rules by idx and attaches their clauses by idx", () => {
    const i = booleanFlag("f");
    i.rules = [
      { id: "r-b", flagEnvironmentId: "fe-f", idx: 1, variationId: "flag-f-v1", rollout: null },
      { id: "r-a", flagEnvironmentId: "fe-f", idx: 0, variationId: "flag-f-v0", rollout: null },
    ];
    i.clauses = [
      { ruleId: "r-a", idx: 1, contextKind: "user", attribute: "plan", op: "in", values: ["pro"], negate: false },
      { ruleId: "r-a", idx: 0, contextKind: "user", attribute: "country", op: "in", values: ["DE"], negate: false },
      { ruleId: "r-b", idx: 0, contextKind: "user", attribute: "plan", op: "in", values: ["free"], negate: true },
    ];
    const rules = compileSnapshot(i, { version: 1 }).flags["f"]!.rules;
    expect(rules.map((r) => r.id)).toEqual(["r-a", "r-b"]);
    expect(rules[0]!.clauses.map((c) => c.attribute)).toEqual(["country", "plan"]);
    expect(rules[0]!.variation).toBe(0);
    expect(rules[1]!.clauses[0]!.negate).toBe(true);
  });

  it("passes a rule rollout through untouched", () => {
    const i = booleanFlag("f");
    const rollout = { variations: [{ variationIndex: 1, weight: 100_000 }] };
    i.rules = [{ id: "r0", flagEnvironmentId: "fe-f", idx: 0, variationId: null, rollout }];
    const rule = compileSnapshot(i, { version: 1 }).flags["f"]!.rules[0]!;
    expect(rule.rollout).toEqual(rollout);
    expect(rule.variation).toBeUndefined();
  });

  it("compiles a fallthrough rollout", () => {
    const i = booleanFlag("f");
    i.flagEnvironments[0]!.fallthroughVariationId = null;
    i.flagEnvironments[0]!.fallthroughRollout = { variations: [{ variationIndex: 1, weight: 100_000 }] };
    expect(compileSnapshot(i, { version: 1 }).flags["f"]!.fallthrough).toEqual({
      rollout: { variations: [{ variationIndex: 1, weight: 100_000 }] },
    });
  });

  it("rejects a variation id that does not belong to the flag", () => {
    const i = booleanFlag("f");
    i.flagEnvironments[0]!.offVariationId = "some-other-flags-variation";
    expect(() => compileSnapshot(i, { version: 1 })).toThrow(CompileError);
  });
});

describe("compileSnapshot - prerequisites", () => {
  function twoFlags(): CompilerInput {
    const a = booleanFlag("a");
    const b = booleanFlag("b");
    return input({
      flags: [...a.flags, ...b.flags],
      variations: [...a.variations, ...b.variations],
      flagEnvironments: [...a.flagEnvironments, ...b.flagEnvironments],
    });
  }

  it("resolves a prerequisite to the flag key and variation index", () => {
    const i = twoFlags();
    i.prerequisites = [
      { flagEnvironmentId: "fe-a", prerequisiteFlagId: "flag-b", requiredVariationId: "flag-b-v1" },
    ];
    expect(compileSnapshot(i, { version: 1 }).flags["a"]!.prerequisites).toEqual([
      { key: "b", variation: 1 },
    ]);
  });

  it("orders flags so every prerequisite precedes its dependent", () => {
    // Topological order, so a consumer walking the snapshot in order never
    // reads a flag before the flag it depends on.
    const i = twoFlags();
    i.prerequisites = [
      { flagEnvironmentId: "fe-a", prerequisiteFlagId: "flag-b", requiredVariationId: "flag-b-v1" },
    ];
    expect(Object.keys(compileSnapshot(i, { version: 1 }).flags)).toEqual(["b", "a"]);
  });

  it("REJECTS a cycle at compile time", () => {
    // The evaluator has a depth cap as defence, but the compiler is the
    // mechanism: it must never publish a snapshot the evaluator has to survive.
    const i = twoFlags();
    i.prerequisites = [
      { flagEnvironmentId: "fe-a", prerequisiteFlagId: "flag-b", requiredVariationId: "flag-b-v1" },
      { flagEnvironmentId: "fe-b", prerequisiteFlagId: "flag-a", requiredVariationId: "flag-a-v1" },
    ];
    expect(() => compileSnapshot(i, { version: 1 })).toThrow(/cycle/i);
  });

  it("rejects a self-referencing prerequisite", () => {
    const i = twoFlags();
    i.prerequisites = [
      { flagEnvironmentId: "fe-a", prerequisiteFlagId: "flag-a", requiredVariationId: "flag-a-v1" },
    ];
    expect(() => compileSnapshot(i, { version: 1 })).toThrow(/cycle/i);
  });

  it("drops a prerequisite whose flag is archived, rather than dangling", () => {
    const i = twoFlags();
    i.flags[1]!.archivedAt = new Date();
    i.prerequisites = [
      { flagEnvironmentId: "fe-a", prerequisiteFlagId: "flag-b", requiredVariationId: "flag-b-v1" },
    ];
    // The dependent flag must still compile; a dangling prerequisite key would
    // make the evaluator report PREREQUISITE_FAILED forever.
    expect(compileSnapshot(i, { version: 1 }).flags["a"]!.prerequisites).toEqual([]);
  });
});

describe("compileSnapshot - referenced attributes", () => {
  it("emits the attributes a flag's rules actually reference, kind-qualified", () => {
    const i = booleanFlag("f");
    i.rules = [{ id: "r0", flagEnvironmentId: "fe-f", idx: 0, variationId: "flag-f-v1", rollout: null }];
    i.clauses = [
      { ruleId: "r0", idx: 0, contextKind: "user", attribute: "country", op: "in", values: ["DE"], negate: false },
      { ruleId: "r0", idx: 1, contextKind: "organization", attribute: "tier", op: "in", values: ["ent"], negate: false },
      { ruleId: "r0", idx: 2, contextKind: "user", attribute: "country", op: "in", values: ["AT"], negate: false },
    ];
    // Deduplicated and sorted, so the set is a stable fingerprint input.
    expect(compileSnapshot(i, { version: 1 }).flags["f"]!.referencedAttributes).toEqual([
      "organization.tier",
      "user.country",
    ]);
  });

  it("is empty for a flag with no rules", () => {
    expect(compileSnapshot(booleanFlag("f"), { version: 1 }).flags["f"]!.referencedAttributes).toEqual([]);
  });

  it("includes the bucketing attribute of a rule rollout", () => {
    const i = booleanFlag("f");
    i.rules = [
      {
        id: "r0",
        flagEnvironmentId: "fe-f",
        idx: 0,
        variationId: null,
        rollout: { contextKind: "organization", bucketBy: "accountId", variations: [{ variationIndex: 1, weight: 100_000 }] },
      },
    ];
    expect(compileSnapshot(i, { version: 1 }).flags["f"]!.referencedAttributes).toContain(
      "organization.accountId",
    );
  });

  it("marks a flag whose value cannot be shared across contexts", () => {
    // A rollout buckets on the context key, so the flag has a per-context
    // answer by construction and cannot share a fan-out fingerprint.
    const rolled = booleanFlag("f");
    rolled.flagEnvironments[0]!.fallthroughVariationId = null;
    rolled.flagEnvironments[0]!.fallthroughRollout = { variations: [{ variationIndex: 1, weight: 50_000 }] };
    expect(compileSnapshot(rolled, { version: 1 }).flags["f"]!.perContext).toBe(true);

    const targeted = booleanFlag("g");
    targeted.targets = [
      { flagEnvironmentId: "fe-g", variationId: "flag-g-v1", contextKind: "user", contextKey: "usr_1" },
    ];
    expect(compileSnapshot(targeted, { version: 1 }).flags["g"]!.perContext).toBe(true);

    expect(compileSnapshot(booleanFlag("h"), { version: 1 }).flags["h"]!.perContext).toBe(false);
  });

  it("marks a flag with a segment clause as per-context", () => {
    // Segment membership is a function of the context key, so it breaks the
    // fingerprint collapse exactly like a rollout does.
    const i = booleanFlag("f");
    i.rules = [{ id: "r0", flagEnvironmentId: "fe-f", idx: 0, variationId: "flag-f-v1", rollout: null }];
    i.clauses = [
      { ruleId: "r0", idx: 0, contextKind: "user", attribute: "key", op: "segmentMatch", values: ["beta"], negate: false },
    ];
    expect(compileSnapshot(i, { version: 1 }).flags["f"]!.perContext).toBe(true);
  });
});

/* ───────────────────────────── segments ─────────────────────────────── */

const seg = (id: string, key: string, over = {}) => ({
  id,
  key,
  environmentId: ENV.id,
  version: 1,
  ...over,
});

describe("compileSnapshot - segment encodings", () => {
  it("inlines a small segment", () => {
    const i = booleanFlag("f");
    i.segments = [seg("s1", "beta")];
    i.segmentMembers = [
      { segmentId: "s1", contextKind: "user", contextKey: "usr_1", excluded: false },
      { segmentId: "s1", contextKind: "user", contextKey: "usr_2", excluded: true },
    ];
    const compiled = compileSnapshot(i, { version: 1 }).segments["beta"]!;
    expect(compiled.kind).toBe("inline");
    expect(compiled).toMatchObject({ members: ["usr_1"], excluded: ["usr_2"] });
  });

  it("builds a cuckoo filter for a large segment with opaque keys", () => {
    const i = booleanFlag("f");
    i.segments = [seg("s1", "enterprise")];
    i.segmentMembers = Array.from({ length: 300 }, (_, n) => ({
      segmentId: "s1",
      contextKind: "user",
      contextKey: `usr_${n.toString(16)}a`,
      excluded: false,
    }));
    const compiled = compileSnapshot(i, { version: 1, segmentInlineMax: 100 }).segments["enterprise"]!;
    expect(compiled.kind).toBe("cuckoo");
    if (compiled.kind !== "cuckoo") throw new Error("unreachable");
    const filter = CuckooFilter.decode(compiled.filter);
    for (let n = 0; n < 300; n++) expect(filter.contains(`usr_${n.toString(16)}a`)).toBe(true);
  });

  it("prefers roaring when every member key is integral", () => {
    const i = booleanFlag("f");
    i.segments = [seg("s1", "accounts")];
    i.segmentMembers = Array.from({ length: 300 }, (_, n) => ({
      segmentId: "s1",
      contextKind: "user",
      contextKey: String(n),
      excluded: false,
    }));
    const compiled = compileSnapshot(i, { version: 1, segmentInlineMax: 100 }).segments["accounts"]!;
    expect(compiled.kind).toBe("roaring");
    if (compiled.kind !== "roaring") throw new Error("unreachable");
    const bitmap = RoaringBitmap.deserialize(compiled.bitmap);
    for (let n = 0; n < 300; n++) expect(bitmap.contains(n)).toBe(true);
    expect(bitmap.contains(9_999)).toBe(false);
  });

  it("falls back to cuckoo when even one key is non-integral", () => {
    const i = booleanFlag("f");
    i.segments = [seg("s1", "mixed")];
    i.segmentMembers = [
      ...Array.from({ length: 299 }, (_, n) => ({
        segmentId: "s1",
        contextKind: "user",
        contextKey: String(n),
        excluded: false,
      })),
      { segmentId: "s1", contextKind: "user", contextKey: "usr_uuid", excluded: false },
    ];
    expect(compileSnapshot(i, { version: 1, segmentInlineMax: 100 }).segments["mixed"]!.kind).toBe("cuckoo");
  });

  it("treats a leading-zero key as non-integral, agreeing with the SDK", () => {
    // "07" and "7" are distinct context keys but the same integer. If the
    // compiler picked roaring here the SDK would answer `false` for "07".
    const i = booleanFlag("f");
    i.segments = [seg("s1", "zeros")];
    i.segmentMembers = [
      ...Array.from({ length: 299 }, (_, n) => ({
        segmentId: "s1",
        contextKind: "user",
        contextKey: String(n + 1),
        excluded: false,
      })),
      { segmentId: "s1", contextKind: "user", contextKey: "07", excluded: false },
    ];
    expect(compileSnapshot(i, { version: 1, segmentInlineMax: 100 }).segments["zeros"]!.kind).toBe("cuckoo");
  });

  it("FAILS THE COMPILE LOUDLY when roaring is forced and a key is non-integral", () => {
    // A wrong answer is not an acceptable response to a misconfiguration.
    const i = booleanFlag("f");
    i.segments = [seg("s1", "mixed")];
    i.segmentMembers = [
      { segmentId: "s1", contextKind: "user", contextKey: "1", excluded: false },
      { segmentId: "s1", contextKind: "user", contextKey: "usr_uuid", excluded: false },
    ];
    expect(() =>
      compileSnapshot(i, { version: 1, segmentInlineMax: 0, segmentFilter: "roaring" }),
    ).toThrow(/non-integral/i);
  });

  it("honours a forced cuckoo choice even when keys are integral", () => {
    const i = booleanFlag("f");
    i.segments = [seg("s1", "accounts")];
    i.segmentMembers = [{ segmentId: "s1", contextKind: "user", contextKey: "1", excluded: false }];
    expect(
      compileSnapshot(i, { version: 1, segmentInlineMax: 0, segmentFilter: "cuckoo" }).segments["accounts"]!.kind,
    ).toBe("cuckoo");
  });

  it("keeps exclusions out of the membership structure in every encoding", () => {
    const i = booleanFlag("f");
    i.segments = [seg("s1", "enterprise")];
    i.segmentMembers = [
      ...Array.from({ length: 200 }, (_, n) => ({
        segmentId: "s1",
        contextKind: "user",
        contextKey: `usr_${n}x`,
        excluded: false,
      })),
      { segmentId: "s1", contextKind: "user", contextKey: "usr_banned", excluded: true },
    ];
    const compiled = compileSnapshot(i, { version: 1, segmentInlineMax: 10 }).segments["enterprise"]!;
    expect(compiled.excluded).toEqual(["usr_banned"]);
    if (compiled.kind !== "cuckoo") throw new Error("expected cuckoo");
    expect(CuckooFilter.decode(compiled.filter).contains("usr_banned")).toBe(false);
  });

  it("compiles segment rules with their clauses", () => {
    const i = booleanFlag("f");
    i.segments = [seg("s1", "eu-pro")];
    i.segmentRules = [{ id: "sr0", segmentId: "s1", idx: 0, weight: 50_000, bucketBy: null, contextKind: "user" }];
    i.segmentRuleClauses = [
      { segmentRuleId: "sr0", idx: 0, contextKind: "user", attribute: "country", op: "in", values: ["DE"], negate: false },
    ];
    const compiled = compileSnapshot(i, { version: 1 }).segments["eu-pro"]!;
    expect(compiled.rules).toEqual([
      {
        id: "sr0",
        weight: 50_000,
        contextKind: "user",
        clauses: [
          { contextKind: "user", attribute: "country", op: "in", values: ["DE"], negate: false },
        ],
      },
    ]);
  });

  it("ignores segments belonging to another environment", () => {
    const i = booleanFlag("f");
    i.segments = [seg("s1", "beta", { environmentId: "env-other" })];
    expect(compileSnapshot(i, { version: 1 }).segments["beta"]).toBeUndefined();
  });
});

/* ───────────────────────── client-tier surface ──────────────────────── */

/**
 * There is deliberately **no second "client snapshot" compile**. The client
 * tier receives *evaluated values*, which the evaluation service in M5
 * produces per-context from this same server-side snapshot. Compiling a second
 * artifact would duplicate the work and give the ruleset a second path out of
 * the building — and §16 is explicit that the tier split is the security
 * boundary, "not a filter applied at serialisation time, which is a filter
 * someone eventually forgets on a new endpoint".
 *
 * What M2 owes the client tier is therefore just the flag on each compiled
 * flag, plus `referencedAttributes` for M5's fan-out.
 */
describe("client-tier availability", () => {
  it("carries clientAvailable onto the compiled flag", () => {
    const i = booleanFlag("f");
    i.flags[0]!.clientAvailable = true;
    expect(compileSnapshot(i, { version: 1 }).flags["f"]!.clientAvailable).toBe(true);
  });

  it("defaults to false, so a flag's existence is not disclosed to browsers", () => {
    expect(compileSnapshot(booleanFlag("f"), { version: 1 }).flags["f"]!.clientAvailable).toBe(false);
  });

  it("lists exactly the client-visible keys", () => {
    const visible = booleanFlag("visible");
    visible.flags[0]!.clientAvailable = true;
    const hidden = booleanFlag("hidden");
    const i = input({
      flags: [...visible.flags, ...hidden.flags],
      variations: [...visible.variations, ...hidden.variations],
      flagEnvironments: [...visible.flagEnvironments, ...hidden.flagEnvironments],
    });
    expect(clientFlagKeys(compileSnapshot(i, { version: 1 }))).toEqual(["visible"]);
  });
});
