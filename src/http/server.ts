/**
 * The HTTP listener: routing, middleware, error mapping, the SSE primitives,
 * and the drain sequence a rolling deploy needs.
 *
 * **Shutdown is the part that is easy to get wrong and expensive to get wrong.**
 * `closeAllConnections()` on its own severs every live SSE stream the instant a
 * deploy starts. With thousands of connected SDKs on a rolling deploy that is a
 * synchronised reconnect storm pointed at the nodes that are still up — the
 * thundering herd, self-inflicted, on every release. So the sequence is:
 * fail readiness, stop accepting, tell every stream to reconnect *with a
 * jittered delay*, let in-flight requests finish, and only then close sockets.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip, brotliCompress, constants as zlibConstants } from "node:zlib";
import { HttpError, readJson, Router, type HttpResponse, type RequestContext } from "./router.js";
import { requestIdFrom } from "../observability/logger.js";
import { traceContextFrom, type TraceContext } from "../observability/trace.js";

/**
 * Runs before the route handler. Returning a response short-circuits — that is
 * how CORS preflight and rate limiting refuse a request without every handler
 * needing to know they exist.
 */
export type Middleware = (
  ctx: RequestContext,
) => HttpResponse | undefined | Promise<HttpResponse | undefined>;

export interface RequestLogFields {
  requestId: string;
  traceId: string;
  spanId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

export interface HttpServerOptions {
  router: Router;
  host?: string;
  port?: number;
  middleware?: Middleware[];
  /** Registered SSE streams, so shutdown can drain them politely. */
  sse?: SseRegistry;
  onError?: (error: unknown, ctx: { method: string; path: string; requestId: string }) => void;
  onRequest?: (fields: RequestLogFields) => void;
  /** How long in-flight work gets after the socket stops accepting. */
  shutdownGraceMs?: number;
}

function buildContext(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  url: URL,
  routePattern: string,
  requestId: string,
  trace: TraceContext,
): RequestContext {
  return {
    req,
    res,
    method: req.method ?? "GET",
    path: url.pathname,
    params,
    query: url.searchParams,
    routePattern,
    requestId,
    trace,
    header: (name) => {
      const value = req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
    json: <T,>(maxBytes?: number) => readJson<T>(req, maxBytes),
  };
}

export class HttpServer {
  private server: Server | null = null;
  private shuttingDown = false;
  /** In-flight non-SSE requests, so the drain can wait for them. */
  private inFlight = 0;

  constructor(private readonly options: HttpServerOptions) {}

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Exposed so tests can drive the router without binding a port. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const requestId = requestIdFrom(
      (Array.isArray(req.headers["x-request-id"])
        ? req.headers["x-request-id"][0]
        : req.headers["x-request-id"]) ?? undefined,
    );
    const trace = traceContextFrom(
      Array.isArray(req.headers["traceparent"])
        ? req.headers["traceparent"][0]
        : req.headers["traceparent"],
    );
    const startedAt = process.hrtime.bigint();
    this.inFlight++;

    let status = 500;
    let routePattern = "unmatched";
    try {
      const matched = this.options.router.match(method, url.pathname);
      if (matched === null) {
        status = 404;
        return await send(res, {
          status,
          body: { error: "NOT_FOUND", path: url.pathname },
          headers: { "x-request-id": requestId },
        });
      }
      if (matched === "method-mismatch") {
        status = 405;
        return await send(res, {
          status,
          body: { error: "METHOD_NOT_ALLOWED", method },
          headers: { "x-request-id": requestId },
        });
      }
      routePattern = matched.pattern;

      const ctx = buildContext(req, res, matched.params, url, matched.pattern, requestId, trace);

      for (const middleware of this.options.middleware ?? []) {
        const short = await middleware(ctx);
        if (short !== undefined) {
          status = short.status;
          return await send(res, {
            ...short,
            headers: { ...short.headers, "x-request-id": requestId },
          });
        }
      }

      const result = await matched.handler(ctx);
      // `undefined` means the handler took over the socket — an SSE stream that
      // will stay open for hours. Writing a response here would close it.
      if (result === undefined) {
        status = res.statusCode;
        return;
      }
      status = result.status;
      await send(res, {
        ...result,
        headers: { ...result.headers, "x-request-id": requestId },
        acceptEncoding: Array.isArray(req.headers["accept-encoding"])
          ? req.headers["accept-encoding"][0]
          : req.headers["accept-encoding"],
      });
    } catch (error) {
      this.options.onError?.(error, { method, path: url.pathname, requestId });
      // Drain any unread request body before answering. A response written while
      // the client is still uploading is a connection reset on most stacks, and
      // the caller then sees a socket error rather than the 413 that explains
      // what it did wrong.
      if (!req.readableEnded) req.resume();
      if (res.headersSent) {
        // Mid-stream failure. Nothing useful can be said in-band; ending the
        // response is what tells the SDK to reconnect.
        status = res.statusCode;
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        status = error.status;
        await send(res, {
          status,
          body: {
            error: error.code,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
          headers: { "x-request-id": requestId },
        });
        return;
      }
      // Never leak an internal message or stack to a caller. The request id
      // travels in the header instead — the caller quotes it, the operator greps
      // it — so the body stays a stable, minimal contract.
      status = 500;
      await send(res, {
        status,
        body: { error: "INTERNAL_ERROR" },
        headers: { "x-request-id": requestId },
      });
    } finally {
      this.inFlight--;
      this.options.onRequest?.({
        requestId,
        traceId: trace.traceId,
        spanId: trace.spanId,
        method,
        route: routePattern,
        status,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      });
    }
  }

  listen(): Promise<{ port: number; host: string }> {
    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 3000;
    this.server = createServer((req, res) => void this.handle(req, res));
    // A slow-loris client that opens a socket and never sends a request must not
    // hold a connection slot forever.
    this.server.headersTimeout = 20_000;
    this.server.requestTimeout = 60_000;
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        const address = this.server!.address();
        resolve({
          port: typeof address === "object" && address !== null ? address.port : port,
          host,
        });
      });
    });
  }

  /**
   * Graceful shutdown.
   *
   * The order matters and each step exists for a named failure:
   * 1. `shuttingDown` — `/ready` starts answering 503 so the load balancer stops
   *    sending work *before* the socket refuses it.
   * 2. `server.close()` — stop accepting, keep serving what is already here.
   * 3. Drain SSE with a jittered reconnect hint — otherwise every SDK on this
   *    node reconnects in the same millisecond.
   * 4. Wait for in-flight requests, bounded by the grace period.
   * 5. `closeAllConnections()` — the backstop for a client that will not leave.
   */
  async close(): Promise<void> {
    const server = this.server;
    this.shuttingDown = true;
    if (server === null) return;
    this.server = null;

    const grace = this.options.shutdownGraceMs ?? 10_000;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));

    await this.options.sse?.drain(grace);

    const deadline = Date.now() + grace;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    server.closeAllConnections?.();
    await closed;
  }
}

