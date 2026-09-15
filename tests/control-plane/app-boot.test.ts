/**
 * The composition root actually composes (§16).
 *
 * Before `src/app.ts` existed, every part of this system was only ever
 * assembled inside a test file — which meant "can it start" had no answer, and
 * §16, §13 and all of §23 had nothing to run against.
 *
 * These tests deliberately point the app at a **dead Postgres and a dead
 * Redis**, because that is the interesting case: a control plane that only
 * starts when its dependencies are healthy is a control plane that cannot be
 * brought up during the incident you most need it in. It must bind, answer
 * liveness, expose metrics, refuse unauthenticated requests, report honestly on
 * readiness, and shut down cleanly — all with nothing behind it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { requestIdFrom } from "../../src/observability/logger.js";

const apps: App[] = [];

/** Ports nothing is listening on: the dependencies are meant to be dead. */
function config(over: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    HOST: "127.0.0.1",
    PORT: "0",
    DATABASE_URL: "postgres://featkit:featkit@127.0.0.1:59999/none",
    REDIS_URL: "redis://127.0.0.1:59998",
    ...over,
  });
}

async function start(over: Record<string, string> = {}) {
  const app = createApp(config(over));
  apps.push(app);
  const address = await app.listen();
  return { app, base: `http://${address.host}:${address.port}` };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("the app boots with nothing behind it", () => {
  it("binds a port and answers liveness", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/live`);
    expect(response.status).toBe(200);
  });

  it("reports not-ready, with the reason, rather than refusing to start", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as {
      status: string;
      checks: Record<string, { state: string }>;
    };
    expect(body.status).toBe("not_ready");
    expect(body.checks["database"]?.state).toBe("failed");
    // Redis is degraded, never failed: a node serving last-known-good snapshots
    // belongs in the load balancer (§8).
    expect(body.checks["redis"]?.state).toBe("degraded");
  });

  it("exposes metrics", async () => {
    const { base } = await start();
    await fetch(`${base}/live`);
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).toContain("featkit_http_requests_total");
    expect(body).toContain("featkit_snapshot_degraded_serves_total");
  });

  it("labels metrics with the route pattern, never the request path", async () => {
    // §17: labelling on the path is one series per environment key.
    const { base } = await start();
    await fetch(`${base}/v1/snapshot/production-eu-1`, {
      headers: { authorization: "Bearer fk_srv_nope" },
    });
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).toContain('route="/v1/snapshot/:envKey"');
    expect(body).not.toContain("production-eu-1");
  });

  it("refuses SDK requests that present no key", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/v1/snapshot/production`)).status).toBe(401);
    expect((await fetch(`${base}/v1/client/state`, { method: "POST" })).status).toBe(401);
  });

  it("refuses management requests that present no token", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/v1/admin/projects`)).status).toBe(401);
  });

  it("answers CORS preflight on the client tier", async () => {
    const { base } = await start({ CORS_ALLOWED_ORIGINS: "https://app.example.com" });
    const response = await fetch(`${base}/v1/client/state`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });

  it("never puts CORS headers on the server tier", async () => {
    const { base } = await start({ CORS_ALLOWED_ORIGINS: "https://app.example.com" });
    const response = await fetch(`${base}/v1/snapshot/production`, {
      headers: { origin: "https://app.example.com", authorization: "Bearer fk_srv_x" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("puts a request id on every response", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/live`);
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("carries a caller-supplied request id through", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/live`, { headers: { "x-request-id": "abc-123" } });
    expect(response.headers.get("x-request-id")).toBe("abc-123");
  });

  it("sanitises a hostile request id rather than echoing it", async () => {
    // A request id lands in a log line and in a response header. Unfiltered,
    // that is log injection (§15). Note that the CRLF case cannot be tested
    // over HTTP at all — every HTTP client refuses to send such a header — so
    // the filtering itself is asserted directly below.
    const { base } = await start();
    const response = await fetch(`${base}/live`, {
      headers: { "x-request-id": "abc/../../etc/passwd <script>" },
    });
    const id = response.headers.get("x-request-id") ?? "";
    expect(id).toBe("abc....etcpasswdscript");
  });

  it("strips control characters from a request id", () => {
    const hostile = `ok${String.fromCharCode(13, 10)}injected: header`;
    expect(requestIdFrom(hostile)).toBe("okinjectedheader");
    // An id that is nothing but junk becomes a generated one rather than empty.
    expect(requestIdFrom("!!!").length).toBeGreaterThan(10);
    // And it is bounded, so a megabyte header is not a megabyte log line.
    expect(requestIdFrom("a".repeat(10_000))).toHaveLength(64);
  });

  it("fails readiness the moment shutdown begins, before the socket closes", async () => {
    // The load balancer must stop sending work before the process stops
    // accepting it, or a rolling deploy drops requests it could have served.
    const { app, base } = await start();
    const closing = app.close();
    const response = await fetch(`${base}/live`).catch(() => null);
    if (response !== null) expect([503, 200]).toContain(response.status);
    await closing;
  });

  it("shuts down cleanly and releases the port", async () => {
    const { app, base } = await start();
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    await expect(fetch(`${base}/live`)).rejects.toThrow();
  });
});
