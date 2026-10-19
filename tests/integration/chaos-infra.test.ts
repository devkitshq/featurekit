/**
 * Chaos against real infrastructure (PR-C4).
 *
 * The existing chaos suite kills an in-process HTTP server and swaps a
 * fault-injecting store. That is genuinely useful and it cannot prove the
 * things that only a real Postgres has: a server that *restarts* under a live
 * LISTEN connection, cache tables emptied the way a crash empties UNLOGGED
 * tables, a partitioned table with no partition for today.
 *
 * Every scenario here states its expected behaviour in the test name, because
 * the review asks for expected-vs-actual per scenario and a test name is the
 * only documentation that cannot drift from what runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { announceSkip, containerUnavailableReason } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import { PostgresSnapshotStore } from "../../src/snapshot/postgres-store.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { EventBuffer } from "../../src/events/ingest.js";
import { MemoryDeadLetterQueue, RollupWorker } from "../../src/events/rollup.js";
import {
  environments,
  evaluationSummaries,
  flagEnvironments,
  flagVariations,
  flags,
  projects,
} from "../../src/db/schema.js";
import { loadCompilerInput } from "../../src/repositories/snapshot-input.js";
import { nextSnapshotVersion } from "../../src/repositories/environments.js";

const reason = await containerUnavailableReason();

/**
 * Fixed host ports so a container can be restarted without moving.
 *
 * High and unusual, to stay clear of anything a developer is likely to be
 * running locally.
 */
const POSTGRES_HOST_PORT = 15_432;

describe("infrastructure chaos prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; infrastructure chaos will run"
      : `infrastructure chaos SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("infrastructure chaos", () => {
  let postgres: StartedTestContainer;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let environmentId: string;
  const services: SnapshotService[] = [];
  const stores: PostgresSnapshotStore[] = [];

  /** A fresh node: its own store and service, so nothing is warm in memory. */
  function node(): { store: PostgresSnapshotStore; service: SnapshotService } {
    const store = new PostgresSnapshotStore({
      sql: handle.sql,
      schema: "public",
      revalidateMs: 100,
      onError: () => {},
    });
    const service = new SnapshotService({
      store,
      loadInput: (id) => loadCompilerInput(db, id),
      nextVersion: (id) => nextSnapshotVersion(db, id),
      debounceMs: 10,
      degradedCompileIntervalMs: 100,
      onError: () => {},
    });
    stores.push(store);
    services.push(service);
    return { store, service };
  }

  beforeAll(async () => {
    // A FIXED host port, deliberately. `restart()` re-creates the container's
    // port mapping, so with an ephemeral port every client built before the
    // restart points at a port nothing is listening on any more — which looks
    // exactly like "the listener never came back" and is really "the test
    // moved it".
    postgres = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "featurekit",
        POSTGRES_PASSWORD: "featurekit",
        POSTGRES_DB: "featurekit",
      })
      .withExposedPorts({ container: 5432, host: POSTGRES_HOST_PORT })
      // `restart()` reuses this strategy. A first boot logs "ready" twice (the
      // init server, then the real one); a restart skips init and logs it once,
      // so counting to two never finishes. The init server listens on a socket
      // only, so a listening TCP port plus one "ready" holds for both.
      .withWaitStrategy(
        Wait.forAll([
          Wait.forListeningPorts(),
          Wait.forLogMessage(/database system is ready to accept connections/),
        ]),
      )
      .start();

    handle = createDatabase({
      url: `postgres://featurekit:featurekit@${postgres.getHost()}:${POSTGRES_HOST_PORT}/featurekit`,
    });
    db = handle.db;
    await runMigrations(db);

    const [project] = await db
      .insert(projects)
      .values({ key: "chaos", name: "Chaos" })
      .returning({ id: projects.id });
    const [environment] = await db
      .insert(environments)
      .values({
        projectId: project!.id,
        key: "production",
        name: "Production",
        bucketSalt: "salt",
      })
      .returning({ id: environments.id });
    environmentId = environment!.id;

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
    await db.insert(flagEnvironments).values({
      flagId: flag!.id,
      environmentId,
      enabled: true,
      offVariationId: variations.find((v) => v.idx === 0)!.id,
      fallthroughVariationId: variations.find((v) => v.idx === 1)!.id,
    });
  }, 600_000);

  afterAll(async () => {
    await Promise.all(services.map((s) => s.close()));
    await Promise.all(stores.map((s) => s.close().catch(() => undefined)));
    await handle?.close();
    await postgres?.stop();
  });

  /* ── the cache tables ─────────────────────────────────────────────── */

  it("snapshot cache emptied, as a crash empties UNLOGGED tables: rebuilds rather than serving nothing", async () => {
    await node().service.get(environmentId);
    await db.execute(sql`truncate snapshot_cache, snapshot_patches, compile_locks`);

    // Expected: a cold node finds nothing cached, compiles from the
    // configuration tables, and serves the flag.
    const after = await node().service.get(environmentId);
    expect(after.snapshot.flags["checkout"]).toBeDefined();
  }, 120_000);

  it("patch history emptied: a resume degrades to a full put", async () => {
    const { store, service } = node();
    await service.recompile(environmentId);
    await db.execute(sql`truncate snapshot_patches`);

    // Expected: `null` means "send a full put", which is the correct answer to
    // an empty history — not an error, and not a silent partial replay.
    expect(await store.patchesSince(environmentId, 1, 200)).toBeNull();
  }, 120_000);

  /* ── Postgres ─────────────────────────────────────────────────────── */

  it("Postgres restart: the listener reconnects and changes are delivered again", async () => {
    const listener = node();
    const writer = node();
    await listener.service.get(environmentId);
    const seen: number[] = [];
    await listener.store.subscribe(environmentId, (message) => seen.push(message.version));

    await postgres.restart();

    // Expected: postgres.js re-establishes LISTEN on its own. A change
    // committed by another node after the restart reaches this one, and its
    // cache serves the new version rather than the one from before.
    let delivered = false;
    for (let i = 0; i < 60 && !delivered; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const committed = await writer.service.recompile(environmentId).catch(() => undefined);
      if (committed === undefined) continue;
      await new Promise((r) => setTimeout(r, 200));
      delivered = seen.includes(committed.version);
      if (delivered) {
        const current = await listener.service.get(environmentId);
        expect(current.version).toBe(committed.version);
      }
    }
    expect(delivered).toBe(true);
  }, 180_000);

  it("Postgres stopped: the last known good snapshot keeps serving", async () => {
    const { service } = node();
    const warm = await service.get(environmentId);
    expect(warm.snapshot.flags["checkout"]).toBeDefined();

    await postgres.stop();

    // Expected: reads keep working. Postgres is truth, but truth already in
    // memory does not need the database to be up.
    const during = await service.get(environmentId);
    expect(during.snapshot.flags["checkout"]).toBeDefined();

    // Expected: writes fail, loudly, rather than appearing to succeed.
    await expect(service.recompile(environmentId)).rejects.toThrow();
  }, 180_000);
});

