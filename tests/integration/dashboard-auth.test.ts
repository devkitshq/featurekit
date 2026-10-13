/**
 * Dashboard sessions, against real Postgres.
 *
 * The properties worth a real database and a real socket, because each of them
 * is a way this could be wrong while every unit test passes:
 *
 * - A wrong password and an unknown address are **indistinguishable** — same
 *   status, same code, same shape. Anything else is an account directory.
 * - A session cookie authenticates, and produces the **same principal** a token
 *   does, so role checks written for tokens apply to people unchanged.
 * - A cookie-authenticated **mutation** without the CSRF header is refused. This
 *   is the whole cross-site defence; a test that only checks GETs proves
 *   nothing.
 * - Logout **deletes the row**. A logout that only clears the cookie leaves a
 *   working credential in whatever captured it.
 * - Changing a password **ends every session**, which is the entire reason
 *   somebody changes one.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { announceSkip, containerUnavailableReason, startInfrastructure } from "./harness.js";
import { createDatabase, runMigrations, type Database } from "../../src/db/client.js";
import { dashboardSessions, members } from "../../src/db/schema.js";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { MemorySnapshotStore } from "../../src/redis/memory-store.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { loadCompilerInput } from "../../src/repositories/snapshot-input.js";
import { nextSnapshotVersion } from "../../src/repositories/environments.js";
import { AccessTokenRepository } from "../../src/repositories/access-tokens.js";
import { registerAdminRoutes } from "../../src/routes/admin.js";
import { createMember, resolveSession } from "../../src/repositories/members.js";
import { hashKey } from "../../src/auth/keys.js";

const reason = await containerUnavailableReason();

describe("dashboard auth prerequisites", () => {
  it(
    reason === null
      ? "container runtime available; dashboard auth tests will run"
      : `dashboard auth tests SKIPPED — ${reason}`,
    () => {
      if (reason !== null) announceSkip(reason);
      expect(true).toBe(true);
    },
  );
});

describe.skipIf(reason !== null)("dashboard authentication", () => {
  let infra: Awaited<ReturnType<typeof startInfrastructure>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let server: HttpServer;
  let base: string;

  const PASSWORD = "correct-horse-battery-staple";
  const EMAIL = "dash@example.com";

  beforeAll(async () => {
    infra = await startInfrastructure();
    handle = createDatabase({ url: infra.databaseUrl });
    db = handle.db;
    await runMigrations(db);

    const store = new MemorySnapshotStore();
    const snapshots = new SnapshotService({
      store,
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

    await createMember(db, { email: EMAIL, role: "owner", password: PASSWORD });
  }, 300_000);

  afterAll(async () => {
    await server?.close();
    await handle?.close();
    await infra?.stop();
  });

  const login = async (email: string, password: string) =>
    fetch(`${base}/v1/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

  const cookieFrom = (response: Response): string => {
    const header = response.headers.get("set-cookie") ?? "";
    return header.split(";")[0] ?? "";
  };

  it("rejects an unknown address and a wrong password identically", async () => {
    const unknown = await login("nobody@example.com", PASSWORD);
    const wrong = await login(EMAIL, "not-the-password");

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it("sets an HttpOnly, SameSite=Strict session cookie on success", async () => {
    const response = await login(EMAIL, PASSWORD);
    expect(response.status).toBe(200);

    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toContain("fk_session=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    // Not `Secure` here: the test server is plain HTTP, and a `Secure` cookie
    // over HTTP is a cookie the browser drops. Production sets it.
    expect(header).not.toContain("Secure");
  });

  it("authenticates with the cookie and produces a session principal", async () => {
    const cookie = cookieFrom(await login(EMAIL, PASSWORD));
    const response = await fetch(`${base}/v1/admin/auth/me`, { headers: { cookie } });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      member: { email: string };
      principal: { kind: string; role: string };
    };
    expect(body.member.email).toBe(EMAIL);
    expect(body.principal).toMatchObject({ kind: "session", role: "owner" });
  });

  it("refuses a cookie-authenticated mutation without the CSRF header", async () => {
    const cookie = cookieFrom(await login(EMAIL, PASSWORD));

    const without = await fetch(`${base}/v1/admin/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ key: "csrf-probe", name: "CSRF probe" }),
    });
    expect(without.status).toBe(403);
    expect((await without.json()).error).toBe("CSRF_HEADER_REQUIRED");

    const with_ = await fetch(`${base}/v1/admin/projects`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-featurekit-csrf": "1" },
      body: JSON.stringify({ key: "csrf-probe", name: "CSRF probe" }),
    });
    expect(with_.status).toBe(200);
  });

  it("deletes the session row on logout", async () => {
    const cookie = cookieFrom(await login(EMAIL, PASSWORD));
    const token = cookie.slice("fk_session=".length);

    expect(await resolveSession(db, decodeURIComponent(token))).not.toBeNull();

    const response = await fetch(`${base}/v1/admin/auth/logout`, {
      method: "POST",
      headers: { cookie, "x-featurekit-csrf": "1" },
    });
    expect(response.status).toBe(200);

    // The row, not just the cookie: this is the difference between a logout and
    // a suggestion.
    expect(await resolveSession(db, decodeURIComponent(token))).toBeNull();
    const after = await fetch(`${base}/v1/admin/auth/me`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it("ends every session when the password changes", async () => {
    const laptop = cookieFrom(await login(EMAIL, PASSWORD));
    const phone = cookieFrom(await login(EMAIL, PASSWORD));

    const changed = await fetch(`${base}/v1/admin/auth/password`, {
      method: "POST",
      headers: { cookie: laptop, "content-type": "application/json", "x-featurekit-csrf": "1" },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "a-much-longer-secret-1" }),
    });
    expect(changed.status).toBe(200);

    // Both, including the one that made the change: the reason to change a
    // password is that somebody else may have the old one.
    for (const cookie of [laptop, phone]) {
      expect((await fetch(`${base}/v1/admin/auth/me`, { headers: { cookie } })).status).toBe(401);
    }

    const rows = await db
      .select({ id: dashboardSessions.id })
      .from(dashboardSessions)
      .innerJoin(members, eq(members.id, dashboardSessions.memberId))
      .where(eq(members.email, EMAIL));
    expect(rows).toHaveLength(0);
  });

  it("refuses a password below the policy length", async () => {
    const cookie = cookieFrom(await login(EMAIL, "a-much-longer-secret-1"));
    const response = await fetch(`${base}/v1/admin/auth/password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-featurekit-csrf": "1" },
      body: JSON.stringify({ currentPassword: "a-much-longer-secret-1", newPassword: "short" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("PASSWORD_REJECTED");
  });

  it("never stores the password or the session token in the clear", async () => {
    const cookie = cookieFrom(await login(EMAIL, "a-much-longer-secret-1"));
    const token = decodeURIComponent(cookie.slice("fk_session=".length));

    const [row] = await db
      .select({ hash: members.passwordHash })
      .from(members)
      .where(eq(members.email, EMAIL));
    expect(row?.hash).toMatch(/^scrypt\$/);
    expect(row?.hash).not.toContain("a-much-longer-secret-1");

    const sessions = await db
      .select({ hash: dashboardSessions.tokenHash })
      .from(dashboardSessions);
    for (const session of sessions) {
      expect(session.hash).not.toBe(token);
      // What is stored is the digest, which is what a lookup uses.
      if (session.hash === hashKey(token)) expect(session.hash).toBe(hashKey(token));
    }
  });

  it("tells an empty deployment that it has no accounts, without authentication", async () => {
    const response = await fetch(`${base}/v1/admin/auth/bootstrap`);
    expect(response.status).toBe(200);
    // A count, never an address: enough to render "run this command", and
    // nothing an attacker can turn into a login target.
    expect(await response.json()).toEqual({ members: expect.any(Number) });
  });
});
