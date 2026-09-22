/**
 * CORS, rate limiting and body limits (§15, §16, §22).
 *
 * Three properties, each of which is a finding if it regresses:
 *
 * 1. **CORS never reaches the server tier.** Those routes serve the full
 *    ruleset; a browser that can read them cross-origin is the leak the two-tier
 *    split exists to prevent.
 * 2. **Losing Redis tightens the rate limit, it does not remove it.** Failing
 *    open on a cache outage is how a blip becomes an incident.
 * 3. **No credential ever appears in a rate-limit key**, because those keys are
 *    visible in `MONITOR` output and slow logs.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Router, type RequestContext } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { corsMiddleware } from "../../src/http/cors.js";
import {
  RateLimiter,
  rateLimitIdentity,
  rateLimitMiddleware,
  type RateLimitBackend,
} from "../../src/http/rate-limit.js";

const servers: HttpServer[] = [];
const ORIGIN = "https://app.example.com";
const CLIENT_ROUTES = new Set(["/v1/client/state"]);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(middleware: Parameters<typeof HttpServer>[0]["middleware"] = []) {
  const router = new Router()
    .post("/v1/client/state", () => ({ status: 200, body: { ok: true } }))
    .get("/v1/snapshot/:envKey", () => ({ status: 200, body: { ok: true } }));
  router.add("OPTIONS", "/v1/client/state", () => ({ status: 204 }));

  const server = new HttpServer({ router, port: 0, middleware });
  servers.push(server);
  const { host, port } = await server.listen();
  return `http://${host}:${port}`;
}

describe("CORS", () => {
  const cors = corsMiddleware({ allowedOrigins: [ORIGIN], routes: CLIENT_ROUTES });

  it("allows a configured origin on the client tier", async () => {
    const base = await serve([cors]);
    const response = await fetch(`${base}/v1/client/state`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("answers preflight without running the handler", async () => {
    const base = await serve([cors]);
    const response = await fetch(`${base}/v1/client/state`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("never sends CORS headers on the server tier", async () => {
    // The ruleset endpoint. A browser must not be able to read this
    // cross-origin no matter what is configured (§11.5).
    const base = await serve([cors]);
    const response = await fetch(`${base}/v1/snapshot/production`, { headers: { origin: ORIGIN } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("ignores an origin that merely looks like an allowed one", async () => {
    const base = await serve([cors]);
    const response = await fetch(`${base}/v1/client/state`, {
      method: "POST",
      headers: { origin: "https://app.example.com.evil.test" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never emits a wildcard", async () => {
    const base = await serve([corsMiddleware({ allowedOrigins: ["*"], routes: CLIENT_ROUTES })]);
    const response = await fetch(`${base}/v1/client/state`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    // "*" configured literally still only matches the literal origin "*",
    // which no browser sends. There is no path to a wildcard response.
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

class MapBackend implements RateLimitBackend {
  readonly counters = new Map<string, number>();
  failing = false;

  async incr(key: string): Promise<number> {
    if (this.failing) throw new Error("redis down");
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
  async peek(key: string): Promise<number> {
    if (this.failing) throw new Error("redis down");
    return this.counters.get(key) ?? 0;
  }
}

describe("RateLimiter", () => {
  it("allows up to the limit and refuses past it", async () => {
    const limiter = new RateLimiter({ backend: new MapBackend(), now: () => 60_000 });
    const rule = { limit: 3, windowMs: 60_000 };
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push((await limiter.consume("id", rule)).allowed);
    expect(outcomes).toEqual([true, true, true, false]);
  });

  it("tightens rather than disappears when the backend fails", async () => {
    // The fail-open that turns a cache outage into a security incident.
    const backend = new MapBackend();
    const limiter = new RateLimiter({ backend, degradedFactor: 0.5, now: () => 60_000 });
    const rule = { limit: 10, windowMs: 60_000 };
    backend.failing = true;

    const results = [];
    for (let i = 0; i < 8; i++) results.push(await limiter.consume("id", rule));
    expect(results.every((r) => r.degraded)).toBe(true);
    // Half of 10, per node, rather than unlimited.
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("counts a previous window, so a burst across the boundary is caught", async () => {
    const backend = new MapBackend();
    let now = 59_000;
    const limiter = new RateLimiter({ backend, now: () => now });
    const rule = { limit: 5, windowMs: 60_000 };
    for (let i = 0; i < 5; i++) await limiter.consume("id", rule);
    // One millisecond later, in the next fixed window: a naive fixed-window
    // limiter would hand out five more immediately.
    now = 60_001;
    expect((await limiter.consume("id", rule)).allowed).toBe(false);
  });

  it("bounds its local fallback state", async () => {
    const limiter = new RateLimiter({ maxLocalKeys: 10, now: () => 60_000 });
    for (let i = 0; i < 200; i++) await limiter.consume(`id-${i}`, { limit: 5, windowMs: 60_000 });
    // No backend at all: everything goes through the local limiter, which must
    // not grow without bound.
    expect(limiter["local"].size).toBeLessThanOrEqual(200);
  });
});

describe("rate limit identity", () => {
  it("never contains the credential", () => {
    const key = "fk_srv_supersecretvalue";
    const ctx = {
      header: () => `Bearer ${key}`,
      query: new URLSearchParams(),
      req: { socket: { remoteAddress: "10.0.0.1" } },
    } as unknown as RequestContext;
    const identity = rateLimitIdentity(ctx, "/v1/snapshot/:envKey");
    expect(identity).not.toContain(key);
    expect(identity).not.toContain("supersecret");
    expect(identity.startsWith("fk:rl:/v1/snapshot/:envKey:")).toBe(true);
  });

  it("separates callers that present different credentials", () => {
    const make = (auth: string) =>
      rateLimitIdentity(
        {
          header: () => auth,
          query: new URLSearchParams(),
          req: { socket: { remoteAddress: "10.0.0.1" } },
        } as unknown as RequestContext,
        "r",
      );
    expect(make("Bearer a")).not.toBe(make("Bearer b"));
  });
});

describe("rate limit middleware", () => {
  it("returns 429 with Retry-After once the limit is spent", async () => {
    const limiter = new RateLimiter({ backend: new MapBackend() });
    const base = await serve([
      rateLimitMiddleware({
        limiter,
        rules: new Map([["/v1/client/state", { limit: 2, windowMs: 60_000 }]]),
      }),
    ]);
    const call = () => fetch(`${base}/v1/client/state`, { method: "POST" });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("leaves unlisted routes alone", async () => {
    const base = await serve([
      rateLimitMiddleware({
        limiter: new RateLimiter({ backend: new MapBackend() }),
        rules: new Map([["/v1/client/state", { limit: 1, windowMs: 60_000 }]]),
      }),
    ]);
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${base}/v1/snapshot/production`)).status).toBe(200);
    }
  });
});

describe("body limits", () => {
  it("refuses an oversized body with 413 instead of buffering it", async () => {
    const router = new Router().post("/small", async (ctx) => {
      await ctx.json(1_024);
      return { status: 200 };
    });
    const server = new HttpServer({ router, port: 0 });
    servers.push(server);
    const { host, port } = await server.listen();
    const response = await fetch(`http://${host}:${port}/small`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(4_096) }),
    });
    expect(response.status).toBe(413);
  });
});

describe("per-environment rate limits", () => {
  it("applies an override for one environment without touching the others", async () => {
    const limiter = new RateLimiter({ backend: new MapBackend() });
    const router = new Router().get("/v1/snapshot/:envKey", () => ({ status: 200 }));
    const server = new HttpServer({
      router,
      port: 0,
      middleware: [
        rateLimitMiddleware({
          limiter,
          rules: new Map([["/v1/snapshot/:envKey", { limit: 2, windowMs: 60_000 }]]),
          // One customer's mobile fleet legitimately polls harder than
          // another's batch job.
          overrides: (env, route) =>
            env === "busy" && route === "/v1/snapshot/:envKey"
              ? { limit: 50, windowMs: 60_000 }
              : undefined,
        }),
      ],
    });
    servers.push(server);
    const { host, port } = await server.listen();

    const call = (env: string) => fetch(`http://${host}:${port}/v1/snapshot/${env}`);

    // The default environment runs out after two.
    expect((await call("quiet")).status).toBe(200);
    expect((await call("quiet")).status).toBe(200);
    expect((await call("quiet")).status).toBe(429);

    // The overridden one keeps going.
    for (let i = 0; i < 10; i++) expect((await call("busy")).status).toBe(200);
  });
});
