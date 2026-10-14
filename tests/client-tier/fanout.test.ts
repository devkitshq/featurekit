import { describe, expect, it } from "vitest";
import {
  ClientFanout,
  contextHash,
  fingerprintOf,
  type ClientConnection,
} from "../../src/evaluation-service/fanout.js";
import {
  buildCuckooFilter,
  evaluate,
  RoaringBitmap,
  type CompiledFlag,
  type CompiledSegment,
  type Snapshot,
} from "../../src/sdk/index.js";

function flag(over: Partial<CompiledFlag> = {}): CompiledFlag {
  return {
    key: "f",
    version: 1,
    kind: "boolean",
    on: true,
    variations: [false, true],
    offVariation: 0,
    fallthrough: { variation: 0 },
    prerequisites: [],
    targets: [],
    rules: [],
    clientAvailable: true,
    referencedAttributes: [],
    perContext: false,
    ...over,
  };
}

const snapshot = (flags: Record<string, CompiledFlag>, version = 1): Snapshot => ({
  version,
  environmentKey: "production",
  salt: "s4lt",
  flags,
  segments: {},
});

/** A flag on for (country=DE AND plan=pro). Depends on attributes only. */
const attributeFlag = flag({
  referencedAttributes: ["user.country", "user.plan"],
  rules: [
    {
      id: "r0",
      variation: 1,
      clauses: [
        { contextKind: "user", attribute: "country", op: "in", values: ["DE"], negate: false },
        { contextKind: "user", attribute: "plan", op: "in", values: ["pro"], negate: false },
      ],
    },
  ],
});

describe("the fingerprint agrees with what evaluation reads", () => {
  /**
   * The cache below is keyed on the fingerprint and shared across users. That
   * is only safe while two contexts with the same fingerprint are genuinely
   * indistinguishable *to these flags*. Anything the evaluator reads and the
   * fingerprint does not is a silent hole in that premise, and it is not a
   * stale-value bug — it is one user's flags being pushed to another.
   */
  const nested = flag({
    key: "eu-pricing",
    // Exactly what `referencedAttributes()` in the compiler emits for a clause
    // on `address.country`: `${kind}.${attribute}`, first dot only.
    referencedAttributes: ["user.address.country"],
    rules: [
      {
        id: "r0",
        variation: 1,
        clauses: [
          {
            contextKind: "user",
            attribute: "address.country",
            op: "in",
            values: ["DE"],
            negate: false,
          },
        ],
      },
    ],
  });

  const german: ClientConnection = { id: "c-de", context: { key: "usr_de", address: { country: "DE" } } };
  const american: ClientConnection = { id: "c-us", context: { key: "usr_us", address: { country: "US" } } };

  it("separates contexts that differ only in a NESTED attribute", () => {
    // A flat `attrs["address.country"]` finds no such property and returns
    // undefined for everyone, collapsing these two into one group.
    expect(fingerprintOf(german.context, nested.referencedAttributes!)).not.toBe(
      fingerprintOf(american.context, nested.referencedAttributes!),
    );
  });

  it("does not push one connection's value to another", () => {
    const fanout = new ClientFanout();
    const out = fanout.fanout("env-1", snapshot({ "eu-pricing": nested }), ["eu-pricing"], [german, american]);

    expect(out.get("c-de")!["eu-pricing"]!.value).toBe(true);
    expect(out.get("c-us")!["eu-pricing"]!.value).toBe(false);
  });

  it("agrees with evaluate() for every connection, which is the actual invariant", () => {
    const s = snapshot({ "eu-pricing": nested });
    const fanout = new ClientFanout();
    const out = fanout.fanout("env-1", s, ["eu-pricing"], [german, american]);

    for (const connection of [german, american]) {
      expect(out.get(connection.id)!["eu-pricing"]!.value).toBe(
        evaluate("eu-pricing", connection.context, s, null).value,
      );
    }
  });

  it("reads no further than the evaluator does: `kind` and the prototype chain", () => {
    // `getAttribute` refuses both. A flat read would return the discriminator
    // for `kind`, and `Object.prototype.constructor` for `constructor` — in
    // each case fingerprinting on something no rule can ever match against.
    const a = fingerprintOf({ key: "u1", kind: "user" }, ["user.kind", "user.constructor"]);
    const b = fingerprintOf({ key: "u2", kind: "user" }, ["user.kind", "user.constructor"]);
    expect(a).toBe(b);
    expect(a).toBe("user.kind=null|user.constructor=null");
  });
});

