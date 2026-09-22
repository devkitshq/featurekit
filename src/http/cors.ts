/**
 * CORS, for the client tier only (§11.5, §16).
 *
 * **The scope is the security property.** `featurekit-client` calls
 * `POST /v1/client/state` from a customer's origin, so those routes need CORS.
 * The server-tier routes — `/v1/stream/:envKey`, `/v1/snapshot/:envKey` — must
 * **never** carry CORS headers: they serve the full ruleset, and a browser that
 * can read them cross-origin is the exact leak the two-tier split exists to
 * prevent. A blanket `app.use(cors())` is therefore not a shortcut here; it is
 * the vulnerability.
 *
 * `*` is never emitted. An allowlist is per-environment configuration, and the
 * absence of a match is a request that simply gets no CORS headers — the
 * browser then refuses it, which is the correct outcome and needs no error of
 * ours.
 */

import type { HttpResponse, RequestContext } from "./router.js";

export interface CorsOptions {
  /**
   * Exact origins, e.g. `https://app.example.com`. Compared literally: a
   * substring or suffix match is how `https://app.example.com.evil.test` gets
   * in.
   */
  allowedOrigins: readonly string[];
  /** Route patterns CORS applies to. Everything else is deliberately excluded. */
  routes: ReadonlySet<string>;
  maxAgeSeconds?: number;
}

const ALLOWED_HEADERS = "authorization, content-type, last-event-id, x-request-id";
const ALLOWED_METHODS = "GET, POST, OPTIONS";

function originAllowed(origin: string | undefined, allowed: readonly string[]): origin is string {
  return origin !== undefined && allowed.includes(origin);
}

/**
 * Headers for an allowed cross-origin request.
 *
 * `Vary: Origin` is not optional: without it a CDN or shared cache can serve
 * one origin's allowed response to another origin.
 */
export function corsHeaders(origin: string, maxAgeSeconds: number): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": String(maxAgeSeconds),
    vary: "Origin",
  };
}

export function corsMiddleware(options: CorsOptions) {
  const maxAge = options.maxAgeSeconds ?? 600;

  return (ctx: RequestContext): HttpResponse | undefined => {
    if (!options.routes.has(ctx.routePattern)) return undefined;

    const origin = ctx.header("origin");
    if (!originAllowed(origin, options.allowedOrigins)) {
      // Not an error: a same-origin call has no `Origin` header at all, and an
      // unknown origin is refused by the browser without our help.
      return undefined;
    }

    const headers = corsHeaders(origin, maxAge);
    if (ctx.method === "OPTIONS") return { status: 204, headers };

    // Not a short circuit: the headers are attached to the real response by the
    // route, so the mutation happens here and the handler still runs.
    for (const [name, value] of Object.entries(headers)) ctx.res.setHeader(name, value);
    return undefined;
  };
}

/**
 * Preflight needs a route to match, and the router matches on method. Without
 * this, `OPTIONS /v1/client/state` is a 405 and the browser never sends the
 * POST.
 */
export function registerCorsPreflight(
  add: (method: string, pattern: string, handler: () => HttpResponse) => void,
  routes: Iterable<string>,
): void {
  for (const pattern of routes) {
    add("OPTIONS", pattern, () => ({ status: 204 }));
  }
}
