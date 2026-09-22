/**
 * Operational endpoints (§15, §16).
 *
 * The assertions that matter here are the ones about *which* failures take a
 * node out of rotation. Getting that backwards is how a Redis blip becomes a
 * full outage: if readiness failed on Redis, every node would leave the load
 * balancer at the same moment, while each of them was still perfectly capable
 * of serving last-known-good snapshots.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { registerOpsRoutes, type CheckResult } from "../../src/routes/ops.js";
import { Metrics, parseSdkUserAgent } from "../../src/observability/metrics.js";

const servers: HttpServer[] = [];

interface Overrides {
  database?: () => Promise<CheckResult>;
  redis?: () => Promise<CheckResult>;
  runway?: () => Promise<number>;
  shuttingDown?: boolean;
}

async function serve(over: Overrides = {}) {
  const metrics = new Metrics({ defaultMetrics: false });
  const router = new Router();
  registerOpsRoutes(router, {
    metrics,
    checkDatabase: over.database ?? (async () => ({ state: "ok" })),
    checkRedis: over.redis ?? (async () => ({ state: "ok" })),
    partitionRunwayDays: over.runway ?? (async () => 7),
    snapshotAges: () => new Map([["env-1", 12]]),
    isShuttingDown: () => over.shuttingDown === true,
    cacheMs: 0,
    version: "test",
  });
  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { host, port } = await server.listen();
  return { base: `http://${host}:${port}`, metrics };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("GET /live", () => {
  it("does not touch a dependency", async () => {
    // The whole point of liveness: a dead database must not restart every node.
    const { base } = await serve({
      database: async () => {
        throw new Error("postgres is gone");
      },
      redis: async () => {
        throw new Error("redis is gone");
      },
    });
    const response = await fetch(`${base}/live`);
    expect(response.status).toBe(200);
  });

  it("reports 503 once shutdown has begun", async () => {
    const { base } = await serve({ shuttingDown: true });
    expect((await fetch(`${base}/live`)).status).toBe(503);
  });
});

describe("GET /ready", () => {
  it("is ready when everything is healthy", async () => {
    const { base } = await serve();
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; snapshotAgeSeconds: unknown };
    expect(body.status).toBe("ok");
    expect(body.snapshotAgeSeconds).toEqual({ "env-1": 12 });
  });

  it("stays in rotation when Redis is unreachable", async () => {
    // Redis is a cache and a bus (§8). A node that can still serve its
    // last-known-good snapshots should keep receiving traffic.
    const { base } = await serve({ redis: async () => ({ state: "degraded", detail: "unreachable" }) });
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("degraded");
  });

  it("leaves rotation when Postgres is unreachable", async () => {
    const { base } = await serve({ database: async () => ({ state: "failed" }) });
    expect((await fetch(`${base}/ready`)).status).toBe(503);
  });

  it("fails below two days of partition runway", async () => {
    // The §7.9 failure nobody sees coming: partitions stop being created,
    // inserts keep working until the last premade one ends, and then ingest
    // throws at midnight. Two days is the warning.
    const { base } = await serve({ runway: async () => 1 });
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: Record<string, CheckResult> };
    expect(body.checks["partitions"]?.state).toBe("failed");
  });

  it("treats a missing partition function as failed, not as healthy", async () => {
    // -1 means the migration never ran. That must not read as "fine".
    const { base } = await serve({ runway: async () => -1 });
    expect((await fetch(`${base}/ready`)).status).toBe(503);
  });

  it("does not leak an exception message", async () => {
    const { base } = await serve({
      database: async () => {
        throw new Error("postgres://user:hunter2@db/featurekit refused");
      },
    });
    const body = await (await fetch(`${base}/ready`)).text();
    expect(body).not.toContain("hunter2");
  });
});

describe("GET /metrics", () => {
  it("serves Prometheus text, not JSON-encoded text", async () => {
    const { base, metrics } = await serve();
    metrics.eventsIngested.inc(3);
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("featurekit_events_ingested_total 3");
    expect(body.startsWith('"')).toBe(false);
  });

  it("exports the partition runway gauge readiness computed", async () => {
    const { base } = await serve({ runway: async () => 5 });
    await fetch(`${base}/ready`);
    expect(await (await fetch(`${base}/metrics`)).text()).toContain(
      "featurekit_partition_runway_days 5",
    );
  });
});

describe("metric cardinality", () => {
  it("collapses environment labels past the ceiling instead of growing forever", async () => {
    // §17: a deployment with 10,000 environments must not create 10,000 series.
    const metrics = new Metrics({ defaultMetrics: false, labelCeiling: 3 });
    const labels = ["a", "b", "c", "d", "e"].map((key) => metrics.env(key));
    expect(labels).toEqual(["a", "b", "c", "other", "other"]);
    // A label already admitted stays admitted, so counters never reset.
    expect(metrics.env("a")).toBe("a");
  });
});

describe("SDK version skew", () => {
  it("records a well-formed SDK user agent", () => {
    const metrics = new Metrics({ defaultMetrics: false });
    metrics.recordSdkVersion("featurekit-node/1.2.3");
    metrics.recordSdkVersion("featurekit-node/1.2.3");
    metrics.recordSdkVersion("featurekit-browser/0.9.0-beta.1");
    // The question this answers during an incident: is it everyone, or only
    // the fleet still on the old version?
    expect(parseSdkUserAgent("featurekit-node/1.2.3")).toEqual({
      sdk: "featurekit-node",
      version: "1.2.3",
    });
    expect(parseSdkUserAgent("featurekit-node/1.2.3")).toEqual({
      sdk: "featurekit-node",
      version: "1.2.3",
    });
  });

  it("collapses anything it does not recognise", () => {
    // The header is attacker-controlled. A permissive parser here is one time
    // series per request (§17).
    for (const agent of [
      undefined,
      "",
      "curl/8.4.0",
      "featurekit-node",
      "featurekit-node/not-a-version",
      `featurekit-node/${"9".repeat(500)}`,
      "featurekit-<script>/1.0.0",
      "featurekit-node",
    ]) {
      expect(parseSdkUserAgent(agent)).toEqual({ sdk: "unknown", version: "unknown" });
    }
  });

  it("bounds the number of version series a client can create", async () => {
    const metrics = new Metrics({ defaultMetrics: false });
    for (let i = 0; i < 500; i++) metrics.recordSdkVersion(`featurekit-node/1.0.${i}`);
    const scrape = await metrics.scrape();
    const series = scrape.body.split("\n").filter((l) => l.startsWith("featurekit_sdk_connections_total"));
    expect(series.length).toBeLessThan(60);
    expect(scrape.body).toContain('version="other"');
  });
});
