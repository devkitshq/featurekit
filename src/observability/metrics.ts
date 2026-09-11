/**
 * Prometheus metrics (§15, §17).
 *
 * **The failure mode this file is built around is not "no metrics". It is
 * "metrics that take the system down."** A label whose value is a flag key, a
 * context key, or a tenant id creates one time series per distinct value.
 * 100k flags is 100k series per metric; a context key is one series per end
 * user. That kills the scrape, then the Prometheus, then — because the process
 * is holding every one of those series in a Map — this process.
 *
 * So:
 *
 * - **No metric here takes a context key, user id, or flag key as a label.**
 *   Per-flag numbers belong in `evaluation_summaries`, which is partitioned and
 *   retained on purpose (§7.9).
 * - Environment appears as a label because operators genuinely need
 *   per-environment snapshot age, but it goes through `bounded()`, which caps
 *   distinct values and collapses the overflow into `"other"`. A runaway label
 *   degrades a dashboard instead of the process.
 * - Route labels are route *patterns* (`/v1/snapshot/:envKey`), never request
 *   paths. Otherwise every environment key becomes a series.
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

/** Beyond this many distinct values for one label, everything else is `"other"`. */
const DEFAULT_LABEL_CEILING = 200;

/**
 * A bounded label vocabulary.
 *
 * Deliberately a plain Set with a ceiling rather than an LRU: an LRU would
 * evict, and an evicted-then-readmitted label value resets its counter, which
 * shows up as a metric that goes backwards. Collapsing to `"other"` is lossy in
 * a way an operator can see and reason about.
 */
export class BoundedLabels {
  private readonly seen = new Set<string>();
  constructor(private readonly ceiling: number = DEFAULT_LABEL_CEILING) {}

