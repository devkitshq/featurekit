import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatkitClient } from "@featkit/client";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { MemorySnapshotStore } from "../../src/redis/memory-store.js";
import { registerClientRoutes } from "../../src/routes/client.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { signContext } from "../../src/auth/secure-mode.js";
import type { AuthenticatedEnvironment } from "../../src/routes/sdk.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

const ENV_ID = "env-1";
const CLIENT_KEY = "fk_clt_test";
const SERVER_KEY = "fk_srv_test";
const SECRET = "s".repeat(32);

const records: Record<string, AuthenticatedEnvironment> = {
  [CLIENT_KEY]: {
    id: "k1",
    environmentId: ENV_ID,
    environmentKey: "production",
    projectId: "project-1",
    isProduction: false,
    kind: "client",
    expiresAt: null,
    revokedAt: null,
  },
  [SERVER_KEY]: {
    id: "k2",
    environmentId: ENV_ID,
    environmentKey: "production",
    projectId: "project-1",
    isProduction: false,
    kind: "server",
    expiresAt: null,
    revokedAt: null,
  },
};

/** `beta-banner` is on only for plan=pro. `secret-flag` is not client-available. */
function input(version = 1): CompilerInput {
  return {
    environment: { id: ENV_ID, key: "production", bucketSalt: "s4lt" },
    flags: [
      { id: "f1", key: "beta-banner", kind: "boolean", archivedAt: null, clientAvailable: true },
      { id: "f2", key: "secret-flag", kind: "boolean", archivedAt: null, clientAvailable: false },
    ],
    variations: [
      { id: "f1-v0", flagId: "f1", idx: 0, value: false },
      { id: "f1-v1", flagId: "f1", idx: 1, value: true },
      { id: "f2-v0", flagId: "f2", idx: 0, value: false },
      { id: "f2-v1", flagId: "f2", idx: 1, value: true },
    ],
    flagEnvironments: [
      {
        id: "fe1",
        flagId: "f1",
        environmentId: ENV_ID,
        enabled: true,
        offVariationId: "f1-v0",
        fallthroughVariationId: "f1-v0",
        fallthroughRollout: null,
        version,
      },
      {
        id: "fe2",
        flagId: "f2",
        environmentId: ENV_ID,
        enabled: true,
        offVariationId: "f2-v0",
        fallthroughVariationId: "f2-v1",
        fallthroughRollout: null,
        version,
      },
    ],
    targets: [],
    rules: [
      { id: "r0", flagEnvironmentId: "fe1", idx: 0, variationId: "f1-v1", rollout: null },
    ],
    clauses: [
      { ruleId: "r0", idx: 0, contextKind: "user", attribute: "plan", op: "in", values: ["pro"], negate: false },
    ],
    prerequisites: [],
    segments: [],
    segmentMembers: [],
    segmentRules: [],
    segmentRuleClauses: [],
  };
}

const servers: HttpServer[] = [];
const services: SnapshotService[] = [];
const clients: FeatkitClient[] = [];

async function controlPlane(over: Partial<Parameters<typeof registerClientRoutes>[1]> = {}) {
  const store = new MemorySnapshotStore();
  let version = 0;
  const snapshots = new SnapshotService({
    store,
    loadInput: async () => input(),
    nextVersion: async () => ++version,
    debounceMs: 5,
  });
  services.push(snapshots);

  const router = new Router();
  registerClientRoutes(router, {
    snapshots,
    store,
    authenticate: async (k) => records[k] ?? null,
    heartbeatMs: 500,
    ...over,
  });

  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { port, host } = await server.listen();
  return { baseUrl: `http://${host}:${port}`, snapshots, store };
}

