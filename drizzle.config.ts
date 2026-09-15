import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://featkit:featkit@localhost:5432/featkit",
  },
  // `evaluation_summaries` is created by a hand-written partitioned migration
  // (§7.9); drizzle-kit cannot emit `PARTITION BY` and would generate a plain
  // table that silently shadows it.
  tablesFilter: ["!evaluation_summaries"],
});
