/**
 * The migration step, as a command (§9, §16).
 *
 *   node scripts/migrate.mjs            apply
 *   node scripts/migrate.mjs --check    report status, change nothing
 *
 * A thin wrapper, deliberately. The implementation is `src/migrate.ts`, shipped
 * as `togglekit/migrate`, and it is what `TogglekitServer`'s `autoMigrate`
 * calls too — so the deploy step and the boot-time step take the same advisory
 * lock and apply the same SQL. Three callers, one definition.
 *
 * If you installed togglekit rather than checked it out, skip this file:
 *
 *   import { migrate } from "togglekit/migrate";
 *   await migrate();
 */

import { migrate, migrationStatus } from "../dist/migrate.js";

if (process.env["DATABASE_URL"] === undefined) {
  process.stderr.write("togglekit: DATABASE_URL is required\n");
  // 78 is EX_CONFIG: the deploy is misconfigured, not broken.
  process.exit(78);
}

try {
  if (process.argv.includes("--check")) {
    const { applied, partitionRunwayDays } = await migrationStatus();
    process.stdout.write(
      `togglekit: ${applied} migrations applied, ` +
        `${partitionRunwayDays ?? "unknown"} days of partition runway\n`,
    );
  } else {
    await migrate({ log: (message) => process.stdout.write(`togglekit: ${message}\n`) });
  }
} catch (error) {
  process.stderr.write(`togglekit: migration failed: ${String(error)}\n`);
  process.exit(1);
}
