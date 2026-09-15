/**
 * The migration step, as a command (§9, §16).
 *
 *   node scripts/migrate.mjs            apply
 *   node scripts/migrate.mjs --check    report status, change nothing
 *
 * A thin wrapper, deliberately. The implementation is `src/migrate.ts`, shipped
 * as `featkit/migrate`, and it is what `FeatkitServer`'s `autoMigrate`
 * calls too — so the deploy step and the boot-time step take the same advisory
 * lock and apply the same SQL. Three callers, one definition.
 *
 * If you installed featkit rather than checked it out, skip this file:
 *
 *   import { migrate } from "featkit/migrate";
 *   await migrate();
 */

import { migrate, migrationStatus } from "../dist/migrate.js";

if (process.env["DATABASE_URL"] === undefined) {
  process.stderr.write("featkit: DATABASE_URL is required\n");
  // 78 is EX_CONFIG: the deploy is misconfigured, not broken.
  process.exit(78);
}

try {
  if (process.argv.includes("--check")) {
    const { applied, partitionRunwayDays } = await migrationStatus();
    process.stdout.write(
      `featkit: ${applied} migrations applied, ` +
        `${partitionRunwayDays ?? "unknown"} days of partition runway\n`,
    );
  } else {
    await migrate({ log: (message) => process.stdout.write(`featkit: ${message}\n`) });
  }
} catch (error) {
  process.stderr.write(`featkit: migration failed: ${String(error)}\n`);
  process.exit(1);
}