/**
 * Below this, compression costs more than it saves.
 *
 * A few hundred bytes of JSON compresses to about the same size plus a header,
 * and the CPU is not free at a few thousand requests a second.
 */
const COMPRESS_THRESHOLD_BYTES = 4 * 1024;

/**
 * Which encoding, if any, the caller will accept.
 *
 * Brotli first — a compiled snapshot is highly repetitive JSON and brotli beats
 * gzip on it by a wide margin — but only at a low quality level. Level 4 gets
 * most of the ratio for a fraction of the CPU, and this runs on a request path,
 * not a build server.
 */
function negotiateEncoding(accept: string | undefined): "br" | "gzip" | null {
  if (accept === undefined) return null;
  const header = accept.toLowerCase();
  if (header.includes("br")) return "br";
  if (header.includes("gzip")) return "gzip";
  return null;
}

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/**
 * Async on purpose: zlib's async forms run on the libuv threadpool. A
 * multi-megabyte snapshot compressed synchronously stalls every open stream on
 * the node for the duration.
 */
export function compressBody(
  payload: string,
  encoding: "br" | "gzip",
): Promise<Buffer> {
  const input = Buffer.from(payload, "utf8");
  return encoding === "br"
    ? brotliAsync(input, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
        },
      })
    : gzipAsync(input, { level: 6 });
}

