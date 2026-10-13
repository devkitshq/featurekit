/**
 * A small router over `node:http`.
 *
 * The server package's runtime dependencies are drizzle,
 * postgres, ioredis, pino, prom-client and zod. No HTTP framework — which is a
 * deliberate signal, not an omission. The control plane serves a handful of
 * routes plus two long-lived SSE endpoints, and SSE is the one thing framework
 * abstractions reliably get in the way of.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TraceContext } from "../observability/trace.js";

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /**
   * The route *pattern* (`/v1/snapshot/:envKey`), never the request path.
   * Metrics label on this: labelling on the path makes one time series per
   * environment key, which is a cardinality explosion.
   */
  routePattern: string;
  /** Correlates the access log, the error response and any audit row written. */
  requestId: string;
  /**
   * The caller's trace, continued — or a new one.
   *
   * A request id correlates featurekit's own lines; a trace id correlates them
   * with the service that made the call.
   */
  trace: TraceContext;
  header(name: string): string | undefined;
  /** Parsed JSON body, size-capped. Throws `HttpError` on malformed input. */
  json<T = unknown>(maxBytes?: number): Promise<T>;
}

/** A handler returns a response, or `undefined` if it took over the socket (SSE). */
export type Handler = (ctx: RequestContext) => Promise<HttpResponse | undefined> | HttpResponse | undefined;

export class HttpError extends Error {
  /**
   * `details` is the deliberate exception to "never put internals in a response".
   * It is only ever set explicitly — a 409 carrying the current version of a
   * flag, say — so that a client can act on the failure instead of asking a
   * human to guess. Nothing derived from an exception ever reaches it.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split("/").filter((s) => s.length > 0),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }
  patch(pattern: string, handler: Handler): this {
    return this.add("PATCH", pattern, handler);
  }
  put(pattern: string, handler: Handler): this {
    return this.add("PUT", pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.add("DELETE", pattern, handler);
  }

  /**
   * Find a handler for a path.
   *
   * Returns `"method-mismatch"` when a route exists at this path under another
   * verb, so the caller can answer 405 rather than 404 — the difference between
   * "you have the wrong URL" and "you have the wrong verb" is most of the
   * debugging time on a REST client.
   */
  match(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string>; pattern: string } | "method-mismatch" | null {
    const parts = path.split("/").filter((s) => s.length > 0);
    let pathMatched = false;

    for (const route of this.routes) {
      // A trailing `*` matches the rest of the path, however many segments, and
      // puts it in `params["*"]`. Exactly one route needs this — the dashboard's
      // static files, where the paths are decided by a bundler and not by us —
      // and a wildcard anywhere else would be a route that shadows its
      // neighbours by accident.
      const wildcard = route.segments[route.segments.length - 1] === "*";
      const fixed = wildcard ? route.segments.length - 1 : route.segments.length;
      if (wildcard ? parts.length < fixed : parts.length !== fixed) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < fixed; i++) {
        const segment = route.segments[i]!;
        const value = parts[i]!;
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (wildcard) {
        // Decoded per segment, never as a whole: decoding first would let `%2f`
        // become a separator the path check below has already been past.
        params["*"] = parts.slice(fixed).map((part) => decodeURIComponent(part)).join("/");
      }

      pathMatched = true;
      if (route.method === method.toUpperCase()) {
        return { handler: route.handler, params, pattern: route.pattern };
      }
    }

    return pathMatched ? "method-mismatch" : null;
  }
}

/**
 * Bodies are capped: an unbounded read is a memory exhaustion primitive.
 *
 * 5 MB is the ceiling for a segment import; every other endpoint passes a far
 * smaller limit of its own, because "the largest body any endpoint accepts" is
 * not a sensible limit for `POST /v1/client/state`.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function readJson<T>(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<T> {
  // Refuse on the declared length before reading a byte. This is the cheap path
  // and the common one: a caller that announces 40 MB is rejected for the cost
  // of parsing one header.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${maxBytes} bytes`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      // Destroy rather than drain: continuing to read a body already known to be
      // over the limit is doing the attacker'''s allocation for them.
      req.destroy();
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (size === 0) return undefined as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}
