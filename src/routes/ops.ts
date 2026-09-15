/**
 * Operational endpoints (§15, §16).
 *
 * ```
 * GET /live     process is alive        — never touches a dependency
 * GET /ready    safe to route traffic   — Postgres, Redis, partition runway
 * GET /health   human-readable detail
 * GET /metrics  Prometheus exposition
 * ```
 *
 * **Liveness and readiness are different questions and must never share an
 * implementation.** A liveness probe that checks Postgres restarts every API
 * node during a database blip — turning a degraded system into an outage, and
 * doing it at the exact moment the control plane most needs to keep serving its
 * last-known-good snapshots (§14). Liveness answers "is this process wedged";
 * readiness answers "should the load balancer send me work".
 *
 * Readiness deliberately fails on **partition runway below two days**. That is
 * the §7.9 failure nobody sees coming: partitions stop being created, inserts
 * keep succeeding until the last premade partition ends, and then the analytics
 * ingest path starts throwing at midnight. Two days of warning is the whole
 * point of `p_premake => 7`.
 */

import type { RequestContext, Router } from "../http/router.js";
import type { Metrics } from "../observability/metrics.js";

export type CheckState = "ok" | "degraded" | "failed";

export interface CheckResult {
  state: CheckState;
  /** Never an exception message: readiness output is effectively public. */
  detail?: string;
}

export interface OpsDeps {
  metrics: Metrics;
  /** Round-trips a trivial query. Truth is in Postgres, so this gates readiness. */
  checkDatabase: () => Promise<CheckResult>;
  /**
   * Redis is a cache and a bus (§8), so its loss is `degraded`, never `failed`:
   * a node that can still serve last-known-good snapshots from memory is a node
   * that should keep receiving traffic. Pulling it out of the load balancer
   * during a Redis outage is how a cache incident becomes a flag outage.
   */
  checkRedis: () => Promise<CheckResult>;
  /** Backed by `featkit_partition_runway_days()`. */
  partitionRunwayDays: () => Promise<number>;
  /** Oldest snapshot this node is serving, per environment key. */
  snapshotAges?: () => Map<string, number>;
  minimumRunwayDays?: number;
  /** Flipped by the shutdown sequence so the LB drains before the socket closes. */
  isShuttingDown?: () => boolean;
  /** Readiness is cached briefly: a probe every second must not query per call. */
  cacheMs?: number;
  version?: string;
}

interface Snapshotted {
  at: number;
  body: ReadyBody;
  ready: boolean;
}

interface ReadyBody {
  status: "ok" | "degraded" | "shutting_down" | "not_ready";
  version: string;
  checks: Record<string, CheckResult>;
  snapshotAgeSeconds?: Record<string, number>;
}

export function registerOpsRoutes(router: Router, deps: OpsDeps): Router {
  const minimumRunway = deps.minimumRunwayDays ?? 2;
  const cacheMs = deps.cacheMs ?? 2_000;
  let cached: Snapshotted | null = null;

  async function evaluateReadiness(): Promise<Snapshotted> {
    const now = Date.now();
    if (cached !== null && now - cached.at < cacheMs) return cached;

    const [database, redis, runway] = await Promise.all([
      deps.checkDatabase().catch((): CheckResult => ({ state: "failed", detail: "unreachable" })),
      deps.checkRedis().catch((): CheckResult => ({ state: "degraded", detail: "unreachable" })),
      deps.partitionRunwayDays().catch(() => -1),
    ]);

    deps.metrics.partitionRunwayDays.set(runway);

    const partitions: CheckResult =
      runway < 0
        ? { state: "failed", detail: "no partitions found" }
        : runway < minimumRunway
          ? { state: "failed", detail: `${runway}d runway, minimum ${minimumRunway}d` }
          : { state: "ok", detail: `${runway}d` };

    const checks: Record<string, CheckResult> = { database, redis, partitions };
    const ages = deps.snapshotAges?.();

    // Readiness fails on a hard dependency only. `degraded` keeps the node in
    // rotation and says so in the body, which is what an operator reads next.
    const failed = Object.values(checks).some((c) => c.state === "failed");
    const degraded = Object.values(checks).some((c) => c.state === "degraded");

    const body: ReadyBody = {
      status: failed ? "not_ready" : degraded ? "degraded" : "ok",
      version: deps.version ?? "unknown",
      checks,
      ...(ages !== undefined && ages.size > 0
        ? { snapshotAgeSeconds: Object.fromEntries(ages) }
        : {}),
    };

    cached = { at: now, body, ready: !failed };
    return cached;
  }

  /* ── GET /live ──────────────────────────────────────────────────────── */

  router.get("/live", (ctx: RequestContext) => {
    void ctx;
    // 503 while draining, so the load balancer stops sending new work before
    // the process stops accepting it (§16 rolling deploys).
    if (deps.isShuttingDown?.() === true) {
      return { status: 503, body: { status: "shutting_down" } };
    }
    return { status: 200, body: { status: "ok" } };
  });

  /* ── GET /ready ─────────────────────────────────────────────────────── */

  router.get("/ready", async () => {
    if (deps.isShuttingDown?.() === true) {
      return { status: 503, body: { status: "shutting_down" } };
    }
    const result = await evaluateReadiness();
    return { status: result.ready ? 200 : 503, body: result.body };
  });

  /* ── GET /health ────────────────────────────────────────────────────── */

  router.get("/health", async () => {
    const result = await evaluateReadiness();
    // Always 200: this endpoint is for a human or a dashboard, and a 503 here
    // makes people wire it to a probe, which is what `/ready` is for.
    return { status: 200, body: result.body };
  });

  /* ── GET /metrics ───────────────────────────────────────────────────── */

  router.get("/metrics", async () => {
    const { body, contentType } = await deps.metrics.scrape();
    return { status: 200, body, headers: { "content-type": contentType } };
  });

  return router;
}
