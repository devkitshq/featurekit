import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://featurekit:featurekit@localhost:5432/featurekit",
  },
  // `evaluation_summaries` is created by a hand-written partitioned migration
  // (§7.9); drizzle-kit cannot emit `PARTITION BY` and would generate a plain
  // table that silently shadows it.
  // The UNLOGGED cache tables in 0005 are hand-written for the same reason:
  // drizzle-kit cannot express UNLOGGED either.
  tablesFilter: [
    "!evaluation_summaries",
    "!snapshot_cache",
    "!snapshot_patches",
    "!client_connections",
    "!compile_locks",
  ],
  // Generated SQL qualifies foreign keys and enum types with "public".; strip
  // those before committing. Migrations must stay schema-neutral so that
  // DATABASE_SCHEMA works, and tests/config/migrations.test.ts enforces it.
});
