/**
 * Integration-test harness.
 *
 * Real Postgres and Redis via testcontainers (§2: "Zero-config dev, explicit
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
 * Set `TOGGLEKIT_REQUIRE_CONTAINERS=1` in CI to turn a skip into a failure.
 */

import type { StartedTestContainer } from "testcontainers";

export interface IntegrationContext {
  databaseUrl: string;
  redisUrl: string;
  stop: () => Promise<void>;
}

let probed: string | null | undefined;

/** Returns null when containers are usable, else the reason they are not. */
export async function containerUnavailableReason(): Promise<string | null> {
  if (probed !== undefined) return probed;

  if (
    process.env["TOGGLEKIT_SKIP_CONTAINERS"] === "1" ||
    process.env["TOGGLEKIT_SKIP_CONTAINERS"] === "1"
  ) {
    probed = "TOGGLEKIT_SKIP_CONTAINERS=1";
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
  const required =
    process.env["TOGGLEKIT_REQUIRE_CONTAINERS"] === "1" ||
    process.env["TOGGLEKIT_REQUIRE_CONTAINERS"] === "1";
  const message =
    `\n  togglekit: integration tests SKIPPED — ${reason}.\n` +
    `  Start a Docker daemon to run them, or set TOGGLEKIT_REQUIRE_CONTAINERS=1 to fail instead.\n`;
  if (required) throw new Error(message);
  // eslint-disable-next-line no-console
  console.warn(message);
}

export async function startInfrastructure(): Promise<IntegrationContext> {
  const { GenericContainer, Wait } = await import("testcontainers");

  const started: StartedTestContainer[] = [];

  const postgres = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "togglekit",
      POSTGRES_PASSWORD: "togglekit",
      POSTGRES_DB: "togglekit",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  started.push(postgres);

  const redis = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  started.push(redis);

  return {
    databaseUrl: `postgres://togglekit:togglekit@${postgres.getHost()}:${postgres.getMappedPort(5432)}/togglekit`,
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    stop: async () => {
      await Promise.all(started.map((c) => c.stop()));
    },
  };
}