  value(raw: string): string {
    if (this.seen.has(raw)) return raw;
    if (this.seen.size >= this.ceiling) return "other";
    this.seen.add(raw);
    return raw;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface MetricsOptions {
  registry?: Registry;
  /** Node process metrics (heap, GC, event-loop lag). On by default. */
  defaultMetrics?: boolean;
  labelCeiling?: number;
}

export class Metrics {
  readonly registry: Registry;
  private readonly environments: BoundedLabels;
  private readonly sdkNames: BoundedLabels;
  private readonly sdkVersions: BoundedLabels;

  /* ── HTTP ─────────────────────────────────────────────────────────── */

  readonly httpRequests: Counter<"route" | "method" | "status">;
  readonly httpDuration: Histogram<"route" | "method">;
  readonly rateLimited: Counter<"route">;

  /* ── Snapshots: the series that answer "is a flag change reaching SDKs" ── */

  readonly snapshotVersion: Gauge<"environment">;
  readonly snapshotAgeSeconds: Gauge<"environment">;
  readonly snapshotCompileDuration: Histogram<never>;
  readonly snapshotCompileFailures: Counter<"reason">;
  /** Serving a snapshot Redis could not supply. The §22 "silently stale" alarm. */
  readonly snapshotDegradedServes: Counter<"source">;

  /* ── Delivery ─────────────────────────────────────────────────────── */

  readonly streamConnections: Gauge<"tier">;
  readonly streamEvents: Counter<"tier" | "op">;
  readonly streamRejections: Counter<"tier" | "reason">;

  /* ── Analytics ────────────────────────────────────────────────────── */

  readonly eventsIngested: Counter<never>;
  readonly eventsDropped: Counter<"reason">;
  readonly rollupWritten: Counter<never>;
  readonly rollupLagSeconds: Gauge<never>;
  readonly rollupDlq: Counter<"reason">;

  /* ── Database ─────────────────────────────────────────────────────── */

  readonly partitionRunwayDays: Gauge<never>;
  readonly dbErrors: Counter<"operation">;

  /**
   * Which SDK versions are connected.
   *
   * The question this answers is the one asked during an incident: "is this
   * happening to everyone, or only to the fleet still on 0.1.2?" Without it the
   * only way to find out is to ask every team.
   *
   * Labelled by SDK name and version, both bounded — a malicious or broken
   * client could otherwise mint a series per request, which is the §17
   * cardinality explosion with extra steps.
   */
  readonly sdkConnections: Counter<"sdk" | "version">;

  /* ── SDK-reported ─────────────────────────────────────────────────── */

  /**
   * Evaluations that fell back to the caller's default. Not per-flag: the flag
   * breakdown is in `evaluation_summaries`. This series exists so a single
   * alert can catch "a whole fleet is serving defaults" without 100k series.
   */
  readonly defaultServed: Counter<"environment">;

  constructor(options: MetricsOptions = {}) {
    this.registry = options.registry ?? new Registry();
    this.environments = new BoundedLabels(options.labelCeiling ?? DEFAULT_LABEL_CEILING);
    // Tighter ceilings: a deployment has a handful of SDKs and a handful of
    // versions in flight. Anything beyond that is noise or an attack.
    this.sdkNames = new BoundedLabels(20);
    this.sdkVersions = new BoundedLabels(50);
    const registers = [this.registry];

    if (options.defaultMetrics !== false) {
      collectDefaultMetrics({ register: this.registry, prefix: "featurekit_" });
    }

    this.httpRequests = new Counter({
      name: "featurekit_http_requests_total",
      help: "HTTP requests by route pattern, method and status class",
      labelNames: ["route", "method", "status"],
      registers,
    });
    this.httpDuration = new Histogram({
      name: "featurekit_http_request_duration_seconds",
      help: "HTTP request duration by route pattern",
      labelNames: ["route", "method"],
      // Tuned for this system: a snapshot poll is single-digit ms, a compile is
      // hundreds. Buckets past 10s are pointless — the client is long gone.
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    });
    this.rateLimited = new Counter({
      name: "featurekit_rate_limited_total",
      help: "Requests rejected by the rate limiter",
      labelNames: ["route"],
      registers,
    });

    this.snapshotVersion = new Gauge({
      name: "featurekit_snapshot_version",
      help: "Current compiled snapshot version per environment",
      labelNames: ["environment"],
      registers,
    });
    this.snapshotAgeSeconds = new Gauge({
      name: "featurekit_snapshot_age_seconds",
      help: "Seconds since this node last compiled or fetched a snapshot",
      labelNames: ["environment"],
      registers,
    });
    this.snapshotCompileDuration = new Histogram({
      name: "featurekit_snapshot_compile_duration_seconds",
      help: "Time to compile one environment's snapshot from Postgres rows",
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers,
    });
    this.snapshotCompileFailures = new Counter({
      name: "featurekit_snapshot_compile_failures_total",
      help: "Compiles that threw, leaving the previous snapshot serving",
      labelNames: ["reason"],
      registers,
    });
    this.snapshotDegradedServes = new Counter({
      name: "featurekit_snapshot_degraded_serves_total",
      help: "Snapshots served from a fallback source because Redis was unavailable",
      labelNames: ["source"],
      registers,
    });

    this.streamConnections = new Gauge({
      name: "featurekit_stream_connections",
      help: "Open SSE connections on this node",
      labelNames: ["tier"],
      registers,
    });
    this.streamEvents = new Counter({
      name: "featurekit_stream_events_total",
      help: "SSE events written, by tier and event name",
      labelNames: ["tier", "op"],
      registers,
    });
    this.streamRejections = new Counter({
      name: "featurekit_stream_rejections_total",
      help: "Stream connections refused, by reason",
      labelNames: ["tier", "reason"],
      registers,
    });

    this.eventsIngested = new Counter({
      name: "featurekit_events_ingested_total",
      help: "Evaluation summary rows accepted from SDKs",
      registers,
    });
    this.eventsDropped = new Counter({
      name: "featurekit_events_dropped_total",
      help: "Summary rows dropped, by reason. Analytics is explicitly lossy (§14)",
      labelNames: ["reason"],
      registers,
    });
    this.rollupWritten = new Counter({
      name: "featurekit_rollup_rows_written_total",
      help: "Rows written into evaluation_summaries",
      registers,
    });
    this.rollupLagSeconds = new Gauge({
      name: "featurekit_rollup_lag_seconds",
      help: "Age of the oldest buffered summary awaiting rollup",
      registers,
    });
    this.rollupDlq = new Counter({
      name: "featurekit_rollup_dlq_total",
      help: "Batches diverted to the dead-letter queue",
      labelNames: ["reason"],
      registers,
    });

    this.partitionRunwayDays = new Gauge({
      name: "featurekit_partition_runway_days",
      help: "Days of pre-created evaluation_summaries partitions remaining",
      registers,
    });
    this.dbErrors = new Counter({
      name: "featurekit_db_errors_total",
      help: "Database operations that failed, by operation name",
      labelNames: ["operation"],
      registers,
    });

    this.sdkConnections = new Counter({
      name: "featurekit_sdk_connections_total",
      help: "SDK connections by reported name and version, for skew detection",
      labelNames: ["sdk", "version"],
      registers,
    });

    this.defaultServed = new Counter({
      name: "featurekit_sdk_default_served_total",
      help: "Evaluations reported by SDKs that fell back to the caller's default",
      labelNames: ["environment"],
      registers,
    });
  }

  /** Bound an environment key before it becomes a label. Always use this. */
  env(environmentKey: string): string {
    return this.environments.value(environmentKey);
  }

  /**
   * Record a connecting SDK's self-reported identity.
   *
   * The header is attacker-controlled, so it is parsed strictly and bounded:
   * anything unrecognised collapses to `"unknown"` rather than becoming a new
   * time series.
   */
  recordSdkVersion(userAgent: string | undefined): void {
    const parsed = parseSdkUserAgent(userAgent);
    this.sdkConnections.inc({
      sdk: this.sdkNames.value(parsed.sdk),
      version: this.sdkVersions.value(parsed.version),
    });
  }

  async scrape(): Promise<{ body: string; contentType: string }> {
    return {
      body: await this.registry.metrics(),
      contentType: this.registry.contentType,
    };
  }
}

/**
 * Parse a featurekit SDK user agent: `featurekit-node/0.1.0`.
 *
 * Strict by design. The value arrives in a header from a client that may be
 * hostile, and a permissive parser here is a per-request time series — the
 * exact cardinality failure this file exists to prevent.
 */
export function parseSdkUserAgent(userAgent: string | undefined): {
  sdk: string;
  version: string;
} {
  if (userAgent === undefined) return { sdk: "unknown", version: "unknown" };
  const match = /^(featurekit-[a-z]{1,20})\/(\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.]{1,20})?)/.exec(
    userAgent.trim(),
  );
  if (match === null) return { sdk: "unknown", version: "unknown" };
  return { sdk: match[1]!, version: match[2]! };
}
