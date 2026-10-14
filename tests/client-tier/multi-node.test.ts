/**
 * The client tier behind more than one node (review PR-A6).
 *
 * This is the test that would have caught the bug. Every existing client-tier
 * test drives a single control plane, and the flow works perfectly there: POST
 * `/v1/client/state`, then `GET /v1/client/stream`, same process, same `Map`.
 *
 * Behind a load balancer those are two requests and they land on two nodes. The
 * second node had never heard of the handle and answered `409 UNKNOWN_CONNECTION`
 * — for every browser, on every multi-node deployment. The single-node case
 * passing is precisely why it survived.
 *
 * So: two independent routers, two servers, one shared store, and the requests
 * deliberately split across them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { MemorySnapshotStore } from "../../src/snapshot/memory-store.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { registerClientRoutes } from "../../src/routes/client.js";
import {
  MemoryClientConnectionStore,
  NullClientConnectionStore,
  newConnectionId,
  type ClientConnectionStore,
} from "../../src/client-tier/connection-store.js";
import type { AuthenticatedEnvironment } from "../../src/routes/sdk.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

const ENV_ID = "env-1";
const KEY = "fk_clt_multinode";

const servers: HttpServer[] = [];
const services: SnapshotService[] = [];

const record: AuthenticatedEnvironment = {
  id: "k1",
  environmentId: ENV_ID,
  environmentKey: "development",
  projectId: "p1",
  isProduction: false,
  kind: "client",
  expiresAt: null,
  revokedAt: null,
};

function input(): CompilerInput {
  return {
    environment: { id: ENV_ID, key: "development", bucketSalt: "salt" },
    flags: [{ id: "f1", key: "banner", kind: "boolean", archivedAt: null, clientAvailable: true }],
    variations: [
      { id: "v0", flagId: "f1", idx: 0, value: false },
      { id: "v1", flagId: "f1", idx: 1, value: true },
    ],
    flagEnvironments: [
      {
        id: "fe1",
        flagId: "f1",
        environmentId: ENV_ID,
        enabled: true,
        offVariationId: "v0",
        fallthroughVariationId: "v1",
        fallthroughRollout: null,
        version: 1,
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

/**
 * One node. Each gets its own router, its own server and — crucially — its own
 * in-process connection registry, exactly as separate processes would.
 */
async function node(shared: ClientConnectionStore, snapshotStore: MemorySnapshotStore) {
  let version = 0;
  const snapshots = new SnapshotService({
    store: snapshotStore,
    loadInput: async () => input(),
    nextVersion: async () => ++version,
    debounceMs: 5,
  });
  services.push(snapshots);

  const router = new Router();
  registerClientRoutes(router, {
    snapshots,
    store: snapshotStore,
    authenticate: async (presented) => (presented === KEY ? record : null),
    connectionStore: shared,
    heartbeatMs: 10_000,
  });

  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { host, port } = await server.listen();
  return { base: `http://${host}:${port}`, snapshots };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const identify = (base: string, context: unknown) =>
  fetch(`${base}/v1/client/state`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ context }),
  });

