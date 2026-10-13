/**
 * The analytics tier.
 *
 * The claim under test is the architectural one: **analytics loss is
 * acceptable, evaluation correctness is not**. That is only true if the ingest
 * path is bounded, non-blocking, and loud about what it drops — so those are
 * what is asserted here, along with the idempotency properties that make a
 * duplicated or replayed batch harmless.
 */

import { describe, expect, it } from "vitest";
import { EventBuffer, type BufferedSummary } from "../../src/events/ingest.js";
import { MemoryDeadLetterQueue, isMissingPartition, mergeRows } from "../../src/events/rollup.js";
import { HyperLogLog } from "../../src/events/hll.js";

const ENV = "env-1";

function batch(over: Partial<{ bucketAt: number; summaries: unknown[]; dropped: number }> = {}) {
  return {
    bucketAt: 60_000,
    summaries: [{ flagKey: "f", variationIndex: 1, reason: "FALLTHROUGH", count: 5 }],
    ...over,
  } as never;
}

describe("EventBuffer", () => {
  it("aggregates identical buckets instead of storing a row each", () => {
    // Fifty SDK instances reporting the same flag/minute must become one row,
    // or the write rate scales with fleet size rather than with flag count.
    const buffer = new EventBuffer();
    for (let i = 0; i < 50; i++) buffer.accept(ENV, batch());
    expect(buffer.size).toBe(1);
    expect(buffer.drain()[0]?.count).toBe(250);
  });

  it("keeps environments separate", () => {
    const buffer = new EventBuffer();
    buffer.accept("env-a", batch());
    buffer.accept("env-b", batch());
    expect(buffer.size).toBe(2);
  });

  it("truncates to the bucket interval", () => {
    const buffer = new EventBuffer({ bucketSeconds: 60 });
    buffer.accept(ENV, batch({ bucketAt: 65_432 }));
    expect(buffer.drain()[0]?.bucketAt).toBe(60_000);
  });

  it("drops the oldest rows at the ceiling and counts every drop", () => {
    const dropped: Array<{ rows: number; reason: string }> = [];
    const buffer = new EventBuffer({
      maxRows: 10,
      onDropped: (rows, reason) => dropped.push({ rows, reason }),
    });
    for (let i = 0; i < 100; i++) {
      buffer.accept(ENV, batch({ summaries: [{ flagKey: `f${i}`, count: 1 }] }));
    }
    expect(buffer.size).toBe(10);
    expect(buffer.dropped).toBe(90);
    expect(dropped.every((d) => d.reason === "buffer_full")).toBe(true);
  });

  it("surfaces SDK-side drops under their own reason", () => {
    const dropped: string[] = [];
    const buffer = new EventBuffer({ onDropped: (_rows, reason) => dropped.push(reason) });
    buffer.accept(ENV, batch({ dropped: 17 }));
    expect(dropped).toContain("sdk_backpressure");
  });

  it("bounds a requeue after a failed write", () => {
    // A retry path that can grow memory without limit is not a retry.
    const buffer = new EventBuffer({ maxRows: 5 });
    for (let i = 0; i < 5; i++) {
      buffer.accept(ENV, batch({ summaries: [{ flagKey: `f${i}`, count: 1 }] }));
    }
    const rows: BufferedSummary[] = Array.from({ length: 50 }, (_, i) => ({
      environmentId: ENV,
      flagKey: `requeued-${i}`,
      variationIndex: null,
      reason: "ERROR",
      bucketAt: 60_000,
      count: 1,
      uniqueContexts: 0,
    }));
    buffer.requeue(rows);
    expect(buffer.size).toBeLessThanOrEqual(5);
  });

  it("skips a malformed row without losing the rest of the batch", () => {
    const buffer = new EventBuffer();
    buffer.accept(
      ENV,
      batch({
        summaries: [
          { flagKey: "bad", count: Number.NaN },
          { flagKey: "good", count: 2 },
        ],
      }),
    );
    const rows = buffer.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flagKey).toBe("good");
  });

  it("reports lag from the oldest buffered bucket", () => {
    const buffer = new EventBuffer({ now: () => 300_000 });
    buffer.accept(ENV, batch({ bucketAt: 60_000 }));
    expect(buffer.lagSeconds()).toBe(240);
    buffer.drain();
    expect(buffer.lagSeconds()).toBe(0);
  });
});

