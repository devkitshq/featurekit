import { describe, expect, it } from "vitest";
import { buildCuckooFilter } from "../../src/sdk/evaluation/cuckoo.js";
import { RoaringBitmap } from "../../src/sdk/evaluation/roaring.js";
import { SegmentIndex, segmentMemberId } from "../../src/sdk/evaluation/segments.js";
import type { CompiledSegment } from "../../src/sdk/evaluation/types.js";

/** Fixture keys are `user` keys; segments store them kind-qualified. */
const ids = (keys: string[]): string[] => keys.map((key) => segmentMemberId("user", key));

const inline = (members: string[], excluded: string[] = []): CompiledSegment => ({
  kind: "inline",
  version: 1,
  members: ids(members),
  excluded: ids(excluded),
});

const cuckoo = (members: string[], excluded: string[] = []): CompiledSegment => ({
  kind: "cuckoo",
  version: 1,
  filter: buildCuckooFilter(ids(members)).filter.encode(),
  fpRate: 1.9e-9,
  loadFactor: 0.8,
  excluded: ids(excluded),
});

/** A filter in the old version-1 format, as an old persisted snapshot would hold. */
const unreadable = (members: string[]): CompiledSegment => {
  const segment = cuckoo(members);
  if (segment.kind !== "cuckoo") throw new Error("unreachable");
  const bytes = segment.filter.slice();
  bytes[4] = 1;
  return { ...segment, filter: bytes };
};

describe("inline segments are fully resolved", () => {
  const index = new SegmentIndex({ beta: inline(["usr_1", "usr_2"], ["usr_2"]) });

  it("reports a member", () => {
    expect(index.membership("beta", "user", "usr_1")).toBe("member");
  });

  it("reports a non-member", () => {
    expect(index.membership("beta", "user", "usr_99")).toBe("not-member");
  });

  it("lets exclusion win over inclusion, so a person can be pinned out", () => {
    expect(index.membership("beta", "user", "usr_2")).toBe("not-member");
  });

  it("is never unresolved - the members are right there in the snapshot", () => {
    expect(index.isResolved("beta")).toBe(true);
  });
});

describe("members are a context kind and key together", () => {
  const index = new SegmentIndex({
    orgs: {
      kind: "inline",
      version: 1,
      members: [segmentMemberId("org", "acme")],
      excluded: [segmentMemberId("org", "blocked")],
    },
  });

  it("does not admit another kind that shares the key", () => {
    expect(index.membership("orgs", "org", "acme")).toBe("member");
    expect(index.membership("orgs", "user", "acme")).toBe("not-member");
  });

  it("does not let one kind's exclusion pin out another", () => {
    const both = new SegmentIndex({
      s: {
        kind: "inline",
        version: 1,
        members: [segmentMemberId("user", "x"), segmentMemberId("org", "x")],
        excluded: [segmentMemberId("org", "x")],
      },
    });
    expect(both.membership("s", "user", "x")).toBe("member");
    expect(both.membership("s", "org", "x")).toBe("not-member");
  });

  it("cannot be forged by a key that embeds a kind", () => {
    // `1:a:` + `b:c` must not equal any id of kind `a:b`.
    expect(segmentMemberId("a", "b:c")).not.toBe(segmentMemberId("a:b", "c"));
  });

  it("answers a roaring segment only for the kind it records", () => {
    const roaring = new SegmentIndex({
      r: { kind: "roaring", version: 1, bitmap: RoaringBitmap.from([42]).serialize(), contextKind: "org" },
    });
    expect(roaring.membership("r", "org", "42")).toBe("member");
    expect(roaring.membership("r", "user", "42")).toBe("not-member");
  });
});

describe("an unknown segment key", () => {
  it("is not a member, not unresolved", () => {
    // The compiler drops archived segments. A clause referencing one that no
    // longer exists is a definite non-match, not an unverifiable one.
    const index = new SegmentIndex({});
    expect(index.membership("gone", "user", "usr_1")).toBe("not-member");
  });
});

