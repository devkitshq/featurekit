/**
 * A production deployment that forgot a variable must die, not dial (§17).
 *
 * `loadConfig`'s `REQUIRED_IN_PRODUCTION` check has always been right, and for
 * `DATABASE_URL` and `REDIS_URL` it was **unreachable**. It tests
 * `env[key] === undefined`, and `FeaturekitServer.start()` wrote both keys into
 * that object unconditionally — holding the loopback defaults it had just
 * invented when nobody supplied any. So production configuration validation
 * passed on a deployment with no database configured at all.
 *
 * What that cost was not an error message. It was **silence**: the process went
 * on to dial `127.0.0.1:5432` and stayed there, printing nothing at any log
 * level, because the stall happens before the logger emits its first line. On a
 * PaaS you learn about it from a healthcheck timeout minutes later, against
 * empty logs, with nothing pointing at the missing variable.
 *
 * The unit test could not have caught this, because every unit test calls
 * `loadConfig` directly with an env object it built itself. The bug lived in
 * the one line between the two.
 *
 * These tests go through `FeaturekitServer.start()` for exactly that reason.
 * None of them can hang: configuration is validated before any connection is
 * opened, so a regression fails as a timeout rather than passing quietly.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/index.js";
import { FeaturekitServer } from "../../src/server.js";

const started: FeaturekitServer[] = [];

afterEach(async () => {
  for (const server of started.splice(0)) await server.stop().catch(() => undefined);
});

/** A production server with dev containers off, so nothing reaches for Docker. */
function productionServer(options: Record<string, unknown> = {}): FeaturekitServer {
  const server = new FeaturekitServer({
    nodeEnv: "production",
    logLevel: "silent",
    port: 0,
    devServices: false,
    autoMigrate: false,
    // Supplied so the assertions below are about the URLs, not this.
    adminToken: "a-token-of-at-least-twenty-four-chars",
    ...options,
    // A bare object: `start()` spreads `process.env` first, and this repository's
    // own DATABASE_URL would otherwise make every case look "supplied".
    env: { DATABASE_URL: undefined, REDIS_URL: undefined, ...(options["env"] as object) },
  });
  started.push(server);
  return server;
}

describe("production refuses the development defaults (§17)", () => {
  it("names every missing variable at once, not one per restart", async () => {
    // Three restarts to discover three missing variables is three outages.
    const error = await productionServer().start().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("DATABASE_URL");
    expect((error as ConfigError).message).toContain("REDIS_URL");
  }, 15_000);

  it("still refuses when only one of the two was supplied", async () => {
    const error = await productionServer({ databaseUrl: "postgres://u:p@db:5432/f" })
      .start()
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).not.toContain("  DATABASE_URL");
    expect((error as ConfigError).message).toContain("REDIS_URL");
  }, 15_000);

  it("accepts an explicit URL from the environment, not only from options", async () => {
    // The PaaS shape: variables arrive in the environment, nothing is passed in
    // code. `start()` must treat those as supplied.
    const error = await productionServer({
      env: { DATABASE_URL: "postgres://u:p@db:5432/f", REDIS_URL: "redis://cache:6379" },
    })
      .start()
      .catch((cause: unknown) => cause);

    // It gets past configuration and fails reaching a host that does not exist,
    // which is the correct next failure and a different one.
    expect(error).not.toBeInstanceOf(ConfigError);
  }, 20_000);

  it("has not made ADMIN_TOKEN's check redundant", async () => {
    const error = await productionServer({
      adminToken: undefined,
      env: { DATABASE_URL: "postgres://u:p@db:5432/f", REDIS_URL: "redis://cache:6379" },
    })
      .start()
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("ADMIN_TOKEN");
  }, 15_000);
});