describe("mergeRows", () => {
  it("collapses rows sharing a primary key", () => {
    // Postgres rejects an ON CONFLICT insert whose own VALUES list hits the same
    // conflict target twice ("cannot affect row a second time"), and a drain can
    // absolutely contain duplicates.
    const row = (count: number): BufferedSummary => ({
      environmentId: ENV,
      flagKey: "f",
      variationIndex: 0,
      reason: "OFF",
      bucketAt: 60_000,
      count,
      uniqueContexts: 0,
    });
    const merged = mergeRows([row(1), row(2), row(3)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.count).toBe(6);
  });

  it("keeps genuinely different keys apart", () => {
    const base: BufferedSummary = {
      environmentId: ENV,
      flagKey: "f",
      variationIndex: 0,
      reason: "OFF",
      bucketAt: 60_000,
      count: 1,
      uniqueContexts: 0,
    };
    const merged = mergeRows([
      base,
      { ...base, variationIndex: 1 },
      { ...base, reason: "FALLTHROUGH" },
      { ...base, bucketAt: 120_000 },
    ]);
    expect(merged).toHaveLength(4);
  });

  it("unions sketches rather than picking one", () => {
    const a = new HyperLogLog();
    const b = new HyperLogLog();
    for (let i = 0; i < 500; i++) a.add(`a-${i}`);
    for (let i = 0; i < 500; i++) b.add(`b-${i}`);
    const row = (sketch: Uint8Array): BufferedSummary => ({
      environmentId: ENV,
      flagKey: "f",
      variationIndex: 0,
      reason: "OFF",
      bucketAt: 60_000,
      count: 1,
      uniqueContexts: 500,
      sketch,
    });
    const merged = mergeRows([row(a.toBytes()), row(b.toBytes())]);
    const union = HyperLogLog.fromBytes(merged[0]?.sketch);
    expect(union).not.toBeNull();
    // Two disjoint sets of 500: the union is ~1000, not ~500.
    expect(union!.count()).toBeGreaterThan(850);
  });
});

describe("isMissingPartition", () => {
  it("recognises the error a stopped partition maintenance produces", () => {
    // §7.9 forbids a DEFAULT partition, so this is a real, expected outcome with
    // its own runbook — not a transient error to retry forever.
    expect(
      isMissingPartition(
        new Error('no partition of relation "evaluation_summaries" found for row'),
      ),
    ).toBe(true);
    expect(isMissingPartition(new Error("connection terminated"))).toBe(false);
  });
});

describe("MemoryDeadLetterQueue", () => {
  it("is bounded, so an outage cannot grow it forever", () => {
    const dlq = new MemoryDeadLetterQueue(3);
    for (let i = 0; i < 20; i++) dlq.push([], "write_failed");
    expect(dlq.size).toBe(3);
  });

  it("hands everything over for replay exactly once", () => {
    const dlq = new MemoryDeadLetterQueue();
    dlq.push([], "missing_partition");
    expect(dlq.take()).toHaveLength(1);
    expect(dlq.take()).toHaveLength(0);
  });
});

describe("HyperLogLog", () => {
  it("estimates cardinality within a few percent", () => {
    const sketch = new HyperLogLog();
    for (let i = 0; i < 10_000; i++) sketch.add(`user-${i}`);
    const error = Math.abs(sketch.count() - 10_000) / 10_000;
    expect(error).toBeLessThan(0.1);
  });

  it("is exact-ish for small sets, where most buckets live", () => {
    const sketch = new HyperLogLog();
    for (let i = 0; i < 100; i++) sketch.add(`user-${i}`);
    expect(sketch.count()).toBeGreaterThan(90);
    expect(sketch.count()).toBeLessThan(115);
  });

  it("merges idempotently, so a duplicated batch changes nothing", () => {
    // This is what makes a replayed or duplicated event harmless.
    const a = new HyperLogLog();
    for (let i = 0; i < 1_000; i++) a.add(`u-${i}`);
    const before = a.count();
    const copy = HyperLogLog.fromBytes(a.toBytes())!;
    a.merge(copy);
    expect(a.count()).toBe(before);
  });

  it("round-trips through bytes", () => {
    const sketch = new HyperLogLog();
    for (let i = 0; i < 2_000; i++) sketch.add(`u-${i}`);
    const decoded = HyperLogLog.fromBytes(sketch.toBytes());
    expect(decoded?.count()).toBe(sketch.count());
  });

  it("returns null for corrupt bytes instead of throwing", () => {
    // A corrupt sketch must degrade to "no unique count", never stall the drain.
    expect(HyperLogLog.fromBytes(new Uint8Array([9, 9, 9]))).toBeNull();
    expect(HyperLogLog.fromBytes(new Uint8Array(0))).toBeNull();
    expect(HyperLogLog.fromBytes(null)).toBeNull();
    expect(HyperLogLog.fromBytes(new Uint8Array([1, 12, 0, 0]))).toBeNull();
  });

  it("refuses to merge sketches of different precision", () => {
    expect(() => new HyperLogLog(12).merge(new HyperLogLog(10))).toThrow(/precision/);
  });
});
