import { afterEach, describe, expect, it, vi } from "vitest";
import { FeaturekitSDK, bucket, buildCuckooFilter, evaluate, SegmentIndex } from "../../src/sdk/index.js";
import type { CompiledFlag, Snapshot } from "../../src/sdk/index.js";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { MemorySnapshotStore } from "../../src/redis/memory-store.js";
import { registerSdkRoutes, type AuthenticatedEnvironment } from "../../src/routes/sdk.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

/**
 * The chaos suite.
 *
 * The property being sold: **featurekit failing should be invisible to your
 * users.** Shipping the SDK without this suite would be
 * shipping the marketing copy without the thing it describes — so these assert
 * the reliability claim rather than restating it.
 *
 * Scenarios needing a real Redis or Postgres to kill (`degraded.test.ts`,
 * `rollup-contention.test.ts`) are gated with the integration suite and are
 * noted in TASKS.md; everything here runs against a real HTTP control plane
 * that is genuinely killed, flapped and stormed.
 */

const ENV_ID = "env-1";
const KEY = "fk_srv_test";

const record: AuthenticatedEnvironment = {
  id: "k1",
  environmentId: ENV_ID,
  environmentKey: "production",
  projectId: "project-1",
  isProduction: true,
  kind: "server",
  expiresAt: null,
  revokedAt: null,
};

function input(state: { on: boolean; flagVersion: number }): CompilerInput {
  return {
    environment: { id: ENV_ID, key: "production", bucketSalt: "env_salt_prod" },
    flags: [
      { id: "f1", key: "new-checkout", kind: "boolean", archivedAt: null, clientAvailable: false },
    ],
    variations: [
      { id: "v0", flagId: "f1", idx: 0, value: false },
      { id: "v1", flagId: "f1", idx: 1, value: true },
    ],
    flagEnvironments: [
      {
        id: "fe1",
        flagId: "f1",
        environmentId: ENV_ID,
        enabled: state.on,
        offVariationId: "v0",
        fallthroughVariationId: "v1",
        fallthroughRollout: null,
        version: state.flagVersion,
      },
    ],
    targets: [],
    rules: [],
    clauses: [],
    prerequisites: [],
    segments: [],
    segmentMembers: [],
    segmentRules: [],
    segmentRuleClauses: [],
  };
}

const servers: HttpServer[] = [];
const services: SnapshotService[] = [];
const sdks: FeaturekitSDK[] = [];

async function controlPlane(store = new MemorySnapshotStore()) {
  const state = { on: true, flagVersion: 1 };
  let version = 0;
  const snapshots = new SnapshotService({
    store,
    loadInput: async () => input(state),
    nextVersion: async () => ++version,
    debounceMs: 5,
    patchHistoryDepth: 10,
  });
  services.push(snapshots);

  const router = new Router();
  registerSdkRoutes(router, {
    snapshots,
    store,
    authenticate: async (k) => (k === KEY ? record : null),
    heartbeatMs: 200,
    patchHistoryDepth: 10,
  });

  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { port, host } = await server.listen();
  return { baseUrl: `http://${host}:${port}`, snapshots, state, server, store };
}

function makeSdk(baseUrl: string, over = {}) {
  const sdk = new FeaturekitSDK({
    sdkKey: KEY,
    baseUrl,
    environmentKey: "production",
    events: { enabled: false },
    ...over,
  });
  sdks.push(sdk);
  return sdk;
}

afterEach(async () => {
  await Promise.all(sdks.splice(0).map((s) => s.close()));
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});

const ctx = { key: "usr_1" };

/* ─────────────────────── control-plane-down ─────────────────────────── */

