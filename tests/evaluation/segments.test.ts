import { describe, expect, it } from "vitest";
import { buildCuckooFilter } from "../../src/sdk/evaluation/cuckoo.js";
import {
  InMemorySegmentCache,
  LruSegmentCache,
  SegmentIndex,
} from "../../src/sdk/evaluation/segments.js";
import type { CompiledSegment } from "../../src/sdk/evaluation/types.js";

const inline = (members: string[], excluded: string[] = []): CompiledSegment => ({
  kind: "inline",
  version: 1,
  members,
  excluded,
});

const cuckoo = (members: string[], excluded: string[] = []): CompiledSegment => ({
  kind: "cuckoo",
  version: 1,
  filter: buildCuckooFilter(members).filter.encode(),
  fpRate: 0.00012,
  loadFactor: 0.8,
  excluded,
});

describe("inline segments are fully resolved", () => {
  const index = new SegmentIndex({ beta: inline(["usr_1", "usr_2"], ["usr_2"]) });

  it("reports a member", () => {
    expect(index.membership("beta", "usr_1")).toBe("member");
  });

  it("reports a non-member", () => {
    expect(index.membership("beta", "usr_99")).toBe("not-member");
  });

  it("lets exclusion win over inclusion, so a person can be pinned out", () => {
    expect(index.membership("beta", "usr_2")).toBe("not-member");
  });

  it("is never unresolved - the members are right there in the snapshot", () => {
    expect(index.isResolved("beta")).toBe(true);
  });
});

describe("an unknown segment key", () => {
  it("is not a member, not unresolved", () => {
    // The compiler drops archived segments. A clause referencing one that no
    // longer exists is a definite non-match, not an unverifiable one.
    const index = new SegmentIndex({});
    expect(index.membership("gone", "usr_1")).toBe("not-member");
  });
});

describe("cuckoo segments - negatives are exact, positives need confirmation", () => {
  const members = Array.from({ length: 5_000 }, (_, i) => `usr_${i}`);

  it("answers not-member from the filter alone, with no confirmation set", () => {
    // Step 1: a negative is exact and final. No network, done.
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    expect(index.membership("enterprise", "definitely_not_a_member_xyz")).toBe("not-member");
  });

  it("answers UNRESOLVED for a filter positive when membership cannot be confirmed", () => {
    // Step 3: this is the state that must never reach the negation operator.
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    expect(index.membership("enterprise", "usr_1")).toBe("unresolved");
    expect(index.isResolved("enterprise")).toBe(false);
  });

  it("confirms a positive once the membership set is loaded", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    index.setCache(new InMemorySegmentCache({ enterprise: members }));
    expect(index.membership("enterprise", "usr_1")).toBe("member");
    expect(index.isResolved("enterprise")).toBe(true);
  });

  it("rejects a filter false-positive at the confirmation step", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(["usr_1"]) });
    index.setCache(new InMemorySegmentCache({ enterprise: ["usr_1"] }));
    // Anything the filter happens to admit is still checked against the set.
    expect(index.membership("enterprise", "usr_1")).toBe("member");
    expect(index.membership("enterprise", "usr_2")).toBe("not-member");
  });

  it("applies exclusions before consulting the filter", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(members, ["usr_1"]) });
    index.setCache(new InMemorySegmentCache({ enterprise: members }));
    expect(index.membership("enterprise", "usr_1")).toBe("not-member");
  });
});

describe("a provider that throws is unresolved, never an exception", () => {
  it("catches provider errors and fails closed", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(["usr_1"]) });
    index.setCache({
      has() {
        throw new Error("cache unreachable");
      },
    });
    // Evaluation never blocks and never rejects. The rule fails closed above.
    expect(index.membership("enterprise", "usr_1")).toBe("unresolved");
  });

  it("treats a promise-returning provider as unresolved on a cold lookup", () => {
    // `boolean()` stays synchronous. An async provider is consulted out of
    // band; a synchronous evaluation reads only the LRU, and a miss is
    // unresolved -- which fails the rule closed and warms the cache.
    const index = new SegmentIndex({ enterprise: cuckoo(["usr_1"]) });
    index.setCache({ has: async () => true });
    expect(index.membership("enterprise", "usr_1")).toBe("unresolved");
  });
});

