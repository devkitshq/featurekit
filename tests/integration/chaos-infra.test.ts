/**
 * Chaos against real infrastructure (review §12, PR-C4).
 *
 * The existing chaos suite kills an in-process HTTP server and swaps a
 * fault-injecting store. That is genuinely useful and it cannot prove the
 * things that only a real Redis and a real Postgres have: a process that
 * *restarts*, a connection that drops mid-command, a Redis whose dataset is
 * gone but whose socket is fine, a partitioned table with no partition for
 * today.
 *
 * Every scenario here states its expected behaviour in the test name, because
 * the review asks for expected-vs-actual per scenario and a test name is the
 * only documentation that cannot drift from what runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { sql } from "drizzle-orm";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { announceSkip, containerUnavailableReason } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import { RedisSnapshotStore } from "../../src/redis/redis-store.js";
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
const REDIS_HOST_PORT = 16_379;

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
  let redis: StartedTestContainer;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let store: RedisSnapshotStore;
  let service: SnapshotService;
  let environmentId: string;
  let redisUrl: string;

  beforeAll(async () => {
    postgres = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "togglekit",
        POSTGRES_PASSWORD: "togglekit",
        POSTGRES_DB: "togglekit",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    // A FIXED host port, deliberately. `restart()` re-creates the container's
    // port mapping, so with an ephemeral port every client built before the
    // restart points at a port nothing is listening on any more — which looks
    // exactly like "Redis never came back" and is really "the test moved it".
    redis = await new GenericContainer("redis:7-alpine")
      .withExposedPorts({ container: 6379, host: REDIS_HOST_PORT })
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();

    redisUrl = `redis://${redis.getHost()}:${REDIS_HOST_PORT}`;
    handle = createDatabase({
      url: `postgres://togglekit:togglekit@${postgres.getHost()}:${postgres.getMappedPort(5432)}/togglekit`,
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

    store = new RedisSnapshotStore({
      url: redisUrl,
      commandTimeoutMs: 500,
      circuitFailureThreshold: 2,
      circuitResetAfterMs: 300,
      onError: () => {},
    });
    service = new SnapshotService({
      store,
      loadInput: (id) => loadCompilerInput(db, id),
      nextVersion: (id) => nextSnapshotVersion(db, id),
      debounceMs: 10,
      degradedCompileIntervalMs: 100,
      onError: () => {},
    });
  }, 600_000);

  afterAll(async () => {
    await service?.close();
    await store?.close().catch(() => undefined);
    await handle?.close();
    await redis?.stop();
    await postgres?.stop();
  });

  /* ── Redis ────────────────────────────────────────────────────────── */

  it("Redis restart: keeps serving, then recovers on its own", async () => {
    const before = await service.get(environmentId);
    expect(before.snapshot.flags["checkout"]).toBeDefined();

    await redis.restart();

    // Expected: the snapshot is served from memory or recompiled from
    // Postgres. Never an error, never an empty configuration.
    const during = await service.get(environmentId);
    expect(during.snapshot.flags["checkout"]).toBeDefined();
    expect(["memory", "postgres", "store", "compiled"]).toContain(during.source);

    // Expected: once Redis is back, the store is repopulated and used again.
    let recovered = false;
    for (let i = 0; i < 40 && !recovered; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const attempt = await service.get(environmentId).catch(() => null);
      recovered = attempt?.source === "store" || attempt?.source === "compiled";
    }
    expect(recovered).toBe(true);
  }, 120_000);

  it("Redis wiped: rebuilds from Postgres rather than serving nothing", async () => {
    await service.get(environmentId);

    const client = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    await client.flushall();
    await client.quit();

    // Expected: every key in Redis is rebuildable (§8). The flag survives.
    const after = await service.get(environmentId);
    expect(after.snapshot.flags["checkout"]).toBeDefined();
  }, 120_000);

  it("Redis wiped: patch history loss degrades a resume to a full put", async () => {
    await service.recompile(environmentId);
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    await client.flushall();
    await client.quit();

    // Expected: `null` means "send a full put", which is the correct answer to
    // an empty history — not an error, and not a silent partial replay.
    expect(await store.patchesSince(environmentId, 1, 200)).toBeNull();
  }, 120_000);

  it("Redis stopped: the breaker makes the degraded path fast, not slow", async () => {
    await service.get(environmentId);
    await redis.stop();

    try {
      // Warm the breaker open with a couple of failures.
      for (let i = 0; i < 3; i++) await service.get(environmentId).catch(() => undefined);

      const started = Date.now();
      for (let i = 0; i < 10; i++) {
        const result = await service.get(environmentId);
        expect(result.snapshot.flags["checkout"]).toBeDefined();
      }
      // Expected: ten requests served from memory in well under the time a
      // single command timeout would have taken.
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      redis = await new GenericContainer("redis:7-alpine")
        .withExposedPorts({ container: 6379, host: REDIS_HOST_PORT })
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start();
    }
  }, 180_000);

  /* ── Postgres ─────────────────────────────────────────────────────── */

  it("Postgres stopped: the last known good snapshot keeps serving", async () => {
    // A fresh service against the live Redis, warmed first.
    const localStore = new RedisSnapshotStore({
      url: redisUrl,
      commandTimeoutMs: 500,
      onError: () => {},
    });
    const localService = new SnapshotService({
      store: localStore,
      loadInput: (id) => loadCompilerInput(db, id),
      nextVersion: (id) => nextSnapshotVersion(db, id),
      debounceMs: 10,
      onError: () => {},
    });

    try {
      const warm = await localService.get(environmentId);
      expect(warm.snapshot.flags["checkout"]).toBeDefined();

      await postgres.stop();

      // Expected: reads keep working. Postgres is truth, but truth already in
      // memory does not need the database to be up.
      const during = await localService.get(environmentId);
      expect(during.snapshot.flags["checkout"]).toBeDefined();

      // Expected: writes fail, loudly, rather than appearing to succeed.
      await expect(localService.recompile(environmentId)).rejects.toThrow();
    } finally {
      await localService.close();
      await localStore.close().catch(() => undefined);
    }
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
        POSTGRES_USER: "togglekit",
        POSTGRES_PASSWORD: "togglekit",
        POSTGRES_DB: "togglekit",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    handle = createDatabase({
      url: `postgres://togglekit:togglekit@${postgres.getHost()}:${postgres.getMappedPort(5432)}/togglekit`,
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
    // §7.9 forbids a DEFAULT partition, so an insert outside every partition
    // range fails — correctly and loudly. What must NOT happen is the drain
    // stalling, because a stalled drain becomes an unbounded buffer, and an
    // unbounded buffer in the analytics path is how analytics takes down
    // evaluation (§22).
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
      sql`select togglekit_partition_runway_days() as days`,
    )) as unknown as Array<{ days: number | string | null }>;
    const days = Number(result[0]?.days ?? -1);
    // The migration premakes a week. Anything below two fails readiness.
    expect(days).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
