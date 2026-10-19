/**
 * featurekit-mcp against the real admin API and real Postgres.
 *
 * The request this exists for: "roll out cart v2 page to 20% of users". The
 * tool has to find `cart-v2-page` from the phrase, write a 20% rollout, and —
 * the part only an end-to-end test can show — the compiled snapshot must then
 * actually serve `true` to about a fifth of users. Raising it must keep those
 * users in, and the server must refuse to guess or to write when read-only.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import { members, accessTokens, environments } from "../../src/db/schema.js";
import { hashKey, generateAccessToken } from "../../src/auth/keys.js";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { registerAdminRoutes } from "../../src/routes/admin.js";
import { AccessTokenRepository } from "../../src/repositories/access-tokens.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { MemorySnapshotStore } from "../../src/snapshot/memory-store.js";
import { loadCompilerInput } from "../../src/repositories/snapshot-input.js";
import { nextSnapshotVersion } from "../../src/repositories/environments.js";
import { evaluate } from "../../src/sdk/index.js";
import { createServer, type ServerOptions } from "../../packages/mcp/src/index.js";

const reason = await containerUnavailableReason();

describe("featurekit-mcp prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; MCP tests will run"
      : `MCP tests SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("featurekit-mcp", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let server: HttpServer;
  let snapshots: SnapshotService;
  let base: string;
  let token: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    infra = await startInfrastructure();
    handle = createDatabase({ url: infra.databaseUrl });
    db = handle.db;
    await runMigrations(db);

    snapshots = new SnapshotService({
      store: new MemorySnapshotStore(),
      loadInput: (environmentId) => loadCompilerInput(db, environmentId),
      nextVersion: (environmentId) => nextSnapshotVersion(db, environmentId),
      debounceMs: 5,
    });
    const router = new Router();
    registerAdminRoutes(router, {
      db,
      snapshots,
      tokens: new AccessTokenRepository(db, { ttlMs: 0, negativeTtlMs: 0 }),
    });
    server = new HttpServer({ router, port: 0 });
    const address = await server.listen();
    base = `http://${address.host}:${address.port}`;

    const [owner] = await db
      .insert(members)
      .values({ email: "owner@example.com", name: "Owen Owner", role: "owner" })
      .returning({ id: members.id });
    token = generateAccessToken();
    await db.insert(accessTokens).values({
      memberId: owner!.id,
      tokenHash: hashKey(token),
      name: "mcp",
      environmentIds: null,
    });

    const admin = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      });
    await admin("/v1/admin/projects", { key: "shop", name: "Shop" });
    await admin("/v1/admin/projects/shop/environments", { key: "staging", name: "Staging" });
    await admin("/v1/admin/projects/shop/environments", {
      key: "production",
      name: "Production",
      isProduction: true,
    });
    await admin("/v1/admin/projects/shop/flags", {
      key: "cart-v2-checkout",
      name: "Cart v2 checkout",
      kind: "boolean",
      variations: [{ value: false }, { value: true }],
    });
  }, 300_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await server?.close();
    await snapshots?.close();
    await handle?.close();
    await infra?.stop();
  });

  async function connect(over: Partial<ServerOptions> = {}): Promise<Client> {
    const mcp = createServer({ baseUrl: base, token, write: true, defaultProject: "shop", ...over });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
  }

  const config = async (environment: string, flag: string) => {
    const response = await fetch(
      `${base}/v1/admin/projects/shop/environments/${environment}/flags/${flag}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    return (await response.json()) as {
      enabled: boolean;
      fallthroughRollout?: { variations: { variationIndex: number; weight: number }[] };
    };
  };

  /** Who actually gets `true`, from the compiled snapshot an SDK would receive. */
  const servedTrue = async (environment: string, flag: string) => {
    const [env] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.key, environment));
    // Waits out the debounced compile the write already started, if it holds the lock.
    const compiled = await snapshots.notifyChangeImmediate(env!.id);
    const snapshot = compiled!.snapshot;
    const keys = Array.from({ length: 10_000 }, (_, i) => `user-${i}`);
    return new Set(keys.filter((key) => evaluate(flag, { key }, snapshot, false).value === true));
  };

  it("creates a flag, then rolls it out to 20% of users from a loose phrase", async () => {
    const client = await connect();
    const created = await call(client, "create_flag", { key: "cart-v2-page", name: "Cart v2 page" });
    expect(created.isError).toBe(false);

    const rolled = await call(client, "set_rollout", {
      flag: "cart v2 page",
      percentage: 20,
      environment: "production",
    });
    expect(rolled.isError).toBe(false);
    expect(rolled.text).toContain("cart-v2-page in production: 20% get true");
    expect(rolled.text).toContain("now on");
    expect(rolled.text).toContain("PRODUCTION");

    const stored = await config("production", "cart-v2-page");
    expect(stored.enabled).toBe(true);
    expect(stored.fallthroughRollout?.variations).toEqual([
      { variationIndex: 1, weight: 20_000 },
      { variationIndex: 0, weight: 80_000 },
    ]);

    const share = (await servedTrue("production", "cart-v2-page")).size / 10_000;
    expect(share).toBeGreaterThan(0.18);
    expect(share).toBeLessThan(0.22);

    // Staging was not touched.
    expect((await config("staging", "cart-v2-page")).enabled).toBe(false);
  });

  it("raising the rollout keeps everyone who already had it", async () => {
    const client = await connect();
    const before = await servedTrue("production", "cart-v2-page");
    const raised = await call(client, "set_rollout", {
      flag: "cart-v2-page",
      percentage: 50,
      environment: "production",
    });
    expect(raised.isError).toBe(false);
    const after = await servedTrue("production", "cart-v2-page");
    for (const key of before) expect(after.has(key)).toBe(true);
    expect(after.size / 10_000).toBeGreaterThan(0.47);
  });

  it("describes the flag back in words", async () => {
    const client = await connect();
    const read = await call(client, "get_flag", { flag: "cart v2 page", environment: "production" });
    expect(read.text).toContain("50% get true");
    expect(read.text).toContain("50% get false");
  });

  it("refuses to guess an ambiguous flag or an unset environment", async () => {
    const client = await connect();
    const ambiguous = await call(client, "set_rollout", {
      flag: "cart v2",
      percentage: 10,
      environment: "staging",
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("cart-v2-page");
    expect(ambiguous.text).toContain("cart-v2-checkout");

    const noEnvironment = await call(client, "set_rollout", { flag: "cart-v2-page", percentage: 10 });
    expect(noEnvironment.isError).toBe(true);
    expect(noEnvironment.text).toContain("which environment?");
    expect((await config("staging", "cart-v2-page")).enabled).toBe(false);
  });

  it("turns a flag off with the kill switch, and records who did it", async () => {
    const client = await connect();
    const off = await call(client, "turn_flag_off", {
      flag: "cart-v2-page",
      environment: "production",
      comment: "checkout errors",
    });
    expect(off.isError).toBe(false);
    expect((await config("production", "cart-v2-page")).enabled).toBe(false);

    const log = await call(client, "get_audit_log", { flag: "cart-v2-page" });
    expect(log.text).toContain("checkout errors (via featurekit-mcp)");
  });

  it("offers no write tools when read-only", async () => {
    const client = await connect({ write: false });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("find_flags");
    expect(names).not.toContain("set_rollout");
    expect(names).not.toContain("turn_flag_off");
  });

  it("reports a rejected token instead of failing the protocol", async () => {
    const client = await connect({ token: "fk_pat_not-a-real-token" });
    const result = await call(client, "list_projects", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("401");
  });
});
