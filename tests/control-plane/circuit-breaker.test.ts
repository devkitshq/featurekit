/**
 * The Redis circuit breaker (review PR-B10).
 *
 * The property being protected is not availability — the last-known-good path
 * already provides that — it is *latency during* an outage. Without a breaker,
 * every request pays a connection attempt and a command timeout before falling
 * back to a snapshot that was in memory the whole time. Two seconds per flag
 * fetch is indistinguishable from an outage to the SDK waiting on it.
 */

import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
} from "../../src/redis/circuit-breaker.js";

const boom = () => Promise.reject(new Error("redis down"));
const fine = () => Promise.resolve("ok");

describe("CircuitBreaker", () => {
  it("passes calls through while healthy", async () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 10; i++) expect(await breaker.run(fine)).toBe("ok");
    expect(breaker.current).toBe("closed");
  });

  it("opens after the configured run of failures", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.run(boom)).rejects.toThrow("redis down");
    }
    expect(breaker.current).toBe("open");
  });

  it("fails fast once open, without calling the work at all", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetAfterMs: 60_000 });
    await expect(breaker.run(boom)).rejects.toThrow("redis down");

    let called = false;
    await expect(
      breaker.run(async () => {
        called = true;
        return "never";
      }),
    ).rejects.toThrow(CircuitOpenError);
    // This is the whole point: no connection attempt, no timeout, no wait.
    expect(called).toBe(false);
  });

  it("resets its failure count on any success", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    await expect(breaker.run(boom)).rejects.toThrow();
    await expect(breaker.run(boom)).rejects.toThrow();
    await breaker.run(fine);
    await expect(breaker.run(boom)).rejects.toThrow();
    // Two, then a success, then one: never three in a row.
    expect(breaker.current).toBe("closed");
  });

  it("admits exactly one probe when the reset window elapses", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetAfterMs: 1_000,
      now: () => now,
    });
    await expect(breaker.run(boom)).rejects.toThrow();
    expect(breaker.current).toBe("open");

    now = 1_001;
    // The first caller becomes the probe...
    expect(breaker.canAttempt()).toBe(true);
    // ...and every other caller still fails fast while it is in flight. Without
    // this, recovery means the whole fleet hits a Redis that has just come back
    // and may still be loading its dataset.
    expect(breaker.canAttempt()).toBe(false);
    expect(breaker.current).toBe("half-open");
  });

  it("closes when the probe succeeds", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetAfterMs: 100, now: () => now });
    await expect(breaker.run(boom)).rejects.toThrow();
    now = 200;
    expect(await breaker.run(fine)).toBe("ok");
    expect(breaker.current).toBe("closed");
  });

  it("re-opens immediately when the probe fails", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 5, resetAfterMs: 100, now: () => now });
    for (let i = 0; i < 5; i++) await expect(breaker.run(boom)).rejects.toThrow();
    expect(breaker.current).toBe("open");

    now = 200;
    await expect(breaker.run(boom)).rejects.toThrow("redis down");
    // One failed probe re-opens it: it does not need another full run of five.
    expect(breaker.current).toBe("open");
    expect(breaker.canAttempt()).toBe(false);
  });

  it("reports every state change once", async () => {
    let now = 0;
    const seen: CircuitState[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetAfterMs: 100,
      onStateChange: (state) => seen.push(state),
      now: () => now,
    });
    await expect(breaker.run(boom)).rejects.toThrow();
    now = 200;
    await breaker.run(fine);
    expect(seen).toEqual(["open", "half-open", "closed"]);
  });

  it("makes the degraded path cheap", async () => {
    // A stand-in for a Redis that accepts connections and never answers.
    const slow = () => new Promise((resolve) => setTimeout(resolve, 200));
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 60_000 });

    const failing = () => breaker.run(() => slow().then(() => Promise.reject(new Error("timeout"))));
    await expect(failing()).rejects.toThrow();
    await expect(failing()).rejects.toThrow();

    const started = performance.now();
    for (let i = 0; i < 50; i++) {
      await expect(breaker.run(slow as () => Promise<unknown>)).rejects.toThrow(CircuitOpenError);
    }
    // 50 calls that would each have waited 200ms. Under a millisecond total.
    expect(performance.now() - started).toBeLessThan(50);
  });
});
