/**
 * The composition root.
 *
 * Until this file existed, every piece of the control plane was assembled only
 * inside tests — which meant operability (can a small team run this at 3am),
 * capacity, and the adversarial scenarios had nothing to run against. This is the one place that turns configuration
 * into a running system, and the one place that knows how to stop it again.
 *
 * The shape is deliberate: `createApp` builds and returns everything, and
 * `main.ts` does nothing but call it and wire signals. That keeps the whole
 * wiring testable in-process — a test can start a real app against a real
 * Postgres without binding a port or forking a process.
 *
 * **Startup order matters and is the reverse of shutdown order.** Dependencies
 * first, then the things that use them, then the socket. On the way out: stop
 * accepting, drain streams, stop workers, then close dependencies — a worker
 * that keeps writing after its database handle is gone is an error log nobody
 * can act on.
 */

import { createDatabase, inspectSchema, verifySchema, type Database } from "./db/client.js";
import { commaList, secureModeSecrets, type FeaturekitConfig } from "./config/index.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { Metrics } from "./observability/metrics.js";
import { Router } from "./http/router.js";
import { HttpServer, SseRegistry } from "./http/server.js";
import { corsMiddleware } from "./http/cors.js";
import { RateLimiter, rateLimitMiddleware, type RateLimitRule } from "./http/rate-limit.js";
import { PostgresSnapshotStore } from "./snapshot/postgres-store.js";
import { PostgresClientConnectionStore } from "./client-tier/postgres-connection-store.js";
import { SnapshotService } from "./snapshot/service.js";
import { loadCompilerInput } from "./repositories/snapshot-input.js";
import { compileSnapshot } from "./snapshot/compile.js";
import { writeFlagConfig } from "./repositories/flags.js";
import type { Snapshot } from "./sdk/index.js";
import {
  listEnvironments,
  nextSnapshotVersion,
  partitionRunwayDays,
} from "./repositories/environments.js";
import { SdkKeyRepository } from "./repositories/sdk-keys.js";
import { AccessTokenRepository } from "./repositories/access-tokens.js";
import { registerSdkRoutes, type AuthenticatedEnvironment } from "./routes/sdk.js";
import { registerClientRoutes } from "./routes/client.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { EventBuffer } from "./events/ingest.js";
import { MemoryDeadLetterQueue, RollupWorker } from "./events/rollup.js";
import { ScheduledChangeWorker } from "./scheduler/scheduled-changes.js";
import { checkKey } from "./auth/keys.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface App {
  server: HttpServer;
  router: Router;
  db: Database;
  store: PostgresSnapshotStore;
  snapshots: SnapshotService;
  metrics: Metrics;
  logger: Logger;
  /**
   * Fails unless connections are in the configured schema and it is migrated.
   * `listen()` deliberately does not: a node with no database still boots and
   * reports not-ready, which `/ready` does for a wrong schema too.
   */
  verifyDatabase(): Promise<void>;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

/** Client-tier routes are the only ones CORS applies to. See `http/cors.ts`. */
const CLIENT_ROUTES = new Set(["/v1/client/state", "/v1/client/stream"]);

/**
 * The processes a deployment can be split into.
 *
 * One process running `["all"]` is the right shape until a few thousand
 * connected SDKs; past that the halves scale differently — streams are held
 * open by memory and file descriptors, rollup is bounded by Postgres write
 * throughput — and the split is how they stop competing for the same node.
 */
export type FeaturekitService = "api" | "stream" | "events" | "rollup" | "scheduler" | "all";
export type { FeaturekitConfig };

/**
 * Which service owns which route.
 *
 * Ops routes are deliberately absent: `/live`, `/ready`, `/health` and
 * `/metrics` are registered by every process whatever it runs, because a
 * rollup-only node still has to answer its orchestrator.
 */
const ROUTE_SERVICE: Readonly<Record<string, FeaturekitService>> = {
  "/v1/snapshot/:envKey": "api",
  "/v1/stream/:envKey": "stream",
  "/v1/events": "events",
  "/v1/client/state": "api",
  "/v1/client/stream": "stream",
};

/**
 * A router that silently drops routes this process does not serve.
 *
 * The alternative — registering everything and answering 503 — looks tidier and
 * is worse: a load balancer health-checking a route that exists but refuses is
 * a node that stays in rotation while failing requests. An unregistered route
 * is a 404, which is the truth: this process does not serve it.
 */
class ServiceRouter extends Router {
  constructor(private readonly enabled: ReadonlySet<FeaturekitService>) {
    super();
  }

