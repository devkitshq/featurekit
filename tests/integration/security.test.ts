/**
 * Adversarial security scenarios (review §7, §8, §17, PR-C5).
 *
 * The management-API suite covers the headline isolation cases. This one covers
 * what the review asks for and those did not: escalation through *nested*
 * resources, credential probing, handle guessing, and whether the telemetry
 * itself leaks the things the tiers exist to protect.
 *
 * Every test is written from the attacker's side — what is being attempted, and
 * what must happen instead.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import { accessTokens, environments, members } from "../../src/db/schema.js";
import { generateAccessToken, hashKey } from "../../src/auth/keys.js";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { registerAdminRoutes } from "../../src/routes/admin.js";
import { registerSdkRoutes } from "../../src/routes/sdk.js";
import { registerClientRoutes } from "../../src/routes/client.js";
import { registerOpsRoutes } from "../../src/routes/ops.js";
import { AccessTokenRepository } from "../../src/repositories/access-tokens.js";
import { SdkKeyRepository } from "../../src/repositories/sdk-keys.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { MemorySnapshotStore } from "../../src/redis/memory-store.js";
import { Metrics } from "../../src/observability/metrics.js";
import { loadCompilerInput } from "../../src/repositories/snapshot-input.js";
import { nextSnapshotVersion } from "../../src/repositories/environments.js";
import { eq } from "drizzle-orm";

const reason = await containerUnavailableReason();

describe("security suite prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; security tests will run"
      : `security tests SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("an attacker with a scoped token", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let server: HttpServer;
  let base: string;
  let metrics: Metrics;
  let snapshots: SnapshotService;

  let ownerToken: string;
  /** Scoped to `victim/staging` only. Everything else must be invisible. */
  let scopedToken: string;
  let readerToken: string;
  let serverSdkKey: string;
  let clientSdkKey: string;

  beforeAll(async () => {
    infra = await startInfrastructure();
    handle = createDatabase({ url: infra.databaseUrl });
    db = handle.db;
    await runMigrations(db);

    const store = new MemorySnapshotStore();
    snapshots = new SnapshotService({
      store,
      loadInput: (id) => loadCompilerInput(db, id),
      nextVersion: (id) => nextSnapshotVersion(db, id),
      debounceMs: 5,
    });
    const sdkKeys = new SdkKeyRepository(db, { ttlMs: 0, negativeTtlMs: 0 });
    metrics = new Metrics({ defaultMetrics: false });

    const router = new Router();
    registerAdminRoutes(router, {
      db,
      snapshots,
      tokens: new AccessTokenRepository(db, { ttlMs: 0, negativeTtlMs: 0 }),
      onKeyRevoked: () => sdkKeys.invalidateAll(),
    });
    registerSdkRoutes(router, {
      snapshots,
      store,
      authenticate: async (presented) => {
        const resolved = await sdkKeys.resolve(presented);
        return resolved === null ? null : { ...resolved };
      },
    });
    registerClientRoutes(router, {
      snapshots,
      store,
      authenticate: async (presented) => {
        const resolved = await sdkKeys.resolve(presented);
        return resolved === null ? null : { ...resolved };
      },
    });
    registerOpsRoutes(router, {
      metrics,
      checkDatabase: async () => ({ state: "ok" }),
      checkRedis: async () => ({ state: "ok" }),
      partitionRunwayDays: async () => 7,
      snapshotAges: () => snapshots.ages(),
      cacheMs: 0,
    });

    server = new HttpServer({ router, port: 0 });
    const address = await server.listen();
    base = `http://${address.host}:${address.port}`;

    const [owner] = await db
      .insert(members)
      .values({ email: "owner@sec.example", role: "owner" })
      .returning({ id: members.id });
    ownerToken = generateAccessToken();
    await db
      .insert(accessTokens)
      .values({ memberId: owner!.id, tokenHash: hashKey(ownerToken), environmentIds: null });

    // Two tenants, each with two environments.
    for (const project of ["victim", "attacker"]) {
      await call("/v1/admin/projects", {
        method: "POST",
        body: JSON.stringify({ key: project, name: project }),
      });
      for (const env of ["production", "staging"]) {
        await call(`/v1/admin/projects/${project}/environments`, {
          method: "POST",
          body: JSON.stringify({ key: env, name: env, isProduction: env === "production" }),
        });
      }
      await call(`/v1/admin/projects/${project}/flags`, {
        method: "POST",
        body: JSON.stringify({
          key: "secret-pricing",
          name: "Secret pricing",
          kind: "boolean",
          clientAvailable: true,
          variations: [{ value: false }, { value: true }],
        }),
      });
    }

    const [staging] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.key, "staging"))
      .limit(1);

    const [writer] = await db
      .insert(members)
      .values({ email: "scoped@sec.example", role: "writer" })
      .returning({ id: members.id });
    scopedToken = generateAccessToken();
    await db.insert(accessTokens).values({
      memberId: writer!.id,
      tokenHash: hashKey(scopedToken),
      environmentIds: [staging!.id],
    });

    const [reader] = await db
      .insert(members)
      .values({ email: "reader@sec.example", role: "reader" })
      .returning({ id: members.id });
    readerToken = generateAccessToken();
    await db
      .insert(accessTokens)
      .values({ memberId: reader!.id, tokenHash: hashKey(readerToken), environmentIds: null });

    const serverKey = await (
      await call("/v1/admin/projects/victim/environments/production/keys", {
        method: "POST",
        body: JSON.stringify({ kind: "server" }),
      })
    ).json();
    serverSdkKey = (serverKey as { key: string }).key;

    const clientKey = await (
      await call("/v1/admin/projects/victim/environments/production/keys", {
        method: "POST",
        body: JSON.stringify({ kind: "client" }),
      })
    ).json();
    clientSdkKey = (clientKey as { key: string }).key;
  }, 600_000);

  afterAll(async () => {
    await server?.close();
    await snapshots?.close();
    await handle?.close();
    await infra?.stop();
  });

  function call(path: string, init: RequestInit = {}, token?: string) {
    return fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token ?? ownerToken}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  /* ── escalation through nested resources ──────────────────────────── */

  const nested = [
    ["GET", "/v1/admin/projects/victim/environments/production/flags/secret-pricing"],
    ["GET", "/v1/admin/projects/victim/environments/production/segments"],
    ["GET", "/v1/admin/projects/victim/environments/production/flags/secret-pricing/schedule"],
    ["GET", "/v1/admin/projects/victim/environments/production/flags/secret-pricing/requests"],
  ] as const;

  for (const [method, path] of nested) {
    it(`refuses ${method} ${path.split("/").slice(-2).join("/")} for an out-of-scope token`, async () => {
      // The scoped token is valid, and for the same *project*. Every nested
      // resource has to re-check the environment, not assume the parent did.
      const response = await call(path, { method }, scopedToken);
      expect(response.status).toBe(404);
    });
  }

  it("refuses to schedule a change in an out-of-scope environment", async () => {
    const response = await call(
      "/v1/admin/projects/victim/environments/production/flags/secret-pricing/schedule",
      {
        method: "POST",
        body: JSON.stringify({
          patch: { enabled: true },
          executeAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
      scopedToken,
    );
    expect(response.status).toBe(404);
  });

  it("refuses to mint an SDK key in an out-of-scope environment", async () => {
    // Minting a key would be a scope escape with a persistent credential.
    const response = await call(
      "/v1/admin/projects/victim/environments/production/keys",
      { method: "POST", body: JSON.stringify({ kind: "server" }) },
      scopedToken,
    );
    expect([403, 404]).toContain(response.status);
  });

  it("refuses to create an environment from an environment-scoped token", async () => {
    // Otherwise a scoped token mints itself an environment outside its scope
    // and then a key inside it.
    const response = await call(
      "/v1/admin/projects/victim/environments",
      { method: "POST", body: JSON.stringify({ key: "backdoor", name: "backdoor" }) },
      scopedToken,
    );
    expect(response.status).toBe(403);
  });

  it("refuses a write from a reader token, even in scope", async () => {
    const response = await call(
      "/v1/admin/projects/victim/environments/production/flags/secret-pricing",
      { method: "PATCH", body: JSON.stringify({ expectedVersion: 1, enabled: true }) },
      readerToken,
    );
    expect(response.status).toBe(403);
  });

  it("lets a reader raise a change request but not approve it", async () => {
    // Four-eyes made useful: proposing is not privileged, applying is.
    const raised = await call(
      "/v1/admin/projects/victim/environments/production/flags/secret-pricing/requests",
      { method: "POST", body: JSON.stringify({ patch: { enabled: true } }) },
      readerToken,
    );
    expect(raised.status).toBe(200);
    const { id } = (await raised.json()) as { id: string };

    const approved = await call(
      `/v1/admin/projects/victim/environments/production/flags/secret-pricing/requests/${id}/approve`,
      { method: "POST", body: "{}" },
      readerToken,
    );
    expect(approved.status).toBe(403);
  });

  /* ── credential confusion ─────────────────────────────────────────── */

  it("refuses an SDK key on the management API", async () => {
    const response = await call("/v1/admin/projects", {}, serverSdkKey);
    expect(response.status).toBe(401);
  });

  it("refuses a management token on the SDK API", async () => {
    const response = await fetch(`${base}/v1/snapshot/production`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.status).toBe(401);
  });

  it("refuses a client key on the ruleset stream", async () => {
    // The whole two-tier split in one assertion: a browser key must never buy
    // the rules.
    const response = await fetch(`${base}/v1/snapshot/production`, {
      headers: { authorization: `Bearer ${clientSdkKey}` },
    });
    expect(response.status).toBe(401);
  });

  it("refuses a server key on the client endpoint", async () => {
    const response = await fetch(`${base}/v1/client/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${serverSdkKey}`, "content-type": "application/json" },
      body: JSON.stringify({ context: { key: "u" } }),
    });
    expect(response.status).toBe(401);
  });

  it("gives one indistinguishable answer to every kind of bad credential", async () => {
    // Distinguishing unknown from revoked from wrong-tier is a probing oracle.
    const shapes = await Promise.all(
      [
        "fk_srv_completely-made-up",
        "fk_clt_completely-made-up",
        "not-even-a-key",
        "",
        "Bearer",
      ].map(async (candidate) => {
        const response = await fetch(`${base}/v1/snapshot/production`, {
          headers: { authorization: `Bearer ${candidate}` },
        });
        return `${response.status}:${((await response.json()) as { error: string }).error}`;
      }),
    );
    expect(new Set(shapes).size).toBe(1);
  });

  /* ── handle guessing ──────────────────────────────────────────────── */

  it("refuses guessed client connection handles", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        fetch(`${base}/v1/client/stream?connection=guess-${i}&key=${clientSdkKey}`).then(
          (r) => r.status,
        ),
      ),
    );
    expect(new Set(attempts)).toEqual(new Set([409]));
  });

  /* ── telemetry leakage (§17) ──────────────────────────────────────── */

  it("puts no context key, flag key or tenant id in the metrics", async () => {
    // Ask for a flag as a very identifiable user, then scrape.
    await fetch(`${base}/v1/client/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientSdkKey}`, "content-type": "application/json" },
      body: JSON.stringify({ context: { key: "victim@example.com", plan: "enterprise" } }),
    });
    await fetch(`${base}/v1/snapshot/production`, {
      headers: { authorization: `Bearer ${serverSdkKey}` },
    });

    const scrape = await (await fetch(`${base}/metrics`)).text();
    expect(scrape).not.toContain("victim@example.com");
    expect(scrape).not.toContain("secret-pricing");
    expect(scrape).not.toContain("enterprise");
    expect(scrape).not.toContain(serverSdkKey);
    expect(scrape).not.toContain(clientSdkKey);
    // The route pattern is there; the environment key in the path is not.
    expect(scrape).toContain("featkit_http_requests_total");
  });

  it("does not echo a credential in any error response", async () => {
    const probes = [
      fetch(`${base}/v1/snapshot/production`, {
        headers: { authorization: `Bearer ${"fk_srv_leaky-secret-value"}` },
      }),
      call("/v1/admin/projects", {}, "fk_pat_leaky-secret-value"),
    ];
    for (const probe of probes) {
      const text = await (await probe).text();
      expect(text).not.toContain("leaky-secret-value");
    }
  });

  it("does not disclose whether a project exists to an unauthorised caller", async () => {
    const real = await call(
      "/v1/admin/projects/victim/environments/production/flags/secret-pricing",
      {},
      scopedToken,
    );
    const fake = await call(
      "/v1/admin/projects/does-not-exist/environments/production/flags/whatever",
      {},
      scopedToken,
    );
    expect(real.status).toBe(fake.status);
  });
});
