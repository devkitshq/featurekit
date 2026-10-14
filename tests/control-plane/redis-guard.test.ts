/**
 * The rate limiter and the client-tier connection store share the snapshot
 * store's Redis connection, and both sit on every client-tier request. They
 * must go through its circuit breaker: before they did, a Redis outage cost
 * every request a full command timeout per call — seconds, long enough for
 * every browser's `ready()` to give up and serve defaults.
 */

import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { CircuitOpenError } from "../../src/redis/circuit-breaker.js";
import { RedisClientConnectionStore } from "../../src/redis/client-connections.js";
import { RedisRateLimitBackend } from "../../src/redis/rate-limit-backend.js";
import type { GuardedRedis } from "../../src/redis/redis-store.js";

/** A breaker that is open: fails at once and never touches the client. */
function openCircuit(): { guarded: GuardedRedis; touched: () => boolean } {
  let touched = false;
  const client = new Proxy({} as Redis, {
    get() {
      touched = true;
      throw new Error("the raw client was used");
    },
  });
  const guarded: GuardedRedis = async (work) => {
    void work;
    void client;
    throw new CircuitOpenError(0);
  };
  return { guarded, touched: () => touched };
}

describe("Redis callers outside the snapshot store go through the breaker", () => {
  it("connection store: every method fails fast and degrades instead of throwing", async () => {
    const { guarded, touched } = openCircuit();
    const errors: unknown[] = [];
    const store = new RedisClientConnectionStore(guarded, { onError: (e) => errors.push(e) });

    await store.save("c1", { environmentId: "e", context: { key: "u" } } as never, 60);
    await expect(store.load("c1")).resolves.toBeNull();
    await store.touch("c1", 60);
    await store.delete("c1");

    expect(touched()).toBe(false);
    expect(errors).toHaveLength(4);
    expect(errors.every((e) => e instanceof CircuitOpenError)).toBe(true);
  });

  it("rate limit backend: surfaces the open circuit so the limiter falls back locally", async () => {
    const { guarded, touched } = openCircuit();
    const backend = new RedisRateLimitBackend(guarded);

    await expect(backend.incr("k", 1_000)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(backend.peek("k")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(touched()).toBe(false);
  });
});
