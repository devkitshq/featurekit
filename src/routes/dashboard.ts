/**
 * Serving the dashboard (dashboard/PLAN.md §3).
 *
 * The control plane serves its own UI at `/admin`. Not a second deployment, not
 * a second thing to run: if featkit is up, the way to turn a flag off is up.
 *
 * A single-page bundle, so every path under `/admin` that is not a real file
 * answers with `index.html` and the client router takes it from there. That
 * fallback is what makes a refresh on `/admin/flags/new-checkout` work.
 *
 * Three properties this handler must have, in order of how much they hurt when
 * missing:
 *
 * 1. **No path traversal.** The requested path is resolved and then checked to
 *    be inside the root, rather than cleaned of `..` by hand — string cleaning
 *    is how every traversal bug in history was written.
 * 2. **Correct caching.** Vite content-hashes everything under `assets/`, so
 *    those are immutable for a year; `index.html` is the one file that changes
 *    at the same URL, so it is `no-store`. Getting this backwards means a deploy
 *    that half-updates in every open tab.
 * 3. **A useful answer when it is not built.** A missing `dist` is the normal
 *    state of a fresh clone, and "Cannot GET /admin" teaches nobody the command.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RequestContext, Router } from "../http/router.js";

export interface DashboardRouteDeps {
  /** Absolute path to the built dashboard (`dashboard/dist`). */
  distDir: string;
  /** Mounted path. `/admin` unless somebody has a reason. */
  basePath?: string;
  onError?: (error: unknown) => void;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Headers that apply to the dashboard and to nothing else.
 *
 * The CSP is deliberately tight and deliberately not `unsafe-inline` for
 * scripts: the bundle is a file, and an XSS in a page that can write flag
 * configuration is an XSS that can turn a feature on for everyone. `style-src`
 * keeps `unsafe-inline` because the bundler inlines a style attribute or two,
 * and a style injection here buys an attacker nothing.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>featkit</title>
<style>
  body { font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0b0d10; color: #e6e9ef; margin: 0;
         display: grid; place-items: center; min-height: 100vh; }
  div { max-width: 44rem; padding: 2rem; }
  code { background: #171a20; padding: .15rem .4rem; border-radius: .3rem; }
  h1 { font-size: 1.1rem; letter-spacing: .02em; }
  p { color: #9aa4b2; }
</style></head>
<body><div>
  <h1>The dashboard is not built</h1>
  <p>The control plane is running; its UI has not been compiled yet.</p>
  <p>Run <code>npm run build:dashboard</code> and reload this page.</p>
</div></body></html>
`;

export function registerDashboardRoutes(router: Router, deps: DashboardRouteDeps): Router {
  const base = deps.basePath ?? "/admin";
  const root = resolve(deps.distDir);

  const serve = async (ctx: RequestContext): Promise<undefined> => {
    const requested = ctx.params["*"] ?? "";
    const file = await resolveFile(root, requested);

    if (file === null) {
      // No `index.html` at all: the dashboard was never built. Answer 200 with
      // the instructions rather than a 404 that looks like a routing bug.
      ctx.res.writeHead(200, { ...SECURITY_HEADERS, "content-type": CONTENT_TYPES[".html"]!, "cache-control": "no-store" });
      ctx.res.end(NOT_BUILT);
      return undefined;
    }

    const type = CONTENT_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      "content-type": type,
      "content-length": String(file.size),
      etag: file.etag,
      // Hashed filenames may be cached forever; the entry point never may.
      "cache-control": file.hashed
        ? "public, max-age=31536000, immutable"
        : "no-store, must-revalidate",
    };

    if (ctx.header("if-none-match") === file.etag) {
      ctx.res.writeHead(304, { etag: file.etag, "cache-control": headers["cache-control"]! });
      ctx.res.end();
      return undefined;
    }

    ctx.res.writeHead(200, headers);
    if (ctx.method === "HEAD") {
      ctx.res.end();
      return undefined;
    }

    try {
      await pipeline(createReadStream(file.path), ctx.res);
    } catch (error) {
      // A client that navigated away mid-response is not an error worth a line.
      deps.onError?.(error);
      ctx.res.destroy();
    }
    return undefined;
  };

  router.get(base, serve);
  router.add("HEAD", base, serve);
  router.get(`${base}/*`, serve);
  router.add("HEAD", `${base}/*`, serve);
  return router;
}

interface ResolvedFile {
  path: string;
  size: number;
  etag: string;
  hashed: boolean;
}

/**
 * The file to send for a request path, or the SPA entry point.
 *
 * A request for something that looks like an asset and is not there gets the
 * entry point too — which sounds sloppy and is the behaviour that matters: a
 * stale tab asking for `assets/index-OLD.js` should get HTML it can fail on
 * loudly rather than a 404 the router will silently swallow.
 */
async function resolveFile(root: string, requested: string): Promise<ResolvedFile | null> {
  const candidate = safeJoin(root, requested);
  if (candidate !== null) {
    const found = await describe(candidate, requested);
    if (found !== null) return found;
  }
  return describe(join(root, "index.html"), "index.html");
}

/**
 * Join a request path onto the root, or refuse.
 *
 * `resolve` collapses `..` first, and the result must still start with the root
 * plus a separator. Anything else — an absolute path, a traversal, a Windows
 * drive letter — lands outside and is refused here rather than read.
 */
function safeJoin(root: string, requested: string): string | null {
  if (requested.length === 0) return null;
  if (requested.includes("\0")) return null;
  const candidate = resolve(root, normalize(requested));
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

async function describe(path: string, requested: string): Promise<ResolvedFile | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    return {
      path,
      size: stats.size,
      // Size and mtime: enough to change whenever a rebuild changes the file,
      // and free compared with hashing the bytes on every request.
      etag: `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`,
      hashed: requested.startsWith("assets/"),
    };
  } catch {
    return null;
  }
}
