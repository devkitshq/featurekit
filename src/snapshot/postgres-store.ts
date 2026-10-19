/**
 * `SnapshotStore` on Postgres alone.
 *
 * Postgres was already the truth; this makes it the cache and the bus as well,
 * so a deployment is one database and the control plane, with nothing else to
 * run, back up, or lose.
 *
 * - **Snapshots and patch history** live in UNLOGGED tables (see
 *   `drizzle/0005_postgres_only.sql`). Every node reads through its own memory;
 *   an SDK request does not touch the database while the cache is current.
 * - **Change delivery is LISTEN/NOTIFY.** `commit` writes the snapshot, the
 *   patches and a `pg_notify` in one transaction, and Postgres delivers a
 *   notification only when its transaction commits — so no node can be woken
 *   for a version it cannot yet read. That is the property a Redis
 *   `MULTI` existed to provide, here for free.
 * - **The compile lock is a lease row** with an expiry: it works through a
 *   transaction-mode pooler, where a session advisory lock would not, and a
 *   holder that dies cannot keep it.
 *
 * **Why the cache cannot trust notifications alone.** A notification reaches a
 * node only while its LISTEN connection is up. postgres.js reconnects that
 * connection and this store resynchronises when it does, but a silently dead
 * socket can go unnoticed for a while. So a cached snapshot is re-validated —
 * a primary-key read of one integer — at most every `revalidateMs`, which
 * bounds how stale a node can be whatever happens to its listener.
 *
 * One channel per database, shared by every install in it: each payload names
 * its schema, and other schemas' notifications are ignored. Any role can send
 * on it, so a payload is only a prompt to re-read: see `onNotification`.
 */

import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { Snapshot } from "../sdk/index.js";
import { resumeFrom } from "./memory-store.js";
import {
  deserializeSnapshot,
  serializeSnapshot,
  type ChangeMessage,
  type SnapshotStore,
  type StreamPatch,
} from "./store.js";

/** The NOTIFY channel. Payloads carry the schema, so installs can share a database. */
export const CHANGE_CHANNEL = "featurekit_changes";

export interface PostgresSnapshotStoreOptions {
  /** Queries run on this pool. Its `search_path` selects the schema. */
  sql: Sql;
  /** The schema this install lives in; notifications for any other are ignored. */
  schema: string;
  /**
   * A separate pool for LISTEN. LISTEN needs a session that stays put, which a
   * transaction-mode pooler cannot give; point this straight at Postgres when
   * `sql` goes through one. Defaults to `sql`.
   */
  listenSql?: Sql;
  /** How long a cached snapshot is served before its version is re-checked. */
  revalidateMs?: number;
  /** Lease length for the compile lock; a holder that dies frees it after this. */
  lockTtlMs?: number;
  onError?: (error: unknown) => void;
  now?: () => number;
}

interface Notification {
  /** Schema. */
  s: string;
  /** Environment id. */
  e: string;
  /** Version. */
  v: number;
  /** Flag key, for a targeted change. */
  f?: string;
}

interface CachedText {
  text: string;
  version: number;
  checkedAt: number;
}

export class PostgresSnapshotStore implements SnapshotStore {
  private readonly cache = new Map<string, CachedText>();
  private readonly handlers = new Map<string, Set<(message: ChangeMessage) => void>>();
  /** Highest version announced per environment, so a slow read cannot cache an older row. */
  private readonly announced = new Map<string, number>();
  /** Environments with a notification being checked: null, or the hint that arrived meanwhile. */
  private readonly verifying = new Map<string, { version: number; flagKey: string | undefined } | null>();
  private listening: Promise<void> | null = null;
  private unlisten: (() => Promise<void>) | null = null;
  private listenerConnects = 0;
  private closed = false;

  constructor(private readonly options: PostgresSnapshotStoreOptions) {}

