/**
 * Postgres connection and migration.
 *
 * Postgres is truth. Everything in Redis is a cache or a bus and is
 * rebuildable from here.
 *
 * **Schema.** Every table, type and function lives in one schema, `public`
 * unless configured otherwise. It is applied as the connection's `search_path`
 * rather than written into each query, so the table definitions and the raw SQL
 * stay schema-neutral, and nothing outside that one schema is on the path — a
 * table missing from it is an error, never a silent read from `public`.
 */

import { sql as sqlTag } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { schema as tables } from "./schema.js";
import { DEFAULT_SCHEMA, isValidSchemaName } from "./schema-name.js";

export { DEFAULT_SCHEMA, isValidSchemaName };

export type Database = ReturnType<typeof createDatabase>["db"];

export interface DatabaseOptions {
  url: string;
  /** Defaults to `public`. */
  schema?: string;
  maxConnections?: number;
  /** `onnotice` is noisy in tests; the migration raises deliberate warnings. */
  onNotice?: (notice: unknown) => void;
}

export function createDatabase(options: DatabaseOptions) {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!isValidSchemaName(schema)) {
    throw new Error(
      `featurekit: invalid database schema ${JSON.stringify(schema)} — use a lowercase ` +
        `identifier (letters, digits, underscores), not starting with pg_`,
    );
  }
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 10,
    onnotice: options.onNotice ?? (() => {}),
    // The compiler reads whole tables; a per-statement prepare buys nothing and
    // breaks pgbouncer in transaction mode.
    prepare: false,
    connection: { search_path: schema },
  });
  const db = drizzle(sql, { schema: tables });
  return { db, sql, schema, close: async () => sql.end({ timeout: 5 }) };
}

export type SchemaState =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "unmigrated" }
  | { state: "mismatch"; current: string };

/**
 * Whether connections really landed in `schema`, and whether it is migrated.
 *
 * The `search_path` travels as a startup parameter, and a pooler can drop it:
 * pgbouncer, for one, refuses or ignores startup parameters it does not track.
 * The symptom would be every query failing with "relation does not exist", or,
 * worse, succeeding against the wrong schema.
 */
export async function inspectSchema(db: Database, schema: string): Promise<SchemaState> {
  const rows = (await db.execute(
    sqlTag`select current_schema() as current, to_regclass('flags') is not null as migrated`,
  )) as unknown as Array<{ current: string | null; migrated: boolean }>;
  const row = rows[0];
  if (row?.current === null || row?.current === undefined) return { state: "missing" };
  if (row.current !== schema) return { state: "mismatch", current: row.current };
  return row.migrated ? { state: "ok" } : { state: "unmigrated" };
}

/** `inspectSchema`, as an error that names the cause and the fix. */
export async function verifySchema(db: Database, schema: string): Promise<void> {
  const found = await inspectSchema(db, schema);
  switch (found.state) {
    case "ok":
      return;
    case "missing":
      throw new Error(`featurekit: database schema "${schema}" does not exist — run migrations first`);
    case "unmigrated":
      throw new Error(`featurekit: database schema "${schema}" has not been migrated — run migrations first`);
    case "mismatch":
      throw new Error(
        `featurekit: connections are using schema "${found.current}", not "${schema}". ` +
          `A connection pooler may be dropping search_path; set it on the role instead: ` +
          `ALTER ROLE <user> SET search_path = ${schema}`,
      );
  }
}

/**
 * Apply migrations, including the hand-written partitioned DDL.
 *
 * Creates the schema if it does not exist, and keeps Drizzle's own bookkeeping
 * table in it too, so one schema holds everything featurekit owns.
 *
 * `autoMigrate` is a development convenience. In production this is normally a
 * deliberate deploy step, because a migration that runs concurrently on every
 * booting node is a lock convoy.
 */
export async function runMigrations(
  db: Database,
  migrationsFolder = "./drizzle",
  schema: string = DEFAULT_SCHEMA,
): Promise<void> {
  await db.execute(sqlTag`create schema if not exists ${sqlTag.identifier(schema)}`);
  await migrate(db, { migrationsFolder, migrationsSchema: schema });
}