function makeClient(over: Partial<ConstructorParameters<typeof FeatkitClient>[0]>) {
  const client = new FeatkitClient({
    clientKey: CLIENT_KEY,
    baseUrl: "http://127.0.0.1:1",
    context: { key: "usr_1" },
    stream: false,
    ...over,
  } as ConstructorParameters<typeof FeatkitClient>[0]);
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("the client tier receives values, not rules (§11.5)", () => {
  it("evaluates for the connection's context, with no context argument", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", false)).toBe(true);
  });

  it("gives a different context a different answer", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_2", plan: "free" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", true)).toBe(false);
  });

  it("never sends a flag that is not clientAvailable — not even its key (§16)", async () => {
    // A flag left false is invisible to browsers: its key never appears in a
    // client payload, so an unreleased feature's *existence* stays private.
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(Object.keys(client.allValues())).toEqual(["beta-banner"]);
    expect(client.detail("secret-flag")).toBeUndefined();
  });

  it("never sends the rule that matched", async () => {
    const cp = await controlPlane();
    const response = await fetch(`${cp.baseUrl}/v1/client/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ context: { key: "usr_1", plan: "pro" }, seq: 1 }),
    });
    const body = (await response.json()) as {
      values: Record<string, Record<string, unknown>>;
      connectionId: string;
    };
    expect(body.values["beta-banner"]?.["reason"]).toBe("RULE_MATCH");

    // Only the reason KIND crosses to the browser — never the rule id, the
    // clause, or the attribute it tested (§16).
    //
    // Asserted against the values payload rather than the whole response text:
    // the connection handle is 32 random bytes, and a substring check against
    // random base64 will eventually match any short needle by chance. It did.
    const serialisedValues = JSON.stringify(body.values);
    expect(serialisedValues).not.toContain("r0");
    expect(serialisedValues).not.toContain("ruleIndex");
    expect(serialisedValues).not.toContain("ruleId");
    expect(serialisedValues).not.toContain("segmentMatch");
    expect(serialisedValues).not.toContain("plan");
  });

  it("REFUSES a server key on the client endpoint", async () => {
    const cp = await controlPlane();
    const response = await fetch(`${cp.baseUrl}/v1/client/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${SERVER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ context: { key: "usr_1" }, seq: 1 }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("WRONG_TIER");
  });
});

describe("get() is one read for every type (§9.2, §14)", () => {
  it("infers the type from the default and returns the value", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", false)).toBe(true);
  });

  it("returns the default for a flag that does not exist", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("no-such-flag", "fallback")).toBe("fallback");
    expect(client.get("no-such-flag", 42)).toBe(42);
    expect(client.get("no-such-flag", false)).toBe(false);
  });

  it("falls back when the held value does not match the default's type", async () => {
    // The case this exists for: a flag retyped in the dashboard while a client
    // still holds the old value. Handing `"false"` to `if (flags.get(k, false))`
    // is truthy, and silently wrong for as long as nobody notices.
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });

    // `beta-banner` is a boolean flag; every other default must be refused.
    expect(client.get("beta-banner", "not-a-boolean")).toBe("not-a-boolean");
    expect(client.get("beta-banner", 0)).toBe(0);
  });

  it("passes object values through without inventing a schema", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });
    // A boolean value under an object default is not type-checked — the shape
    // of a JSON flag is the caller's to know — so it comes through as held.
    expect(client.get<unknown>("beta-banner", { accent: "blue" })).toBe(true);
    expect(client.get("no-such-flag", { accent: "blue" })).toEqual({ accent: "blue" });
  });

  it("is synchronous, so awaiting it is a no-op rather than a request", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });

    const direct = client.get("beta-banner", false);
    expect(direct).not.toBeInstanceOf(Promise);
    // The AsyncStorage-shaped call still works; there is just nothing behind it.
    await expect(Promise.resolve(client.get("beta-banner", false))).resolves.toBe(direct);
  });
});

describe("identify (§11.5)", () => {
  it("re-evaluates for the new context", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "free" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", false)).toBe(false);

    await client.identify({ key: "usr_2", plan: "pro" });
    expect(client.get("beta-banner", false)).toBe(true);
  });

  it("DISCARDS previous values on a key change rather than reusing them", async () => {
    // Serving user A's flags to user B after a login is a real bug class and a
    // privacy leak. Between identify() and its response, defaults serve.
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", false)).toBe(true);

    const pending = client.identify({ key: "usr_2", plan: "free" });
    // Synchronously after the call, before the response: A's value is gone.
    expect(client.get("beta-banner", false)).toBe(false);
    await pending;
  });

  it("keeps serving on an attribute-only change, which is stale but not misattributed", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });

    const pending = client.identify({ key: "usr_1", plan: "pro", theme: "dark" });
    expect(client.get("beta-banner", false)).toBe(true);
    await pending;
  });
});

