/**
 * Redis-backed segment membership.
 *
 * **The problem this solves.** A ten-million-member segment cannot live in the
 * heap of every SDK process — `Set<string>` at that size is well over a gigabyte
 * — and it cannot be inlined into a snapshot every SDK downloads. The answer
 * is a two-part split: a small deletable filter ships in the snapshot and gives
 * an exact *negative* with no I/O, and the positives it lets through are
 * confirmed against a resolved membership set. This is that set, kept in Redis
 * as a hash so many processes share one copy.
 *
 * **The hard constraint is that `has()` must not do I/O.** Evaluation is
 * synchronous by design — a promise per check poisons every call site and
 * cannot be used in a React render. So this provider answers from a bounded
 * local cache and returns `false`-as-unresolved on a miss, warming the answer in
 * the background. The `SegmentIndex` treats an unconfirmed positive as
 * `"unresolved"`, which fails the *rule* closed rather than granting it.
 *
 * That is the trade, stated plainly: a genuinely cold process fails a
 * large-segment rule closed on its first look at a given context, and resolves
 * it a round trip later. The alternative — awaiting Redis on the evaluation
 * path — makes every flag check in the customer's application depend on a
 * network hop, which is the thing this system exists not to do.
 */

import type { Redis } from "ioredis";
import type { SegmentCacheProvider, SegmentDelta } from "../sdk/index.js";
import { redisKeys } from "./keys.js";

export interface RedisSegmentCacheOptions {
  keyPrefix?: string;
  /** Bounded confirmed-membership cache. A miss is unresolved, not false. */
  maxCachedKeys?: number;
  /** How long a confirmed answer is trusted before it is looked up again. */
  ttlMs?: number;
  onError?: (error: unknown) => void;
  now?: () => number;
}

interface CacheEntry {
  member: boolean;
  expiresAt: number;
}

export class RedisSegmentCache implements SegmentCacheProvider {
  /** `${segmentKey}\0${contextKey}` → answer. Bounded, TTL'd. */
  private readonly confirmed = new Map<string, CacheEntry>();
  /** Segments this provider has been told it is responsible for. */
  private readonly known = new Set<string>();
  /** In-flight warms, so a hot context does not queue one lookup per check. */
  private readonly warming = new Set<string>();
  private readonly prefix: string;

  constructor(
    private readonly client: Redis,
    private readonly options: RedisSegmentCacheOptions = {},
  ) {
    this.prefix = options.keyPrefix === undefined ? "" : `${options.keyPrefix}:`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private key(segmentId: string): string {
    return `${this.prefix}${redisKeys.segment(segmentId)}`;
  }

  private cacheKey(segmentKey: string, contextKey: string): string {
    return `${segmentKey}\0${contextKey}`;
  }

  /**
   * Declare which segments this provider can answer for.
   *
   * Without it `isResolved` cannot distinguish "this segment is not mine" from
   * "I have not warmed it yet", and the SDK would treat every segment as
   * remotely resolvable — including the small ones already inlined in the
   * snapshot, whose answers are exact and free.
   */
  register(segmentKeys: Iterable<string>): void {
    for (const key of segmentKeys) this.known.add(key);
  }

  isResolved(segmentKey: string): boolean {
    return this.known.has(segmentKey);
  }

  /**
   * Synchronous by contract.
   *
   * A cached answer is returned immediately. A miss returns `false` and starts a
   * background warm — and `false` here does not mean "not a member": the
   * `SegmentIndex` only consults a provider for keys the filter has already
   * admitted, and treats an unconfirmed positive as unresolved, which fails the
   * rule closed.
   */
  has(segmentKey: string, contextKey: string): boolean {
    const id = this.cacheKey(segmentKey, contextKey);
    const entry = this.confirmed.get(id);
    const now = this.now();
    if (entry !== undefined && entry.expiresAt > now) return entry.member;

    void this.warm(segmentKey, contextKey);
    return false;
  }

  /** Fetch one membership answer and cache it. Never throws into the caller. */
  private async warm(segmentKey: string, contextKey: string): Promise<void> {
    const id = this.cacheKey(segmentKey, contextKey);
    if (this.warming.has(id)) return;
    this.warming.add(id);
    try {
      const raw = await this.client.hget(this.key(segmentKey), contextKey);
      this.remember(id, raw !== null && raw !== "0");
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.warming.delete(id);
    }
  }

  /**
   * Resolve a batch up front.
   *
   * The useful shape for the client tier, which knows every context it is about
   * to evaluate: one `HMGET` per segment instead of one round trip per context,
   * and every answer is warm before evaluation starts.
   */
  async resolve(segmentKey: string, contextKeys: readonly string[]): Promise<void> {
    if (contextKeys.length === 0) return;
    try {
      const values = await this.client.hmget(this.key(segmentKey), ...contextKeys);
      contextKeys.forEach((contextKey, i) => {
        const raw = values[i];
        this.remember(this.cacheKey(segmentKey, contextKey), raw != null && raw !== "0");
      });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private remember(id: string, member: boolean): void {
    const ceiling = this.options.maxCachedKeys ?? 100_000;
    if (this.confirmed.size >= ceiling) {
      // Drop the oldest half rather than growing: this cache is keyed by
      // (segment, context), so its cardinality is the customer's user base.
      let dropped = 0;
      const target = Math.floor(ceiling / 2);
      for (const key of this.confirmed.keys()) {
        this.confirmed.delete(key);
        if (++dropped >= target) break;
      }
    }
    this.confirmed.set(id, { member, expiresAt: this.now() + (this.options.ttlMs ?? 300_000) });
  }

  /**
   * Apply a segment delta.
   *
   * The Redis copy is shared, so a single writer updates it — this provider
   * only invalidates its own local answers. Applying the delta here on every
   * node would be N nodes writing the same hash, and a lost update between them
   * is a membership change that half the fleet never sees.
   */
  apply(segmentKey: string, delta: SegmentDelta): void {
    for (const contextKey of [...delta.add, ...delta.remove]) {
      this.confirmed.delete(this.cacheKey(segmentKey, contextKey));
    }
  }

  /** Local cache size, for tests and the memory gauge. */
  get cachedAnswers(): number {
    return this.confirmed.size;
  }
}

/**
 * The writer half: publish a segment's membership into Redis.
 *
 * Called by the control plane after an import, not by SDKs. Chunked, because
 * one `HSET` with ten million fields is a single command that blocks the Redis
 * event loop for seconds — and blocking Redis blocks every other node's
 * snapshot read at the same time.
 */
export async function publishSegmentMembers(
  client: Redis,
  segmentKey: string,
  members: readonly string[],
  options: { keyPrefix?: string; chunkSize?: number; ttlSeconds?: number } = {},
): Promise<void> {
  const prefix = options.keyPrefix === undefined ? "" : `${options.keyPrefix}:`;
  const key = `${prefix}${redisKeys.segment(segmentKey)}`;
  const chunk = options.chunkSize ?? 5_000;

  for (let i = 0; i < members.length; i += chunk) {
    const slice = members.slice(i, i + chunk);
    const fields: string[] = [];
    for (const member of slice) fields.push(member, "1");
    await client.hset(key, ...fields);
  }
  if (options.ttlSeconds !== undefined) await client.expire(key, options.ttlSeconds);
}