describe("LruSegmentCache - the bounded confirmation cache for remote providers", () => {
  it("returns undefined on a miss, which the index reports as unresolved", () => {
    const lru = new LruSegmentCache(4);
    expect(lru.peek("seg", "usr_1")).toBeUndefined();
  });

  it("returns a warmed answer, positive or negative", () => {
    const lru = new LruSegmentCache(4);
    lru.put("seg", "usr_1", true);
    lru.put("seg", "usr_2", false);
    expect(lru.peek("seg", "usr_1")).toBe(true);
    expect(lru.peek("seg", "usr_2")).toBe(false);
  });

  it("evicts least-recently-used entries at the cap", () => {
    const lru = new LruSegmentCache(2);
    lru.put("seg", "a", true);
    lru.put("seg", "b", true);
    lru.peek("seg", "a"); // touch a, so b becomes least-recent
    lru.put("seg", "c", true);
    expect(lru.peek("seg", "b")).toBeUndefined();
    expect(lru.peek("seg", "a")).toBe(true);
    expect(lru.peek("seg", "c")).toBe(true);
  });

  it("keys by segment as well as context, so segments cannot bleed together", () => {
    const lru = new LruSegmentCache(8);
    lru.put("seg_a", "usr_1", true);
    expect(lru.peek("seg_b", "usr_1")).toBeUndefined();
  });

  it("counts unresolved lookups for featurekit_sdk_segment_unresolved_total", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(["usr_1"]) });
    expect(index.unresolvedCount).toBe(0);
    index.membership("enterprise", "usr_1");
    index.membership("enterprise", "usr_1");
    expect(index.unresolvedCount).toBe(2);
  });
});

describe("segment membership deltas ride the patch stream", () => {
  it("applies an add to an inline segment", () => {
    const index = new SegmentIndex({ beta: inline(["usr_1"]) });
    expect(index.membership("beta", "usr_2")).toBe("not-member");
    index.applyDelta("beta", 2, { add: ["usr_2"], remove: [] });
    expect(index.membership("beta", "usr_2")).toBe("member");
  });

  it("applies a removal to a cuckoo segment without a full re-encode", () => {
    // Removing one person from a 500k allow-list is the single most common
    // operation on this kind of segment. It must be a few hundred bytes.
    const members = Array.from({ length: 5_000 }, (_, i) => `usr_${i}`);
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    index.setCache(new InMemorySegmentCache({ enterprise: members }));
    expect(index.membership("enterprise", "usr_7")).toBe("member");

    index.applyDelta("enterprise", 2, { add: [], remove: ["usr_7"] });
    expect(index.membership("enterprise", "usr_7")).toBe("not-member");
    expect(index.membership("enterprise", "usr_8")).toBe("member");
  });

  it("ignores a delta at or below the version it already holds", () => {
    // The version guard makes duplicate broadcasts and out-of-order delivery
    // non-events rather than corruption.
    const index = new SegmentIndex({ beta: inline(["usr_1"]) });
    index.applyDelta("beta", 1, { add: ["usr_stale"], remove: [] });
    expect(index.membership("beta", "usr_stale")).toBe("not-member");
    index.applyDelta("beta", 0, { add: ["usr_older"], remove: [] });
    expect(index.membership("beta", "usr_older")).toBe("not-member");
  });

  it("ignores a delta for a segment it does not have", () => {
    const index = new SegmentIndex({});
    expect(() => index.applyDelta("nope", 5, { add: ["usr_1"], remove: [] })).not.toThrow();
  });
});