describe("cuckoo segments are answered from the filter alone", () => {
  const members = Array.from({ length: 5_000 }, (_, i) => `usr_${i}`);

  it("answers not-member for a key that was never added", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    expect(index.membership("enterprise", "user", "definitely_not_a_member_xyz")).toBe("not-member");
  });

  it("answers member for a key that was added, with nothing else loaded", () => {
    // No provider, no confirmation set, no warm-up: the snapshot is enough.
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    expect(index.membership("enterprise", "user", "usr_1")).toBe("member");
    expect(index.isResolved("enterprise")).toBe(true);
  });

  it("admits no non-member across 50,000 lookups", () => {
    // At 32-bit fingerprints the expected count here is ~0.0001.
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    let falsePositives = 0;
    for (let i = 0; i < 50_000; i++) {
      if (index.membership("enterprise", "user", `ghost_${i}`) === "member") falsePositives++;
    }
    expect(falsePositives).toBe(0);
  });

  it("applies exclusions before consulting the filter", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(members, ["usr_1"]) });
    expect(index.membership("enterprise", "user", "usr_1")).toBe("not-member");
  });
});

describe("an unreadable segment is unresolved, never a guess", () => {
  it("answers UNRESOLVED for a filter in a format this SDK does not read", () => {
    // This is the state that must never reach the negation operator.
    const index = new SegmentIndex({ enterprise: unreadable(["usr_1"]) });
    expect(index.membership("enterprise", "user", "usr_1")).toBe("unresolved");
    expect(index.membership("enterprise", "user", "usr_2")).toBe("unresolved");
    expect(index.isResolved("enterprise")).toBe(false);
  });

  it("answers UNRESOLVED for corrupt bytes rather than throwing", () => {
    const segment = cuckoo(["usr_1"]);
    if (segment.kind !== "cuckoo") throw new Error("unreachable");
    const truncated = { ...segment, filter: segment.filter.slice(0, 20) };
    const index = new SegmentIndex({ enterprise: truncated });
    expect(index.membership("enterprise", "user", "usr_1")).toBe("unresolved");
  });

  it("counts unresolved lookups for featurekit_sdk_segment_unresolved_total", () => {
    const index = new SegmentIndex({ enterprise: unreadable(["usr_1"]), beta: inline(["usr_1"]) });
    index.membership("beta", "user", "usr_1");
    expect(index.unresolvedCount).toBe(0);
    index.membership("enterprise", "user", "usr_1");
    index.membership("enterprise", "user", "usr_2");
    expect(index.unresolvedCount).toBe(2);
  });
});

describe("segment membership deltas ride the patch stream", () => {
  it("applies an add to an inline segment", () => {
    const index = new SegmentIndex({ beta: inline(["usr_1"]) });
    expect(index.membership("beta", "user", "usr_2")).toBe("not-member");
    index.applyDelta("beta", 2, { add: ["usr_2"], remove: [] });
    expect(index.membership("beta", "user", "usr_2")).toBe("member");
  });

  it("applies a removal to a cuckoo segment without a full re-encode", () => {
    // Removing one person from a 500k allow-list is the single most common
    // operation on this kind of segment. It must be a few hundred bytes.
    const members = Array.from({ length: 5_000 }, (_, i) => `usr_${i}`);
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    expect(index.membership("enterprise", "user", "usr_7")).toBe("member");

    index.applyDelta("enterprise", 2, { add: [], remove: ["usr_7"] });
    expect(index.membership("enterprise", "user", "usr_7")).toBe("not-member");
    expect(index.membership("enterprise", "user", "usr_8")).toBe("member");
  });

  it("ignores a delta at or below the version it already holds", () => {
    // The version guard makes duplicate broadcasts and out-of-order delivery
    // non-events rather than corruption.
    const index = new SegmentIndex({ beta: inline(["usr_1"]) });
    index.applyDelta("beta", 1, { add: ["usr_stale"], remove: [] });
    expect(index.membership("beta", "user", "usr_stale")).toBe("not-member");
    index.applyDelta("beta", 0, { add: ["usr_older"], remove: [] });
    expect(index.membership("beta", "user", "usr_older")).toBe("not-member");
  });

  it("ignores a delta for a segment it does not have", () => {
    const index = new SegmentIndex({});
    expect(() => index.applyDelta("nope", 5, { add: ["usr_1"], remove: [] })).not.toThrow();
  });
});
