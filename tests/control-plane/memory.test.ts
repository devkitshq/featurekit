/**
 * Memory under sustained churn (PR-C6).
 *
 * This covers every path where a customer or an attacker can cause unbounded
 * growth. The answer in this system is a set of `Map`s, and a `Map` that is
 * bounded in principle but not in a test is a `Map` that will be unbounded
 * after the next refactor.
 *
 * Each structure here is driven far past its ceiling with realistic churn, and
 * asserted to have stopped growing. Where a ceiling is configurable the test
 * sets a small one — the property is "it stops", not "it stops at 100,000".
 *
 * Heap is sampled where a structure holds *values* rather than counters, but
 * the size assertions are the load-bearing ones: heap in a GC'd runtime is
 * noisy, and a test that fails when the collector felt lazy is a test people
 * delete.
 */

import { describe, expect, it } from "vitest";
import { EventBuffer } from "../../src/events/ingest.js";
import { MemoryDeadLetterQueue } from "../../src/events/rollup.js";
import { RateLimiter } from "../../src/http/rate-limit.js";
import { MemoryClientConnectionStore } from "../../src/client-tier/connection-store.js";
import { SseRegistry, type SseStream } from "../../src/http/server.js";
import { ClientFanout } from "../../src/evaluation-service/fanout.js";
import { compileSnapshot } from "../../src/snapshot/compile.js";
import { clearRegexCache, compileSafeRegExp } from "../../src/sdk/evaluation/regex.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

const mb = (bytes: number) => bytes / 1024 / 1024;

/** Sample RSS growth around a block of work, after a settling pause. */
async function heapDelta(work: () => Promise<void> | void): Promise<number> {
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  await work();
  global.gc?.();
  await new Promise((r) => setTimeout(r, 10));
  return mb(process.memoryUsage().heapUsed - before);
}

describe("the event buffer", () => {
  it("stops growing at its ceiling under a flood of distinct flags", () => {
    const buffer = new EventBuffer({ maxRows: 1_000 });
    for (let i = 0; i < 100_000; i++) {
      buffer.accept("env-1", {
        bucketAt: Date.now(),
        summaries: [{ flagKey: `flag-${i}`, variationIndex: 0, reason: "OFF", count: 1 }],
      } as never);
    }
    expect(buffer.size).toBeLessThanOrEqual(1_000);
    expect(buffer.dropped).toBeGreaterThan(90_000);
  });

  it("stops growing under a flood of distinct environments", () => {
    // One tenant cannot push another tenant's rows out by volume alone beyond
    // the shared ceiling — but the ceiling itself must hold.
    const buffer = new EventBuffer({ maxRows: 500 });
    for (let i = 0; i < 50_000; i++) {
      buffer.accept(`env-${i}`, {
        bucketAt: Date.now(),
        summaries: [{ flagKey: "f", variationIndex: 0, reason: "OFF", count: 1 }],
      } as never);
    }
    expect(buffer.size).toBeLessThanOrEqual(500);
  });

  it("does not grow across repeated drain cycles", async () => {
    const buffer = new EventBuffer({ maxRows: 10_000 });
    const delta = await heapDelta(() => {
      for (let cycle = 0; cycle < 50; cycle++) {
        for (let i = 0; i < 1_000; i++) {
          buffer.accept("env-1", {
            bucketAt: Date.now(),
            summaries: [{ flagKey: `f${i}`, variationIndex: 0, reason: "OFF", count: 1 }],
          } as never);
        }
        buffer.drain();
      }
    });
    expect(buffer.size).toBe(0);
    // 50,000 rows churned through. A leak shows up as tens of megabytes.
    expect(delta).toBeLessThan(20);
  });
});

describe("the dead-letter queue", () => {
  it("stops at its batch ceiling during a long outage", () => {
    const dlq = new MemoryDeadLetterQueue(10);
    for (let i = 0; i < 10_000; i++) {
      dlq.push(
        [
          {
            environmentId: "env-1",
            flagKey: `f${i}`,
            variationIndex: 0,
            reason: "OFF",
            bucketAt: Date.now(),
            count: 1,
            uniqueContexts: 0,
          },
        ],
        "write_failed",
      );
    }
    expect(dlq.size).toBe(10);
  });
});

describe("the rate limiter's counters", () => {
  it("stop growing under a flood of distinct callers", async () => {
    // Counters are keyed by caller identity — which is the internet.
    const limiter = new RateLimiter({ maxLocalKeys: 1_000, now: () => 60_000 });
    const delta = await heapDelta(async () => {
      for (let i = 0; i < 100_000; i++) {
        await limiter.consume(`identity-${i}`, { limit: 10, windowMs: 60_000 });
      }
    });
    expect(delta).toBeLessThan(50);
  });

  it("prunes counters from windows that have passed", async () => {
    let now = 0;
    const limiter = new RateLimiter({ maxLocalKeys: 100, now: () => now });
    for (let window = 0; window < 20; window++) {
      now = window * 60_000;
      for (let i = 0; i < 50; i++) {
        await limiter.consume(`caller-${window}-${i}`, { limit: 100, windowMs: 60_000 });
      }
    }
    expect((limiter as unknown as { local: Map<string, unknown> }).local.size).toBeLessThan(1_000);
  });
});

