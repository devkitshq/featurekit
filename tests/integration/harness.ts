/**
 * Integration-test harness.
 *
 * Real Postgres, via testcontainers or FEATUREKIT_TEST_DATABASE_URL ("Zero-config dev, explicit
 * prod"). These tests exercise the layer that a pure unit test cannot reach —
 * generated columns, check constraints, composite foreign keys, partitioned
 * DDL — which is exactly the layer where a schema bug hides.
 *
 * **Gating, and why it is loud.** If no container runtime is reachable the
 * suite skips rather than fails, so a laptop without a running Docker daemon
 * is not a broken checkout. But it announces the skip once, with the reason,
 * because a silently skipped integration suite is indistinguishable from a
 * passing one and that is how schema regressions ship.
 *
 * Set `FEATUREKIT_REQUIRE_CONTAINERS=1` in CI to turn a skip into a failure.
 */

import type { StartedTestContainer } from "testcontainers";

export interface IntegrationContext {
  databaseUrl: string;
  stop: () => Promise<void>;
}

/**
 * An existing Postgres server to run against instead of a container.
 *
 * Each `startInfrastructure()` call gets its own freshly created database on
 * it, dropped again by `stop()`, so suites stay as isolated as they are with a
 * container per suite. The URL needs a role allowed to `CREATE DATABASE`.
 */
const EXTERNAL_DATABASE_URL = process.env["FEATUREKIT_TEST_DATABASE_URL"];

/**
 * Null when integration tests can get a database — an external server or a
 * container runtime — else the reason they cannot.
 */
export async function databaseUnavailableReason(): Promise<string | null> {
  if (EXTERNAL_DATABASE_URL !== undefined && EXTERNAL_DATABASE_URL.length > 0) return null;
  const reason = await containerUnavailableReason();
  return reason === null ? null : `${reason}, and FEATUREKIT_TEST_DATABASE_URL is not set`;
}

let probed: string | null | undefined;

/**
 * Null when containers are usable, else the reason they are not. Only for the
 * suites that stop and restart their own containers; everything else needs just
 * a database — see `databaseUnavailableReason`.
 */
export async function containerUnavailableReason(): Promise<string | null> {
  if (probed !== undefined) return probed;

  if (process.env["FEATUREKIT_SKIP_CONTAINERS"] === "1") {
    probed = "FEATUREKIT_SKIP_CONTAINERS=1";
    return probed;
  }
  try {
    const { getContainerRuntimeClient } = await import(
      "testcontainers/build/container-runtime/clients/client.js"
    );
    // Bounded: testcontainers probes several strategies in turn and takes ~20s
    // to give up on a host with no daemon. Nobody should wait that long to be
    // told the suite is skipping.
    await Promise.race([
      getContainerRuntimeClient(),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("probe timed out after 4s")), 4_000);
        timer.unref?.();
      }),
    ]);
    probed = null;
  } catch (error) {
    probed = `no container runtime (${(error as Error).message.split("\n")[0]})`;
  }
  return probed;
}

let announced = false;

/**
 * Announce a skip exactly once per run. Repeating it for every test file turns
 * a signal into noise; omitting it entirely turns a gap into a false pass.
 */
export function announceSkip(reason: string): void {
  if (announced) return;
  announced = true;
  const required = process.env["FEATUREKIT_REQUIRE_CONTAINERS"] === "1";
  const message =
    `\n  featurekit: integration tests SKIPPED — ${reason}.\n` +
    `  Start a Docker daemon to run them, or set FEATUREKIT_REQUIRE_CONTAINERS=1 to fail instead.\n`;
  if (required) throw new Error(message);
  // eslint-disable-next-line no-console
  console.warn(message);
}

export async function startInfrastructure(): Promise<IntegrationContext> {
  if (EXTERNAL_DATABASE_URL !== undefined && EXTERNAL_DATABASE_URL.length > 0) {
    return freshDatabaseOn(EXTERNAL_DATABASE_URL);
  }

  const { GenericContainer, Wait } = await import("testcontainers");
  const postgres: StartedTestContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "featurekit",
      POSTGRES_PASSWORD: "featurekit",
      POSTGRES_DB: "featurekit",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  return {
    databaseUrl: `postgres://featurekit:featurekit@${postgres.getHost()}:${postgres.getMappedPort(5432)}/featurekit`,
    stop: async () => {
      await postgres.stop();
    },
  };
}

async function freshDatabaseOn(serverUrl: string): Promise<IntegrationContext> {
  const { default: postgres } = await import("postgres");
  const name = `fk_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    databaseUrl: url.toString(),
    stop: async () => {
      const cleanup = postgres(serverUrl, { max: 1, onnotice: () => {} });
      await cleanup.unsafe(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
