import { afterEach, describe, expect, it, vi } from "vitest";
import { TogglekitSDK, type Snapshot } from "../../src/sdk/index.js";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { MemorySnapshotStore } from "../../src/redis/memory-store.js";
import { registerSdkRoutes, type AuthenticatedEnvironment } from "../../src/routes/sdk.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

/**
 * End to end against the real control plane, not mocks: the SDK's job is to
 * survive what an actual server does — 304s, SSE frame boundaries, capacity
 * shedding, a socket dying mid-stream — and a mocked transport tests none of it.
 */

const ENV_ID = "env-1";
const KEY = "tk_srv_test";

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

function input(flagOn: boolean, keys = ["new-checkout"], flagVersion = 1): CompilerInput {
  return {
    environment: { id: ENV_ID, key: "production", bucketSalt: "s4lt" },
    flags: keys.map((key) => ({
      id: `flag-${key}`,
      key,
      kind: "boolean" as const,
      archivedAt: null,
      clientAvailable: false,
    })),
    variations: keys.flatMap((key) => [
      { id: `flag-${key}-v0`, flagId: `flag-${key}`, idx: 0, value: false },
      { id: `flag-${key}-v1`, flagId: `flag-${key}`, idx: 1, value: true },
    ]),
    flagEnvironments: keys.map((key) => ({
      id: `fe-${key}`,
      flagId: `flag-${key}`,
      environmentId: ENV_ID,
      enabled: flagOn,
      offVariationId: `flag-${key}-v0`,
      fallthroughVariationId: `flag-${key}-v1`,
      fallthroughRollout: null,
      // Bumped by the control plane on every config change. The SDK's per-flag
      // version guard discards any patch at or below what it holds, so a
      // fixture that never increments this models a database that never
      // records a change -- and the SDK is right to ignore it.
      version: flagVersion,
    })),
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
const sdks: TogglekitSDK[] = [];

async function controlPlane(options: { flagOn?: boolean; maxStreams?: number } = {}) {
  const state = { flagOn: options.flagOn ?? true, keys: ["new-checkout"], flagVersion: 1 };
  const store = new MemorySnapshotStore();
  let version = 0;
  const snapshots = new SnapshotService({
    store,
    loadInput: async () => input(state.flagOn, state.keys, state.flagVersion),
    nextVersion: async () => ++version,
    debounceMs: 5,
    patchHistoryDepth: 200,
  });
  services.push(snapshots);

  const received: unknown[] = [];
  const router = new Router();
  registerSdkRoutes(router, {
    snapshots,
    store,
    authenticate: async (k) => (k === KEY ? record : null),
    heartbeatMs: 200,
    patchHistoryDepth: 200,
    ...(options.maxStreams !== undefined ? { maxStreamConnections: options.maxStreams } : {}),
    ingestEvents: async (_env, batch) => void received.push(batch),
  });

  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { port, host } = await server.listen();
  return { baseUrl: `http://${host}:${port}`, snapshots, state, server, received };
}

function makeSdk(over: Partial<ConstructorParameters<typeof TogglekitSDK>[0]>) {
  const sdk = new TogglekitSDK({
    sdkKey: KEY,
    environmentKey: "production",
    events: { enabled: false },
    ...over,
  } as ConstructorParameters<typeof TogglekitSDK>[0]);
  sdks.push(sdk);
  return sdk;
}

afterEach(async () => {
  await Promise.all(sdks.splice(0).map((s) => s.close()));
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const ctx = { key: "usr_1" };

describe("streaming", () => {
  it("evaluates a real flag after ready()", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl });
    await sdk.ready({ timeoutMs: 3_000 });
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);
    expect(sdk.state).toBe("connected");
  });

  it("picks up a change without a reconnect", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl });
    await sdk.ready({ timeoutMs: 3_000 });
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);

    cp.state.flagOn = false;
    cp.state.flagVersion++;
    await cp.snapshots.recompile(ENV_ID, { flagKey: "new-checkout" });

    await vi.waitFor(() => expect(sdk.get("new-checkout", ctx, true)).toBe(false), {
      timeout: 3_000,
    });
  });

  it("discards a patch at or below the version it already holds (§10.2)", async () => {
    // Duplicate broadcasts and out-of-order delivery must be non-events rather
    // than corruption. Recompiling without bumping the flag version is exactly
    // that case: the payload changes, the version does not, and the SDK is
    // right to keep what it has.
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl });
    await sdk.ready({ timeoutMs: 3_000 });
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);

    cp.state.flagOn = false; // NB: flagVersion deliberately NOT bumped
    await cp.snapshots.recompile(ENV_ID, { flagKey: "new-checkout" });
    await new Promise((r) => setTimeout(r, 300));

    expect(sdk.get("new-checkout", ctx, false)).toBe(true);
  });

  it("propagates a change quickly enough to be a kill switch (§10.4)", async () => {
    // The target is p99 under 300ms from toggle to flip. On a loopback with no
    // debounce this is generous, but it fails loudly if a buffering or polling
    // regression creeps in.
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl });
    await sdk.ready({ timeoutMs: 3_000 });

    cp.state.flagOn = false;
    cp.state.flagVersion++;
    const started = Date.now();
    await cp.snapshots.recompile(ENV_ID, { flagKey: "new-checkout" });
    await vi.waitFor(() => expect(sdk.get("new-checkout", ctx, true)).toBe(false), {
      timeout: 3_000,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("emits change and state events", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl });
    const states: string[] = [];
    const changes: (string | null)[] = [];
    sdk.on("state", (s) => states.push(s));
    sdk.on("change", ({ flagKey }) => changes.push(flagKey));

    await sdk.ready({ timeoutMs: 3_000 });
    expect(states).toContain("connected");
    expect(changes.length).toBeGreaterThan(0);
  });

  it("applies a delete when a flag is archived", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl });
    await sdk.ready({ timeoutMs: 3_000 });
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);

    cp.state.keys = [];
    await cp.snapshots.recompile(ENV_ID, { flagKey: "new-checkout" });

    await vi.waitFor(() => expect(sdk.get("new-checkout", ctx, false)).toBe(false), {
      timeout: 3_000,
    });
  });
});