  private get sql(): Sql {
    return this.options.sql;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /* ── snapshots ──────────────────────────────────────────────────────── */

  async get(environmentId: string): Promise<{ snapshot: Snapshot; version: number } | null> {
    this.ensureListening();

    const cached = this.cache.get(environmentId);
    if (cached !== undefined) {
      if (this.now() - cached.checkedAt < (this.options.revalidateMs ?? 10_000)) {
        return { snapshot: deserializeSnapshot(cached.text), version: cached.version };
      }
      const current = await this.sql<Array<{ version: number }>>`
        select version from snapshot_cache where environment_id = ${environmentId}`;
      if (current[0]?.version === cached.version) {
        cached.checkedAt = this.now();
        return { snapshot: deserializeSnapshot(cached.text), version: cached.version };
      }
      this.cache.delete(environmentId);
    }

    const rows = await this.sql<Array<{ version: number; body: string }>>`
      select version, body from snapshot_cache where environment_id = ${environmentId}`;
    const row = rows[0];
    if (row === undefined) return null;
    this.remember(environmentId, row.body, row.version);
    return { snapshot: deserializeSnapshot(row.body), version: row.version };
  }

  async put(environmentId: string, snapshot: Snapshot): Promise<void> {
    const body = serializeSnapshot(snapshot);
    await this.sql`
      insert into snapshot_cache (environment_id, version, body)
      values (${environmentId}, ${snapshot.version}, ${body})
      on conflict (environment_id) do update
        set version = excluded.version, body = excluded.body, updated_at = now()`;
    this.remember(environmentId, body, snapshot.version, true);
  }

  /* ── patch history ──────────────────────────────────────────────────── */

  async appendPatch(environmentId: string, patch: StreamPatch, depth = 200): Promise<void> {
    await this.sql.begin(async (tx) => {
      await insertPatches(tx, environmentId, [patch], depth);
    });
  }

  async patchesSince(
    environmentId: string,
    version: number,
    depth: number,
  ): Promise<StreamPatch[] | null> {
    const rows = await this.sql<
      Array<{ version: number; op: StreamPatch["op"]; flag_key: string; payload: string }>
    >`
      select version, op, flag_key, payload from snapshot_patches
       where environment_id = ${environmentId}
       order by id desc
       limit ${depth}`;
    const history: StreamPatch[] = rows.reverse().map((row) => ({
      version: row.version,
      op: row.op,
      flagKey: row.flag_key,
      payload: JSON.parse(row.payload) as unknown,
    }));
    return resumeFrom(history, version);
  }

  /* ── change delivery ────────────────────────────────────────────────── */

  async publish(environmentId: string, message: ChangeMessage): Promise<void> {
    await this.sql`select pg_notify(${CHANGE_CHANNEL}, ${this.payload(environmentId, message)})`;
  }

  /**
   * Snapshot, patches and notification in one transaction.
   *
   * NOTIFY is transactional: nobody hears it until the snapshot it announces is
   * committed and readable, and if anything here fails nobody hears it at all.
   */
  async commit(
    environmentId: string,
    snapshot: Snapshot,
    patches: readonly StreamPatch[],
    message: ChangeMessage,
    depth = 200,
  ): Promise<void> {
    const body = serializeSnapshot(snapshot);
    await this.sql.begin(async (tx) => {
      await tx`
        insert into snapshot_cache (environment_id, version, body)
        values (${environmentId}, ${snapshot.version}, ${body})
        on conflict (environment_id) do update
          set version = excluded.version, body = excluded.body, updated_at = now()`;
      await insertPatches(tx, environmentId, patches, depth);
      await tx`select pg_notify(${CHANGE_CHANNEL}, ${this.payload(environmentId, message)})`;
    });
    this.remember(environmentId, body, snapshot.version, true);
  }

  async subscribe(
    environmentId: string,
    handler: (message: ChangeMessage) => void,
  ): Promise<() => Promise<void>> {
    const set = this.handlers.get(environmentId) ?? new Set();
    set.add(handler);
    this.handlers.set(environmentId, set);
    await this.ensureListening();
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(environmentId);
      return Promise.resolve();
    };
  }

  /* ── compile lock ───────────────────────────────────────────────────── */

