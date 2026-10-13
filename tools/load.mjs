/**
 * System-level load measurement (PR-C2).
 *
 * `tools/bench.mjs` measures the evaluator in isolation, which is the number
 * §1 argues about. This measures the parts a capacity plan actually needs and
 * that a micro-benchmark cannot see: HTTP round trips, SSE fan-out across many
 * connections, snapshot compilation as flag counts grow, and the analytics
 * drain. Latency is reported as a distribution, because a p50 tells you nothing
 * about the request that timed out.
 *
 * **Every number this prints is measured on the machine it ran on.** It is not
 * a projection, and the capacity table in `docs/ops/deployment.md` cites it
 * with the hardware named. Extrapolating from one laptop to a fleet is the
 * reader's job, and the report says so.
 *
 * Run: npm run build && node tools/load.mjs [--connections 2000] [--quick]
 */

import { createRequire } from "node:module";
import { Router } from "../dist/http/router.js";
import { HttpServer } from "../dist/http/server.js";
import { MemorySnapshotStore } from "../dist/redis/memory-store.js";
import { SnapshotService } from "../dist/snapshot/service.js";
import { registerSdkRoutes } from "../dist/routes/sdk.js";
import { registerClientRoutes } from "../dist/routes/client.js";
import { compileSnapshot } from "../dist/snapshot/compile.js";
import { EventBuffer } from "../dist/events/ingest.js";
import { ClientFanout } from "../dist/evaluation-service/fanout.js";

const require = createRequire(import.meta.url);
void require;

const args = process.argv.slice(2);
const flagOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const quick = args.includes("--quick");

const CONNECTIONS = flagOf("connections", quick ? 200 : 2_000);
const REQUESTS = flagOf("requests", quick ? 500 : 5_000);

/* ─────────────────────────── measurement ─────────────────────────────── */

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: at(50), p95: at(95), p99: at(99), p999: at(99.9), max: sorted[sorted.length - 1] };
}

function report(label, samples, extra = "") {
  const p = percentiles(samples);
  const fmt = (n) => `${n.toFixed(2)}ms`;
  console.log(
    `| ${label} | ${samples.length} | ${fmt(p.p50)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ` +
      `${fmt(p.p999)} | ${fmt(p.max)} | ${extra} |`,
  );
}

async function timed(fn) {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/* ─────────────────────────── fixtures ────────────────────────────────── */

const ENV_ID = "env-load";

function input(flagCount, { rollout = false } = {}) {
  const flags = [];
  const variations = [];
  const flagEnvironments = [];
  const rules = [];
  const clauses = [];

  for (let i = 0; i < flagCount; i++) {
    const id = `flag-${i}`;
    flags.push({ id, key: `flag-${i}`, kind: "boolean", archivedAt: null, clientAvailable: true });
    variations.push(
      { id: `${id}-v0`, flagId: id, idx: 0, value: false },
      { id: `${id}-v1`, flagId: id, idx: 1, value: true },
    );
    flagEnvironments.push({
      id: `fe-${i}`,
      flagId: id,
      environmentId: ENV_ID,
      enabled: true,
      offVariationId: `${id}-v0`,
      fallthroughVariationId: rollout ? null : `${id}-v1`,
      fallthroughRollout: rollout
        ? { variations: [{ variationIndex: 0, weight: 50_000 }, { variationIndex: 1, weight: 50_000 }] }
        : null,
      version: 1,
    });
    // One targeting rule per flag, so the compile and the fan-out have
    // something to do beyond copying.
    rules.push({ id: `rule-${i}`, flagEnvironmentId: `fe-${i}`, idx: 0, variationId: `${id}-v1`, rollout: null });
    clauses.push({
      ruleId: `rule-${i}`,
      idx: 0,
      contextKind: "user",
      attribute: "country",
      op: "in",
      values: ["NL", "DE", "FR"],
      negate: false,
    });
  }

  return {
    environment: { id: ENV_ID, key: "production", bucketSalt: "salt" },
    flags,
    variations,
    flagEnvironments,
    targets: [],
    rules,
    clauses,
    prerequisites: [],
    segments: [],
    segmentMembers: [],
    segmentRules: [],
    segmentRuleClauses: [],
  };
}

const KEY = "fk_srv_load";
const CLIENT_KEY = "fk_clt_load";
const record = (kind) => ({
  id: `k-${kind}`,
  environmentId: ENV_ID,
  environmentKey: "production",
  projectId: "p1",
  isProduction: false,
  kind,
  expiresAt: null,
  revokedAt: null,
});

async function controlPlane(flagCount) {
  const store = new MemorySnapshotStore();
  let version = 0;
  const snapshots = new SnapshotService({
    store,
    loadInput: async () => input(flagCount),
    nextVersion: async () => ++version,
    debounceMs: 5,
  });

  const router = new Router();
  registerSdkRoutes(router, {
    snapshots,
    store,
    authenticate: async (k) => (k === KEY ? record("server") : null),
    heartbeatMs: 60_000,
  });
  registerClientRoutes(router, {
    snapshots,
    store,
    authenticate: async (k) => (k === CLIENT_KEY ? record("client") : null),
    heartbeatMs: 60_000,
    maxClientConnections: 200_000,
  });

  const server = new HttpServer({ router, port: 0 });
  const { host, port } = await server.listen();
  return { base: `http://${host}:${port}`, server, snapshots, store };
}

/* ─────────────────────────────── runs ────────────────────────────────── */

console.log(`featurekit load report`);
console.log(`node ${process.version}  ${process.platform}/${process.arch}  ${new Date().toISOString()}`);
console.log(`connections=${CONNECTIONS} requests=${REQUESTS}\n`);
console.log("| Scenario | n | p50 | p95 | p99 | p99.9 | max | notes |");
console.log("| :-- | --: | --: | --: | --: | --: | --: | :-- |");

/* 1. Snapshot compile as the flag count grows. */
for (const flagCount of quick ? [100, 1_000] : [100, 1_000, 10_000]) {
  const rows = input(flagCount);
  const samples = [];
  for (let i = 0; i < (flagCount >= 10_000 ? 3 : 10); i++) {
    samples.push(await timed(async () => compileSnapshot(rows, { version: i + 1 })));
  }
  const snapshot = compileSnapshot(rows, { version: 1 });
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  report(`compile ${flagCount} flags`, samples, `snapshot ${mb(bytes)}`);
}

/* 2. Polling: GET /v1/snapshot, the request every SDK makes. */
{
  const cp = await controlPlane(500);
  await cp.snapshots.get(ENV_ID);
  const samples = [];
  for (let i = 0; i < REQUESTS; i++) {
    samples.push(
      await timed(async () => {
        const response = await fetch(`${cp.base}/v1/snapshot/production`, {
          headers: { authorization: `Bearer ${KEY}` },
        });
        await response.arrayBuffer();
      }),
    );
  }
  report("GET /v1/snapshot (500 flags)", samples, `${(REQUESTS / (samples.reduce((a, b) => a + b, 0) / 1000)).toFixed(0)}/s`);

  /* 3. The same request, already current: 304 with no body. */
  const first = await fetch(`${cp.base}/v1/snapshot/production`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  const etag = first.headers.get("etag");
  await first.arrayBuffer();
  const cached = [];
  for (let i = 0; i < REQUESTS; i++) {
    cached.push(
      await timed(async () => {
        const response = await fetch(`${cp.base}/v1/snapshot/production`, {
          headers: { authorization: `Bearer ${KEY}`, "if-none-match": etag },
        });
        await response.arrayBuffer();
      }),
    );
  }
  report("GET /v1/snapshot (304)", cached);
  await cp.server.close();
  await cp.snapshots.close();
}

/* 4. Client tier: the expensive endpoint an untrusted caller can reach. */
{
  const cp = await controlPlane(200);
  const samples = [];
  for (let i = 0; i < Math.min(REQUESTS, 2_000); i++) {
    samples.push(
      await timed(async () => {
        const response = await fetch(`${cp.base}/v1/client/state`, {
          method: "POST",
          headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ context: { key: `user-${i}`, country: "NL", plan: "pro" } }),
        });
        await response.arrayBuffer();
      }),
    );
  }
  const total = samples.reduce((a, b) => a + b, 0) / 1000;
  report("POST /v1/client/state (200 flags)", samples, `${(samples.length / total).toFixed(0)}/s`);
  await cp.server.close();
  await cp.snapshots.close();
}