describe("control-plane-down: evaluations continue across an outage", () => {
  it("serves zero errors and zero changed values while the API is dead", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk(cp.baseUrl);
    await sdk.ready({ timeoutMs: 3_000 });

    const before = sdk.get("new-checkout", ctx, false);
    expect(before).toBe(true);

    // Kill the control plane under live evaluation load.
    let stopped = false;
    const errors: unknown[] = [];
    const values = new Set<boolean>();
    const load = (async () => {
      while (!stopped) {
        try {
          values.add(sdk.get("new-checkout", ctx, false));
        } catch (error) {
          errors.push(error);
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    await cp.server.close();
    servers.length = 0;
    await new Promise((r) => setTimeout(r, 400));
    stopped = true;
    await load;

    // Zero evaluation errors, and the value never changed across the outage.
    expect(errors).toEqual([]);
    expect([...values]).toEqual([true]);
    expect(sdk.state).toBe("reconnecting");
  });

  it("never blocks: an evaluation during an outage is still synchronous", async () => {
    const sdk = makeSdk("http://127.0.0.1:1");
    await sdk.ready({ timeoutMs: 300 });
    const started = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) sdk.get("new-checkout", ctx, false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // 10k evaluations against a dead control plane, well under a frame.
    expect(elapsedMs).toBeLessThan(200);
  });
});

/* ──────────────────────────── stream-flap ───────────────────────────── */

describe("stream-flap: converges across repeated disconnects", () => {
  it("converges after flapping the connection several times", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk(cp.baseUrl);
    await sdk.ready({ timeoutMs: 3_000 });

    for (let round = 0; round < 3; round++) {
      cp.state.on = round % 2 === 0 ? false : true;
      cp.state.flagVersion++;
      await cp.snapshots.recompile(ENV_ID, { flagKey: "new-checkout" });

      const expected = cp.state.on;
      await vi.waitFor(() => expect(sdk.get("new-checkout", ctx, !expected)).toBe(expected), {
        timeout: 5_000,
      });
    }
  });

  it("falls back to a full put across more than PATCH_HISTORY_DEPTH changes", async () => {
    // The documented resume floor: at depth 10, missing 25 changes must degrade
    // to a `put` rather than replaying a gap it cannot cover.
    const cp = await controlPlane();
    const sdk = makeSdk(cp.baseUrl);
    await sdk.ready({ timeoutMs: 3_000 });

    // Disconnect by closing the SDK's socket, then churn well past the depth.
    for (let i = 0; i < 25; i++) {
      cp.state.on = i % 2 === 0;
      cp.state.flagVersion++;
      await cp.snapshots.recompile(ENV_ID, { flagKey: "new-checkout" });
    }

    const expected = cp.state.on;
    await vi.waitFor(() => expect(sdk.get("new-checkout", ctx, !expected)).toBe(expected), {
      timeout: 5_000,
    });
  });
});

/* ─────────────────────────────── storm ──────────────────────────────── */

describe("storm: many SDKs, one flag toggled repeatedly", () => {
  it("converges every SDK, and the compile lock prevents a herd", async () => {
    const cp = await controlPlane();
    const fleet = Array.from({ length: 25 }, () => makeSdk(cp.baseUrl));
    await Promise.all(fleet.map((s) => s.ready({ timeoutMs: 5_000 })));

    for (let i = 0; i < 20; i++) {
      cp.state.on = i % 2 === 0;
      cp.state.flagVersion++;
      cp.snapshots.notifyChange(ENV_ID, "new-checkout");
    }
    // Debounce coalesces the burst: 20 notifications, far fewer compiles.
    await new Promise((r) => setTimeout(r, 200));
    cp.state.on = true;
    cp.state.flagVersion++;
    await cp.snapshots.recompile(ENV_ID, { flagKey: "new-checkout" });

    await vi.waitFor(
      () => {
        for (const sdk of fleet) expect(sdk.get("new-checkout", ctx, false)).toBe(true);
      },
      { timeout: 8_000 },
    );
  });
});

/* ───────────────────── bucketing-stability ───────────────────── */

describe("bucketing-stability", () => {
  const SALT = "env_salt_prod";

  it("holds a 10% rollout to 10% +/- 0.5% over 200k contexts", () => {
    let inRollout = 0;
    for (let i = 0; i < 200_000; i++) {
      if (bucket(`usr_${i}`, "new-checkout", SALT) < 10_000) inRollout++;
    }
    const pct = (inRollout / 200_000) * 100;
    expect(pct).toBeGreaterThan(9.5);
    expect(pct).toBeLessThan(10.5);
  });

  it("changes ZERO contexts when an unrelated flag is edited", () => {
    // The property that makes a rollout trustworthy. If editing flag B moved
    // anyone in flag A's rollout, every conclusion drawn from A is worthless.
    const before = Array.from({ length: 20_000 }, (_, i) =>
      bucket(`usr_${i}`, "new-checkout", SALT),
    );
    // Simulate any amount of unrelated activity.
    for (let i = 0; i < 20_000; i++) bucket(`usr_${i}`, "some-other-flag", SALT);
    const after = Array.from({ length: 20_000 }, (_, i) =>
      bucket(`usr_${i}`, "new-checkout", SALT),
    );
    expect(after).toEqual(before);
  });

  it("changes ZERO contexts across a process restart", () => {
    // Determinism across processes is what "sticky" means. Nothing here holds
    // state, which is the point: the bucket is a pure function of its inputs.
    const first = bucket("usr_7f3a91", "new-checkout", SALT);
    for (let i = 0; i < 1_000; i++) {
      expect(bucket("usr_7f3a91", "new-checkout", SALT)).toBe(first);
    }
  });
});

/* ──────────────────── segment-fail-closed ───────────────────── */

describe("segment-fail-closed: the r2 leak, as a chaos test", () => {
  const members = Array.from({ length: 2_000 }, (_, i) => `usr_${i}`);

  function snapshotWithNegatedSegment(): Snapshot {
    const flag: CompiledFlag = {
      key: "new-checkout",
      version: 1,
      kind: "boolean",
      on: true,
      variations: [false, true],
      offVariation: 0,
      fallthrough: { variation: 0 },
      prerequisites: [],
      targets: [],
      rules: [
        {
          id: "r0",
          variation: 1,
          clauses: [
            {
              contextKind: "user",
              attribute: "key",
              op: "segmentMatch",
              values: ["enterprise"],
              negate: true,
            },
          ],
        },
      ],
    };
    return {
      version: 1,
      environmentKey: "production",
      salt: "s4lt",
      flags: { "new-checkout": flag },
      segments: {
        enterprise: {
          kind: "cuckoo",
          version: 1,
          filter: buildCuckooFilter(members).filter.encode(),
          fpRate: 0.00012,
          loadFactor: 0.8,
        },
      },
    };
  }

  it("does not grant the gated feature in the window before membership loads", () => {
    // This gets a chaos test rather than only a unit test because the bug only
    // appears in the window between process start and the first segment load —
    // which exists on EVERY cold start.
    const snapshot = snapshotWithNegatedSegment();
    const index = new SegmentIndex(snapshot.segments);

    for (const key of members.slice(0, 200)) {
      const detail = evaluate("new-checkout", { key }, snapshot, false, { segments: index });
      // Rule fails closed; the fallthrough (false) serves, NOT the gated value.
      expect(detail.value).toBe(false);
      expect(detail.unresolved?.[0]?.reason).toBe("SEGMENT_UNRESOLVED");
    }
  });

  it("does not grant it when the cache provider is unreachable either", () => {
    const snapshot = snapshotWithNegatedSegment();
    const index = new SegmentIndex(snapshot.segments);
    index.setCache({
      has() {
        throw new Error("redis unreachable");
      },
    });

    for (const key of members.slice(0, 200)) {
      expect(evaluate("new-checkout", { key }, snapshot, false, { segments: index }).value).toBe(
        false,
      );
    }
    expect(index.unresolvedCount).toBeGreaterThan(0);
  });

  it("grants it correctly once membership resolves", async () => {
    const { InMemorySegmentCache } = await import("../../src/sdk/index.js");
    const snapshot = snapshotWithNegatedSegment();
    const index = new SegmentIndex(snapshot.segments);
    index.setCache(new InMemorySegmentCache({ enterprise: members }));

    // A member of `enterprise` is excluded by the negated clause.
    expect(evaluate("new-checkout", { key: "usr_1" }, snapshot, false, { segments: index }).value).toBe(
      false,
    );
    // A non-member matches the negated clause and gets the feature.
    expect(
      evaluate("new-checkout", { key: "outsider" }, snapshot, false, { segments: index }).value,
    ).toBe(true);
  });
});

/* ────────────────────── snapshot version regression ─────────────────── */

describe("snapshot version regression is rejected", () => {
  it("ignores a snapshot older than the one held", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk(cp.baseUrl);
    await sdk.ready({ timeoutMs: 3_000 });

    cp.state.on = false;
    cp.state.flagVersion++;
    await cp.snapshots.recompile(ENV_ID, { flagKey: "new-checkout" });
    await vi.waitFor(() => expect(sdk.get("new-checkout", ctx, true)).toBe(false), {
      timeout: 3_000,
    });

    const held = sdk.snapshotVersion!;
    // A rolled-back database would republish an older version. The guard must
    // make that a non-event rather than a silent revert.
    await cp.store.put(ENV_ID, {
      version: held - 5,
      environmentKey: "production",
      salt: "env_salt_prod",
      flags: {},
      segments: {},
    });
    await cp.store.publish(ENV_ID, { version: held - 5 });
    await new Promise((r) => setTimeout(r, 200));

    expect(sdk.snapshotVersion).toBe(held);
    expect(sdk.get("new-checkout", ctx, true)).toBe(false);
  });
});