  async withCompileLock<T>(environmentId: string, work: () => Promise<T>): Promise<T | undefined> {
    const token = randomUUID();
    const seconds = (this.options.lockTtlMs ?? 30_000) / 1000;
    // Taken if absent, or if the previous holder's lease has run out.
    const acquired = await this.sql`
      insert into compile_locks (environment_id, token, expires_at)
      values (${environmentId}, ${token}, now() + make_interval(secs => ${seconds}))
      on conflict (environment_id) do update
        set token = excluded.token, expires_at = excluded.expires_at
        where compile_locks.expires_at < now()
      returning token`;
    // A second compile of the same change is waste, not a queue. The node that
    // skipped hears the result over NOTIFY like everyone else.
    if (acquired.length === 0) return undefined;

    try {
      return await work();
    } finally {
      // By token: a compile that overran its lease must not release a lock
      // another node has since taken.
      await this.sql`
        delete from compile_locks where environment_id = ${environmentId} and token = ${token}`.catch(
        (error: unknown) => this.options.onError?.(error),
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.unlisten?.().catch(() => undefined);
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  private payload(environmentId: string, message: ChangeMessage): string {
    const notification: Notification = {
      s: this.options.schema,
      e: environmentId,
      v: message.version,
      ...(message.flagKey !== undefined ? { f: message.flagKey } : {}),
    };
    return JSON.stringify(notification);
  }

  /** Cache a row unless a newer version has already been announced or cached. */
  private remember(environmentId: string, text: string, version: number, own = false): void {
    if (!own && version < (this.announced.get(environmentId) ?? 0)) return;
    const existing = this.cache.get(environmentId);
    if (existing !== undefined && existing.version > version) return;
    this.cache.set(environmentId, { text, version, checkedAt: this.now() });
  }

  /**
   * Start listening, once. Failure is reported and retried on the next call:
   * without a listener the cache still revalidates on its timer, it just stops
   * hearing changes the moment they happen.
   */
  private ensureListening(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.listening !== null) return this.listening;
    const listener = this.options.listenSql ?? this.options.sql;
    this.listening = listener
      .listen(
        CHANGE_CHANNEL,
        (payload) => this.onNotification(payload),
        () => this.onListen(),
      )
      .then((meta) => {
        this.unlisten = () => meta.unlisten();
        if (this.closed) void meta.unlisten();
      })
      .catch((error: unknown) => {
        this.listening = null;
        this.options.onError?.(error);
      });
    return this.listening;
  }

  /**
   * A notification is a hint, never the truth.
   *
   * NOTIFY is not authenticated: any role connected to the database can send
   * on this channel. So nothing in a payload is acted on as given. The version
   * delivered is the one `snapshot_cache` holds, and the flag key survives only
   * when `snapshot_patches` records that key at that version — a forged key
   * would otherwise make the client tier re-evaluate the wrong flag and mark
   * itself current, skipping the real change for good. A forged message can at
   * most cause one primary-key read, and only for an environment this node is
   * already holding.
   */
  private onNotification(raw: string): void {
    let notification: Notification;
    try {
      notification = JSON.parse(raw) as Notification;
    } catch {
      return;
    }
    if (notification.s !== this.options.schema || typeof notification.e !== "string") return;
    if (!Number.isSafeInteger(notification.v) || notification.v <= 0) return;
    const environmentId = notification.e;
    // Anything else would be a query per forged environment id.
    if (!this.handlers.has(environmentId) && !this.cache.has(environmentId)) return;
    if (notification.v <= (this.announced.get(environmentId) ?? 0)) return;
    this.verify(environmentId, notification.v, typeof notification.f === "string" ? notification.f : undefined);
  }

  /** One read in flight per environment; hints arriving meanwhile fold into one more. */
  private verify(environmentId: string, version: number, flagKey: string | undefined): void {
    if (this.verifying.has(environmentId)) {
      const pending = this.verifying.get(environmentId);
      this.verifying.set(environmentId, {
        version: Math.max(version, pending?.version ?? 0),
        // Two changes folded into one check: a single flag key cannot describe both.
        flagKey: pending === null || pending === undefined ? flagKey : undefined,
      });
      return;
    }
    this.verifying.set(environmentId, null);
    void this.confirm(environmentId, version, flagKey)
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        const pending = this.verifying.get(environmentId);
        this.verifying.delete(environmentId);
        if (pending != null && pending.version > (this.announced.get(environmentId) ?? 0)) {
          this.verify(environmentId, pending.version, pending.flagKey);
        }
      });
  }

  private async confirm(environmentId: string, hinted: number, flagKey: string | undefined): Promise<void> {
    const rows = await this.sql<Array<{ version: number; confirmed: boolean }>>`
      select c.version,
             exists (select 1 from snapshot_patches p
                      where p.environment_id = c.environment_id
                        and p.version = ${hinted}
                        and p.flag_key = ${flagKey ?? ""}) as confirmed
        from snapshot_cache c
       where c.environment_id = ${environmentId}`;
    const row = rows[0];
    if (row === undefined) return;
    // Past the hinted version, more than this one flag may have changed.
    const keep = flagKey !== undefined && row.confirmed && row.version === hinted;
    this.announce(environmentId, row.version, keep ? flagKey : undefined);
  }

  /** Deliver a version read from the database to this environment's subscribers. */
  private announce(environmentId: string, version: number, flagKey: string | undefined): void {
    if (version <= (this.announced.get(environmentId) ?? 0)) return;
    this.announced.set(environmentId, version);
    const cached = this.cache.get(environmentId);
    if (cached !== undefined && version > cached.version) this.cache.delete(environmentId);

    const message: ChangeMessage = { version, ...(flagKey !== undefined ? { flagKey } : {}) };
    for (const handler of this.handlers.get(environmentId) ?? []) handler(message);
  }

  /**
   * Called on the first LISTEN and again on every reconnect. Anything announced
   * while the connection was down was missed, so drop the cache and tell each
   * subscribed environment about any version newer than the last it heard.
   */
  private onListen(): void {
    if (this.listenerConnects++ === 0) return;
    this.cache.clear();
    const environments = [...this.handlers.keys()];
    if (environments.length === 0) return;
    void this.sql<Array<{ environment_id: string; version: number }>>`
      select environment_id, version from snapshot_cache
       where environment_id in ${this.sql(environments)}`
      .then((rows) => {
        // Read from the database, so announced directly rather than re-verified.
        for (const row of rows) this.announce(row.environment_id, row.version, undefined);
      })
      .catch((error: unknown) => this.options.onError?.(error));
  }
}

/** Append patches and trim the environment's history to `depth`, in one transaction. */
async function insertPatches(
  tx: TransactionSql,
  environmentId: string,
  patches: readonly StreamPatch[],
  depth: number,
): Promise<void> {
  if (patches.length === 0) return;
  for (const patch of patches) {
    await tx`
      insert into snapshot_patches (environment_id, version, op, flag_key, payload)
      values (${environmentId}, ${patch.version}, ${patch.op}, ${patch.flagKey}, ${JSON.stringify(patch.payload)})`;
  }
  await tx`
    delete from snapshot_patches
     where environment_id = ${environmentId}
       and id <= (select id from snapshot_patches
                   where environment_id = ${environmentId}
                   order by id desc offset ${depth} limit 1)`;
}