/* 5. Fingerprint fan-out: the §11.5 claim, measured. */
{
  const rows = input(200);
  const snapshot = compileSnapshot(rows, { version: 1 });
  const fanout = new ClientFanout();
  const countries = ["NL", "DE", "FR", "GB", "US"];
  const plans = ["free", "pro", "enterprise"];
  const connections = Array.from({ length: CONNECTIONS }, (_, i) => ({
    id: `c${i}`,
    context: {
      key: `user-${i}`,
      country: countries[i % countries.length],
      plan: plans[i % plans.length],
    },
  }));
  const changed = Object.keys(snapshot.flags).slice(0, 20);

  const samples = [];
  for (let i = 0; i < 10; i++) {
    samples.push(await timed(async () => fanout.fanout(snapshot, changed, connections)));
  }
  report(
    `fan-out ${CONNECTIONS} connections / 20 flags`,
    samples,
    `${countries.length * plans.length} distinct fingerprints`,
  );
}

/* 6. SSE: many live connections on one node. */
{
  const cp = await controlPlane(100);
  await cp.snapshots.get(ENV_ID);

  const controllers = [];
  const opened = [];
  const target = Math.min(CONNECTIONS, quick ? 200 : 1_000);
  const before = process.memoryUsage().rss;

  for (let i = 0; i < target; i++) {
    opened.push(
      await timed(async () => {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await fetch(`${cp.base}/v1/stream/production`, {
          headers: { authorization: `Bearer ${KEY}` },
          signal: controller.signal,
        });
        // Read the first event so the connection is genuinely established.
        const reader = response.body.getReader();
        await reader.read();
        reader.releaseLock();
      }),
    );
  }

  const after = process.memoryUsage().rss;
  report(
    `SSE connect (${target} streams)`,
    opened,
    `${mb(after - before)} rss delta, ${((after - before) / target / 1024).toFixed(1)}KB/conn`,
  );

  for (const controller of controllers) controller.abort();
  await cp.server.close();
  await cp.snapshots.close();
}

/* 7. Analytics ingest and drain. */
{
  const buffer = new EventBuffer({ maxRows: 500_000 });
  const batch = {
    bucketAt: Date.now(),
    summaries: Array.from({ length: 200 }, (_, i) => ({
      flagKey: `flag-${i}`,
      variationIndex: i % 2,
      reason: "FALLTHROUGH",
      count: 17,
    })),
  };

  const samples = [];
  for (let i = 0; i < 1_000; i++) {
    samples.push(await timed(async () => buffer.accept(`env-${i % 10}`, batch)));
  }
  report("ingest 200-row batch", samples, `${buffer.size} rows buffered`);

  const drain = await timed(async () => buffer.drain());
  console.log(`| drain buffered rows | 1 | ${drain.toFixed(2)}ms | | | | | in-memory only |`);
}

console.log(`\nheap used: ${mb(process.memoryUsage().heapUsed)}  rss: ${mb(process.memoryUsage().rss)}`);
process.exit(0);
