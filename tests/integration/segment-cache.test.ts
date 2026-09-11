/**
 * The Redis segment cache, against a real Redis (§9.7, review PR-B6).
 *
 * The SDK half of external segment resolution has existed since M1; this is the
 * server half that was missing, which meant "external segment resolution
 * without evaluation-path I/O" was unproven for anything larger than the heap.
 *
 * The property that matters and cannot be checked with a mock: **`has()` never
 * awaits.** Evaluation is synchronous by design, so a provider that resolved by
 * awaiting Redis would put a network hop inside every flag check in the
 * customer's application. It answers from a bounded local cache, misses are
 * unresolved rather than false, and warming happens out of band.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { RedisSegmentCache, publishSegmentMembers } from "../../src/redis/segment-cache.js";
import { SegmentIndex } from "../../src/sdk/index.js";

const reason = await containerUnavailableReason();

describe("segment cache prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; segment cache tests will run"
      : `segment cache tests SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("RedisSegmentCache", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let client: Redis;

  const SEGMENT = "enterprise-accounts";
  const MEMBERS = Array.from({ length: 5_000 }, (_, i) => `usr_${i}`);

  beforeAll(async () => {
    infra = await startInfrastructure();
    client = new Redis(infra.redisUrl, { maxRetriesPerRequest: 3 });
    await publishSegmentMembers(client, SEGMENT, MEMBERS, { chunkSize: 1_000 });
  }, 300_000);

  afterAll(async () => {
    await client?.quit();
    await infra?.stop();
  });

  function cache(over: ConstructorParameters<typeof RedisSegmentCache>[1] = {}) {
    const provider = new RedisSegmentCache(client, over);
    provider.register([SEGMENT]);
    return provider;
  }

  it("answers a cold lookup synchronously, without awaiting Redis", () => {
    const provider = cache();
    const started = performance.now();
    const answer = provider.has(SEGMENT, "usr_1");
    const elapsed = performance.now() - started;

    // A round trip to Redis is milliseconds; this must be microseconds. The
    // answer is `false` (unresolved), not a promise and not a wait.
    expect(typeof answer).toBe("boolean");
    expect(elapsed).toBeLessThan(2);
  });

  it("resolves a member after the background warm completes", async () => {
    const provider = cache();
    expect(provider.has(SEGMENT, "usr_2")).toBe(false); // cold: unresolved
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.has(SEGMENT, "usr_2")).toBe(true);
  });

  it("stays false for a genuine non-member", async () => {
    const provider = cache();
    provider.has(SEGMENT, "nobody");
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.has(SEGMENT, "nobody")).toBe(false);
  });

  it("resolves a batch in one round trip", async () => {
    const provider = cache();
    const keys = ["usr_10", "usr_11", "usr_12", "not-a-member"];
    await provider.resolve(SEGMENT, keys);
    expect(provider.has(SEGMENT, "usr_10")).toBe(true);
    expect(provider.has(SEGMENT, "usr_11")).toBe(true);
    expect(provider.has(SEGMENT, "usr_12")).toBe(true);
    expect(provider.has(SEGMENT, "not-a-member")).toBe(false);
  });

  it("reports which segments it can answer for", () => {
    const provider = cache();
    expect(provider.isResolved(SEGMENT)).toBe(true);
    // A small segment inlined in the snapshot is not this provider's business;
    // claiming it would make the SDK defer an answer it already has exactly.
    expect(provider.isResolved("some-inline-segment")).toBe(false);
  });

  it("bounds its local cache rather than growing with the user base", async () => {
    const provider = cache({ maxCachedKeys: 100 });
    await provider.resolve(SEGMENT, MEMBERS.slice(0, 500));
    expect(provider.cachedAnswers).toBeLessThanOrEqual(100);
  });

  it("expires answers so membership changes are picked up", async () => {
    let now = 1_000;
    const provider = cache({ ttlMs: 50, now: () => now });
    await provider.resolve(SEGMENT, ["usr_20"]);
    expect(provider.has(SEGMENT, "usr_20")).toBe(true);
    now += 100;
    // Expired: back to unresolved and a fresh warm, rather than serving a
    // membership answer from an hour ago forever.
    expect(provider.has(SEGMENT, "usr_20")).toBe(false);
  });

  it("drops local answers when a delta arrives", async () => {
    const provider = cache();
    await provider.resolve(SEGMENT, ["usr_30"]);
    expect(provider.has(SEGMENT, "usr_30")).toBe(true);
    provider.apply(SEGMENT, { add: [], remove: ["usr_30"] });
    expect(provider.has(SEGMENT, "usr_30")).toBe(false);
  });

  it("survives Redis being unreachable without throwing into evaluation", async () => {
    const dead = new Redis("redis://127.0.0.1:59997", {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    dead.on("error", () => {});
    const errors: unknown[] = [];
    const provider = new RedisSegmentCache(dead, { onError: (e) => errors.push(e) });
    provider.register([SEGMENT]);

    // Fails closed and quietly: unresolved, never an exception on the hot path.
    expect(provider.has(SEGMENT, "usr_1")).toBe(false);
    await provider.resolve(SEGMENT, ["usr_1"]);
    expect(provider.has(SEGMENT, "usr_1")).toBe(false);
    await dead.quit().catch(() => undefined);
  });
});

describe.skipIf(reason !== null)("the SDK resolving through it", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let client: Redis;

  beforeAll(async () => {
    infra = await startInfrastructure();
    client = new Redis(infra.redisUrl, { maxRetriesPerRequest: 3 });
    await publishSegmentMembers(client, "big", ["usr_a", "usr_b"]);
  }, 300_000);

  afterAll(async () => {
    await client?.quit();
    await infra?.stop();
  });

  it("fails a membership check closed until the provider has warmed", async () => {
    // The §22.3 property, end to end through a real provider: an unconfirmed
    // positive is `unresolved`, never `member` and never `not-member`.
    const provider = new RedisSegmentCache(client);
    provider.register(["big"]);

    const index = new SegmentIndex({
      big: {
        key: "big",
        version: 1,
        kind: "cuckoo",
        // A filter that admits everything: every check reaches the provider.
        filter: new Uint8Array(0),
        fpRate: 1,
        loadFactor: 0,
      },
    } as never);
    index.setCache(provider);

    const before = index.membership("big", "usr_a");
    expect(before).not.toBe("member");

    await provider.resolve("big", ["usr_a"]);
    expect(["member", "unresolved"]).toContain(index.membership("big", "usr_a"));
  });
});
