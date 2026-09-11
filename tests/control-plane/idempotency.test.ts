/**
 * Idempotency keys (review PR-E1).
 *
 * The scenario: a CI job PATCHes a flag, the response is lost to a timeout, the
 * job retries. Without a key the retry carries a stale `expectedVersion` and
 * fails a pipeline for a change that actually landed — and on the endpoints
 * with no version check, notably the kill switch, it simply applies twice.
 */

import { describe, expect, it } from "vitest";
import { IdempotencyCache, idempotencyKeyOf } from "../../src/http/idempotency.js";
import { HttpError, type RequestContext } from "../../src/http/router.js";

const ok = (n: number) => ({ status: 200, body: { applied: n } });

describe("IdempotencyCache", () => {
  it("runs the work once and replays the result", async () => {
    const cache = new IdempotencyCache();
    let runs = 0;
    const work = async () => {
      runs++;
      return ok(runs);
    };

    const first = await cache.run("key-1", { a: 1 }, work);
    const second = await cache.run("key-1", { a: 1 }, work);

    expect(runs).toBe(1);
    expect(second).toEqual(first);
  });

  it("refuses the same key with a different body", async () => {
    // The same key meaning two different changes is a caller bug, and silently
    // applying the second is the worst available response to it.
    const cache = new IdempotencyCache();
    await cache.run("key-1", { enabled: true }, async () => ok(1));
    await expect(cache.run("key-1", { enabled: false }, async () => ok(2))).rejects.toThrow(
      HttpError,
    );
  });

  it("refuses a concurrent retry rather than running the mutation twice", async () => {
    const cache = new IdempotencyCache();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = cache.run("key-1", { a: 1 }, async () => {
      await gate;
      return ok(1);
    });
    // A client that retries on timeout while the first request is still alive.
    await expect(cache.run("key-1", { a: 1 }, async () => ok(2))).rejects.toThrow(
      /still being processed/,
    );

    release();
    expect(await first).toEqual(ok(1));
  });

  it("does not remember a failure, so the caller can fix it and retry", async () => {
    const cache = new IdempotencyCache();
    await expect(
      cache.run("key-1", { a: 1 }, async () => {
        throw new HttpError(400, "INVALID_BODY", "nope");
      }),
    ).rejects.toThrow();

    // The same key now works: the first attempt changed nothing.
    expect(await cache.run("key-1", { a: 1 }, async () => ok(7))).toEqual(ok(7));
  });

  it("forgets entries after their TTL", async () => {
    let now = 0;
    const cache = new IdempotencyCache({ ttlMs: 1_000, now: () => now });
    let runs = 0;
    const work = async () => {
      runs++;
      return ok(runs);
    };

    await cache.run("key-1", { a: 1 }, work);
    now = 2_000;
    await cache.run("key-1", { a: 1 }, work);
    expect(runs).toBe(2);
  });

  it("stays bounded under a flood of distinct keys", async () => {
    const cache = new IdempotencyCache({ maxEntries: 100 });
    for (let i = 0; i < 5_000; i++) {
      await cache.run(`key-${i}`, { i }, async () => ok(i));
    }
    expect(cache.size).toBeLessThanOrEqual(100);
  });
});

describe("idempotencyKeyOf", () => {
  const ctx = (header: string | undefined, route = "/v1/admin/x", method = "POST") =>
    ({
      header: () => header,
      method,
      routePattern: route,
    }) as unknown as RequestContext;

  it("is absent when the caller sends no key", () => {
    expect(idempotencyKeyOf(ctx(undefined))).toBeNull();
    expect(idempotencyKeyOf(ctx("   "))).toBeNull();
  });

  it("scopes the key to the method and route", () => {
    // The same key on two endpoints is two operations; collapsing them would
    // replay the wrong response.
    const a = idempotencyKeyOf(ctx("abc", "/v1/admin/a"));
    const b = idempotencyKeyOf(ctx("abc", "/v1/admin/b"));
    const c = idempotencyKeyOf(ctx("abc", "/v1/admin/a", "DELETE"));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("rejects a key that is too long or oddly shaped", () => {
    // It becomes a cache key and a log field.
    expect(() => idempotencyKeyOf(ctx("x".repeat(500)))).toThrow(HttpError);
    expect(() => idempotencyKeyOf(ctx("has spaces"))).toThrow(HttpError);
    expect(() => idempotencyKeyOf(ctx("newline\nhere"))).toThrow(HttpError);
  });

  it("accepts the shapes a real client generates", () => {
    for (const key of ["a1b2c3", "run-4821", "deploy:2026-09-06:17", "uuid.v4_style-key"]) {
      expect(idempotencyKeyOf(ctx(key))).toContain(key);
    }
  });
});
