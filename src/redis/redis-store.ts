/**
 * The Redis `SnapshotStore` (§8, §10.3, §10.4).
 *
 * Uses a capped Redis stream for patch history and pub/sub for fan-out. Two
 * connections are unavoidable: a connection in subscriber mode cannot issue
 * ordinary commands, so the subscriber is separate from the command client and
 * is created lazily — a node that never subscribes never opens it.
 */

import { Redis } from "ioredis";
import { CircuitBreaker, type CircuitState } from "./circuit-breaker.js";
import type { Snapshot } from "../sdk/index.js";
import { redisKeys } from "./keys.js";
import { resumeFrom } from "./memory-store.js";
import {
  deserializeSnapshot,
  serializeSnapshot,
  type ChangeMessage,
  type SnapshotStore,
  type StreamPatch,
} from "./snapshot-store.js";

export interface RedisSnapshotStoreOptions {
  url: string;
  /** Namespaces every key. Lets tests share one Redis without colliding. */
  keyPrefix?: string;
  /** How long a compile lock is held before it is assumed abandoned. */
  lockTtlMs?: number;
  /**
   * Connection-level errors.
   *
   * ioredis emits `error` on the client itself, separately from the promise a
   * command rejects with. Nothing listening means Node prints
   * `[ioredis] Unhandled error event` for every reconnect attempt — several per
   * second during an outage, in a log people are trying to read during an
   * incident. Worse, an `error` event with no listener on an EventEmitter is a
   * throw in some paths, which would take the process down over a cache being
   * unavailable (§11).
   */
  onError?: (error: unknown) => void;
  /** TLS for a managed Redis. `rediss://` in the URL implies it. */
  tls?: boolean;
  /** Off only for a self-signed certificate you have decided to trust. */
  tlsRejectUnauthorized?: boolean;
  connectTimeoutMs?: number;
  /** Bounds how long any single command may wait. See `connectionOptions`. */
  commandTimeoutMs?: number;
  /** Consecutive failures before commands fail fast instead of timing out. */
  circuitFailureThreshold?: number;
  circuitResetAfterMs?: number;
  onCircuitStateChange?: (state: CircuitState) => void;
}

/**
 * Connection options shared by the command and subscriber connections.
 *
 * The interesting pair is `commandTimeout` plus the circuit breaker, and the
 * reasoning is worth writing down because the obvious setting is wrong.
 *
 * Turning the offline queue *off* looks right — "fail immediately instead of
 * waiting for a reconnect that may never come" — and it breaks startup: a
 * command issued in the moments before the socket finishes connecting is
 * rejected outright, so every node begins life with a burst of spurious
 * failures and degraded compiles on every deploy.
 *
 * So the queue stays on and the *wait* is bounded instead. A command that
 * cannot complete within `commandTimeout` fails, and after a few such failures
 * the breaker opens and subsequent calls fail in microseconds. Startup gets its
 * short grace period; an outage still degrades to the in-memory snapshot almost
 * immediately (§14).
 */
function connectionOptions(options: RedisSnapshotStoreOptions) {
  // Cast once, here: ioredis' option type is a large intersection whose
  // optional members are not `| undefined`, which `exactOptionalPropertyTypes`
  // refuses to accept from a spread. Building the object in one place keeps
  // that to a single line rather than one at every construction site.
  return {
    maxRetriesPerRequest: 3,
    connectTimeout: options.connectTimeoutMs ?? 5_000,
    // Bounded, jittered reconnect. Without the jitter, every node in a fleet
    // that lost Redis together retries in the same millisecond, forever.
    retryStrategy: (times: number) =>
      Math.min(1_000 * 2 ** Math.min(times, 5), 30_000) + Math.floor(Math.random() * 250),
    ...(options.tls === true
      ? { tls: { rejectUnauthorized: options.tlsRejectUnauthorized !== false } }
      : {}),
  };
}

export class RedisSnapshotStore implements SnapshotStore {
  private readonly client: Redis;
  private subscriber: Redis | null = null;
  private readonly prefix: string;
  private readonly lockTtlMs: number;
  private readonly handlers = new Map<string, Set<(m: ChangeMessage) => void>>();
  /**
   * Fails commands fast once Redis is clearly gone.
   *
   * The snapshot is in memory the whole time; waiting out a connection timeout
   * on every request before reaching it is the difference between a cache
   * outage nobody notices and one that looks like a flag outage.
   */
  private readonly breaker: CircuitBreaker;

