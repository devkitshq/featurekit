import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { MemorySnapshotStore } from "../../src/redis/memory-store.js";
import { registerSdkRoutes, type AuthenticatedEnvironment } from "../../src/routes/sdk.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

const ENV_ID = "env-1";
const SERVER_KEY = "tk_srv_test";
const CLIENT_KEY = "tk_clt_test";

let flagKeys = ["f"];

function input(): CompilerInput {
  return {
    environment: { id: ENV_ID, key: "production", bucketSalt: "s4lt" },
    flags: flagKeys.map((key) => ({
      id: `flag-${key}`,
      key,
      kind: "boolean" as const,
      archivedAt: null,
      clientAvailable: false,
    })),
    variations: flagKeys.flatMap((key) => [
      { id: `flag-${key}-v0`, flagId: `flag-${key}`, idx: 0, value: false },
      { id: `flag-${key}-v1`, flagId: `flag-${key}`, idx: 1, value: true },
    ]),
    flagEnvironments: flagKeys.map((key) => ({
      id: `fe-${key}`,
      flagId: `flag-${key}`,
      environmentId: ENV_ID,
      enabled: true,
      offVariationId: `flag-${key}-v0`,
      fallthroughVariationId: `flag-${key}-v1`,
      fallthroughRollout: null,
      version: 1,
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

const records: Record<string, AuthenticatedEnvironment> = {
  [SERVER_KEY]: {
    id: "k-server",
    environmentId: ENV_ID,
    environmentKey: "production",
    projectId: "project-1",
    isProduction: true,
    kind: "server",
    expiresAt: null,
    revokedAt: null,
  },
  [CLIENT_KEY]: {
    id: "k-client",
    environmentId: ENV_ID,
    environmentKey: "production",
    projectId: "project-1",
    isProduction: true,
    kind: "client",
    expiresAt: null,
    revokedAt: null,
  },
};

const servers: HttpServer[] = [];
const services: SnapshotService[] = [];

async function harness(over: Partial<Parameters<typeof registerSdkRoutes>[1]> = {}) {
  flagKeys = ["f"];
  const store = new MemorySnapshotStore();
  let version = 0;
  // Retention is enforced at append time, so the service must use the same
  // depth the route reads with -- otherwise the "gap too large" case cannot
  // arise and the test silently asserts nothing.
  const patchHistoryDepth = over.patchHistoryDepth ?? 200;
  const snapshots = new SnapshotService({
    store,
    loadInput: async () => input(),
    nextVersion: async () => ++version,
    debounceMs: 5,
    patchHistoryDepth,
  });
  services.push(snapshots);

  const router = new Router();
  registerSdkRoutes(router, {
    snapshots,
    store,
    authenticate: async (key) => records[key] ?? null,
    heartbeatMs: 10_000,
    patchHistoryDepth: 200,
    ...over,
  });

  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { port, host } = await server.listen();
  return { base: `http://${host}:${port}`, store, snapshots };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const auth = (key = SERVER_KEY) => ({ authorization: `Bearer ${key}` });

describe("authentication", () => {
  it("refuses a request with no key", async () => {
    const { base } = await harness();
    const response = await fetch(`${base}/v1/snapshot/production`);
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("MISSING_SDK_KEY");
  });

  it("accepts a bare key as well as `Bearer <key>`", async () => {
    const { base } = await harness();
    const response = await fetch(`${base}/v1/snapshot/production`, {
      headers: { authorization: SERVER_KEY },
    });
    expect(response.status).toBe(200);
  });

  it("REFUSES a client key on the ruleset stream", async () => {
    // The single most important authorisation check in the system: a client key
    // reaching this endpoint hands a browser the rules the entire client tier
    // exists to withhold (§16).
    const { base } = await harness();
    for (const path of ["/v1/snapshot/production", "/v1/stream/production"]) {
      const response = await fetch(`${base}${path}`, { headers: auth(CLIENT_KEY) });
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe("WRONG_TIER");
    }
  });

  it("refuses a key for a different environment than the path names", async () => {
    // Otherwise a valid staging key reads production by editing the URL.
    const { base } = await harness();
    const response = await fetch(`${base}/v1/snapshot/staging`, { headers: auth() });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("ENVIRONMENT_MISMATCH");
  });

  it("gives one status for every rejection, so there is no key-probing oracle", async () => {
    const { base } = await harness({
      authenticate: async (key) =>
        key === "revoked"
          ? { ...records[SERVER_KEY]!, revokedAt: new Date("2020-01-01") }
          : null,
    });
    const unknown = await fetch(`${base}/v1/snapshot/production`, { headers: auth("nope") });
    const revoked = await fetch(`${base}/v1/snapshot/production`, { headers: auth("revoked") });
    expect(unknown.status).toBe(401);
    expect(revoked.status).toBe(401);
  });
});

describe("GET /v1/snapshot/:envKey — polling is first class (§10.2)", () => {
  it("returns the compiled snapshot with an ETag", async () => {
    const { base } = await harness();
    const response = await fetch(`${base}/v1/snapshot/production`, { headers: auth() });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"1"');
    const snapshot = await response.json();
    expect(snapshot.environmentKey).toBe("production");
    expect(snapshot.flags.f.on).toBe(true);
  });

  it("answers 304 with no body when the poller is current", async () => {
    const { base } = await harness();
    const first = await fetch(`${base}/v1/snapshot/production`, { headers: auth() });
    const etag = first.headers.get("etag")!;
    const second = await fetch(`${base}/v1/snapshot/production`, {
      headers: { ...auth(), "if-none-match": etag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("returns a new body once the version moves", async () => {
    const { base, snapshots } = await harness();
    const first = await fetch(`${base}/v1/snapshot/production`, { headers: auth() });
    await snapshots.recompile(ENV_ID);
    const second = await fetch(`${base}/v1/snapshot/production`, {
      headers: { ...auth(), "if-none-match": first.headers.get("etag")! },
    });
    expect(second.status).toBe(200);
  });

  it("round-trips a binary segment filter through JSON", async () => {
    // A filter that arrives as `{"0":1,...}` answers false for every member.
    const store = new MemorySnapshotStore();
    await store.put(ENV_ID, {
      version: 5,
      environmentKey: "production",
      salt: "s4lt",
      flags: {},
      segments: {
        big: { kind: "cuckoo", version: 1, filter: new Uint8Array([9, 8, 7]), fpRate: 0.0001, loadFactor: 0.8 },
      },
    });
    const snapshots = new SnapshotService({
      store,
      loadInput: async () => input(),
      nextVersion: async () => 6,
      debounceMs: 5,
    });
    services.push(snapshots);
    const router = new Router();
    registerSdkRoutes(router, {
      snapshots,
      store,
      authenticate: async (key) => records[key] ?? null,
    });
    const server = new HttpServer({ router, port: 0 });
    servers.push(server);
    const { port, host } = await server.listen();

    const body = await (
      await fetch(`http://${host}:${port}/v1/snapshot/production`, { headers: auth() })
    ).json();
    // The tagged form survives; the SDK's deserializer revives it as bytes.
    expect(body.segments.big.filter).toEqual({ $tkBytes: Buffer.from([9, 8, 7]).toString("base64") });
  });
});

/* ─────────────────────────────── streaming ──────────────────────────── */

/** Read an SSE body until `until` matches or the timeout expires. */
async function readSse(
  url: string,
  headers: Record<string, string>,
  until: (text: string) => boolean,
  timeoutMs = 3_000,
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (until(text)) break;
    }
  } finally {
    controller.abort();
  }
  return text;
}

describe("GET /v1/stream/:envKey (§10.2, §10.3)", () => {
  it("sends a full put on connect, with the version as the event id", async () => {
    const { base } = await harness();
    const text = await readSse(`${base}/v1/stream/production`, auth(), (t) => t.includes("event: put"));
    expect(text).toContain("id: 1\nevent: put\n");
    expect(text).toContain('"environmentKey":"production"');
  });

  it("pushes a patch when a flag changes", async () => {
    const { base, snapshots } = await harness();
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/stream/production`, {
      headers: auth(),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    // Drain the initial put.
    text += decoder.decode((await reader.read()).value, { stream: true });
    expect(text).toContain("event: put");

    await snapshots.recompile(ENV_ID, { flagKey: "f" });

    const deadline = Date.now() + 3_000;
    while (!text.includes("event: patch") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    expect(text).toContain("event: patch");
    expect(text).toContain('"key":"f"');
  });

  it("replays from Last-Event-ID rather than resending the whole snapshot", async () => {
    const { base, snapshots } = await harness();
    await snapshots.recompile(ENV_ID); // v1
    await snapshots.recompile(ENV_ID, { flagKey: "f" }); // v2

    const text = await readSse(
      `${base}/v1/stream/production`,
      { ...auth(), "last-event-id": "1" },
      (t) => t.includes("event: patch"),
    );
    expect(text).toContain("event: patch");
    expect(text).toContain("id: 2");
    expect(text).not.toContain("event: put");
  });

  it("sends NOTHING to a client that reconnects already current", async () => {
    // The regression this guards: an empty replay left the sent-version at 0
    // and triggered a full `put` of the whole snapshot on every reconnect --
    // so a fleet flapping its connections would each pull a complete snapshot
    // for no reason, which is precisely what resume exists to avoid.
    const { base, snapshots } = await harness();
    await snapshots.recompile(ENV_ID); // v1
    await snapshots.recompile(ENV_ID, { flagKey: "f" }); // v2

    const text = await readSse(
      `${base}/v1/stream/production`,
      { ...auth(), "last-event-id": "2" },
      () => false,
      400,
    );
    expect(text).not.toContain("event: put");
    expect(text).not.toContain("event: patch");
  });

  it("falls back to a full put when history cannot cover the gap", async () => {
    // The documented floor: disconnected across more than PATCH_HISTORY_DEPTH
    // changes. A put is both correct and cheaper than replay.
    const { base, snapshots } = await harness({ patchHistoryDepth: 2 });
    for (let i = 0; i < 6; i++) await snapshots.recompile(ENV_ID, { flagKey: "f" });

    const text = await readSse(
      `${base}/v1/stream/production`,
      { ...auth(), "last-event-id": "1" },
      (t) => t.includes("event: put"),
    );
    expect(text).toContain("event: put");
  });

  it("sends a full put when the client claims a version ahead of history", async () => {
    // Should not happen; indicates a rolled-back database.
    const { base } = await harness();
    const text = await readSse(
      `${base}/v1/stream/production`,
      { ...auth(), "last-event-id": "9999" },
      (t) => t.includes("event: put"),
    );
    expect(text).toContain("event: put");
  });

  it("sheds to polling above the connection cap rather than accepting a stream it cannot serve", async () => {
    const { base } = await harness({ maxStreamConnections: 1 });
    const controller = new AbortController();
    const first = await fetch(`${base}/v1/stream/production`, {
      headers: auth(),
      signal: controller.signal,
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${base}/v1/stream/production`, { headers: auth() });
    expect(second.status).toBe(503);
    expect((await second.json()).error).toBe("STREAM_CAPACITY");
    controller.abort();
  });

  it("frees a slot when a stream closes", async () => {
    const { base } = await harness({ maxStreamConnections: 1 });
    const controller = new AbortController();
    await fetch(`${base}/v1/stream/production`, { headers: auth(), signal: controller.signal });
    controller.abort();

    await vi.waitFor(
      async () => {
        const response = await fetch(`${base}/v1/stream/production`, { headers: auth() });
        expect(response.status).toBe(200);
        await response.body?.cancel();
      },
      { timeout: 3_000 },
    );
  });
});

describe("POST /v1/events", () => {
  it("accepts a batch and returns 202", async () => {
    const received: unknown[] = [];
    const { base } = await harness({ ingestEvents: async (_env, batch) => void received.push(batch) });
    const response = await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ summaries: [{ flagKey: "f", count: 3 }] }),
    });
    expect(response.status).toBe(202);
    expect(received).toHaveLength(1);
  });

  it("accepts summaries from the client tier too", async () => {
    const { base } = await harness({ ingestEvents: async () => {} });
    const response = await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { ...auth(CLIENT_KEY), "content-type": "application/json" },
      body: JSON.stringify({ summaries: [] }),
    });
    expect(response.status).toBe(202);
  });

  it("still returns 202 when ingest fails", async () => {
    // Analytics loss is acceptable; blocking an SDK is not (§14). Failing here
    // makes the SDK retry a batch that is already stale.
    const errors: unknown[] = [];
    const { base } = await harness({
      ingestEvents: async () => {
        throw new Error("redis down");
      },
      onError: (error) => errors.push(error),
    });
    const response = await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ summaries: [] }),
    });
    expect(response.status).toBe(202);
    expect(errors).toHaveLength(1);
  });
});
