/**
 * Migrations must not name a schema.
 *
 * featurekit installs into whatever schema `DATABASE_SCHEMA` names, applied as
 * the connection's search_path. drizzle-kit writes `"public".` into generated
 * foreign keys and enum types; one of those left in a migration silently puts
 * part of a custom-schema install in `public`. Strip them after generating.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "drizzle");

describe("migrations", () => {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));

  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s does not hardcode the public schema", (file) => {
    const text = readFileSync(join(MIGRATIONS, file), "utf8");
    expect(text).not.toMatch(/"public"\.|\bpublic\./i);
  });
});