describe("polling is a first-class fallback (§10.2)", () => {
  it("fetches a snapshot and evaluates", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl, mode: "polling", pollIntervalMs: 50 });
    await sdk.ready({ timeoutMs: 3_000 });
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);
  });

  it("picks up a change on the next poll", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl, mode: "polling", pollIntervalMs: 40 });
    await sdk.ready({ timeoutMs: 3_000 });

    cp.state.flagOn = false;
    cp.state.flagVersion++;
    await cp.snapshots.recompile(ENV_ID);
    await vi.waitFor(() => expect(sdk.get("new-checkout", ctx, true)).toBe(false), {
      timeout: 3_000,
    });
  });

  it("takes the hint and polls when the server sheds it to polling", async () => {
    const cp = await controlPlane({ maxStreams: 0 });
    const sdk = makeSdk({ baseUrl: cp.baseUrl, pollIntervalMs: 40 });
    await sdk.ready({ timeoutMs: 3_000 });
    // Shed to polling rather than reconnect-looping against a full node.
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);
  });
});

describe("failing should be invisible to your users (§14)", () => {
  it("serves the caller default when the control plane was never reachable", async () => {
    const sdk = makeSdk({ baseUrl: "http://127.0.0.1:1" });
    await sdk.ready({ timeoutMs: 300 });
    // Never blocks, never throws — the whole property being sold.
    expect(sdk.get("new-checkout", ctx, false)).toBe(false);
    expect(sdk.get("new-checkout", ctx, true)).toBe(true);
    expect(sdk.initialized).toBe(false);
  });

  it("ready() times out into serving defaults rather than rejecting", async () => {
    const sdk = makeSdk({ baseUrl: "http://127.0.0.1:1" });
    // A ready() that throws turns a control-plane outage into a failed deploy.
    await expect(sdk.ready({ timeoutMs: 200 })).resolves.toBeUndefined();
  });

  it("keeps serving the last good snapshot after the control plane dies", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl });
    await sdk.ready({ timeoutMs: 3_000 });
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);

    await cp.server.close();
    servers.length = 0;

    // Last known good serves indefinitely. No user impact.
    await new Promise((r) => setTimeout(r, 300));
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);
    expect(sdk.state).toBe("reconnecting");
  });

  it("is usable at import time from a bootstrap snapshot", async () => {
    // The difference between a cold start serving correct flags and one
    // serving defaults.
    const bootstrap: Snapshot = {
      version: 1,
      environmentKey: "production",
      salt: "s4lt",
      flags: {
        "new-checkout": {
          key: "new-checkout",
          version: 1,
          kind: "boolean",
          on: true,
          variations: [false, true],
          offVariation: 0,
          fallthrough: { variation: 1 },
          prerequisites: [],
          targets: [],
          rules: [],
        },
      },
      segments: {},
    };
    const sdk = makeSdk({ baseUrl: "http://127.0.0.1:1", bootstrap });
    // No await: usable immediately, before any network round trip.
    expect(sdk.get("new-checkout", ctx, false)).toBe(true);
  });

  it("never throws from an evaluation, whatever the flag key", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({ baseUrl: cp.baseUrl });
    await sdk.ready({ timeoutMs: 3_000 });
    expect(() => sdk.get("does-not-exist", ctx, false)).not.toThrow();
    expect(() => sdk.get("new-checkout", {} as never, false)).not.toThrow();
    expect(sdk.get("new-checkout", {} as never, false)).toBe(false);
  });
});