/** Open the stream and read just the first event, then close. */
async function firstEvent(base: string, connectionId: string, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${base}/v1/client/stream?connection=${encodeURIComponent(connectionId)}&key=${KEY}`,
      { signal: controller.signal },
    );
    if (response.status !== 200) return { status: response.status, event: null };
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event:")) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    return { status: response.status, event: buffer };
  } finally {
    clearTimeout(timer);
  }
}

describe("a browser whose requests land on different nodes", () => {
  it("is taken over by the second node instead of being refused", async () => {
    const shared = new MemoryClientConnectionStore();
    const snapshotStore = new MemorySnapshotStore();
    const a = await node(shared, snapshotStore);
    const b = await node(shared, snapshotStore);

    // Node A hands out the handle.
    const state = (await (await identify(a.base, { key: "user-1" })).json()) as {
      connectionId: string;
      values: Record<string, unknown>;
    };
    expect(state.connectionId).not.toBe("");
    expect(state.values["banner"]).toBeDefined();

    // Node B receives the stream. This is the request that used to 409.
    const stream = await firstEvent(b.base, state.connectionId);
    expect(stream.status).toBe(200);
    expect(stream.event).toContain("event: ready");
  });

  it("still refuses a handle that was never issued", async () => {
    // The takeover must not become "any caller can open a stream".
    const shared = new MemoryClientConnectionStore();
    const snapshotStore = new MemorySnapshotStore();
    const b = await node(shared, snapshotStore);
    const stream = await firstEvent(b.base, newConnectionId());
    expect(stream.status).toBe(409);
  });

  it("refuses a handle issued for another environment", async () => {
    const shared = new MemoryClientConnectionStore();
    const snapshotStore = new MemorySnapshotStore();
    const b = await node(shared, snapshotStore);
    // A well-formed record, but for a different environment than the key names.
    const id = newConnectionId();
    await shared.save(
      id,
      { environmentId: "some-other-environment", context: { key: "u" }, lastSentVersion: 1 },
      900,
    );
    const stream = await firstEvent(b.base, id);
    expect(stream.status).toBe(409);
  });

  it("falls back to single-node behaviour when the shared store is disabled", async () => {
    // The documented degraded mode: without a shared store the tier behaves
    // exactly as it did before, and requires sticky routing.
    const snapshotStore = new MemorySnapshotStore();
    const a = await node(new NullClientConnectionStore(), snapshotStore);
    const b = await node(new NullClientConnectionStore(), snapshotStore);

    const state = (await (await identify(a.base, { key: "user-1" })).json()) as {
      connectionId: string;
    };
    // Same node: fine.
    expect((await firstEvent(a.base, state.connectionId)).status).toBe(200);
    // Different node: refused, and the browser re-identifies.
    expect((await firstEvent(b.base, state.connectionId)).status).toBe(409);
  });

  it("survives the shared store throwing on every call", async () => {
    // A store outage must cost a re-identify, never a failed identify.
    const broken: ClientConnectionStore = {
      save: () => Promise.reject(new Error("store down")),
      load: () => Promise.reject(new Error("store down")),
      touch: () => Promise.reject(new Error("store down")),
      delete: () => Promise.reject(new Error("store down")),
    };
    const snapshotStore = new MemorySnapshotStore();
    const a = await node(broken, snapshotStore);

    // The identify itself must still succeed.
    const response = await identify(a.base, { key: "user-1" });
    expect(response.status).toBe(200);
  });
});

describe("connection handles", () => {
  it("carry 256 bits of entropy and are url-safe", () => {
    const id = newConnectionId();
    // A handle is a bearer token for one browser's flag values, so it must not
    // be guessable — and it travels in a query string, because EventSource
    // cannot set headers.
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(id, "base64url")).toHaveLength(32);
    expect(new Set(Array.from({ length: 500 }, () => newConnectionId())).size).toBe(500);
  });
});

describe("MemoryClientConnectionStore", () => {
  it("expires records rather than pinning contexts forever", async () => {
    let now = 1_000;
    const store = new MemoryClientConnectionStore({ now: () => now });
    await store.save("id", { environmentId: ENV_ID, context: { key: "u" }, lastSentVersion: 1 }, 60);
    expect(await store.load("id")).not.toBeNull();
    now += 61_000;
    expect(await store.load("id")).toBeNull();
  });

  it("extends a lease on touch", async () => {
    let now = 1_000;
    const store = new MemoryClientConnectionStore({ now: () => now });
    await store.save("id", { environmentId: ENV_ID, context: { key: "u" }, lastSentVersion: 1 }, 60);
    now += 50_000;
    await store.touch("id", 60);
    now += 30_000;
    expect(await store.load("id")).not.toBeNull();
  });

  it("stays bounded under a flood of connections", async () => {
    const store = new MemoryClientConnectionStore({ maxEntries: 100 });
    for (let i = 0; i < 1_000; i++) {
      await store.save(
        `id-${i}`,
        { environmentId: ENV_ID, context: { key: `u${i}` }, lastSentVersion: 1 },
        900,
      );
    }
    expect(store.size).toBeLessThanOrEqual(100);
  });
});
