/**
 * Serving the dashboard bundle (dashboard/PLAN.md §3).
 *
 * No database and no containers: this is a file server, and its interesting
 * behaviours are all about paths and headers.
 *
 * The one that matters is traversal. `/admin/../../etc/passwd` and its
 * percent-encoded twin must not read a byte outside the bundle directory, and
 * the check has to survive an encoded separator — which is precisely where the
 * hand-rolled "strip the dots" version of this fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../../src/http/router.js";
import { HttpServer } from "../../src/http/server.js";
import { registerDashboardRoutes } from "../../src/routes/dashboard.js";

describe("dashboard static serving", () => {
  let dist: string;
  let outside: string;
  let server: HttpServer;
  let base: string;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "togglekit-dashboard-"));
    dist = join(root, "dist");
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<!doctype html><title>dash</title>", "utf8");
    await writeFile(join(dist, "assets", "index-abc123.js"), "export const x = 1;\n", "utf8");

    // A file a traversal would love to reach.
    outside = join(root, "secret.txt");
    await writeFile(outside, "TOP SECRET", "utf8");

    const router = new Router();
    registerDashboardRoutes(router, { distDir: dist });
    server = new HttpServer({ router, port: 0 });
    const address = await server.listen();
    base = `http://${address.host}:${address.port}`;
  });

  afterAll(async () => {
    await server?.close();
    await rm(join(dist, ".."), { recursive: true, force: true });
  });

  it("serves index.html at the mount point", async () => {
    const response = await fetch(`${base}/admin`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>dash</title>");
  });

  it("serves hashed assets as immutable and the entry point as no-store", async () => {
    const asset = await fetch(`${base}/admin/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toContain("javascript");

    const html = await fetch(`${base}/admin`);
    // The one file that changes at the same URL. Caching it is how a deploy
    // half-lands in every open tab.
    expect(html.headers.get("cache-control")).toContain("no-store");
  });

  it("falls back to index.html for client-side routes", async () => {
    const response = await fetch(`${base}/admin/flags/new-checkout`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>dash</title>");
  });

  it("refuses to read outside the bundle, encoded or not", async () => {
    for (const path of [
      "/admin/../secret.txt",
      "/admin/%2e%2e%2fsecret.txt",
      "/admin/..%2fsecret.txt",
      "/admin/assets/../../secret.txt",
    ]) {
      const response = await fetch(`${base}${path}`);
      const body = await response.text();
      expect(body).not.toContain("TOP SECRET");
    }
  });

  it("answers a conditional request with 304", async () => {
    const first = await fetch(`${base}/admin/assets/index-abc123.js`);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const second = await fetch(`${base}/admin/assets/index-abc123.js`, {
      headers: { "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
  });

  it("sends a content security policy that forbids inline script", async () => {
    const response = await fetch(`${base}/admin`);
    const csp = response.headers.get("content-security-policy") ?? "";
    // An XSS in a page that can write flag configuration turns a feature on for
    // everyone, so the bundle is the only script that may run.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("explains itself when the bundle has not been built", async () => {
    const router = new Router();
    registerDashboardRoutes(router, { distDir: join(dist, "does-not-exist") });
    const unbuilt = new HttpServer({ router, port: 0 });
    const address = await unbuilt.listen();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/admin`);
      expect(response.status).toBe(200);
      // Not a 404: a fresh clone has no bundle, and "Cannot GET /admin" teaches
      // nobody the command that fixes it.
      expect(await response.text()).toContain("build:dashboard");
    } finally {
      await unbuilt.close();
    }
  });
});