describe("concurrent identify applies in CALL order, not response order (§22.7)", () => {
  it("drops a late response that was superseded", async () => {
    // fk.identify({key:"user_A"});  // request 1 -- slow
    // fk.identify({key:"user_B"});  // request 2 -- fast, applied
    //                               // request 1 lands late, overwriting B with A
    // An account switcher, a React effect firing twice, or a login right after
    // an anonymous identify all produce exactly this.
    const cp = await controlPlane();

    const realFetch = globalThis.fetch;
    const delays = new Map<string, number>();
    delays.set("usr_A", 300);
    delays.set("usr_B", 10);

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { context?: { key?: string } };
      const delay = delays.get(body.context?.key ?? "") ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return realFetch(url, init);
    }) as unknown as typeof fetch;

    const client = makeClient({
      baseUrl: cp.baseUrl,
      context: { key: "usr_seed", plan: "free" },
      fetchImpl,
    });
    await client.ready({ timeoutMs: 2_000 });

    // A is slow, B is fast. B must win, because B was called last.
    const a = client.identify({ key: "usr_A", plan: "pro" });
    const b = client.identify({ key: "usr_B", plan: "free" });
    await b;
    expect(client.get("beta-banner", true)).toBe(false); // B: plan=free

    // A's response lands afterwards and must be dropped, not applied.
    await a;
    await new Promise((r) => setTimeout(r, 100));
    expect(client.get("beta-banner", true)).toBe(false);
  });

  it("resolves the superseded call rather than leaving it hanging", async () => {
    // It was superseded, not failed.
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1" } });
    await client.ready({ timeoutMs: 2_000 });

    const first = client.identify({ key: "usr_A" });
    const second = client.identify({ key: "usr_B" });
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });
});

