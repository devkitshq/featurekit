import { describe, expect, it } from "vitest";
import { buildCuckooFilter } from "../../src/sdk/evaluation/cuckoo.js";
import { SegmentIndex } from "../../src/sdk/evaluation/segments.js";
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
  fpRate: 1.9e-9,
  loadFactor: 0.8,
  excluded,
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

describe("cuckoo segments are answered from the filter alone", () => {
  const members = Array.from({ length: 5_000 }, (_, i) => `usr_${i}`);

  it("answers not-member for a key that was never added", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    expect(index.membership("enterprise", "definitely_not_a_member_xyz")).toBe("not-member");
  });

  it("answers member for a key that was added, with nothing else loaded", () => {
    // No provider, no confirmation set, no warm-up: the snapshot is enough.
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    expect(index.membership("enterprise", "usr_1")).toBe("member");
    expect(index.isResolved("enterprise")).toBe(true);
  });

  it("admits no non-member across 50,000 lookups", () => {
    // At 32-bit fingerprints the expected count here is ~0.0001.
    const index = new SegmentIndex({ enterprise: cuckoo(members) });
    let falsePositives = 0;
    for (let i = 0; i < 50_000; i++) {
      if (index.membership("enterprise", `ghost_${i}`) === "member") falsePositives++;
    }
    expect(falsePositives).toBe(0);
  });

  it("applies exclusions before consulting the filter", () => {
    const index = new SegmentIndex({ enterprise: cuckoo(members, ["usr_1"]) });
    expect(index.membership("enterprise", "usr_1")).toBe("not-member");
  });
});

describe("an unreadable segment is unresolved, never a guess", () => {
  it("answers UNRESOLVED for a filter in a format this SDK does not read", () => {
    // This is the state that must never reach the negation operator.
    const index = new SegmentIndex({ enterprise: unreadable(["usr_1"]) });
    expect(index.membership("enterprise", "usr_1")).toBe("unresolved");
    expect(index.membership("enterprise", "usr_2")).toBe("unresolved");
    expect(index.isResolved("enterprise")).toBe(false);
  });

  it("answers UNRESOLVED for corrupt bytes rather than throwing", () => {
    const segment = cuckoo(["usr_1"]);
    if (segment.kind !== "cuckoo") throw new Error("unreachable");
    const truncated = { ...segment, filter: segment.filter.slice(0, 20) };
    const index = new SegmentIndex({ enterprise: truncated });
    expect(index.membership("enterprise", "usr_1")).toBe("unresolved");
  });

  it("counts unresolved lookups for featurekit_sdk_segment_unresolved_total", () => {
    const index = new SegmentIndex({ enterprise: unreadable(["usr_1"]), beta: inline(["usr_1"]) });
    index.membership("beta", "usr_1");
    expect(index.unresolvedCount).toBe(0);
    index.membership("enterprise", "usr_1");
    index.membership("enterprise", "usr_2");
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
