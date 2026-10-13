/**
 * `featurekit` — the server-side package: the control plane, and the evaluator.
 *
 * ```ts
 * import { FeaturekitServer } from "featurekit-server";
 *
 * const server = new FeaturekitServer({ services: ["all"], port: 3000 });
 * await server.start();
 * ```
 *
 * Two things live here because both are server-side and neither belongs in a
 * client bundle:
 *
 * - **`FeaturekitServer`** — the control plane. Owns Postgres, Redis, the
 *   management API, the client tier and the dashboard.
 * - **`FeaturekitSDK`** — the server-tier SDK. Holds the compiled ruleset in
 *   memory and evaluates any context synchronously, with no network call.
 *
 * The import boundary still runs between them: nothing under `src/sdk/` may
 * reach into the rest of `src/`, so the evaluator stays usable without a
 * database. `tools/check-package.mjs` asserts it.
 *
 * Clients — browsers, mobile apps, and backends that would rather ask than
 * evaluate — use `featurekit-client`, which is never sent the ruleset.
 */

export {
  FeaturekitServer,
} from "./server.js";
export type {
  FeaturekitServerOptions,
  FeaturekitAddress,
  FeaturekitService,
} from "./server.js";

export { createApp } from "./app.js";
export type { App, CreateAppOptions } from "./app.js";
export { loadConfig, ConfigError, configSchema } from "./config/index.js";
export type { FeaturekitConfig } from "./config/index.js";

export {
  FeaturekitSDK,
} from "./sdk/index.js";
export type {
  FeaturekitSdkOptions,
  SdkState,
  Snapshot,
} from "./sdk/index.js";

/**
 * Migrations, for a process that already imports the control plane. A deploy
 * job should import `featurekit-server/migrate` instead — same functions, without the
 * route layer, Redis and the metrics registry.
 */
export { migrate, migrationStatus, MIGRATION_LOCK } from "./migrate.js";
export type { MigrateOptions, MigrationStatus } from "./migrate.js";

/**
 * Secure mode, for a process that already imports the control plane.
 *
 * A backend whose only job is signing contexts should import
 * `featurekit-server/secure-mode` instead — same functions, without loading Drizzle,
 * Postgres, Redis and the rest at import time.
 */
export { signContext, verifyContext } from "./auth/secure-mode.js";
export type { SignedContext, SignatureRejection, VerifyOptions } from "./auth/secure-mode.js";
export { contextHash, canonicalize } from "./contracts/context-hash.js";
