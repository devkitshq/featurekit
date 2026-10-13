/**
 * Resolving a presented SDK key to an environment.
 *
 * This is the function every SDK request runs before anything else, so it has
 * two jobs that pull against each other: be fast enough to sit in front of a
 * polling fleet, and be *revocable* — a key that keeps working for an hour after
 * an operator revoked it is not revoked.
 *
 * How that is resolved:
 *
 * - **Lookup is a single indexed equality query.** Server keys are hashed at
 *   rest, so the presented key is hashed and matched against `key_hash`; client
 *   and mobile keys are public and matched against `key_public`. Never a scan
 *   with a comparison in application code — that is O(keys) per request and
 *   leaks timing besides.
 * - **The cache is short and bounded**, and its TTL *is* the revocation bound.
 *   It is stated in one place, returned to callers, and asserted by a test, so
 *   "how long until a revoked key stops working" has a number rather than an
 *   opinion.
 * - **Misses are cached too**, briefly. Otherwise an attacker guessing keys
 *   costs one database round trip per guess, which is a free denial of service
 *   against the one query every legitimate request also needs.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { environments, sdkKeys } from "../db/schema.js";
import { claimedKind, hashKey, type SdkKeyKind } from "../auth/keys.js";

export interface ResolvedKey {
  id: string;
  environmentId: string;
  environmentKey: string;
  projectId: string;
  /** Drives secure-mode enforcement: production rejects unsigned contexts. */
  isProduction: boolean;
  kind: SdkKeyKind;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface SdkKeyCacheOptions {
  /** Revocation bound. A revoked key stops working within this window. */
  ttlMs?: number;
  /** Shorter than `ttlMs`: a key created moments ago should start working fast. */
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry {
  value: ResolvedKey | null;
  expiresAt: number;
}

export class SdkKeyRepository {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastUsedWrites = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly db: Database,
    private readonly options: SdkKeyCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 5_000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** The documented revocation bound, in milliseconds. */
  get revocationBoundMs(): number {
    return this.ttlMs;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * The cache key is a hash of the presented key, never the key itself.
   *
   * A heap dump, a debugger, or an error serialising a Map are all ways a raw
   * key in memory becomes a raw key somewhere else.
   */
  private cacheKey(presented: string): string {
    return hashKey(presented);
  }

  async resolve(presentedKey: string): Promise<ResolvedKey | null> {
    if (presentedKey.length === 0 || presentedKey.length > 256) return null;

    const cacheKey = this.cacheKey(presentedKey);
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      if (cached.value !== null) this.touch(cached.value, now);
      return cached.value;
    }

    const resolved = await this.query(presentedKey);
    if (this.cache.size >= this.maxEntries) this.evictExpired(now);
    this.cache.set(cacheKey, {
      value: resolved,
      expiresAt: now + (resolved === null ? this.negativeTtlMs : this.ttlMs),
    });
    if (resolved !== null) this.touch(resolved, now);
    return resolved;
  }

  private async query(presentedKey: string): Promise<ResolvedKey | null> {
    // The prefix routes the lookup and nothing else. What a key *is* comes from
    // the `kind` column beside it, because a caller can write any prefix it
    // likes.
    const claimed = claimedKind(presentedKey);
    const predicate =
      claimed === "server" || claimed === null
        ? eq(sdkKeys.keyHash, hashKey(presentedKey))
        : eq(sdkKeys.keyPublic, presentedKey);

    const rows = await this.db
      .select({
        id: sdkKeys.id,
        environmentId: sdkKeys.environmentId,
        kind: sdkKeys.kind,
        expiresAt: sdkKeys.expiresAt,
        revokedAt: sdkKeys.revokedAt,
        environmentKey: environments.key,
        projectId: environments.projectId,
        isProduction: environments.isProduction,
      })
      .from(sdkKeys)
      .innerJoin(environments, eq(environments.id, sdkKeys.environmentId))
      .where(predicate)
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      environmentId: row.environmentId,
      environmentKey: row.environmentKey,
      projectId: row.projectId,
      isProduction: row.isProduction,
      kind: row.kind,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  /**
   * `last_used_at`, at most once per key per interval.
   *
   * Writing it per request turns every read of a cached key into a database
   * write — a fleet of 10,000 polling SDKs would generate 10,000 UPDATEs per
   * poll interval against one row each, for a column nobody reads in real time.
   */
  private touch(key: ResolvedKey, now: number): void {
    const last = this.lastUsedWrites.get(key.id) ?? 0;
    if (now - last < 300_000) return;
    this.lastUsedWrites.set(key.id, now);
    void this.db
      .update(sdkKeys)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(sdkKeys.id, key.id))
      // Best effort by construction: failing to record a timestamp must never
      // fail the request that was otherwise fine.
      .catch(() => undefined);
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    // Still full: the traffic is genuinely diverse (or hostile). Drop the oldest
    // half rather than growing without bound.
    if (this.cache.size >= this.maxEntries) {
      const half = Math.floor(this.cache.size / 2);
      let dropped = 0;
      for (const key of this.cache.keys()) {
        this.cache.delete(key);
        if (++dropped >= half) break;
      }
    }
  }

  /** Drop a key from the cache immediately — used by the revoke endpoint. */
  invalidate(presentedKey: string): void {
    this.cache.delete(this.cacheKey(presentedKey));
  }

  /** Drop everything. Used when a key is revoked by id rather than by value. */
  invalidateAll(): void {
    this.cache.clear();
  }
}