describe("fingerprintOf", () => {
  it("EXCLUDES the context key — the entire point", () => {
    // Including it would give every connection its own fingerprint and
    // reinstate exactly the fan-out this collapses.
    const a = fingerprintOf({ key: "usr_1", country: "US", plan: "pro" }, ["user.country", "user.plan"]);
    const b = fingerprintOf({ key: "usr_9999", country: "US", plan: "pro" }, ["user.country", "user.plan"]);
    expect(a).toBe(b);
  });

  it("distinguishes different values of a referenced attribute", () => {
    const de = fingerprintOf({ key: "u", country: "DE" }, ["user.country"]);
    const us = fingerprintOf({ key: "u", country: "US" }, ["user.country"]);
    expect(de).not.toBe(us);
  });

  it("ignores attributes the flag does not reference", () => {
    // Two contexts differing only in an unreferenced attribute must collapse,
    // or the fingerprint space is the context space.
    const a = fingerprintOf({ key: "u", country: "DE", email: "a@x.com", signupAt: 1 }, ["user.country"]);
    const b = fingerprintOf({ key: "u", country: "DE", email: "b@y.com", signupAt: 2 }, ["user.country"]);
    expect(a).toBe(b);
  });

  it("distinguishes a missing attribute from a present one", () => {
    const present = fingerprintOf({ key: "u", country: "DE" }, ["user.country"]);
    const absent = fingerprintOf({ key: "u" }, ["user.country"]);
    expect(present).not.toBe(absent);
  });

  it("qualifies by context kind, so the same name on two kinds differs", () => {
    const ctx = { kind: "multi" as const, user: { key: "u", tier: "free" }, organization: { key: "o", tier: "ent" } };
    expect(fingerprintOf(ctx, ["user.tier"])).not.toBe(fingerprintOf(ctx, ["organization.tier"]));
  });

  it("never lets a `key` attribute into the fingerprint", () => {
    const a = fingerprintOf({ key: "usr_1", country: "DE" }, ["user.key", "user.country"]);
    const b = fingerprintOf({ key: "usr_2", country: "DE" }, ["user.key", "user.country"]);
    expect(a).toBe(b);
  });
});

describe("contextHash", () => {
  it("is stable regardless of key order", () => {
    expect(contextHash({ key: "u", a: 1, b: 2 })).toBe(contextHash({ key: "u", b: 2, a: 1 } as never));
  });

  it("changes when any attribute changes", () => {
    expect(contextHash({ key: "u", plan: "pro" })).not.toBe(contextHash({ key: "u", plan: "free" }));
  });

  it("changes when the key changes", () => {
    expect(contextHash({ key: "usr_1" })).not.toBe(contextHash({ key: "usr_2" }));
  });
});

describe("evaluateAll", () => {
  it("returns only flags marked clientAvailable", () => {
    const snap = snapshot({
      visible: flag({ key: "visible", clientAvailable: true, fallthrough: { variation: 1 } }),
      hidden: flag({ key: "hidden", clientAvailable: false }),
    });
    const values = new ClientFanout().evaluateAll("env-1", snap, { key: "usr_1" });
    expect(Object.keys(values)).toEqual(["visible"]);
    expect(values["visible"]).toEqual({ value: true, variationIndex: 1, reason: "FALLTHROUGH" });
  });

  it("sends only the reason kind, not the rule that matched", () => {
    // `ruleIndex`/`ruleId` would disclose the shape of the ruleset the client
    // tier exists to withhold -- the same leak as shipping rules, one field at
    // a time.
    const snap = snapshot({ f: attributeFlag });
    const values = new ClientFanout().evaluateAll("env-1", snap, { key: "u", country: "DE", plan: "pro" });
    expect(values["f"]).toEqual({ value: true, variationIndex: 1, reason: "RULE_MATCH" });
    expect(JSON.stringify(values)).not.toContain("r0");
  });
});

