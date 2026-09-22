/**
 * The Redis key map (§8).
 *
 * **Redis is a cache and a bus. Losing all of it must not lose a flag
 * configuration** — Postgres is truth and every key here is rebuildable.
 * The rebuild cost of each is documented beside it, because "what happens when
 * Redis restarts" is a question that has to have an answer per key rather than
 * in general.
 */

export const redisKeys = {
  /** Compiled ruleset snapshot. Rebuild: recompile from Postgres. */
  snapshot: (environmentId: string) => `fk:snap:${environmentId}:server`,
  /** Snapshot version, served as `ETag`. Rebuild: recompile. */
  snapshotVersion: (environmentId: string) => `fk:snap:${environmentId}:ver`,
  /**
   * Patch history for SSE resume (§10.3). Capped stream.
   * Rebuild: **lossy** — reconnects degrade to a full `put`, which is correct.
   */
  patches: (environmentId: string) => `fk:patches:${environmentId}`,
  /** Change broadcast to every API node. Pub/sub, no rebuild. */
  channel: (environmentId: string) => `fk:chan:${environmentId}`,
  /** Client-tier connection → context (§11.5). Rebuild: client re-identifies. */
  clientContext: (connectionId: string) => `fk:cctx:${connectionId}`,
  /** Raw summary batches from SDKs. **Lossy by design** (§14). */
  events: "fk:events",
  /** Sharded for single-writer rollup (§7.9). Lossy by design. */
  rollup: (shard: number) => `fk:rollup:${shard}`,
  /** Rollup failures, replayable. */
  dlq: "fk:dlq",
  /** Sliding-window rate limit per SDK key. */
  rateLimit: (keyId: string) => `fk:rl:${keyId}`,
  /**
   * Membership for external segments; also the backing store a remote
   * `SegmentCacheProvider` reads (§9.7). Rebuild: reload from Postgres.
   */
  segment: (segmentId: string) => `fk:seg:${segmentId}`,
  /**
   * Client-tier fingerprint → evaluated values (§11.5). Keyed by version so a
   * snapshot bump invalidates by construction rather than by an explicit sweep.
   */
  clientFingerprint: (environmentId: string, version: number) =>
    `fk:cfp:${environmentId}:${version}`,
  /** Compile lock; prevents a thundering herd. */
  compileLock: (environmentId: string) => `fk:lock:snapshot:${environmentId}`,
} as const;
