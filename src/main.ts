/**
 * The process entrypoint (§16, §17).
 *
 * Everything interesting is in `server.ts`. This file exists to do the four
 * things a long-lived server process must do and that are wrong by default in
 * Node:
 *
 * 1. **Fail fast and loudly on bad configuration**, before binding a port.
 * 2. **Shut down gracefully on SIGTERM**, which is what an orchestrator sends
 *    first. Without a handler, Node exits immediately and every SSE connection
 *    is severed mid-deploy — the §6 reconnect storm, on every release.
 * 3. **Never shut down twice.** A second SIGTERM during a drain must not start a
 *    second drain; it should be the operator's escape hatch to exit now.
 * 4. **Die on an unhandled rejection rather than continuing in an unknown
 *    state.** A process that logs one and keeps serving flags is a process
 *    whose next answer nobody can reason about.
 *
 * `TOGGLEKIT_SERVICES` splits a deployment: `api,stream` on one, `rollup,
 * scheduler` on another. Unset means one process running everything.
 */

import { ConfigError } from "./config/index.js";
import { TogglekitServer, type TogglekitService } from "./server.js";

const SERVICES: readonly TogglekitService[] = [
  "api",
  "stream",
  "events",
  "rollup",
  "scheduler",
  "all",
];

function servicesFromEnv(): readonly TogglekitService[] | undefined {
  const raw = process.env["TOGGLEKIT_SERVICES"] ?? process.env["TOGGLEKIT_SERVICES"];
  if (raw === undefined) return undefined;
  const requested = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const unknown = requested.filter((entry) => !SERVICES.includes(entry as TogglekitService));
  if (unknown.length > 0) {
    // A typo here silently produces a process that serves nothing, and the
    // symptom — every request 404s — points nowhere near the cause.
    throw new ConfigError(
      `togglekit: unknown TOGGLEKIT_SERVICES entries: ${unknown.join(", ")}\n` +
        `  valid: ${SERVICES.join(", ")}`,
    );
  }
  return requested as TogglekitService[];
}

async function main(): Promise<void> {
  const services = servicesFromEnv();
  const server = new TogglekitServer({
    ...(services !== undefined ? { services } : {}),
    // Migrations are a deploy step here, not something a booting node does:
    // every node running them is a lock convoy during a rolling deploy.
    autoMigrate:
      process.env["TOGGLEKIT_AUTO_MIGRATE"] === "1" ||
      process.env["TOGGLEKIT_AUTO_MIGRATE"] === "1",
    devServices: false,
  });

  try {
    await server.start();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Configuration errors are for a human reading a terminal, not a log
      // aggregator: every missing variable at once, in plain text.
      process.stderr.write(`${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    process.stderr.write(`togglekit: failed to start: ${String(error)}\n`);
    process.exit(1);
  }

  const { logger } = server.app;
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      // Second signal: the operator has decided waiting is worse than dropping
      // connections. Honour that.
      process.stderr.write(`togglekit: ${signal} during shutdown, exiting now\n`);
      process.exit(130);
    }
    stopping = true;
    logger.info({ signal }, "shutting down");
    void server
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled rejection");
    // Drain first, but do not wait forever for it.
    setTimeout(() => process.exit(1), 5_000).unref();
    void server.stop().finally(() => process.exit(1));
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
    setTimeout(() => process.exit(1), 5_000).unref();
    void server.stop().finally(() => process.exit(1));
  });
}

void main();