  constructor(private readonly options: RedisSnapshotStoreOptions) {
    this.breaker = new CircuitBreaker({
      ...(options.circuitFailureThreshold !== undefined
        ? { failureThreshold: options.circuitFailureThreshold }
        : {}),
      ...(options.circuitResetAfterMs !== undefined
        ? { resetAfterMs: options.circuitResetAfterMs }
        : {}),
      ...(options.onCircuitStateChange !== undefined
        ? { onStateChange: options.onCircuitStateChange }
        : {}),
    });
    this.client = new Redis(options.url, {
      ...connectionOptions(options),
      lazyConnect: false,
      // Only the command connection gets a command timeout. It bounds how long
      // a request can wait on a Redis that is up but not answering.
      commandTimeout: options.commandTimeoutMs ?? 2_000,
    });
    this.client.on("error", (error: unknown) => this.options.onError?.(error));
    this.prefix = options.keyPrefix === undefined ? "" : `${options.keyPrefix}:`;
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  /**
   * The command connection, for callers that need Redis for something other
   * than snapshots — the rate limiter's counters, and the readiness ping.
   *
   * Exposed rather than opening a third connection: a node already holds one
   * command connection and one subscriber, and connection count per node times
   * node count is a number Redis notices.
   */
  get connection(): Redis {
    return this.client;
  }

  /** Round-trips the command connection. Readiness only — never a hot path. */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  /** Whether commands are currently failing fast. Surfaced on `/health`. */
  get circuitState(): CircuitState {
    return this.breaker.current;
  }

  async get(environmentId: string): Promise<{ snapshot: Snapshot; version: number } | null> {
    // Under the breaker: this is the call every SDK request makes, and once
    // Redis is clearly gone it must fail in microseconds so the caller can
    // reach the snapshot already in its memory (§14).
    return this.breaker.run(async () => {
      const text = await this.client.get(this.key(redisKeys.snapshot(environmentId)));
      if (text === null) return null;
      const snapshot = deserializeSnapshot(text);
      return { snapshot, version: snapshot.version };
    });
  }

  async put(environmentId: string, snapshot: Snapshot): Promise<void> {
    await this.breaker.run(() => this.putUnguarded(environmentId, snapshot));
  }

  private async putUnguarded(environmentId: string, snapshot: Snapshot): Promise<void> {
    // Version and body written together: a reader that saw a new ETag but an
    // old body would serve a stale snapshot under a fresh version forever.
    await this.client
      .multi()
      .set(this.key(redisKeys.snapshot(environmentId)), serializeSnapshot(snapshot))
      .set(this.key(redisKeys.snapshotVersion(environmentId)), String(snapshot.version))
      .exec();
  }

  /**
   * Append to the capped patch history.
   *
   * **Trimming is exact, not approximate.** `MAXLEN ~` was the original choice —
   * it lets Redis trim only whole macro nodes, which is far cheaper on large
   * streams. It is wrong here, and a container-backed contract test is what
   * caught it: with `~`, a stream configured for 5 entries keeps rather more,
   * so `patchesSince` could replay from a version the memory store considers
   * long gone. The two implementations then disagree about the one thing §10.3
   * defines precisely — when a reconnect degrades to a full `put` — and they
   * disagree only under load, on one of them, in production.
   *
   * The cost argument does not apply at this size: the stream is capped at a
   * couple of hundred entries, where exact trimming is a rounding error.
   */
  async appendPatch(environmentId: string, patch: StreamPatch, depth = 200): Promise<void> {
    await this.client.xadd(
      this.key(redisKeys.patches(environmentId)),
      "MAXLEN",
      String(depth),
      "*",
      "version",
      String(patch.version),
      "op",
      patch.op,
      "flagKey",
      patch.flagKey,
      "payload",
      JSON.stringify(patch.payload),
    );
  }

  async patchesSince(
    environmentId: string,
    version: number,
    depth: number,
  ): Promise<StreamPatch[] | null> {
    const entries = await this.client.xrange(
      this.key(redisKeys.patches(environmentId)),
      "-",
      "+",
      "COUNT",
      depth,
    );
    const history: StreamPatch[] = entries.map(([, fields]) => {
      const map = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
      return {
        version: Number(map.get("version")),
        op: map.get("op") as StreamPatch["op"],
        flagKey: map.get("flagKey") ?? "",
        payload: JSON.parse(map.get("payload") ?? "null") as unknown,
      };
    });
    return resumeFrom(history, version);
  }

  /**
   * Snapshot, patches and broadcast in one `MULTI`.
   *
   * Redis executes a transaction's commands together, with nothing from another
   * client interleaved, so a subscriber cannot be woken by the `PUBLISH` and
   * then read the *previous* snapshot — which was possible when these were
   * three separate round trips, and produced a stale configuration that looked
   * fresh under a new version number.
   *
   * Note that `EXEC` failing is all-or-nothing for *queued* commands; a command
   * that fails at queue time (a syntax error, say) aborts the whole
   * transaction. Neither case leaves the three artefacts disagreeing.
   */
  async commit(
    environmentId: string,
    snapshot: Snapshot,
    patches: readonly StreamPatch[],
    message: ChangeMessage,
    depth = 200,
  ): Promise<void> {
    const transaction = this.client
      .multi()
      .set(this.key(redisKeys.snapshot(environmentId)), serializeSnapshot(snapshot))
      .set(this.key(redisKeys.snapshotVersion(environmentId)), String(snapshot.version));

    for (const patch of patches) {
      transaction.xadd(
        this.key(redisKeys.patches(environmentId)),
        "MAXLEN",
        String(depth),
        "*",
        "version",
        String(patch.version),
        "op",
        patch.op,
        "flagKey",
        patch.flagKey,
        "payload",
        JSON.stringify(patch.payload),
      );
    }

    transaction.publish(this.key(redisKeys.channel(environmentId)), JSON.stringify(message));

    const results = await this.breaker.run(() => transaction.exec());
    if (results === null) {
      // A watched key changed, or the transaction was discarded. Nothing was
      // applied, which is the point — the caller keeps its previous snapshot.
      throw new Error("featurekit: snapshot commit aborted");
    }
    for (const [error] of results) {
      if (error !== null) throw error;
    }
  }

  async publish(environmentId: string, message: ChangeMessage): Promise<void> {
    await this.breaker.run(() =>
      this.client.publish(this.key(redisKeys.channel(environmentId)), JSON.stringify(message)),
    );
  }

  async subscribe(
    environmentId: string,
    handler: (message: ChangeMessage) => void,
  ): Promise<() => Promise<void>> {
    // A connection in subscriber mode cannot issue ordinary commands, so this
    // is a second connection — opened lazily, since a worker-only node never
    // subscribes at all.
    if (this.subscriber === null) {
      // The subscriber gets NO command timeout — not zero, absent. It issues
      // `SUBSCRIBE` and then sits idle for hours by design, so a timeout tears
      // down exactly the connection that is supposed to stay open. (ioredis
      // treats `0` as "time out immediately", not as "no timeout".)
      this.subscriber = new Redis(this.options.url, connectionOptions(this.options));
      this.subscriber.on("error", (error: unknown) => this.options.onError?.(error));
      this.subscriber.on("message", (channel: string, payload: string) => {
        for (const h of this.handlers.get(channel) ?? []) {
          h(JSON.parse(payload) as ChangeMessage);
        }
      });
    }

    const channel = this.key(redisKeys.channel(environmentId));
    const set = this.handlers.get(channel) ?? new Set();
    const isFirst = set.size === 0;
    set.add(handler);
    this.handlers.set(channel, set);
    if (isFirst) await this.subscriber.subscribe(channel);

    return async () => {
      set.delete(handler);
      // Only leave the channel once nothing on this node still wants it.
      if (set.size === 0) {
        this.handlers.delete(channel);
        await this.subscriber?.unsubscribe(channel);
      }
    };
  }

  async withCompileLock<T>(environmentId: string, work: () => Promise<T>): Promise<T | undefined> {
    const lockKey = this.key(redisKeys.compileLock(environmentId));
    const token = `${process.pid}-${Date.now()}-${Math.random()}`;
    const acquired = await this.client.set(lockKey, token, "PX", this.lockTtlMs, "NX");
    // A second compile of the same version is waste, not a queue. The node that
    // skipped receives the result over pub/sub like everyone else.
    if (acquired === null) return undefined;

    try {
      return await work();
    } finally {
      // Compare-and-delete: without the token check, a compile that overran the
      // TTL would delete a lock another node had since acquired.
      await this.client.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        lockKey,
        token,
      );
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.client.quit(), this.subscriber?.quit()].filter(Boolean));
  }
}
