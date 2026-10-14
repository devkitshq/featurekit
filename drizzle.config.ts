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
  tablesFilter: ["!evaluation_summaries"],
  // Generated SQL qualifies foreign keys and enum types with "public".; strip
  // those before committing. Migrations must stay schema-neutral so that
  // DATABASE_SCHEMA works, and tests/config/migrations.test.ts enforces it.
});