describe("the client connection store", () => {
  it("stops growing under a flood of identifies", async () => {
    const store = new MemoryClientConnectionStore({ maxEntries: 1_000 });
    const delta = await heapDelta(async () => {
      for (let i = 0; i < 50_000; i++) {
        await store.save(
          `conn-${i}`,
          {
            environmentId: "env-1",
            context: { key: `user-${i}`, country: "NL", plan: "pro" },
            lastSentVersion: 1,
          },
          900,
        );
      }
    });
    expect(store.size).toBeLessThanOrEqual(1_000);
    expect(delta).toBeLessThan(50);
  });
});

describe("the SSE registry", () => {
  it("releases every stream that closes", () => {
    // The registry exists so shutdown can drain. It must not become a list of
    // every connection the node has ever had.
    const registry = new SseRegistry();
    const streams: SseStream[] = [];
    for (let i = 0; i < 20_000; i++) {
      const stream = {
        closed: false,
        event: () => true,
        raw: () => true,
        comment: () => true,
        close: () => {},
      } as SseStream;
      streams.push(stream);
      registry.add(stream);
    }
    expect(registry.size).toBe(20_000);
    for (const stream of streams) registry.remove(stream);
    expect(registry.size).toBe(0);
  });
});

describe("the client fan-out cache", () => {
  function snapshot(version: number) {
    const input: CompilerInput = {
      environment: { id: "env-1", key: "production", bucketSalt: "salt" },
      flags: Array.from({ length: 50 }, (_, i) => ({
        id: `f${i}`,
        key: `flag-${i}`,
        kind: "boolean" as const,
        archivedAt: null,
        clientAvailable: true,
      })),
      variations: Array.from({ length: 50 }, (_, i) => [
        { id: `f${i}-v0`, flagId: `f${i}`, idx: 0, value: false },
        { id: `f${i}-v1`, flagId: `f${i}`, idx: 1, value: true },
      ]).flat(),
      flagEnvironments: Array.from({ length: 50 }, (_, i) => ({
        id: `fe${i}`,
        flagId: `f${i}`,
        environmentId: "env-1",
        enabled: true,
        offVariationId: `f${i}-v0`,
        fallthroughVariationId: `f${i}-v1`,
        fallthroughRollout: null,
        version: 1,
      })),
      targets: [],
      rules: [],
      clauses: [],
      prerequisites: [],
      segments: [],
      segmentMembers: [],
      segmentRules: [],
      segmentRuleClauses: [],
    };
    return compileSnapshot(input, { version });
  }

  it("does not accumulate across snapshot versions", async () => {
    // The cache is keyed `(version, flagKey, fingerprint)`, so a version bump
    // invalidates by construction — but only if the old entries actually go.
    const fanout = new ClientFanout();
    const connections = Array.from({ length: 500 }, (_, i) => ({
      id: `c${i}`,
      context: { key: `user-${i}`, country: ["NL", "DE", "FR"][i % 3], plan: "pro" },
    }));

    const delta = await heapDelta(() => {
      for (let version = 1; version <= 60; version++) {
        const snap = snapshot(version);
        fanout.fanout(snap, Object.keys(snap.flags), connections);
      }
    });
    // Sixty snapshots' worth of cached values would be hundreds of megabytes.
    expect(delta).toBeLessThan(80);
  });
});

describe("the regex cache", () => {
  it("stops growing under a flood of distinct patterns", async () => {
    // Patterns come from customer configuration, so their cardinality is
    // "bounded by the customer", which is not bounded.
    clearRegexCache();
    const delta = await heapDelta(() => {
      for (let i = 0; i < 50_000; i++) compileSafeRegExp(`^user-${i}-[a-z]+$`);
    });
    expect(delta).toBeLessThan(30);
    // Still working afterwards.
    expect(compileSafeRegExp("^ok$")?.test("ok")).toBe(true);
  });
});

describe("evaluation itself", () => {
  it("allocates nothing that survives the call", async () => {
    const { evaluate } = await import("../../src/sdk/evaluation/evaluate.js");
    const snap = {
      version: 1,
      environmentKey: "production",
      salt: "salt",
      flags: {
        f: {
          key: "f",
          version: 1,
          kind: "boolean",
          on: true,
          variations: [false, true],
          offVariation: 0,
          fallthrough: { variation: 1 },
          prerequisites: [],
          targets: [],
          rules: [],
        },
      },
      segments: {},
    } as never;

    const delta = await heapDelta(() => {
      for (let i = 0; i < 500_000; i++) evaluate("f", { key: `user-${i}` }, snap, false);
    });
    // Half a million evaluations. Anything retained per call shows up here.
    expect(delta).toBeLessThan(30);
  });
});
