/**
 * The client tier's shared connection records, in Postgres.
 *
 * A browser's `POST /v1/client/state` and its stream can land on different
 * nodes; this table is how the second node finds the context the first one
 * issued the handle for. Each node still checks its own memory first, so this
 * is read only on a miss.
 *
 * Every failure is reported and swallowed: a record that cannot be saved or
 * found means the browser re-identifies, which is slower but never wrong.
 * `client_connections` is UNLOGGED (see `drizzle/0005_postgres_only.sql`), so a
 * crash empties it with the same outcome.
 */

import type { Sql } from "postgres";
import type { ClientConnectionStore, StoredConnection } from "./connection-store.js";

export interface PostgresClientConnectionStoreOptions {
  onError?: (error: unknown) => void;
  /** Rejects a stored record larger than this. Contexts are capped upstream. */
  maxBytes?: number;
  /**
   * Share of saves that also delete expired records. Expired rows are never
   * served either way; this only keeps the table from growing.
   */
  sweepProbability?: number;
}

export class PostgresClientConnectionStore implements ClientConnectionStore {
  private readonly maxBytes: number;

  constructor(
    private readonly sql: Sql,
    private readonly options: PostgresClientConnectionStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 128 * 1024;
  }

  async save(id: string, record: StoredConnection, ttlSeconds: number): Promise<void> {
    try {
      const payload = JSON.stringify(record);
      // The client tier already caps context size; this is the backstop
      // for a cap that gets loosened later without anyone thinking about it.
      if (Buffer.byteLength(payload) > this.maxBytes) return;
      await this.sql`
        insert into client_connections (id, record, expires_at)
        values (${id}, ${payload}, now() + make_interval(secs => ${ttlSeconds}))
        on conflict (id) do update set record = excluded.record, expires_at = excluded.expires_at`;
      if (Math.random() < (this.options.sweepProbability ?? 0.01)) {
        await this.sql`delete from client_connections where expires_at < now()`;
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  async load(id: string): Promise<StoredConnection | null> {
    try {
      const rows = await this.sql<Array<{ record: string }>>`
        select record from client_connections where id = ${id} and expires_at > now()`;
      const raw = rows[0]?.record;
      if (raw === undefined) return null;
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
      await this.sql`
        update client_connections set expires_at = now() + make_interval(secs => ${ttlSeconds})
         where id = ${id}`;
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.sql`delete from client_connections where id = ${id}`;
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
