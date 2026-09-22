/**
 * Trace propagation and the error surface (review PR-D5, PR-B15).
 *
 * Two things that only matter when something has gone wrong, which is exactly
 * when nobody has time to work out whether they were implemented:
 *
 * - a request must be findable from the *caller's* trace, not only from
 *   togglekit's own request id;
 * - no error response may carry anything an attacker did not already know.
 */

import { afterEach, describe, expect, it } from "vitest";
import { HttpError, Router } from "../../src/http/router.js";
import { HttpServer, type RequestLogFields } from "../../src/http/server.js";
import { traceContextFrom, traceFields } from "../../src/observability/trace.js";

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("traceContextFrom", () => {
  const PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("continues a caller's trace", () => {
    const trace = traceContextFrom(PARENT);
    expect(trace.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(trace.parentId).toBe("00f067aa0ba902b7");
    expect(trace.sampled).toBe(true);
    // A new span, not the caller's — this request is a child, not the same work.
    expect(trace.spanId).not.toBe("00f067aa0ba902b7");
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("emits a well-formed traceparent to pass downstream", () => {
    const trace = traceContextFrom(PARENT);
    expect(trace.traceparent).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${trace.spanId}-01`);
  });

  it("carries the caller's sampling decision", () => {
    const unsampled = traceContextFrom(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    );
    expect(unsampled.sampled).toBe(false);
  });

  it("tolerates an uppercased header from a proxy", () => {
    const trace = traceContextFrom(PARENT.toUpperCase());
    expect(trace.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("starts a fresh trace when there is no usable parent", () => {
    for (const header of [
      undefined,
      "",
      "garbage",
      "00-tooshort-00f067aa0ba902b7-01",
      "99-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // unknown version
      `00-${"0".repeat(32)}-00f067aa0ba902b7-01`, // all-zero trace id is invalid
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`, // all-zero span
    ]) {
      const trace = traceContextFrom(header);
      expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(trace.parentId).toBeNull();
      // Discarded, never repaired: joining a malformed header's trace would
      // splice two unrelated traces together.
      expect(trace.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    }
  });

  it("gives every request its own trace when none is supplied", () => {
    const ids = new Set(Array.from({ length: 200 }, () => traceContextFrom(undefined).traceId));
    expect(ids.size).toBe(200);
  });

  it("omits the parent span from log fields when there is no parent", () => {
    expect(traceFields(traceContextFrom(undefined))).not.toHaveProperty("parentSpanId");
    expect(traceFields(traceContextFrom(PARENT))).toHaveProperty("parentSpanId");
  });
});

describe("trace fields reach the access log", () => {
  it("logs the caller's trace id, not a fresh one", async () => {
    const logged: RequestLogFields[] = [];
    const router = new Router().get("/hello", () => ({ status: 200, body: { ok: true } }));
    const server = new HttpServer({ router, port: 0, onRequest: (f) => logged.push(f) });
    servers.push(server);
    const { host, port } = await server.listen();

    await fetch(`http://${host}:${port}/hello`, {
      headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });

    expect(logged[0]?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(logged[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(logged[0]?.route).toBe("/hello");
  });
});

describe("the error surface", () => {
  async function serve(router: Router) {
    const server = new HttpServer({ router, port: 0 });
    servers.push(server);
    const { host, port } = await server.listen();
    return `http://${host}:${port}`;
  }

  it("never returns an exception message, however it was thrown", async () => {
    const secrets = [
      new Error("connection postgres://user:hunter2@db/togglekit refused"),
      new TypeError("Cannot read properties of undefined (reading 'sdkKey')"),
      "a bare string with tk_srv_leaked in it",
      { message: "object thrown", stack: "at /srv/togglekit/src/secret.ts:12" },
    ];

    for (const [index, thrown] of secrets.entries()) {
      const base = await serve(
        new Router().get(`/boom${index}`, () => {
          throw thrown;
        }),
      );
      const response = await fetch(`${base}/boom${index}`);
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).toBe(JSON.stringify({ error: "INTERNAL_ERROR" }));
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("tk_srv_leaked");
      expect(text).not.toContain("secret.ts");
    }
  });

  it("still carries a request id, so the caller can quote it", async () => {
    const base = await serve(
      new Router().get("/boom", () => {
        throw new Error("internal");
      }),
    );
    const response = await fetch(`${base}/boom`);
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns HttpError details only when they were set deliberately", async () => {
    const base = await serve(
      new Router()
        .get("/plain", () => {
          throw new HttpError(409, "CONFLICT", "someone else got there first");
        })
        .get("/detailed", () => {
          throw new HttpError(409, "CONFLICT", "version mismatch", { current: { version: 7 } });
        }),
    );

    const plain = (await (await fetch(`${base}/plain`)).json()) as Record<string, unknown>;
    expect(plain).toEqual({ error: "CONFLICT", message: "someone else got there first" });
    expect(plain).not.toHaveProperty("details");

    const detailed = (await (await fetch(`${base}/detailed`)).json()) as Record<string, unknown>;
    expect(detailed["details"]).toEqual({ current: { version: 7 } });
  });

  it("does not describe the route table to an unauthenticated caller", async () => {
    const base = await serve(new Router().get("/v1/secret/:id", () => ({ status: 200 })));
    const missing = await fetch(`${base}/v1/does-not-exist`);
    const body = (await missing.json()) as Record<string, unknown>;
    // The path the caller asked for, echoed back — nothing about what exists.
    expect(Object.keys(body).sort()).toEqual(["error", "path"]);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("distinguishes a wrong verb from a wrong URL without leaking more", async () => {
    const base = await serve(new Router().post("/v1/events", () => ({ status: 202 })));
    const response = await fetch(`${base}/v1/events`);
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "METHOD_NOT_ALLOWED", method: "GET" });
  });
});
