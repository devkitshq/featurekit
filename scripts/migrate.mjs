/**
 * The migration step, as a command (§9, §16).
 *
 *   node scripts/migrate.mjs            apply
 *   node scripts/migrate.mjs --check    report status, change nothing
 *
 * A thin wrapper, deliberately. The implementation is `src/migrate.ts`, shipped
 * as `featurekit-server/migrate`, and it is what `FeaturekitServer`'s `autoMigrate`
 * calls too — so the deploy step and the boot-time step take the same advisory
 * lock and apply the same SQL. Three callers, one definition.
 *
 * If you installed featurekit rather than checked it out, skip this file:
 *
 *   import { migrate } from "featurekit-server/migrate";
 *   await migrate();
 */

import { migrate, migrationStatus } from "../dist/migrate.js";

if (process.env["DATABASE_URL"] === undefined) {
  process.stderr.write("featurekit: DATABASE_URL is required\n");
  // 78 is EX_CONFIG: the deploy is misconfigured, not broken.
  process.exit(78);
}

try {
  if (process.argv.includes("--check")) {
    const { applied, partitionRunwayDays } = await migrationStatus();
    process.stdout.write(
      `featurekit: ${applied} migrations applied, ` +
        `${partitionRunwayDays ?? "unknown"} days of partition runway\n`,
    );
  } else {
    await migrate({ log: (message) => process.stdout.write(`featurekit: ${message}\n`) });
  }
} catch (error) {
  process.stderr.write(`featurekit: migration failed: ${String(error)}\n`);
  process.exit(1);
}
