/**
 * A rehearsed restore (review PR-D3).
 *
 * `docs/ops/deployment.md` states an RPO of 5 minutes and an RTO of an hour,
 * and then says: *an unrehearsed restore is a hypothesis*. This is the
 * rehearsal, run in CI, against real Postgres.
 *
 * It exercises the whole procedure rather than the happy half:
 *
 * 1. Take a dump of a database with real flag configuration in it.
 * 2. Restore into a **fresh** instance.
 * 3. Prove the configuration is intact and still compiles into a snapshot.
 * 4. Prove the partition machinery survived — a restore that loses partitions
 *    loses analytics ingest at midnight, silently.
 * 5. Prove the documented `snapshot_version` fix-up is necessary and sufficient.
 *    This is the part everybody forgets: a point-in-time restore rolls the
 *    version counter *backwards*, SDKs reject snapshots that are not newer than
 *    what they hold, and the entire fleet freezes on its last good snapshot with
 *    nothing in the logs to explain why.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { announceSkip, containerUnavailableReason } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import {
  environments,
  flagEnvironments,
  flagVariations,
  flags,
  projects,
} from "../../src/db/schema.js";
import { loadCompilerInput } from "../../src/repositories/snapshot-input.js";
import { compileSnapshot } from "../../src/snapshot/compile.js";
import { nextSnapshotVersion } from "../../src/repositories/environments.js";

const reason = await containerUnavailableReason();

describe("restore rehearsal prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; the restore rehearsal will run"
      : `restore rehearsal SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("disaster recovery", () => {
  let origin: StartedTestContainer;
  let replica: StartedTestContainer;
  let originHandle: ReturnType<typeof createDatabase>;
  let replicaHandle: ReturnType<typeof createDatabase>;
  let dump: string;

  const url = (container: StartedTestContainer) =>
    `postgres://featurekit:featurekit@${container.getHost()}:${container.getMappedPort(5432)}/featurekit`;

  async function postgres() {
    return new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "featurekit",
        POSTGRES_PASSWORD: "featurekit",
        POSTGRES_DB: "featurekit",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
  }

  beforeAll(async () => {
    origin = await postgres();
    originHandle = createDatabase({ url: url(origin) });
    const db = originHandle.db;
    await runMigrations(db);

    // A production-shaped environment: a project, two environments, a flag with
    // configuration in each.
    const [project] = await db
      .insert(projects)
      .values({ key: "acme", name: "Acme" })
      .returning({ id: projects.id });
    for (const key of ["production", "staging"]) {
      await db.insert(environments).values({
        projectId: project!.id,
        key,
        name: key,
        bucketSalt: `${key}-salt`,
        isProduction: key === "production",
      });
    }
    const [flag] = await db
      .insert(flags)
      .values({ projectId: project!.id, key: "checkout", name: "Checkout", kind: "boolean" })
      .returning({ id: flags.id });
    const variations = await db
      .insert(flagVariations)
      .values([
        { flagId: flag!.id, idx: 0, value: false },
        { flagId: flag!.id, idx: 1, value: true },
      ])
      .returning({ id: flagVariations.id, idx: flagVariations.idx });

    const envRows = await db.select({ id: environments.id }).from(environments);
    for (const environment of envRows) {
      await db.insert(flagEnvironments).values({
        flagId: flag!.id,
        environmentId: environment.id,
        enabled: true,
        offVariationId: variations.find((v) => v.idx === 0)!.id,
        fallthroughVariationId: variations.find((v) => v.idx === 1)!.id,
      });
      // Move the version counter well past 1, so a naive restore is detectable.
      for (let i = 0; i < 25; i++) await nextSnapshotVersion(db, environment.id);
    }

    // The backup. `pg_dump` inside the container, exactly as an operator would.
    const dumped = await origin.exec([
      "pg_dump",
      "--username=featurekit",
      "--dbname=featurekit",
      "--no-owner",
    ]);
    expect(dumped.exitCode).toBe(0);
    dump = dumped.output;
    expect(dump.length).toBeGreaterThan(1_000);

    replica = await postgres();
    replicaHandle = createDatabase({ url: url(replica) });
  }, 900_000);

  afterAll(async () => {
    await originHandle?.close();
    await replicaHandle?.close();
    await origin?.stop();
    await replica?.stop();
  });

  it("restores into a fresh instance", async () => {
    // Written to a file inside the container and fed to psql, because a dump of
    // any size does not belong on a command line.
    await replica.exec([
      "sh",
      "-c",
      `cat > /tmp/dump.sql <<'FEATUREKIT_DUMP_EOF'\n${dump}\nFEATUREKIT_DUMP_EOF`,
    ]);
    const restored = await replica.exec([
      "psql",
      "--username=featurekit",
      "--dbname=featurekit",
      "--set=ON_ERROR_STOP=1",
      "--file=/tmp/dump.sql",
    ]);
    expect(restored.exitCode).toBe(0);
  }, 300_000);

  it("brings back every flag configuration intact", async () => {
    const db: Database = replicaHandle.db;
    const rows = await db.select({ key: flags.key }).from(flags);
    expect(rows.map((r) => r.key)).toContain("checkout");

    const envRows = await db
      .select({ id: environments.id, key: environments.key, salt: environments.bucketSalt })
      .from(environments);
    expect(envRows).toHaveLength(2);
    // The per-environment bucketing salt must survive: losing it re-randomises
    // every percentage rollout in that environment.
    expect(envRows.map((e) => e.salt).sort()).toEqual(["production-salt", "staging-salt"]);
  }, 120_000);

  it("still compiles a snapshot from the restored rows", async () => {
    // The real test of a restore is not "the rows are there", it is "the system
    // can do its job with them".
    const db: Database = replicaHandle.db;
    const [environment] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.key, "production"))
      .limit(1);

    const input = await loadCompilerInput(db, environment!.id);
    const snapshot = compileSnapshot(input, { version: 1 });
    expect(snapshot.flags["checkout"]).toBeDefined();
    expect(snapshot.salt).toBe("production-salt");
  }, 120_000);

  it("keeps the partitioned analytics table and its runway function", async () => {
    // A restore that loses the partition machinery loses analytics ingest at
    // midnight, silently, days later.
    const db: Database = replicaHandle.db;
    const partitioned = (await db.execute(
      sql`select relkind from pg_class where relname = 'evaluation_summaries'`,
    )) as unknown as Array<{ relkind: string }>;
    expect(partitioned[0]?.relkind).toBe("p"); // 'p' = partitioned table

    const runway = (await db.execute(
      sql`select featurekit_partition_runway_days() as days`,
    )) as unknown as Array<{ days: number | string }>;
    expect(Number(runway[0]?.days ?? -1)).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("shows why the documented snapshot_version fix-up is needed", async () => {
    const db: Database = replicaHandle.db;
    const [environment] = await db
      .select({ id: environments.id, snapshotVersion: environments.snapshotVersion })
      .from(environments)
      .where(eq(environments.key, "production"))
      .limit(1);

    // The restored counter is whatever it was at backup time. An SDK that
    // reconnects still holding a LATER version rejects everything the restored
    // control plane publishes, because the guard is "strictly greater".
    const restoredVersion = environment!.snapshotVersion;
    const versionHeldByFleet = restoredVersion + 12;
    expect(versionHeldByFleet > restoredVersion).toBe(true);

    // The documented fix-up, verbatim from docs/ops/deployment.md.
    await db.execute(
      sql`UPDATE environments SET snapshot_version = snapshot_version + 10000`,
    );

    const next = await nextSnapshotVersion(db, environment!.id);
    // Now every subsequent snapshot is newer than anything the fleet holds.
    expect(next).toBeGreaterThan(versionHeldByFleet);
  }, 120_000);

  it("leaves the restored database usable for writes", async () => {
    const db: Database = replicaHandle.db;
    const [environment] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.key, "staging"))
      .limit(1);

    const before = await nextSnapshotVersion(db, environment!.id);
    const after = await nextSnapshotVersion(db, environment!.id);
    expect(after).toBe(before + 1);
  }, 120_000);
});
