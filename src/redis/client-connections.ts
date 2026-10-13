/**
 * The Redis `ClientConnectionStore`.
 *
 * One key per connection, `fk:cctx:{connectionId}`, holding the context a
 * second node needs to take over the stream. Every entry has a TTL: this is
 * the one place in the system where an untrusted caller can create keys, so
 * unbounded retention would be a memory-growth primitive pointed at Redis
 * rather than at the node.
 *
 * **Every method fails soft.** A connection store that throws would turn a
 * Redis blip into a 500 on `POST /v1/client/state`, which is the request that
 * hands a browser its flag values. Losing the shared copy costs a browser a
 * re-identify when its two requests split across nodes; failing the request
 * costs it every flag. The caller therefore gets `null` on a read failure and a
 * silent no-op on a write failure, and the local in-memory copy carries the
 * single-node case regardless.
 */

import type { Redis } from "ioredis";
import { redisKeys } from "./keys.js";
import type { ClientConnectionStore, StoredConnection } from "../client-tier/connection-store.js";

export interface RedisClientConnectionStoreOptions {
  keyPrefix?: string;
  onError?: (error: unknown) => void;
  /** Rejects a stored record larger than this. Contexts are capped upstream. */
  maxBytes?: number;
}

export class RedisClientConnectionStore implements ClientConnectionStore {
  private readonly prefix: string;
  private readonly maxBytes: number;

  constructor(
    private readonly client: Redis,
    private readonly options: RedisClientConnectionStoreOptions = {},
  ) {
    this.prefix = options.keyPrefix === undefined ? "" : `${options.keyPrefix}:`;
    this.maxBytes = options.maxBytes ?? 128 * 1024;
  }

  private key(id: string): string {
    return `${this.prefix}${redisKeys.clientContext(id)}`;
  }

  async save(id: string, record: StoredConnection, ttlSeconds: number): Promise<void> {
    try {
      const payload = JSON.stringify(record);
      // The client tier already caps context size; this is the backstop
      // for a cap that gets loosened later without anyone thinking about Redis.
      if (Buffer.byteLength(payload) > this.maxBytes) return;
      await this.client.set(this.key(id), payload, "EX", ttlSeconds);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  async load(id: string): Promise<StoredConnection | null> {
    try {
      const raw = await this.client.get(this.key(id));
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as StoredConnection;
      // A record that does not look like one is treated as absent: the browser
      // re-identifies, which is always a safe outcome here.
      if (typeof parsed?.environmentId !== "string" || parsed.context === undefined) return null;
      return parsed;
    } catch (error) {
      this.options.onError?.(error);
      return null;
    }
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.expire(this.key(id), ttlSeconds);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.client.del(this.key(id));
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