  override add(method: string, pattern: string, handler: Parameters<Router["add"]>[2]): this {
    const service = ROUTE_SERVICE[pattern];
    if (service !== undefined && !this.enabled.has(service)) return this;
    return super.add(method, pattern, handler);
  }
}

export interface CreateAppOptions {
  /** Defaults to `["all"]`: one process that does everything. */
  services?: readonly FeaturekitService[];
}

function serviceSet(services: readonly FeaturekitService[] | undefined): Set<FeaturekitService> {
  const requested = services === undefined || services.length === 0 ? ["all" as const] : services;
  if (requested.includes("all")) {
    return new Set<FeaturekitService>(["api", "stream", "events", "rollup", "scheduler"]);
  }
  return new Set(requested);
}

export function createApp(config: FeaturekitConfig, options: CreateAppOptions = {}): App {
  const services = serviceSet(options.services);
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { service: "featurekit", env: config.NODE_ENV },
  });
  const metrics = new Metrics();

  const { db, sql, close: closeDatabase } = createDatabase({
    url: config.DATABASE_URL,
    schema: config.DATABASE_SCHEMA,
    maxConnections: config.DB_MAX_CONNECTIONS,
  });
  // Only when LISTEN has to bypass a transaction-mode pooler; otherwise the
  // main pool opens its own dedicated LISTEN connection.
  const listener =
    config.DATABASE_LISTEN_URL === undefined
      ? undefined
      : createDatabase({
          url: config.DATABASE_LISTEN_URL,
          schema: config.DATABASE_SCHEMA,
          maxConnections: 1,
        });

  const store = new PostgresSnapshotStore({
    sql,
    schema: config.DATABASE_SCHEMA,
    ...(listener !== undefined ? { listenSql: listener.sql } : {}),
    // Sampled rather than logged per event: a database outage produces a
    // reconnect error every few seconds per node, and a log nobody can read
    // during an incident is worse than no log.
    onError: throttled((error) => logger.warn({ err: error }, "snapshot store error"), 10_000),
  });

  /* ── snapshots ─────────────────────────────────────────────────────── */

  const snapshots = new SnapshotService({
    store,
    loadInput: (environmentId) =>
      loadCompilerInput(db, environmentId, {
        maxSegmentMembers: config.SEGMENT_MEMBER_CEILING,
        memberPageSize: config.SEGMENT_MEMBER_PAGE_SIZE,
      }),
    nextVersion: (environmentId) => nextSnapshotVersion(db, environmentId),
    debounceMs: config.SNAPSHOT_DEBOUNCE_MS,
    patchHistoryDepth: config.PATCH_HISTORY_DEPTH,
    segmentInlineMax: config.SEGMENT_INLINE_MAX,
    onError: (error, ctx) => {
      metrics.snapshotCompileFailures.inc({ reason: "error" });
      logger.error({ err: error, environmentId: ctx.environmentId }, "snapshot pipeline error");
    },
    onSnapshot: (event) => {
      // The environment id is bounded before it becomes a label — a deployment
      // with 10,000 environments must not create 10,000 series.
      const label = metrics.env(event.environmentId);
      metrics.snapshotVersion.set({ environment: label }, event.version);
      metrics.snapshotAgeSeconds.set({ environment: label }, 0);
      if (event.compileMs !== undefined) {
        metrics.snapshotCompileDuration.observe(event.compileMs / 1000);
      }
      if (event.source === "memory" || event.source === "postgres") {
        metrics.snapshotDegradedServes.inc({ source: event.source });
      }
    },
  });

  /* ── authentication ────────────────────────────────────────────────── */

  const sdkKeys = new SdkKeyRepository(db, { ttlMs: config.SDK_KEY_CACHE_TTL_MS });
  const tokens = new AccessTokenRepository(db);

  const authenticate = async (presented: string): Promise<AuthenticatedEnvironment | null> => {
    const resolved = await sdkKeys.resolve(presented);
    if (resolved === null) return null;
    // The route still runs `checkKey`; this only reshapes the row. Expiry and
    // revocation are decided in one place, not two.
    return {
      id: resolved.id,
      environmentId: resolved.environmentId,
      environmentKey: resolved.environmentKey,
      projectId: resolved.projectId,
      isProduction: resolved.isProduction,
      kind: resolved.kind,
      expiresAt: resolved.expiresAt,
      revokedAt: resolved.revokedAt,
    };
  };

  /* ── analytics ─────────────────────────────────────────────────────── */

  const deadLetter = new MemoryDeadLetterQueue();
  const events = new EventBuffer({
    maxRows: config.EVENT_BUFFER_MAX,
    bucketSeconds: config.ROLLUP_BUCKET_SECONDS,
    onDropped: (rows, reason) => metrics.eventsDropped.inc({ reason }, rows),
  });
  const rollup = new RollupWorker({
    db,
    buffer: events,
    intervalMs: config.EVENT_FLUSH_INTERVAL_MS,
    deadLetter,
    onWritten: (rows) => metrics.rollupWritten.inc(rows),
    onDropped: (rows, reason) => metrics.rollupDlq.inc({ reason }, rows),
    onLag: (seconds) => metrics.rollupLagSeconds.set(seconds),
    onError: (error) => logger.warn({ err: error }, "rollup write failed"),
  });

  /* ── scheduled changes ─────────────────────────────────────────────── */

  const scheduler = new ScheduledChangeWorker({
    db,
    intervalMs: config.SCHEDULER_INTERVAL_MS,
    graceMs: config.SCHEDULER_GRACE_MS,
    // Applied through the ordinary write path, so propagation is the ordinary
    // debounced recompile — not a second way for a flag to change.
    onApplied: (environmentId, flagKey) => snapshots.notifyChange(environmentId, flagKey),
    onOutcome: (outcome) =>
      logger.info(outcome, outcome.applied ? "scheduled change applied" : "scheduled change skipped"),
    onError: (error) => logger.error({ err: error }, "scheduled change failed"),
  });

  /* ── HTTP ──────────────────────────────────────────────────────────── */

  const sse = new SseRegistry();
  const router = new ServiceRouter(services);
  /** Filled inside the rolled-back dry-run transaction below. */

  registerSdkRoutes(router, {
    snapshots,
    store,
    authenticate,
    sse,
    heartbeatMs: config.STREAM_HEARTBEAT_MS,
    patchHistoryDepth: config.PATCH_HISTORY_DEPTH,
    maxStreamConnections: config.MAX_STREAM_CONNECTIONS,
    onStreamChange: (open) => metrics.streamConnections.set({ tier: "server" }, open),
    onSdkIdentified: (userAgent) => metrics.recordSdkVersion(userAgent),
    ingestEvents: async (environmentId, batch) => {
      // Synchronous buffer append. Nothing on this path awaits a database, which
      // is what makes "analytics cannot slow evaluation" structural.
      events.accept(environmentId, batch as never);
      metrics.eventsIngested.inc();
    },
    onError: (error) => logger.warn({ err: error }, "sdk route error"),
  });

  registerClientRoutes(router, {
    snapshots,
    store,
    authenticate,
    secureModeSecrets: secureModeSecrets(config),
    secureModeMaxTtlSeconds: config.SECURE_MODE_MAX_TTL_SECONDS,
    unsignedContextEnvironmentIds: new Set(commaList(config.UNSIGNED_CONTEXT_ENVIRONMENT_IDS)),
    // Shared so a browser whose POST and stream land on different nodes is
    // taken over rather than refused. Without this the client tier
    // requires sticky routing.
    connectionStore: new PostgresClientConnectionStore(sql, {
      onError: throttled(
        (error) => logger.warn({ err: error }, "client connection store error"),
        10_000,
      ),
    }),
    connectionTtlSeconds: config.CLIENT_CONNECTION_TTL_SECONDS,
    maxClientConnections: config.MAX_CLIENT_CONNECTIONS,
    heartbeatMs: config.STREAM_HEARTBEAT_MS,
    sse,
    onConnectionChange: (open) => metrics.streamConnections.set({ tier: "client" }, open),
    onError: (error) => logger.warn({ err: error }, "client route error"),
  });

  if (services.has("api")) {
  registerAdminRoutes(router, {
    db,
    snapshots,
    tokens,
    /**
     * Compile a proposed configuration in a transaction that is rolled back.
     *
     * Applying the patch for real and undoing it would be visible to every SDK
     * for the duration, and would write two audit rows for a change nobody
     * made. A rolled-back transaction gives the compiler exactly the rows it
     * would have seen, and leaves nothing behind.
     */
    dryRun: async (target, patch) => {
      const ROLLBACK = Symbol("featurekit: dry run rollback");
      // Per request: a shared variable would let a concurrent dry run for
      // another flag or environment overwrite this one's result during the
      // rollback await.
      let dryRunSnapshot: Snapshot | null = null;
      try {
        await db.transaction(async (tx) => {
          const scoped = tx as unknown as typeof db;
          await writeFlagConfig(
            scoped,
            target,
            { ...(patch as Record<string, unknown>), expectedVersion: target.version } as never,
            {
              kind: "token",
              tokenId: "dry-run",
              memberId: "00000000-0000-0000-0000-000000000000",
              memberEmail: "dry-run@featurekit",
              role: "owner",
              environmentIds: null,
            },
            { action: "flag.dry_run" },
          );
          dryRunSnapshot = compileSnapshot(
            await loadCompilerInput(scoped, target.environmentId, {
              maxSegmentMembers: config.SEGMENT_MEMBER_CEILING,
              memberPageSize: config.SEGMENT_MEMBER_PAGE_SIZE,
            }),
            { version: target.version + 1 },
          );
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) throw error;
      }
      if (dryRunSnapshot === null) throw new Error("featurekit: dry run produced no snapshot");
      return dryRunSnapshot;
    },
    // A revoked key must stop working now, not when its cache entry expires.
    onKeyRevoked: () => sdkKeys.invalidateAll(),
    // `Secure` cookies cannot be set over plain HTTP, and development is plain
    // HTTP. Production is not.
    secureCookies: config.NODE_ENV === "production",
    onError: (error) => logger.warn({ err: error }, "admin route error"),
  });
  }

  const server = new HttpServer({
    router,
    host: config.HOST,
    port: config.PORT,
    sse,
    shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
    middleware: [
      corsMiddleware({
        allowedOrigins: commaList(config.CORS_ALLOWED_ORIGINS),
        routes: CLIENT_ROUTES,
      }),
      rateLimitMiddleware({
        overrides: parseRateLimitOverrides(config.RATE_LIMIT_OVERRIDES, logger),
        limiter: new RateLimiter(),
        rules: rateLimitRules(config),
        onLimited: (ctx) => metrics.rateLimited.inc({ route: ctx.routePattern }),
      }),
    ],
    onRequest: (fields) => {
      metrics.httpRequests.inc({
        route: fields.route,
        method: fields.method,
        // The status *class*, not the code: 5 series instead of 40, and nobody
        // has ever alerted on the difference between 401 and 403 in aggregate.
        status: `${Math.floor(fields.status / 100)}xx`,
      });
      metrics.httpDuration.observe(
        { route: fields.route, method: fields.method },
        fields.durationMs / 1000,
      );
      // SSE requests are logged when they end, which for a stream is hours
      // later; that is correct, and their duration is the connection lifetime.
      // The trace id is in `fields`, so a slow flag fetch seen by the calling
      // service can be found here without knowing featurekit's request id.
      logger.debug(fields, "request");
    },
    onError: (error, ctx) => logger.error({ err: error, ...ctx }, "unhandled request error"),
  });

  registerOpsRoutes(router, {
    metrics,
    checkDatabase: async () => {
      // One round trip that is also the reachability check.
      const schema = await inspectSchema(db, config.DATABASE_SCHEMA);
      return schema.state === "ok"
        ? { state: "ok" }
        : { state: "failed", detail: `schema ${schema.state}` };
    },
    partitionRunwayDays: () => partitionRunwayDays(db),
    snapshotAges: () => snapshots.ages(),
    minimumRunwayDays: config.PARTITION_RUNWAY_MIN_DAYS,
    isShuttingDown: () => server.isShuttingDown,
    version: process.env["FEATUREKIT_VERSION"] ?? "dev",
  });

  /* ── the dashboard ─────────────────────────────────────────────────── */

  // Served by the node that serves the API, so there is one URL to remember and
  // no CORS between the UI and the endpoints it calls. A node that does not run
  // the API has no dashboard to serve either.
  if (services.has("api") && config.DASHBOARD !== "off") {
    registerDashboardRoutes(router, {
      distDir:
        config.DASHBOARD === ""
          ? join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "dist")
          : config.DASHBOARD,
      basePath: config.DASHBOARD_PATH,
      onError: (error) => logger.debug({ err: error }, "dashboard asset stream ended early"),
    });
  }

  /* ── preflight ─────────────────────────────────────────────────────── */

  for (const pattern of CLIENT_ROUTES) {
    // The router matches on method, so without an OPTIONS route a preflight is
    // a 405 and the browser never sends the POST behind it.
    router.add("OPTIONS", pattern, () => ({ status: 204 }));
  }

  return {
    server,
    router,
    db,
    store,
    snapshots,
    metrics,
    logger,

    async verifyDatabase() {
      await verifySchema(db, config.DATABASE_SCHEMA);
    },

    async listen() {
      if (services.has("rollup")) rollup.start();
      if (services.has("scheduler")) scheduler.start();
      const address = await server.listen();
      logger.info({ ...address, nodeEnv: config.NODE_ENV }, "featurekit control plane listening");

      // Warm the snapshot cache in the background. A node that has already
      // compiled every environment answers its first SDK connection from memory
      // instead of making that SDK wait for a compile — and it means the
      // last-known-good path has something to fall back to from the first
      // second, not from the first successful request.
      void (async () => {
        try {
          for (const environment of await listEnvironments(db)) {
            await snapshots.get(environment.id).catch((error: unknown) => {
              logger.warn({ err: error, environment: environment.key }, "warm failed");
            });
          }
        } catch (error) {
          logger.warn({ err: error }, "could not enumerate environments to warm");
        }
      })();

      return address;
    },

    /**
     * Shutdown, in the order that keeps a rolling deploy quiet.
     *
     * Readiness fails first (inside `server.close`), then streams are drained
     * with a jittered reconnect hint, then the workers stop — each flushing what
     * it holds — and only then do the database handles close.
     */
    async close() {
      await server.close();
      await snapshots.close();
      await scheduler.close();
      await rollup.close();
      await store.close().catch(() => undefined);
      await listener?.close();
      await closeDatabase();
      logger.info("featurekit control plane stopped");
    },
  };
}

