/**
 * Secure mode as a property of the environment.
 *
 * The regression this suite exists to prevent is subtle and was live: whether
 * production rejected unsigned contexts depended on the *caller* passing
 * `requireSignature: true` when registering the routes. A security boundary
 * that depends on wiring is a security boundary that a new deployment turns off
 * by omission — and the failure is silent, because everything keeps working.
 *
 * The requirement now comes from `environments.is_production`, carried on the
 * authenticated key. Opting out is possible, explicit, and per environment.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { MemorySnapshotStore } from "../../src/snapshot/memory-store.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { registerClientRoutes } from "../../src/routes/client.js";
import { signContext, verifyContext } from "../../src/auth/secure-mode.js";
import { contextHash } from "../../src/evaluation-service/fanout.js";
import type { AuthenticatedEnvironment } from "../../src/routes/sdk.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

const PROD_ENV = "env-production";
const DEV_ENV = "env-dev";
const SECRET = "a-secret-at-least-thirty-two-characters";

const servers: HttpServer[] = [];
const services: SnapshotService[] = [];

const keys: Record<string, AuthenticatedEnvironment> = {
  prod: {
    id: "k1",
    environmentId: PROD_ENV,
    environmentKey: "production",
    projectId: "p1",
    isProduction: true,
    kind: "client",
    expiresAt: null,
    revokedAt: null,
  },
  dev: {
    id: "k2",
    environmentId: DEV_ENV,
    environmentKey: "development",
    projectId: "p1",
    isProduction: false,
    kind: "client",
    expiresAt: null,
    revokedAt: null,
  },
};

function input(environmentId: string): CompilerInput {
  return {
    environment: { id: environmentId, key: "production", bucketSalt: "salt" },
    flags: [{ id: "f1", key: "f", kind: "boolean", archivedAt: null, clientAvailable: true }],
    variations: [
      { id: "v0", flagId: "f1", idx: 0, value: false },
      { id: "v1", flagId: "f1", idx: 1, value: true },
    ],
    flagEnvironments: [
      {
        id: "fe1",
        flagId: "f1",
        environmentId,
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

async function harness(over: Partial<Parameters<typeof registerClientRoutes>[1]> = {}) {
  const store = new MemorySnapshotStore();
  let version = 0;
  const snapshots = new SnapshotService({
    store,
    loadInput: async (environmentId) => input(environmentId),
    nextVersion: async () => ++version,
    debounceMs: 5,
  });
  services.push(snapshots);

  const router = new Router();
  registerClientRoutes(router, {
    snapshots,
    store,
    authenticate: async (key) => keys[key] ?? null,
    secureModeSecrets: [SECRET],
    ...over,
  });
  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { host, port } = await server.listen();
  return `http://${host}:${port}`;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const state = (base: string, key: string, body: unknown) =>
  fetch(`${base}/v1/client/state`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("secure mode enforcement", () => {
  it("rejects an unsigned context in production without being told to", async () => {
    // No `requireSignature` anywhere in this harness. Production is enough.
    const base = await harness();
    const response = await state(base, "prod", { context: { key: "victim@example.com" } });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("SIGNATURE_MISSING");
  });

  it("accepts a correctly signed context in production", async () => {
    const base = await harness();
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const response = await state(base, "prod", {
      context: { key: "user-1" },
      expiresAt,
      signature: signContext("user-1", expiresAt, [SECRET]),
    });
    expect(response.status).toBe(200);
  });

  it("allows unsigned contexts outside production", async () => {
    const base = await harness();
    expect((await state(base, "dev", { context: { key: "user-1" } })).status).toBe(200);
  });

  it("honours an explicit per-environment opt-out", async () => {
    const base = await harness({ unsignedContextEnvironmentIds: new Set([PROD_ENV]) });
    expect((await state(base, "prod", { context: { key: "user-1" } })).status).toBe(200);
  });

  it("fails closed when production has no secret configured", async () => {
    // A misconfigured deployment must not silently serve unsigned contexts.
    const base = await harness({ secureModeSecrets: [] });
    expect((await state(base, "prod", { context: { key: "user-1" } })).status).toBe(500);
  });

  it("still serves a non-production environment with no secret", async () => {
    const base = await harness({ secureModeSecrets: [] });
    expect((await state(base, "dev", { context: { key: "user-1" } })).status).toBe(200);
  });

  it("rejects a signature for a different identity", async () => {
    // The impersonation attempt: a valid signature the caller
    // captured, presented with somebody else's key.
    const base = await harness();
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const response = await state(base, "prod", {
      context: { key: "victim@example.com" },
      expiresAt,
      signature: signContext("attacker@example.com", expiresAt, [SECRET]),
    });
    expect(response.status).toBe(401);
  });

  it("rejects an expired signature distinctly from an invalid one", async () => {
    const base = await harness();
    const expiresAt = Math.floor(Date.now() / 1000) - 1;
    const response = await state(base, "prod", {
      context: { key: "user-1" },
      expiresAt,
      signature: signContext("user-1", expiresAt, [SECRET]),
    });
    expect(response.status).toBe(401);
    // The SDK keeps serving its last values on EXPIRED and drops to defaults on
    // INVALID, so the distinction has to survive to the wire.
    expect(((await response.json()) as { error: string }).error).toBe("SIGNATURE_EXPIRED");
  });

  it("refuses a signature whose TTL exceeds the maximum", async () => {
    const base = await harness({ secureModeMaxTtlSeconds: 3_600 });
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400 * 365;
    const response = await state(base, "prod", {
      context: { key: "user-1" },
      expiresAt,
      signature: signContext("user-1", expiresAt, [SECRET]),
    });
    expect(((await response.json()) as { error: string }).error).toBe("SIGNATURE_TTL_TOO_LONG");
  });

  it("accepts a signed context with attribute hash and rejects tampered attributes", async () => {
    const base = await harness({ secureModeSecrets: [SECRET] });
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const originalContext = { key: "user-1", plan: "pro" };
    const attrHash = contextHash(originalContext);
    const signature = signContext("user-1", expiresAt, [SECRET], attrHash);

    // Valid signature with original attributes is accepted
    const ok = await state(base, "prod", {
      context: originalContext,
      expiresAt,
      signature,
    });
    expect(ok.status).toBe(200);

    // Tampered attributes with the same signature fails verification
    const tamperedContext = { key: "user-1", plan: "enterprise" };
    const badHash = contextHash(tamperedContext);
    const result = verifyContext(
      { key: "user-1", expiresAt, signature, attributesHash: badHash },
      { secrets: [SECRET], maxTtlSeconds: 86_400 },
    );
    expect(result.ok).toBe(false);
  });
});

describe("client-tier input caps", () => {
  it("rejects an oversized context before evaluating it", async () => {
    const base = await harness();
    const context: Record<string, unknown> = { key: "user-1" };
    for (let i = 0; i < 500; i++) context[`attr${i}`] = "x".repeat(50);
    const response = await state(base, "dev", { context });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "CONTEXT_TOO_MANY_ATTRIBUTES",
    );
  });

  it("rejects a deeply nested context rather than overflowing the stack", async () => {
    const base = await harness();
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 200; i++) deep = { next: deep };
    const response = await state(base, "dev", { context: { key: "u", deep } });
    expect(response.status).toBe(400);
  });

  it("still requires a context", async () => {
    const base = await harness();
    expect((await state(base, "dev", {})).status).toBe(400);
  });
});

describe("a connection handle does not outlive its signature", () => {
  const signedIdentify = async (base: string, ttlSeconds: number) => {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const response = await state(base, "prod", {
      context: { key: "user-1" },
      expiresAt,
      signature: signContext("user-1", expiresAt, [SECRET], contextHash({ key: "user-1" })),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { connectionId: string }).connectionId;
  };
  const stream = (base: string, connectionId: string, signal?: AbortSignal) =>
    fetch(`${base}/v1/client/stream?connection=${encodeURIComponent(connectionId)}&key=prod`, {
      ...(signal !== undefined ? { signal } : {}),
    });

  it("refuses the stream once the signature has expired", async () => {
    const base = await harness();
    const connectionId = await signedIdentify(base, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const response = await stream(base, connectionId);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("SIGNATURE_EXPIRED");
  });

  it("closes an open stream when the signature expires", async () => {
    const base = await harness();
    const connectionId = await signedIdentify(base, 1);
    const abort = new AbortController();
    const response = await stream(base, connectionId, abort.signal);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const ended = (async () => {
      for (;;) if ((await reader.read()).done) return true;
    })();
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000));
    const closed = await Promise.race([ended, timeout]);
    abort.abort();
    expect(closed).toBe(true);
  });
});
