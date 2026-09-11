import { describe, expect, it } from "vitest";
import { bucketValue, getAttribute, normalizeContext } from "../../src/sdk/evaluation/context.js";
import type { EvaluationContext } from "../../src/sdk/evaluation/types.js";

const norm = (ctx: unknown) => normalizeContext(ctx as EvaluationContext);

describe("normalizeContext — single context", () => {
  it("defaults an unkinded context to `user` (the simple case stays simple)", () => {
    const n = norm({ key: "usr_123", plan: "pro" })!;
    expect(n.get("user")).toEqual({ key: "usr_123", plan: "pro" });
  });

  it("honours an explicit kind", () => {
    const n = norm({ kind: "organization", key: "org_9", tier: "enterprise" })!;
    expect(n.get("organization")?.key).toBe("org_9");
    expect(n.get("user")).toBeUndefined();
  });

  it("does not expose `kind` as a readable attribute", () => {
    // `kind` is the discriminator, not data. Normalisation holds the caller's
    // own object by reference rather than copying it (the copy cost ~150ns per
    // evaluation), so `kind` is filtered at read time instead of stripped at
    // build time. What matters is that no clause can read it.
    const n = norm({ kind: "device", key: "dev_1" })!;
    expect(getAttribute(n, "device", "kind")).toBeUndefined();
  });

  it("reserves `kind` in every context shape, not just the single one", () => {
    // A rule that could read `kind` in one shape but not the other would be
    // worse than one that can read it in neither. A clause selects its context
    // kind with `contextKind`, which is what that field is for.
    const multi = norm({ kind: "multi", user: { key: "usr_1", kind: "sneaky" } })!;
    expect(getAttribute(multi, "user", "kind")).toBeUndefined();
  });
});

describe("normalizeContext — multi-context (§9.8)", () => {
  it("splits every kind out", () => {
    const n = norm({
      kind: "multi",
      user: { key: "usr_123", plan: "pro" },
      organization: { key: "org_9", tier: "enterprise" },
      device: { key: "dev_abc", os: "ios" },
    })!;
    expect([...n.keys()].sort()).toEqual(["device", "organization", "user"]);
    expect(n.get("organization")?.tier).toBe("enterprise");
  });

  it("rejects a multi-context whose member has no key", () => {
    expect(norm({ kind: "multi", user: { key: "usr_1" }, organization: { tier: "x" } })).toBeNull();
  });

  it("rejects a multi-context with no kinds at all", () => {
    expect(norm({ kind: "multi" })).toBeNull();
  });

  it("rejects a non-object kind entry", () => {
    expect(norm({ kind: "multi", user: "usr_1" })).toBeNull();
  });
});

describe("normalizeContext — invalid input yields null, never a throw (§9.1)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "usr_123"],
    ["a number", 42],
    ["an array", []],
    ["no key", { plan: "pro" }],
    ["an empty key", { key: "" }],
    ["a non-string key", { key: 123 }],
    ["a whitespace-only key", { key: "   " }],
  ])("returns null for %s", (_label, input) => {
    expect(norm(input)).toBeNull();
  });
});

describe("getAttribute", () => {
  const n = norm({
    kind: "multi",
    user: { key: "usr_123", plan: "pro", country: "DE", groups: ["a", "b"], address: { country: "AT", geo: { lat: 1 } } },
    organization: { key: "org_9" },
  })!;

  it("resolves `key` to the context key", () => {
    expect(getAttribute(n, "user", "key")).toBe("usr_123");
    expect(getAttribute(n, "organization", "key")).toBe("org_9");
  });

  it("resolves a plain attribute", () => {
    expect(getAttribute(n, "user", "plan")).toBe("pro");
  });

  it("resolves a dotted path into a nested object", () => {
    expect(getAttribute(n, "user", "address.country")).toBe("AT");
    expect(getAttribute(n, "user", "address.geo.lat")).toBe(1);
  });

  it("returns undefined for a missing kind, so its clauses cannot match", () => {
    expect(getAttribute(n, "device", "os")).toBeUndefined();
  });

  it("returns undefined for a missing attribute or a broken path", () => {
    expect(getAttribute(n, "user", "nope")).toBeUndefined();
    expect(getAttribute(n, "user", "plan.nested")).toBeUndefined();
    expect(getAttribute(n, "user", "address.nope.deeper")).toBeUndefined();
  });

  it("never reads inherited properties", () => {
    // A rule author writing `constructor` must not receive a Function, and a
    // context built from user-controlled JSON must not expose Object.prototype.
    expect(getAttribute(n, "user", "constructor")).toBeUndefined();
    expect(getAttribute(n, "user", "toString")).toBeUndefined();
    expect(getAttribute(n, "user", "__proto__")).toBeUndefined();
    expect(getAttribute(n, "user", "address.constructor")).toBeUndefined();
  });

  it("returns array attributes whole, for the any-element match rule (§9.6)", () => {
    expect(getAttribute(n, "user", "groups")).toEqual(["a", "b"]);
  });
});

describe("bucketValue — what a rollout hashes (§9.3)", () => {
  const n = norm({
    kind: "multi",
    user: { key: "usr_123", accountId: 88, ratio: 1.5, missing: null, obj: {}, arr: [1] },
    organization: { key: "org_9" },
  })!;

  it("buckets on the context key by default", () => {
    expect(bucketValue(n, "user", "key")).toBe("usr_123");
  });

  it("buckets on the named context kind, not always the user", () => {
    // This is what rolls out to 10% of *organizations* — everyone in an org
    // flips together — instead of 10% of users, which half-migrates orgs.
    expect(bucketValue(n, "organization", "key")).toBe("org_9");
  });

  it("buckets on a named attribute", () => {
    expect(bucketValue(n, "user", "accountId")).toBe("88");
  });

  it("stringifies numbers and booleans deterministically", () => {
    expect(bucketValue(n, "user", "ratio")).toBe("1.5");
  });

  it("returns null when the kind is absent, excluding rather than defaulting", () => {
    expect(bucketValue(n, "device", "key")).toBeNull();
  });

  it.each([
    ["a missing attribute", "nope"],
    ["a null attribute", "missing"],
    ["an object attribute", "obj"],
    ["an array attribute", "arr"],
  ])("returns null for %s rather than silently bucketing everyone together", (_l, attr) => {
    // A context that cannot be bucketed consistently is excluded from the
    // rollout, not assigned to the first variation.
    expect(bucketValue(n, "user", attr)).toBeNull();
  });
});