/**
 * Call at most once per interval, dropping the rest.
 *
 * For events that arrive in floods during exactly the incident you are trying to
 * read the logs through.
 */
function throttled<T>(fn: (value: T) => void, intervalMs: number): (value: T) => void {
  let last = 0;
  return (value: T) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    fn(value);
  };
}

/**
 * Parse `env:route:limit` triples into a lookup.
 *
 * Route patterns contain colons (`/v1/snapshot/:envKey`), so the split is from
 * the ends inward rather than a naive `split(":")` — which would truncate every
 * pattern at its first parameter and silently apply no override at all.
 */
function parseRateLimitOverrides(
  raw: string,
  logger: Logger,
): (environmentKey: string, routePattern: string) => RateLimitRule | undefined {
  const table = new Map<string, RateLimitRule>();

  for (const entry of commaList(raw)) {
    const firstColon = entry.indexOf(":");
    const lastColon = entry.lastIndexOf(":");
    const limit = Number(entry.slice(lastColon + 1));
    if (firstColon <= 0 || lastColon <= firstColon || !Number.isFinite(limit) || limit < 1) {
      // Loud but not fatal: a typo in one override must not stop the process
      // from starting with the defaults for everything else.
      logger.warn({ entry }, "ignoring malformed RATE_LIMIT_OVERRIDES entry");
      continue;
    }
    table.set(`${entry.slice(0, firstColon)} ${entry.slice(firstColon + 1, lastColon)}`, {
      limit,
      windowMs: 60_000,
    });
  }

  return (environmentKey, routePattern) => table.get(`${environmentKey} ${routePattern}`);
}

