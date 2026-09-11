/**
 * Postgres connection and migration.
 *
 * Postgres is truth (§8). Everything in Redis is a cache or a bus and is
 * rebuildable from here.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { schema } from "./schema.js";

export type Database = ReturnType<typeof createDatabase>["db"];

export interface DatabaseOptions {
  url: string;
  maxConnections?: number;
  /** `onnotice` is noisy in tests; the migration raises deliberate warnings. */
  onNotice?: (notice: unknown) => void;
}

export function createDatabase(options: DatabaseOptions) {
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 10,
    onnotice: options.onNotice ?? (() => {}),
    // The compiler reads whole tables; a per-statement prepare buys nothing and
    // breaks pgbouncer in transaction mode.
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: async () => sql.end({ timeout: 5 }) };
}

/**
 * Apply migrations, including the hand-written partitioned DDL (§7.9).
 *
 * `autoMigrate` is a development convenience. In production this is normally a
 * deliberate deploy step, because a migration that runs concurrently on every
 * booting node is a lock convoy.
 */
export async function runMigrations(db: Database, migrationsFolder = "./drizzle"): Promise<void> {
  await migrate(db, { migrationsFolder });
}
