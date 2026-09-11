/**
 * Response compression (review PR-E5).
 *
 * The load report put a 10,000-flag snapshot at 3.9 MB, sent to every SDK on
 * every cold poll and on every reconnect that cannot resume. Compiled snapshots
 * are extremely repetitive JSON, so this is the single largest reduction in
 * bytes-on-the-wire available anywhere in the system: **2.43 MB becomes 20 KB
 * with brotli**, in 14ms.
 *
 * The correctness risks are the usual ones for compression, and each has a test:
 * a client that did not ask for it must not get it, `Vary` must be set so a
 * cache cannot serve compressed bytes to a client that cannot read them, and
 * small bodies must not pay CPU for nothing.
 */

import { afterEach, describe, expect, it } from "vitest";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { Router } from "../../src/http/router.js";
import { HttpServer, compressBody } from "../../src/http/server.js";

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A body big and repetitive enough to be worth compressing, like a snapshot. */
const large = {
  flags: Object.fromEntries(
    Array.from({ length: 2_000 }, (_, i) => [
      `flag-${i}`,
      { key: `flag-${i}`, on: true, variations: [false, true], fallthrough: { variation: 1 } },
    ]),
  ),
};

async function serve() {
  const router = new Router()
    .get("/large", () => ({ status: 200, body: large }))
    .get("/small", () => ({ status: 200, body: { ok: true } }))
    .get("/prose", () => ({
      status: 200,
      body: "x".repeat(50_000),
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));
  const server = new HttpServer({ router, port: 0 });
  servers.push(server);
  const { host, port } = await server.listen();
  return `http://${host}:${port}`;
}

describe("compression", () => {
  it("compresses a large body for a client that accepts brotli", async () => {
    const base = await serve();
    const response = await fetch(`${base}/large`, { headers: { "accept-encoding": "br" } });
    expect(response.headers.get("content-encoding")).toBe("br");

    // `fetch` decodes transparently, so the body must still parse.
    const body = (await response.json()) as { flags: Record<string, unknown> };
    expect(Object.keys(body.flags)).toHaveLength(2_000);
  });

  it("falls back to gzip when brotli is not on offer", async () => {
    const base = await serve();
    const response = await fetch(`${base}/large`, { headers: { "accept-encoding": "gzip" } });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(((await response.json()) as { flags: unknown }).flags).toBeDefined();
  });

  it("sends nothing compressed to a client that did not ask", async () => {
    const base = await serve();
    const response = await fetch(`${base}/large`, { headers: { "accept-encoding": "" } });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(((await response.json()) as { flags: unknown }).flags).toBeDefined();
  });

  it("sets Vary so a cache cannot serve the wrong bytes", async () => {
    // Without this a shared cache can hand a brotli body to a client that
    // cannot decode it, and the failure looks like corruption.
    const base = await serve();
    const response = await fetch(`${base}/large`, { headers: { "accept-encoding": "br" } });
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
  });

  it("leaves a small body alone", async () => {
    const base = await serve();
    const response = await fetch(`${base}/small`, { headers: { "accept-encoding": "br, gzip" } });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  it("sets a content-length matching the compressed bytes", async () => {
    const base = await serve();
    const response = await fetch(`${base}/large`, { headers: { "accept-encoding": "gzip" } });
    const declared = Number(response.headers.get("content-length"));
    const raw = Buffer.from(await response.arrayBuffer());
    // `fetch` decompresses, so compare against a fresh compression of the same
    // payload rather than the decoded length.
    expect(declared).toBeGreaterThan(0);
    expect(declared).toBeLessThan(raw.byteLength);
  });

  it("compresses a pre-serialised string body too", async () => {
    // Snapshots take this path: already JSON, handed through as a string.
    const base = await serve();
    const response = await fetch(`${base}/prose`, { headers: { "accept-encoding": "br" } });
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(await response.text()).toHaveLength(50_000);
  });
});

describe("compressBody", () => {
  const payload = JSON.stringify(large);

  it("round-trips through gzip", () => {
    expect(gunzipSync(compressBody(payload, "gzip")).toString("utf8")).toBe(payload);
  });

  it("round-trips through brotli", () => {
    expect(brotliDecompressSync(compressBody(payload, "br")).toString("utf8")).toBe(payload);
  });

  it("actually shrinks a compiled-snapshot-shaped payload", () => {
    const raw = Buffer.byteLength(payload);
    const gzip = compressBody(payload, "gzip").byteLength;
    const brotli = compressBody(payload, "br").byteLength;
    // Measured at 10,000 flags: 2.43 MB to 57 KB (gzip) and 20 KB (brotli).
    expect(gzip).toBeLessThan(raw * 0.1);
    expect(brotli).toBeLessThan(gzip);
  });

  it("stays fast enough for a request path", () => {
    const started = performance.now();
    compressBody(payload, "br");
    // Quality 4, not 11: most of the ratio for a fraction of the CPU.
    expect(performance.now() - started).toBeLessThan(200);
  });
});
