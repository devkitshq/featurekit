/**
 * Where a client-tier connection lives.
 *
 * **The bug this exists to fix.** The client tier is two requests: a browser
 * POSTs `/v1/client/state` with its context and gets back a connection handle,
 * then opens `GET /v1/client/stream` with that handle. Those are two separate
 * HTTP requests, and behind any ordinary load balancer they land on two
 * *different* nodes. With the connection held in a per-process `Map`, the second
 * node has never heard of the handle and answers `409 UNKNOWN_CONNECTION` —
 * every time, for every browser, on any deployment with more than one node.
 * The single-node case worked perfectly, which is exactly why this survived.
 *
 * `fk:cctx:{connectionId}` was reserved for this in the §8 key map from the
 * start ("Client-tier connection → context. Rebuild: client re-identifies").
 * This is the code that finally uses it.
 *
 * **Redis is still not authoritative here.** Every node keeps its own in-memory
 * copy and consults it first — a stream is served by the node holding the
 * socket, so the local copy is the hot path and Redis is only consulted on a
 * miss. If Redis is unavailable the tier degrades to exactly its old behaviour:
 * single-node correct, and a browser whose two requests split across nodes
 * re-identifies. That is a worse experience, not a wrong answer.
 *
 * **The handle is a 256-bit random value, not a uuid.** It is a bearer token
 * for one browser's own flag values, so it must not be guessable; `randomUUID`
 * gives 122 bits with a recognisable shape, and there is no reason to spend
 * less entropy here.
 */

import { randomBytes } from "node:crypto";
import type { EvaluationContext } from "../sdk/index.js";

/** What a second node needs in order to take over serving a connection. */
export interface StoredConnection {
  environmentId: string;
  context: EvaluationContext;
  /** So a takeover does not re-send values the browser already has. */
  lastSentVersion: number;
}

export interface ClientConnectionStore {
  save(id: string, record: StoredConnection, ttlSeconds: number): Promise<void>;
  load(id: string): Promise<StoredConnection | null>;
  /** Extend the lease without rewriting the record. */
  touch(id: string, ttlSeconds: number): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * A connection handle.
 *
 * 32 bytes of entropy, url-safe, so it can travel in a query string — which is
 * where it has to travel, because `EventSource` cannot set headers.
 */
export function newConnectionId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * In-process store.
 *
 * Correct for a single-node deployment, and the fixture the Redis
 * implementation is held against. Entries expire, because a browser that closes
 * without a clean disconnect must not pin its context in memory forever — that
 * is the §14 unbounded-Map failure in miniature.
 */
export class MemoryClientConnectionStore implements ClientConnectionStore {
  private readonly entries = new Map<string, { record: StoredConnection; expiresAt: number }>();

  constructor(
    private readonly options: { maxEntries?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  save(id: string, record: StoredConnection, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= (this.options.maxEntries ?? 100_000)) this.evictExpired();
    this.entries.set(id, { record, expiresAt: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  load(id: string): Promise<StoredConnection | null> {
    const entry = this.entries.get(id);
    if (entry === undefined) return Promise.resolve(null);
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.record);
  }

  touch(id: string, ttlSeconds: number): Promise<void> {
    const entry = this.entries.get(id);
    if (entry !== undefined) entry.expiresAt = this.now() + ttlSeconds * 1000;
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.entries.delete(id);
    return Promise.resolve();
  }

  get size(): number {
    return this.entries.size;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
    // Still full: drop the oldest half rather than growing without bound. A
    // dropped connection re-identifies; an unbounded Map takes the node.
    if (this.entries.size >= (this.options.maxEntries ?? 100_000)) {
      let dropped = 0;
      const target = Math.floor(this.entries.size / 2);
      for (const id of this.entries.keys()) {
        this.entries.delete(id);
        if (++dropped >= target) break;
      }
    }
  }
}

/**
 * A store that never remembers anything.
 *
 * For a deployment that has deliberately chosen sticky routing and does not want
 * connection contexts in Redis at all. Behaviour is identical to the original
 * per-process registry, and choosing it is an explicit decision rather than an
 * accident of not configuring anything.
 */
export class NullClientConnectionStore implements ClientConnectionStore {
  save(): Promise<void> {
    return Promise.resolve();
  }
  load(): Promise<StoredConnection | null> {
    return Promise.resolve(null);
  }
  touch(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
}
