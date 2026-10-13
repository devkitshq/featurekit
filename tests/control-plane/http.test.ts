import { afterEach, describe, expect, it } from "vitest";
import { HttpError, Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";

const servers: HttpServer[] = [];

async function serve(router: Router): Promise<string> {
  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { port, host } = await server.listen();
  return `http://${host}:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("Router.match", () => {
  const router = new Router()
    .get("/v1/snapshot/:env", () => ({ status: 200 }))
    .get("/v1/projects/:p/flags/:key", () => ({ status: 200 }))
    .post("/v1/events", () => ({ status: 202 }));

  it("extracts path parameters", () => {
    const matched = router.match("GET", "/v1/projects/acme/flags/new-checkout");
    expect(matched).not.toBeNull();
    expect(matched).not.toBe("method-mismatch");
    expect((matched as { params: Record<string, string> }).params).toEqual({
      p: "acme",
      key: "new-checkout",
    });
  });

  it("decodes percent-encoded parameters", () => {
    const matched = router.match("GET", "/v1/snapshot/my%2Fenv");
    expect((matched as { params: Record<string, string> }).params["env"]).toBe("my/env");
  });

  it("returns null for an unknown path", () => {
    expect(router.match("GET", "/nope")).toBeNull();
  });

  it("distinguishes a wrong verb from a wrong URL", () => {
    // 405 vs 404 is most of the debugging time on a REST client.
    expect(router.match("DELETE", "/v1/events")).toBe("method-mismatch");
  });

  it("does not match a path with a different segment count", () => {
    expect(router.match("GET", "/v1/snapshot/production/extra")).toBeNull();
    expect(router.match("GET", "/v1/snapshot")).toBeNull();
  });
});

describe("HttpServer", () => {
  it("serves JSON with a content-length", async () => {
    const base = await serve(new Router().get("/hello", () => ({ status: 200, body: { ok: true } })));
    const response = await fetch(`${base}/hello`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers 404 and 405 distinctly", async () => {
    const base = await serve(new Router().get("/only-get", () => ({ status: 200 })));
    expect((await fetch(`${base}/missing`)).status).toBe(404);
    expect((await fetch(`${base}/only-get`, { method: "POST" })).status).toBe(405);
  });

  it("parses a JSON body", async () => {
    const router = new Router().post("/echo", async (ctx) => ({
      status: 200,
      body: await ctx.json(),
    }));
    const base = await serve(router);
    const response = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flag: "new-checkout" }),
    });
    expect(await response.json()).toEqual({ flag: "new-checkout" });
  });

  it("rejects a malformed JSON body with 400, not 500", async () => {
    const router = new Router().post("/echo", async (ctx) => ({ status: 200, body: await ctx.json() }));
    const base = await serve(router);
    const response = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_JSON");
  });

  it("maps an HttpError to its status and code", async () => {
    const router = new Router().get("/gone", () => {
      throw new HttpError(401, "UNKNOWN_KEY", "no such SDK key");
    });
    const base = await serve(router);
    const response = await fetch(`${base}/gone`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNKNOWN_KEY", message: "no such SDK key" });
  });

  it("never leaks an internal error message to the caller", async () => {
    const router = new Router().get("/boom", () => {
      throw new Error("connection string postgres://user:hunter2@db/featurekit failed");
    });
    const base = await serve(router);
    const response = await fetch(`${base}/boom`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({ error: "INTERNAL_ERROR" }));
    expect(body).not.toContain("hunter2");
  });

  it("reports errors to the hook so they can be logged", async () => {
    const seen: string[] = [];
    const router = new Router().get("/boom", () => {
      throw new Error("kaboom");
    });
    const server = new HttpServer({
      router,
      port: 0,
      onError: (error) => seen.push((error as Error).message),
    });
    servers.push(server);
    const { port, host } = await server.listen();
    await fetch(`http://${host}:${port}/boom`);
    expect(seen).toEqual(["kaboom"]);
  });

  it("passes query parameters through", async () => {
    const router = new Router().get("/q", (ctx) => ({
      status: 200,
      body: { since: ctx.query.get("since") },
    }));
    const base = await serve(router);
    expect(await (await fetch(`${base}/q?since=42`)).json()).toEqual({ since: "42" });
  });
});

describe("SSE", () => {
  it("streams events with an id, and keeps the connection open", async () => {
    const { openSse } = await import("../../src/http/server.js");
    const router = new Router().get("/stream", (ctx) => {
      const stream = openSse(ctx.res, { heartbeatMs: 50 });
      stream.event("put", { version: 1 }, 1);
      setTimeout(() => {
        stream.event("patch", { flagKey: "f" }, 2);
        stream.close();
      }, 20);
      return undefined; // handler took over the socket
    });
    const base = await serve(router);

    const response = await fetch(`${base}/stream`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // A buffering proxy turns a sub-300ms kill switch into whatever the flush
    // interval happens to be.
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const body = await response.text();
    expect(body).toContain("id: 1\nevent: put\n");
    expect(body).toContain('data: {"version":1}');
    expect(body).toContain("id: 2\nevent: patch\n");
  });

  it("sends heartbeats so proxies do not reap an idle connection", async () => {
    const { openSse } = await import("../../src/http/server.js");
    const router = new Router().get("/stream", (ctx) => {
      const stream = openSse(ctx.res, { heartbeatMs: 10 });
      setTimeout(() => stream.close(), 60);
      return undefined;
    });
    const base = await serve(router);
    const body = await (await fetch(`${base}/stream`)).text();
    expect(body.split(": ping").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("reports closure so the server can drop its connection registry entry", async () => {
    const { openSse } = await import("../../src/http/server.js");
    let closed = false;
    const router = new Router().get("/stream", (ctx) => {
      const stream = openSse(ctx.res, { heartbeatMs: 10, onClose: () => (closed = true) });
      setTimeout(() => stream.close(), 10);
      return undefined;
    });
    const base = await serve(router);
    await (await fetch(`${base}/stream`)).text();
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("writes nothing after close, so a late patch cannot resurrect a dead stream", async () => {
    const { openSse } = await import("../../src/http/server.js");
    let wroteAfterClose: boolean | undefined;
    const router = new Router().get("/stream", (ctx) => {
      const stream = openSse(ctx.res, { heartbeatMs: 1_000 });
      stream.event("put", { version: 1 }, 1);
      stream.close();
      wroteAfterClose = stream.event("patch", { version: 2 }, 2);
      return undefined;
    });
    const base = await serve(router);
    const body = await (await fetch(`${base}/stream`)).text();
    expect(wroteAfterClose).toBe(false);
    expect(body).not.toContain("event: patch");
  });
});

import { vi } from "vitest";