/* ── analytics under partition failure ──────────────────────────────── */

describe.skipIf(reason !== null)("analytics when the partition is missing", () => {
  let postgres: StartedTestContainer;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let environmentId: string;

  beforeAll(async () => {
    postgres = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "featurekit",
        POSTGRES_PASSWORD: "featurekit",
        POSTGRES_DB: "featurekit",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    handle = createDatabase({
      url: `postgres://featurekit:featurekit@${postgres.getHost()}:${postgres.getMappedPort(5432)}/featurekit`,
    });
    db = handle.db;
    await runMigrations(db);

    const [project] = await db
      .insert(projects)
      .values({ key: "analytics", name: "Analytics" })
      .returning({ id: projects.id });
    const [environment] = await db
      .insert(environments)
      .values({
        projectId: project!.id,
        key: "production",
        name: "Production",
        bucketSalt: "salt",
      })
      .returning({ id: environments.id });
    environmentId = environment!.id;
  }, 600_000);

  afterAll(async () => {
    await handle?.close();
    await postgres?.stop();
  });

  function worker(buffer: EventBuffer, dlq: MemoryDeadLetterQueue) {
    return new RollupWorker({ db, buffer, deadLetter: dlq, onError: () => {} });
  }

  it("writes summaries into today's partition", async () => {
    const buffer = new EventBuffer();
    buffer.accept(environmentId, {
      bucketAt: Date.now(),
      summaries: [{ flagKey: "checkout", variationIndex: 1, reason: "FALLTHROUGH", count: 7 }],
    } as never);

    const written = await worker(buffer, new MemoryDeadLetterQueue()).drainOnce();
    expect(written).toBe(1);

    const rows = await db.select().from(evaluationSummaries);
    expect(rows.some((r) => r.flagKey === "checkout" && Number(r.count) === 7)).toBe(true);
  }, 120_000);

  it("adds to an existing bucket rather than duplicating it", async () => {
    // The idempotency property: `count = count + excluded.count`, so a second
    // drain for the same minute accumulates instead of failing on the key.
    const bucketAt = Date.now();
    for (let i = 0; i < 3; i++) {
      const buffer = new EventBuffer();
      buffer.accept(environmentId, {
        bucketAt,
        summaries: [{ flagKey: "repeat", variationIndex: 0, reason: "OFF", count: 5 }],
      } as never);
      await worker(buffer, new MemoryDeadLetterQueue()).drainOnce();
    }

    const rows = await db.select().from(evaluationSummaries);
    const repeated = rows.filter((r) => r.flagKey === "repeat");
    expect(repeated).toHaveLength(1);
    expect(Number(repeated[0]!.count)).toBe(15);
  }, 120_000);

  it("routes to the dead-letter queue when no partition covers the row", async () => {
    // There is deliberately no DEFAULT partition, so an insert outside every partition
    // range fails — correctly and loudly. What must NOT happen is the drain
    // stalling, because a stalled drain becomes an unbounded buffer, and an
    // unbounded buffer in the analytics path is how analytics takes down
    // evaluation.
    const buffer = new EventBuffer();
    // Two years out: no partition exists, and none is premade that far ahead.
    const farFuture = Date.now() + 730 * 24 * 60 * 60 * 1000;
    buffer.accept(environmentId, {
      bucketAt: farFuture,
      summaries: [{ flagKey: "orphan", variationIndex: 0, reason: "OFF", count: 1 }],
    } as never);

    const dlq = new MemoryDeadLetterQueue();
    const written = await worker(buffer, dlq).drainOnce();

    expect(written).toBe(0);
    expect(dlq.size).toBe(1);
    // And the reason is the specific one, so the runbook that names partition
    // maintenance is the one that gets paged.
    expect(dlq.take()[0]?.reason).toBe("missing_partition");
  }, 120_000);

  it("keeps draining after a poisoned batch", async () => {
    const buffer = new EventBuffer();
    const farFuture = Date.now() + 730 * 24 * 60 * 60 * 1000;
    buffer.accept(environmentId, {
      bucketAt: farFuture,
      summaries: [{ flagKey: "poison", variationIndex: 0, reason: "OFF", count: 1 }],
    } as never);
    const dlq = new MemoryDeadLetterQueue();
    const rollup = worker(buffer, dlq);
    await rollup.drainOnce();

    // The next, perfectly good batch must still be written.
    buffer.accept(environmentId, {
      bucketAt: Date.now(),
      summaries: [{ flagKey: "healthy", variationIndex: 1, reason: "FALLTHROUGH", count: 2 }],
    } as never);
    expect(await rollup.drainOnce()).toBe(1);
  }, 120_000);

  it("two workers draining the same buffer never double-count", async () => {
    // Shard ownership in miniature: `drain()` empties the buffer, so a second
    // worker racing the first finds nothing rather than writing it twice.
    const buffer = new EventBuffer();
    const bucketAt = Date.now();
    buffer.accept(environmentId, {
      bucketAt,
      summaries: [{ flagKey: "contended", variationIndex: 1, reason: "FALLTHROUGH", count: 4 }],
    } as never);

    const dlq = new MemoryDeadLetterQueue();
    const [a, b] = await Promise.all([
      worker(buffer, dlq).drainOnce(),
      worker(buffer, dlq).drainOnce(),
    ]);
    expect(a + b).toBe(1);

    const rows = await db.select().from(evaluationSummaries);
    const contended = rows.filter((r) => r.flagKey === "contended");
    expect(contended).toHaveLength(1);
    expect(Number(contended[0]!.count)).toBe(4);
  }, 120_000);

  it("reports partition runway, which is what readiness gates on", async () => {
    const result = (await db.execute(
      sql`select featurekit_partition_runway_days() as days`,
    )) as unknown as Array<{ days: number | string | null }>;
    const days = Number(result[0]?.days ?? -1);
    // The migration premakes a week. Anything below two fails readiness.
    expect(days).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