describe("persistence (§11.2)", () => {
  it("restores from a persisted snapshot when the control plane is down", async () => {
    const saved: Snapshot[] = [];
    const persist = {
      load: () => saved.at(-1) ?? null,
      save: (s: Snapshot) => void saved.push(s),
    };

    const cp = await controlPlane();
    const first = makeSdk({ baseUrl: cp.baseUrl, persist });
    await first.ready({ timeoutMs: 3_000 });
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    await first.close();
    await cp.server.close();
    servers.length = 0;

    // A restart during an outage still serves correct flags.
    const second = makeSdk({ baseUrl: cp.baseUrl, persist });
    await second.ready({ timeoutMs: 500 });
    expect(second.get("new-checkout", ctx, false)).toBe(true);
  });

  it("treats a corrupt persisted snapshot as absent rather than fatal", async () => {
    const persist = {
      load: () => {
        throw new Error("corrupt file");
      },
      save: () => {},
    };
    const sdk = makeSdk({ baseUrl: "http://127.0.0.1:1", persist });
    await expect(sdk.ready({ timeoutMs: 300 })).resolves.toBeUndefined();
    expect(sdk.get("new-checkout", ctx, false)).toBe(false);
  });
});

describe("offline mode", () => {
  it("never touches the network", async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error("offline mode must not fetch");
    });
    const sdk = makeSdk({
      baseUrl: "http://127.0.0.1:1",
      mode: "offline",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sdk.ready({ timeoutMs: 300 });
    sdk.get("new-checkout", ctx, false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sdk.state).toBe("offline");
  });
});

describe("event summaries", () => {
  it("batches evaluations rather than sending one request per check", async () => {
    const cp = await controlPlane();
    const sdk = makeSdk({
      baseUrl: cp.baseUrl,
      events: { enabled: true, flushIntervalMs: 50 },
    });
    await sdk.ready({ timeoutMs: 3_000 });

    for (let i = 0; i < 500; i++) sdk.get("new-checkout", { key: `usr_${i % 5}` }, false);

    await vi.waitFor(() => expect(cp.received.length).toBeGreaterThan(0), { timeout: 3_000 });
    const batch = cp.received[0] as { summaries: { count: number; uniqueContexts: number }[] };
    // 500 evaluations arrive as ONE bucket, not 500 requests.
    expect(batch.summaries).toHaveLength(1);
    expect(batch.summaries[0]!.count).toBe(500);
    expect(batch.summaries[0]!.uniqueContexts).toBe(5);
  });
});