export async function send(
  res: ServerResponse,
  response: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
    /** `Accept-Encoding` from the request, when the body is worth compressing. */
    acceptEncoding?: string | undefined;
  },
): Promise<void> {
  const headers: Record<string, string> = { ...response.headers };
  let payload: string | undefined;
  if (response.body !== undefined) {
    // A string body is already serialised — Prometheus exposition and compiled
    // snapshots. JSON-encoding it would wrap the whole thing in quotes.
    if (typeof response.body === "string") {
      payload = response.body;
      headers["content-type"] ??= "text/plain; charset=utf-8";
    } else {
      payload = JSON.stringify(response.body);
      headers["content-type"] ??= "application/json; charset=utf-8";
    }

    // A 10,000-flag snapshot is ~3.9 MB of repetitive JSON, sent to every SDK
    // on every cold poll. Compressing it is the single largest reduction in
    // bytes-on-the-wire available, and the ETag path already avoids sending it
    // at all when nothing changed.
    const encoding = negotiateEncoding(response.acceptEncoding);
    if (encoding !== null && Buffer.byteLength(payload) >= COMPRESS_THRESHOLD_BYTES) {
      const compressed = await compressBody(payload, encoding);
      headers["content-encoding"] = encoding;
      // Caches must not serve a compressed body to a client that cannot read it.
      headers["vary"] = headers["vary"] === undefined ? "Accept-Encoding" : `${headers["vary"]}, Accept-Encoding`;
      headers["content-length"] = String(compressed.byteLength);
      res.writeHead(response.status, headers);
      res.end(compressed);
      return;
    }

    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  res.writeHead(response.status, headers);
  res.end(payload);
}

/* ───────────────────────────────── SSE ──────────────────────────────── */

export interface SseStream {
  /** `id:` is the snapshot version, which is what `Last-Event-ID` resumes from. */
  event(name: string, data: unknown, id?: number): boolean;
  /**
   * Write an event whose payload is *already* JSON.
   *
   * The snapshot is serialised once per version and reused across every
   * connection; handing it to `event()` would parse it and re-stringify it per
   * subscriber, which at a thousand streams is a thousand round trips through
   * a megabyte of JSON for one flag change.
   */
  raw(name: string, json: string, id?: number): boolean;
  comment(text: string): boolean;
  close(): void;
  readonly closed: boolean;
}

/**
 * Every open SSE stream on this node, so shutdown can drain them.
 *
 * Without this, the only shutdown available is severing sockets, and a rolling
 * deploy across N nodes produces N synchronised reconnect storms.
 */
export class SseRegistry {
  private readonly streams = new Set<SseStream>();

  add(stream: SseStream): void {
    this.streams.add(stream);
  }
  remove(stream: SseStream): void {
    this.streams.delete(stream);
  }
  get size(): number {
    return this.streams.size;
  }

  /**
   * Tell every stream to go away and come back later, spreading the returns
   * across the grace window.
   *
   * The `reconnect` event carries a per-connection delay, so the fleet's return
   * is a ramp rather than a spike. Clients that ignore it still reconnect on
   * their own jittered backoff; this makes the good case better rather than
   * depending on client cooperation.
   */
  async drain(graceMs: number): Promise<void> {
    const streams = [...this.streams];
    if (streams.length === 0) return;

    const window = Math.max(graceMs - 1_000, 0);
    for (const stream of streams) {
      const afterMs = Math.floor(Math.random() * window);
      stream.event("reconnect", { reason: "shutdown", afterMs });
    }
    // A brief pause so the writes reach the socket before it is torn down.
    await new Promise((r) => setTimeout(r, Math.min(250, graceMs)));
    for (const stream of streams) stream.close();
    this.streams.clear();
  }
}

/**
 * Open an SSE stream on a response.
 *
 * `X-Accel-Buffering: no` and the disabled Nagle algorithm are both load-bearing:
 * a proxy that buffers, or a socket that coalesces, turns a sub-300ms kill
 * switch into whatever the buffer flush interval happens to be.
 */
export function openSse(
  res: ServerResponse,
  options: {
    heartbeatMs?: number;
    onClose?: () => void;
    registry?: SseRegistry;
    headers?: Record<string, string>;
  } = {},
): SseStream {
  res.writeHead(200, {
    ...options.headers,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  res.write(": featurekit stream open\n\n");

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    options.registry?.remove(stream);
    options.onClose?.();
  };

  // Every 30s by default, so proxies do not reap an idle connection. A flag
  // that changes once a week must not need a reconnect to be delivered.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref?.();

  res.on("close", finish);
  res.on("error", finish);

  const stream: SseStream = {
    get closed() {
      return closed;
    },
    event(name, data, id) {
      if (closed) return false;
      const idLine = id === undefined ? "" : `id: ${id}\n`;
      return res.write(`${idLine}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    raw(name, json, id) {
      if (closed) return false;
      const idLine = id === undefined ? "" : `id: ${id}\n`;
      return res.write(`${idLine}event: ${name}\ndata: ${json}\n\n`);
    },
    comment(text) {
      if (closed) return false;
      return res.write(`: ${text}\n\n`);
    },
    close() {
      if (closed) return;
      finish();
      res.end();
    },
  };

  options.registry?.add(stream);
  return stream;
}
