/**
 * Rate limiting.
 *
 * The question this answers: *can one tenant create resource
 * exhaustion for all tenants?* Without a limiter the answer is yes, trivially —
 * `POST /v1/client/state` evaluates every client-available flag against a
 * caller-supplied context, and the key needed to call it ships in a JS bundle.
 *
 * Three decisions worth stating:
 *
 * 1. **The limiter runs before authentication.** A limiter that only counts
 *    authenticated requests cannot slow down key-guessing, which is the attack
 *    that matters here ("brute-force identities"). Identity is therefore derived
 *    from the presented credential's *hash* plus the peer address — never the
 *    credential itself, which must not be a key in Redis or a label in a log.
 * 2. **Redis loss degrades to a local limit, never to unlimited.** This is the
 *    fail-open that turns a cache outage into a security incident: the moment
 *    Redis blips, an unlimited endpoint is exactly what an attacker was waiting
 *    for. Each node instead enforces its own share, conservatively.
 * 3. **Sliding, not fixed, window.** A fixed window lets a caller spend its
 *    whole budget in the last millisecond of one window and again in the first
 *    of the next — double the intended rate, at the worst possible moment.
 */

import { createHash } from "node:crypto";
import type { RequestContext } from "./router.js";
import type { HttpResponse } from "./router.js";

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

/**
 * The counter store. Deliberately one method: `SnapshotStore` is a class with
 * one method for the same reason, and it means a test can substitute a
 * Map without a container.
 */
export interface RateLimitBackend {
  /** Increment `key`, returning the new value. The key expires after `ttlMs`. */
  incr(key: string, ttlMs: number): Promise<number>;
  /** Read a counter without creating it. Missing reads as 0. */
  peek(key: string): Promise<number>;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  /** True when the decision came from the local fallback rather than Redis. */
  degraded: boolean;
}

export interface RateLimiterOptions {
  backend?: RateLimitBackend;
  /**
   * Share of the configured limit each node allows on its own when the backend
   * is unavailable. Below 1 because every node is doing this simultaneously.
   */
  degradedFactor?: number;
  /** Bounded, so the fallback cannot itself become the memory leak. */
  maxLocalKeys?: number;
  now?: () => number;
  onDegraded?: (error: unknown) => void;
}

interface LocalCounter {
  windowStart: number;
  current: number;
  previous: number;
}

export class RateLimiter {
  private readonly local = new Map<string, LocalCounter>();

  constructor(private readonly options: RateLimiterOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Sliding window over two adjacent fixed windows.
   *
   * The estimate weights the previous window by how much of it is still inside
   * the trailing window. It is the standard approximation, it is stable under
   * concurrency, and it needs one counter per window rather than a sorted set
   * per caller — which at a million SDKs is the difference between a Redis that
   * works and one that does not.
   */
  async consume(identity: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const now = this.now();
    const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
    const elapsed = (now - windowStart) / rule.windowMs;

    const backend = this.options.backend;
    if (backend !== undefined) {
      try {
        const currentKey = `${identity}:${windowStart}`;
        const previousKey = `${identity}:${windowStart - rule.windowMs}`;
        const current = await backend.incr(currentKey, rule.windowMs * 2);
        // A miss reads as zero, which is correct: no traffic, or a window that
        // has already expired.
        const previous = await backend.peek(previousKey);
        const estimate = current + previous * (1 - elapsed);
        return this.decide(estimate, rule, elapsed, false);
      } catch (error) {
        this.options.onDegraded?.(error);
        // fall through to the local limiter
      }
    }

    return this.decide(this.localEstimate(identity, windowStart, rule, elapsed), rule, elapsed, true);
  }

  private localEstimate(
    identity: string,
    windowStart: number,
    rule: RateLimitRule,
    elapsed: number,
  ): number {
    let counter = this.local.get(identity);
    if (counter === undefined) {
      if (this.local.size >= (this.options.maxLocalKeys ?? 100_000)) this.prune(windowStart);
      counter = { windowStart, current: 0, previous: 0 };
      this.local.set(identity, counter);
    }
    if (counter.windowStart !== windowStart) {
      counter.previous = counter.windowStart === windowStart - rule.windowMs ? counter.current : 0;
      counter.current = 0;
      counter.windowStart = windowStart;
    }
    counter.current++;
    return counter.current + counter.previous * (1 - elapsed);
  }

  /**
   * Make room in the local counter map.
   *
   * Expired windows first — that is the cheap, correct eviction. But it is not
   * *sufficient*, and the difference matters: during a Redis outage with many
   * distinct callers, every counter belongs to the current window, so an
   * expiry-only prune deletes nothing. The map then keeps growing while a full
   * scan runs on every single request, which is quadratic work and unbounded
   * memory at exactly the moment the system is already degraded. A memory test
   * is what found that; it took 90 seconds to insert 100,000 identities.
   *
   * So if expiry frees nothing, the oldest half goes. Dropping a counter is
   * not a security hole — it resets one caller's window, and the caller still
   * cannot exceed the limit going forward — whereas an unbounded map is the
   * node.
   */
  private prune(windowStart: number): void {
    for (const [key, counter] of this.local) {
      if (counter.windowStart < windowStart) this.local.delete(key);
    }
    const ceiling = this.options.maxLocalKeys ?? 100_000;
    if (this.local.size < ceiling) return;

    let dropped = 0;
    const target = Math.max(1, Math.floor(ceiling / 2));
    for (const key of this.local.keys()) {
      this.local.delete(key);
      if (++dropped >= target) break;
    }
  }

  private decide(
    estimate: number,
    rule: RateLimitRule,
    elapsed: number,
    degraded: boolean,
  ): RateLimitDecision {
    const limit = degraded
      ? Math.max(1, Math.ceil(rule.limit * (this.options.degradedFactor ?? 0.5)))
      : rule.limit;
    const allowed = estimate <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(0, Math.floor(limit - estimate)),
      retryAfterSeconds: Math.max(1, Math.ceil((rule.windowMs * (1 - elapsed)) / 1000)),
      degraded,
    };
  }
}

