/**
 * Installing into a schema other than `public`.
 *
 * Everything featurekit owns — tables, enum types, functions, partitions and
 * Drizzle's migration history — must land in the configured schema, and two
 * installs in different schemas of one database must not see each other.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, verifySchema, type Database } from "../../src/db/client.js";
import { migrate, migrationStatus } from "../../src/migrate.js";
import { applyFlagFile, type FlagFile } from "../../src/provisioning.js";

const reason = await containerUnavailableReason();

describe("custom schema prerequisites", () => {
  it(reason === null ? "container runtime is available" : `custom schema tests SKIPPED — ${reason}`, () => {
    if (reason !== null) announceSkip(reason);
    expect(true).toBe(true);
  });
});

const FLAGS: FlagFile = {
  project: { key: "acme", name: "Acme" },
  environment: { key: "development", name: "Development", isProduction: false },
  flags: [
    {
      key: "new-checkout",
      name: "New checkout",
      kind: "boolean",
      variations: [
        { name: "off", value: false },
        { name: "on", value: true },
      ],
      config: { enabled: true, offVariation: "off", fallthroughVariation: "on" },
    },
  ],
};

async function rows<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

describe.skipIf(reason !== null)("a custom database schema", () => {
  let databaseUrl: string;
  let stop: () => Promise<void>;
  let admin: Database;
  let closeAdmin: () => Promise<void>;

  beforeAll(async () => {
    const infrastructure = await startInfrastructure();
    databaseUrl = infrastructure.databaseUrl;
    stop = infrastructure.stop;
    ({ db: admin, close: closeAdmin } = createDatabase({ url: databaseUrl, maxConnections: 2 }));
    await migrate({ databaseUrl, schema: "flags_a" });
    await migrate({ databaseUrl, schema: "flags_b" });
  }, 180_000);

  afterAll(async () => {
    await closeAdmin?.();
    await stop?.();
  });

  it("puts every table, type and function in that schema and nothing in public", async () => {
    const owned = await rows<{ schema: string; count: number }>(
      admin,
      sql`select n.nspname as schema, count(*)::int as count
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r', 'p') and n.nspname in ('public', 'flags_a')
           group by n.nspname`,
    );
    expect(owned.find((r) => r.schema === "public")).toBeUndefined();
    expect(owned.find((r) => r.schema === "flags_a")?.count).toBeGreaterThan(20);

    const types = await rows<{ schema: string }>(
      admin,
      sql`select n.nspname as schema from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where t.typname = 'flag_kind'`,
    );
    expect(types.map((t) => t.schema).sort()).toEqual(["flags_a", "flags_b"]);

    const functions = await rows<{ schema: string }>(
      admin,
      sql`select n.nspname as schema from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.proname = 'featurekit_ensure_partitions'`,
    );
    expect(functions.map((f) => f.schema).sort()).toEqual(["flags_a", "flags_b"]);
  });

  it("keeps Drizzle's migration history in the same schema", async () => {
    const tables = await rows<{ schema: string }>(
      admin,
      sql`select table_schema as schema from information_schema.tables
           where table_name = '__drizzle_migrations'`,
    );
    expect(tables.map((t) => t.schema).sort()).toEqual(["flags_a", "flags_b"]);

    const status = await migrationStatus({ databaseUrl, schema: "flags_a" });
    expect(status.applied).toBeGreaterThan(0);
    expect(status.partitionRunwayDays).toBeGreaterThan(0);
  });

  it("creates each install's partitions in its own schema", async () => {
    const partitions = await rows<{ schema: string; count: number }>(
      admin,
      sql`select n.nspname as schema, count(*)::int as count
            from pg_inherits i
            join pg_class c on c.oid = i.inhrelid
            join pg_namespace n on n.oid = c.relnamespace
            join pg_class p on p.oid = i.inhparent
           where p.relname = 'evaluation_summaries'
           group by n.nspname`,
    );
    expect(partitions.find((p) => p.schema === "flags_a")?.count).toBeGreaterThan(0);
    expect(partitions.find((p) => p.schema === "flags_b")?.count).toBeGreaterThan(0);
  });

  it("reads and writes only its own schema", async () => {
    const a = createDatabase({ url: databaseUrl, schema: "flags_a", maxConnections: 1 });
    const b = createDatabase({ url: databaseUrl, schema: "flags_b", maxConnections: 1 });
    try {
      await applyFlagFile(a.db, FLAGS, { reset: false });
      const inA = await rows<{ count: number }>(a.db, sql`select count(*)::int as count from flags`);
      const inB = await rows<{ count: number }>(b.db, sql`select count(*)::int as count from flags`);
      expect(inA[0]?.count).toBe(1);
      expect(inB[0]?.count).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("passes verification in a migrated schema", async () => {
    const a = createDatabase({ url: databaseUrl, schema: "flags_a", maxConnections: 1 });
    try {
      await expect(verifySchema(a.db, "flags_a")).resolves.toBeUndefined();
    } finally {
      await a.close();
    }
  });

  it("refuses a schema that does not exist rather than failing on a missing table", async () => {
    const missing = createDatabase({ url: databaseUrl, schema: "flags_missing", maxConnections: 1 });
    try {
      await expect(verifySchema(missing.db, "flags_missing")).rejects.toThrow(/does not exist/);
    } finally {
      await missing.close();
    }
  });

  it("refuses a schema that exists but has not been migrated", async () => {
    await admin.execute(sql`create schema if not exists flags_empty`);
    const empty = createDatabase({ url: databaseUrl, schema: "flags_empty", maxConnections: 1 });
    try {
      await expect(verifySchema(empty.db, "flags_empty")).rejects.toThrow(/not been migrated/);
    } finally {
      await empty.close();
    }
  });

  it("rejects a schema name that would need quoting", () => {
    expect(() => createDatabase({ url: databaseUrl, schema: "Flags-A" })).toThrow(/invalid database schema/);
  });
});