/**
 * Per-route limits.
 *
 * The numbers differ by what the endpoint costs. `/v1/client/state` evaluates
 * every client-available flag against a caller-supplied context, so it is the
 * most expensive thing an untrusted caller can ask for and gets the tightest
 * per-identity ceiling relative to its cost. `/v1/stream` is limited on
 * *connection attempts*, which is what a reconnect storm consists of.
 */
function rateLimitRules(config: FeaturekitConfig): Map<string, RateLimitRule> {
  const perMinute = (limit: number): RateLimitRule => ({ limit, windowMs: 60_000 });
  return new Map<string, RateLimitRule>([
    ["/v1/client/state", perMinute(config.RATE_LIMIT_CLIENT_STATE_PER_MIN)],
    ["/v1/client/stream", perMinute(config.RATE_LIMIT_STREAM_PER_MIN)],
    ["/v1/snapshot/:envKey", perMinute(config.RATE_LIMIT_SNAPSHOT_PER_MIN)],
    ["/v1/stream/:envKey", perMinute(config.RATE_LIMIT_STREAM_PER_MIN)],
    ["/v1/events", perMinute(config.RATE_LIMIT_EVENTS_PER_MIN)],
    ["/v1/admin/auth/login", perMinute(config.RATE_LIMIT_LOGIN_PER_MIN)],
    ["/v1/admin/projects", perMinute(config.RATE_LIMIT_ADMIN_PER_MIN)],
    ["/v1/admin/projects/:project/flags", perMinute(config.RATE_LIMIT_ADMIN_PER_MIN)],
    [
      "/v1/admin/projects/:project/environments/:env/flags/:flag",
      perMinute(config.RATE_LIMIT_ADMIN_PER_MIN),
    ],
    [
      "/v1/admin/projects/:project/environments/:env/segments/:segment/members",
      perMinute(config.RATE_LIMIT_ADMIN_PER_MIN),
    ],
  ]);
}

/** Re-exported so tests can assert the tier split without importing the app. */
export { CLIENT_ROUTES, checkKey };