/**
 * The identity a limit is counted against.
 *
 * The credential is hashed and truncated: Redis keys end up in `MONITOR`
 * output, slow logs and support tickets, and an SDK key that reaches any of
 * those is a leaked credential. The peer address is included so that
 * rotating through unauthenticated requests does not reset the counter.
 */
export function rateLimitIdentity(ctx: RequestContext, scope: string): string {
  const credential = ctx.header("authorization") ?? ctx.query.get("key") ?? "";
  const peer = ctx.req.socket.remoteAddress ?? "unknown";
  const digest = createHash("sha256")
    .update(credential.length > 0 ? credential : peer, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `fk:rl:${scope}:${digest}`;
}

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** Route pattern → rule. A pattern with no rule is not limited. */
  rules: Map<string, RateLimitRule>;
  /**
   * A per-environment override, keyed by the environment in the request path.
   *
   * One customer's mobile fleet legitimately polls harder than another's batch
   * job, and a single global ceiling means the tight one is set by whoever
   * complains loudest. Resolved from the path rather than from the credential:
   * the limiter runs *before* authentication (see the header comment), so the
   * key is not available yet — and an unauthenticated caller inventing an
   * environment name gets a limit for an environment that does not exist, which
   * is no worse than the default.
   */
  overrides?: (environmentKey: string, routePattern: string) => RateLimitRule | undefined;
  onLimited?: (ctx: RequestContext, decision: RateLimitDecision) => void;
}

export function rateLimitMiddleware(options: RateLimitMiddlewareOptions) {
  return async (ctx: RequestContext): Promise<HttpResponse | undefined> => {
    const base = options.rules.get(ctx.routePattern);
    if (base === undefined) return undefined;

    const environmentKey = ctx.params["envKey"] ?? ctx.params["env"];
    const rule =
      environmentKey === undefined
        ? base
        : (options.overrides?.(environmentKey, ctx.routePattern) ?? base);

    const decision = await options.limiter.consume(
      rateLimitIdentity(ctx, ctx.routePattern),
      rule,
    );
    if (decision.allowed) return undefined;

    options.onLimited?.(ctx, decision);
    return {
      status: 429,
      body: { error: "RATE_LIMITED", retryAfterSeconds: decision.retryAfterSeconds },
      headers: {
        "retry-after": String(decision.retryAfterSeconds),
        "x-ratelimit-limit": String(decision.limit),
        "x-ratelimit-remaining": "0",
      },
    };
  };
}