describe("fanout collapses connections to fingerprints", () => {
  const countries = ["US", "DE", "FR", "GB", "JP", "BR", "IN", "AU", "CA", "MX"];
  const plans = ["free", "pro", "team", "enterprise"];

  /** 50,000 connections spanning 40 distinct (country, plan) pairs. */
  function connections(n: number): ClientConnection[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `conn_${i}`,
      context: {
        key: `usr_${i}`,
        country: countries[i % countries.length]!,
        plan: plans[i % plans.length]!,
        // Deliberately high-cardinality and unreferenced: it must not affect
        // the fingerprint, or the collapse does not happen.
        email: `user${i}@example.com`,
      },
    }));
  }

  it("evaluates once per fingerprint, not once per connection", () => {
    const snap = snapshot({ f: attributeFlag });
    const fanout = new ClientFanout();
    const conns = connections(50_000);

    const result = fanout.fanout("env-1", snap, ["f"], conns);

    // 10 countries x 4 plans = 40 combinations, and i%10 / i%4 co-vary on a
    // period of 20, so 20 distinct pairs actually occur.
    expect(fanout.stats.fingerprints).toBeLessThanOrEqual(40);
    expect(fanout.stats.evaluations).toBe(fanout.stats.fingerprints);
    // The claim being tested: evaluation count tracks fingerprints, NOT the
    // 50,000 connections.
    expect(fanout.stats.evaluations).toBeLessThan(100);
    expect(result.size).toBe(50_000);
  });

  it("still gives every connection the correct value", () => {
    const snap = snapshot({ f: attributeFlag });
    const conns = connections(2_000);
    const result = new ClientFanout().fanout("env-1", snap, ["f"], conns);

    for (const connection of conns) {
      const context = connection.context as { country: string; plan: string };
      const expected = context.country === "DE" && context.plan === "pro";
      expect(result.get(connection.id)!["f"]!.value).toBe(expected);
    }
  });

  it("reuses the cache across successive fan-outs at the same version", () => {
    const snap = snapshot({ f: attributeFlag });
    const fanout = new ClientFanout();
    const conns = connections(5_000);

    fanout.fanout("env-1", snap, ["f"], conns);
    const first = fanout.stats.evaluations;
    fanout.resetStats();
    fanout.fanout("env-1", snap, ["f"], conns);

    expect(first).toBeGreaterThan(0);
    expect(fanout.stats.evaluations).toBe(0); // entirely served from cache
    expect(fanout.stats.cacheHits).toBe(5_000);
  });

  it("invalidates by construction on a version bump, with no explicit sweep", () => {
    const fanout = new ClientFanout();
    const conns = connections(1_000);
    fanout.fanout("env-1", snapshot({ f: attributeFlag }, 1), ["f"], conns);
    const fingerprints = fanout.stats.fingerprints;
    fanout.resetStats();

    // Same flag, new snapshot version: the cache key changes, so nothing from
    // v1 can be served. No sweep to forget to call.
    fanout.fanout("env-1", snapshot({ f: attributeFlag }, 2), ["f"], conns);

    // Every distinct fingerprint is evaluated afresh -- which is precisely the
    // "nothing stale survives a bump" property. Hits *within* this call, for
    // later connections sharing an already-computed fingerprint, are the
    // collapse working and are expected.
    expect(fanout.stats.evaluations).toBe(fingerprints);
    expect(fanout.stats.cacheHits).toBe(1_000 - fingerprints);
  });

  it("bounds the cache", () => {
    const fanout = new ClientFanout({ cacheMax: 5 });
    fanout.fanout("env-1", snapshot({ f: attributeFlag }), ["f"], connections(1_000));
    expect(fanout.cacheSize).toBeLessThanOrEqual(5);
  });
});

describe("flags that cannot share a fingerprint", () => {
  const rolloutFlag = flag({
    key: "rolled",
    perContext: true,
    fallthrough: {
      rollout: {
        variations: [
          { variationIndex: 1, weight: 50_000 },
          { variationIndex: 0, weight: 50_000 },
        ],
      },
    },
  });

  it("buckets a rollout flag per connection", () => {
    const snap = snapshot({ rolled: rolloutFlag });
    const fanout = new ClientFanout();
    const conns = Array.from({ length: 4_000 }, (_, i) => ({
      id: `c${i}`,
      context: { key: `usr_${i}`, country: "DE" },
    }));

    const result = fanout.fanout("env-1", snap, ["rolled"], conns);

    // Per connection, as it must be -- but a bucket, not a rule evaluation.
    expect(fanout.stats.perContextEvaluations).toBe(4_000);
    expect(fanout.stats.evaluations).toBe(0);

    // And the split is a real 50/50, not everyone landing in one variation.
    const on = [...result.values()].filter((v) => v["rolled"]!.value === true).length;
    expect(on / 4_000).toBeGreaterThan(0.45);
    expect(on / 4_000).toBeLessThan(0.55);
  });

  it("specialises a targeted flag per connection", () => {
    const targeted = flag({
      key: "targeted",
      perContext: true,
      targets: [{ contextKind: "user", variation: 1, keys: ["usr_7"] }],
    });
    const conns = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      context: { key: `usr_${i}` },
    }));
    const result = new ClientFanout().fanout("env-1", snapshot({ targeted }), ["targeted"], conns);

    expect(result.get("c7")!["targeted"]!.value).toBe(true);
    expect(result.get("c8")!["targeted"]!.value).toBe(false);
  });

  it("mixes collapsed and per-context flags in one fan-out", () => {
    const snap = snapshot({ f: attributeFlag, rolled: rolloutFlag });
    const fanout = new ClientFanout();
    const conns = Array.from({ length: 1_000 }, (_, i) => ({
      id: `c${i}`,
      context: { key: `usr_${i}`, country: i % 2 === 0 ? "DE" : "US", plan: "pro" },
    }));

    fanout.fanout("env-1", snap, ["f", "rolled"], conns);

    // The attribute flag collapsed to 2 groups; the rollout did not collapse.
    expect(fanout.stats.evaluations).toBe(2);
    expect(fanout.stats.perContextEvaluations).toBe(1_000);
  });

  it("skips a flag the client tier may not see", () => {
    const snap = snapshot({ secret: flag({ key: "secret", clientAvailable: false }) });
    const result = new ClientFanout().fanout("env-1", snap, ["secret"], [
      { id: "c1", context: { key: "u" } },
    ]);
    expect(result.get("c1")).toEqual({});
  });
});