describe("secure mode (§16)", () => {
  it("accepts a validly signed context", async () => {
    const cp = await controlPlane({ secureModeSecrets: [SECRET], requireSignature: true });
    const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
    const client = makeClient({
      baseUrl: cp.baseUrl,
      context: { key: "usr_1", plan: "pro" },
      contextSignature: signContext("usr_1", expiresAt, [SECRET]),
      contextSignatureExpiresAt: expiresAt,
    });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", false)).toBe(true);
  });

  it("REFUSES an unsigned context when secure mode is required", async () => {
    // Because the server evaluates *as* a claimed identity, an unsigned key
    // would let anyone evaluate as anyone.
    const cp = await controlPlane({ secureModeSecrets: [SECRET], requireSignature: true });
    const response = await fetch(`${cp.baseUrl}/v1/client/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ context: { key: "usr_1" }, seq: 1 }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("SIGNATURE_MISSING");
  });

  it("refuses a signature minted for a different user", async () => {
    const cp = await controlPlane({ secureModeSecrets: [SECRET], requireSignature: true });
    const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
    const response = await fetch(`${cp.baseUrl}/v1/client/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        context: { key: "usr_victim" },
        seq: 1,
        signature: signContext("usr_attacker", expiresAt, [SECRET]),
        expiresAt,
      }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("SIGNATURE_INVALID");
  });

  it("returns SIGNATURE_EXPIRED distinctly, so the SDK can refresh", async () => {
    const cp = await controlPlane({ secureModeSecrets: [SECRET], requireSignature: true });
    const expiresAt = Math.floor(Date.now() / 1000) - 10;
    const response = await fetch(`${cp.baseUrl}/v1/client/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        context: { key: "usr_1" },
        seq: 1,
        signature: signContext("usr_1", expiresAt, [SECRET]),
        expiresAt,
      }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("SIGNATURE_EXPIRED");
  });

  it("refreshes an expiring signature and keeps serving through it", async () => {
    const cp = await controlPlane({ secureModeSecrets: [SECRET], requireSignature: true });
    let minted = 0;
    const client = makeClient({
      baseUrl: cp.baseUrl,
      context: { key: "usr_1", plan: "pro" },
      onSignatureExpiring: () => {
        minted++;
        const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
        return { signature: signContext("usr_1", expiresAt, [SECRET]), expiresAt };
      },
    });
    await client.ready({ timeoutMs: 2_000 });
    expect(minted).toBeGreaterThan(0);
    expect(client.get("beta-banner", false)).toBe(true);
  });

  it("allows unsigned contexts when secure mode is not required", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", false)).toBe(true);
  });
});

describe("client-tier failure modes (§14)", () => {
  it("serves caller defaults when the control plane is unreachable", async () => {
    const client = makeClient({ baseUrl: "http://127.0.0.1:1", context: { key: "usr_1" } });
    await client.ready({ timeoutMs: 400 });
    expect(client.get("beta-banner", false)).toBe(false);
    expect(client.get("beta-banner", true)).toBe(true);
  });

  it("does not inherit the previous user's flags when identify fails", async () => {
    const cp = await controlPlane();
    const client = makeClient({ baseUrl: cp.baseUrl, context: { key: "usr_1", plan: "pro" } });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", false)).toBe(true);

    await Promise.all(servers.splice(0).map((s) => s.close()));
    await client.identify({ key: "usr_2", plan: "pro" });

    // A login must not inherit the previous user's flags, outage or not.
    expect(client.get("beta-banner", false)).toBe(false);
  });

  it("uses an SSR bootstrap for first paint, with no flicker", async () => {
    const client = makeClient({
      baseUrl: "http://127.0.0.1:1",
      context: { key: "usr_1" },
      bootstrap: {
        contextHash: "abc",
        seq: 0,
        version: 1,
        connectionId: "",
        values: { "beta-banner": { value: true, variationIndex: 1, reason: "RULE_MATCH" } },
      },
    });
    // Synchronously usable, before any network round trip.
    expect(client.get("beta-banner", false)).toBe(true);
  });
});

describe("streaming value updates", () => {
  it("pushes a new value when a flag changes", async () => {
    const cp = await controlPlane();
    const client = makeClient({
      baseUrl: cp.baseUrl,
      context: { key: "usr_1", plan: "pro" },
      stream: true,
    });
    await client.ready({ timeoutMs: 2_000 });
    expect(client.get("beta-banner", false)).toBe(true);

    // Turn the flag off entirely; the connected browser must see it.
    const store = cp.store;
    const current = (await store.get(ENV_ID))!;
    const updated = {
      ...current.snapshot,
      version: current.version + 1,
      flags: {
        ...current.snapshot.flags,
        "beta-banner": { ...current.snapshot.flags["beta-banner"]!, on: false },
      },
    };
    await store.put(ENV_ID, updated);

    // Re-published on each attempt: the SSE connection is established a round
    // trip after `ready()` resolves, so a single publish can legitimately land
    // before this browser is in the registry. The catch-up on stream open
    // covers that case too; this keeps the test about delivery, not timing.
    await vi.waitFor(
      async () => {
        await store.publish(ENV_ID, { version: updated.version, flagKey: "beta-banner" });
        expect(client.get("beta-banner", true)).toBe(false);
      },
      { timeout: 3_000, interval: 50 },
    );
  });

  it("does not treat its own stream replacement as a lost connection", async () => {
    // identify() opens a new stream, which aborts the old one. Reading that
    // abort as a dropped connection went offline and refetched, whose new
    // stream aborted the last — a loop that never settled.
    const cp = await controlPlane();
    const errors: unknown[] = [];
    const client = makeClient({
      baseUrl: cp.baseUrl,
      context: { key: "usr_1", plan: "pro" },
      stream: true,
      onError: (error: unknown) => errors.push(error),
    });
    await client.ready({ timeoutMs: 2_000 });

    const states: string[] = [];
    client.on("state", (state) => states.push(state));
    await client.identify({ key: "usr_2", plan: "pro" });

    // Past the 1.5s recovery delay, so a spurious reconnect would have fired.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(states).not.toContain("offline");
    expect(errors).toEqual([]);
    expect(client.get("beta-banner", false)).toBe(true);
  });

  it("refuses a stream for a connection that was never established", async () => {
    // The stream carries no context of its own; inventing one would mean
    // evaluating as an identity nobody proved.
    const cp = await controlPlane();
    const response = await fetch(
      `${cp.baseUrl}/v1/client/stream?connection=made-up&key=${CLIENT_KEY}`,
    );
    expect(response.status).toBe(409);
  });
});
