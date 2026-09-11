/**
 * The Redis counter behind the rate limiter (§8, §15).
 *
 * Two commands, pipelined: `INCR` then `PEXPIRE`. Not a Lua script, because the
 * only race here is two nodes setting the same expiry on the same key, and the
 * outcome of that race is "the expiry is set" either way.
 *
 * **Every failure is the caller's problem, deliberately.** This class does not
 * swallow errors: `RateLimiter` catches them and falls back to a local limit,
 * and a backend that quietly returned 0 on failure would look like "no traffic"
 * and let the limiter fail open — the exact security regression a Redis outage
 * must not cause.
 */

import type { Redis } from "ioredis";
import type { RateLimitBackend } from "../http/rate-limit.js";

export class RedisRateLimitBackend implements RateLimitBackend {
  constructor(
    private readonly client: Redis,
    private readonly prefix = "",
  ) {}

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    const results = await this.client.multi().incr(this.key(key)).pexpire(this.key(key), ttlMs).exec();
    const first = results?.[0];
    if (first === undefined || first[0] !== null) {
      throw first?.[0] ?? new Error("featurekit: rate limit INCR failed");
    }
    return Number(first[1]);
  }

  async peek(key: string): Promise<number> {
    const value = await this.client.get(this.key(key));
    return value === null ? 0 : Number(value);
  }
}