describe("one instance serves every environment", () => {
  it("never serves one environment's cached value to another at the same version", () => {
    // Versions restart at 1 in every environment, and a project's flags share
    // their keys across its environments. Keyed on version alone, staging's
    // value at version 5 was pushed to production's browsers at its version 5.
    const fanout = new ClientFanout();
    const conns = [{ id: "c1", context: { key: "u", country: "DE", plan: "pro" } }];
    const staging = snapshot({ f: attributeFlag }, 5);
    const production = snapshot({ f: flag({ ...attributeFlag, on: false }) }, 5);

    expect(fanout.fanout("staging", staging, ["f"], conns).get("c1")!["f"]!.value).toBe(true);
    expect(fanout.fanout("production", production, ["f"], conns).get("c1")!["f"]!.value).toBe(false);
  });
});

describe("segment rules are evaluated on the client tier", () => {
  // Every segment clause used to come back unresolved here, because no segment
  // index was ever passed in: segment targeting failed closed for every browser
  // and phone, whatever the segment's encoding.
  const segmentFlag = flag({
    key: "seg",
    perContext: true,
    rules: [
      {
        id: "r0",
        variation: 1,
        clauses: [{ contextKind: "user", attribute: "key", op: "segmentMatch", values: ["s"], negate: false }],
      },
    ],
  });
  const withSegment = (segment: CompiledSegment): Snapshot => ({
    ...snapshot({ seg: segmentFlag }),
    segments: { s: segment },
  });
  const valueFor = (snap: Snapshot, key: string) =>
    new ClientFanout().evaluateAll("env-1", snap, { key })["seg"]!.value;

  it("matches an inline segment", () => {
    const snap = withSegment({ kind: "inline", version: 1, members: ["usr_1"] });
    expect(valueFor(snap, "usr_1")).toBe(true);
    expect(valueFor(snap, "usr_2")).toBe(false);
  });

  it("matches a roaring segment", () => {
    const bitmap = new RoaringBitmap();
    bitmap.add(42);
    const snap = withSegment({ kind: "roaring", version: 1, contextKind: "user", bitmap: bitmap.serialize() });
    expect(valueFor(snap, "42")).toBe(true);
    expect(valueFor(snap, "43")).toBe(false);
  });

  it("matches a large cuckoo segment with nothing to confirm against", () => {
    const members = Array.from({ length: 60_000 }, (_, i) => `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`);
    const snap = withSegment({
      kind: "cuckoo",
      version: 1,
      filter: buildCuckooFilter(members).filter.encode(),
      fpRate: 1.9e-9,
      loadFactor: 0.8,
    });
    expect(valueFor(snap, members[12_345]!)).toBe(true);
    expect(valueFor(snap, "not-a-member")).toBe(false);
  });

  it("decodes a segment once per environment and version, not per request", () => {
    const fanout = new ClientFanout();
    const snap = withSegment({ kind: "inline", version: 1, members: ["usr_1"] });
    fanout.evaluateAll("env-1", snap, { key: "usr_1" });
    const first = fanout["segmentIndexes"].get("env-1")!.index;
    fanout.evaluateAll("env-1", snap, { key: "usr_2" });
    expect(fanout["segmentIndexes"].get("env-1")!.index).toBe(first);
    fanout.evaluateAll("env-1", { ...snap, version: 2 }, { key: "usr_1" });
    expect(fanout["segmentIndexes"].get("env-1")!.index).not.toBe(first);
  });
});
