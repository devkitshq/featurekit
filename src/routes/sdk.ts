/**
 * SDK-facing routes (§12, server tier).
 *
 * ```
 * GET  /v1/stream/:envKey     SSE ruleset stream (server keys only)
 * GET  /v1/snapshot/:envKey   Poll fallback (ETag / 304)
 * POST /v1/events             Batched evaluation summaries
 * ```
 *
 * **Polling is a first-class fallback, not a degraded mode** (§10.2). Corporate
 * proxies eat SSE, and some runtimes have no long-lived connections.
 *
 * @see docs/control-plane/delivery.md
 */

import type { Snapshot } from "../sdk/index.js";
import { HttpError, type RequestContext, type Router } from "../http/router.js";
import { openSse } from "../http/server.js";
import { serializeSnapshot, type SnapshotStore } from "../redis/snapshot-store.js";
import type { SnapshotService } from "../snapshot/service.js";
import { checkKey, type KeyRecord, type SdkKeyKind } from "../auth/keys.js";
import { summaryBatchSchema, bucketIsAcceptable, BODY_LIMITS } from "../contracts/wire.js";
import type { SseRegistry } from "../http/server.js";

export interface AuthenticatedEnvironment extends KeyRecord {
  environmentKey: string;
  projectId: string;
  /**
   * Carried from the environment row so secure mode is a property of the
   * environment rather than of whichever call site remembered to enable it
   * (§16). See `registerClientRoutes`.
   */
  isProduction: boolean;
}

export interface SdkRouteDeps {
  snapshots: SnapshotService;
  store: SnapshotStore;
  /** Resolve a presented SDK key to its record, or null. */
  authenticate: (presentedKey: string) => Promise<AuthenticatedEnvironment | null>;
  heartbeatMs?: number;
  patchHistoryDepth?: number;
  maxStreamConnections?: number;
  /** Accepts a batch of pre-aggregated summaries. Fire-and-forget. */
  ingestEvents?: (environmentId: string, batch: unknown) => Promise<void>;
  /** Registers streams so a rolling deploy can drain them politely (§16). */
  sse?: SseRegistry;
  onStreamChange?: (open: number) => void;
  /**
   * Called with the connecting SDK's `User-Agent`.
   *
   * Version skew is the first thing worth knowing during an incident: is this
   * happening to every SDK, or only to the fleet still on an old one (§16).
   */
  onSdkIdentified?: (userAgent: string | undefined) => void;
  onError?: (error: unknown) => void;
}

/**
 * Extract the SDK key. `Authorization: Bearer <key>` is the documented form;
 * bare `Authorization: <key>` is accepted because several HTTP clients make the
 * `Bearer` prefix awkward and rejecting it produces an unhelpful 401.
 */
function presentedKey(ctx: RequestContext): string {
  const header = ctx.header("authorization");
  if (header === undefined || header.length === 0) {
    throw new HttpError(401, "MISSING_SDK_KEY", "an SDK key is required");
  }
  return header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
}

async function requireEnvironment(
  ctx: RequestContext,
  deps: SdkRouteDeps,
  requireKind: SdkKeyKind | SdkKeyKind[],
): Promise<AuthenticatedEnvironment> {
  const record = await deps.authenticate(presentedKey(ctx));
  const checked = checkKey(record, { requireKind });
  if (!checked.ok) {
    // One status for every rejection: a caller that can distinguish "unknown
    // key" from "revoked key" has a key-probing oracle.
    throw new HttpError(401, checked.reason, "SDK key rejected");
  }
  const authenticated = checked.record as AuthenticatedEnvironment;

  // The key names the environment; the path must agree. Otherwise a valid
  // staging key could read production simply by changing the URL.
  //
  // `-` is the documented "whatever this key is for" placeholder the SDK sends
  // when it was not told an environment key. It weakens nothing: the key still
  // decides which environment is served, and a caller naming a *different*
  // environment is still refused.
  const requested = ctx.params["envKey"];
  if (requested !== undefined && requested !== "-" && requested !== authenticated.environmentKey) {
    throw new HttpError(403, "ENVIRONMENT_MISMATCH", "this key is not for that environment");
  }
  return authenticated;
}

export function registerSdkRoutes(router: Router, deps: SdkRouteDeps): Router {
  let openStreams = 0;

  /**
   * The serialised snapshot, cached per environment and version.
   *
   * Without it every poll ran the snapshot through `serializeSnapshot` →
   * `JSON.parse` → `JSON.stringify`: three passes over the whole ruleset, per
   * request, to produce bytes identical to the last thousand times. A load run
   * is what made that visible — it is invisible at one request and dominant at
   * a thousand SDKs polling a large environment.
   *
   * Keyed by version, so a new snapshot replaces it by construction rather than
   * by an invalidation someone has to remember to call.
   */
  const serialized = new Map<string, { version: number; text: string }>();

  function snapshotJson(environmentId: string, snapshot: Snapshot): string {
    const cached = serialized.get(environmentId);
    if (cached !== undefined && cached.version === snapshot.version) return cached.text;
    const text = serializeSnapshot(snapshot);
    serialized.set(environmentId, { version: snapshot.version, text });
    return text;
  }

  /* ── GET /v1/snapshot/:envKey — polling fallback, ETag / 304 ────────── */

  router.get("/v1/snapshot/:envKey", async (ctx) => {
    const env = await requireEnvironment(ctx, deps, "server");
    deps.onSdkIdentified?.(ctx.header("user-agent"));
    const { snapshot, version } = await deps.snapshots.get(env.environmentId);

    const etag = `"${version}"`;
    // A poller that is already current gets 304 and no body. At a few thousand
    // SDKs on a 30s poll, the body is the entire cost of this endpoint.
    if (ctx.header("if-none-match") === etag) {
      return { status: 304, headers: { etag, "cache-control": "no-cache" } };
    }
    return {
      status: 200,
      headers: {
        etag,
        "cache-control": "no-cache",
        // The body is already JSON; `send` writes a string through untouched.
        "content-type": "application/json; charset=utf-8",
      },
      body: snapshotJson(env.environmentId, snapshot),
    };
  });

  /* ── GET /v1/stream/:envKey — SSE, server keys only ─────────────────── */

  router.get("/v1/stream/:envKey", async (ctx) => {
    const env = await requireEnvironment(ctx, deps, "server");
    deps.onSdkIdentified?.(ctx.header("user-agent"));

    const cap = deps.maxStreamConnections ?? 10_000;
    if (openStreams >= cap) {
      // Shed to polling rather than accepting a connection this node cannot
      // serve. The tier degrades on a curve instead of a cliff (§11.5).
      throw new HttpError(503, "STREAM_CAPACITY", "stream capacity reached; fall back to polling");
    }

    const current = await deps.snapshots.get(env.environmentId);
    openStreams++;

    let unsubscribe: (() => Promise<void>) | undefined;
    const stream = openSse(ctx.res, {
      ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
      ...(deps.sse !== undefined ? { registry: deps.sse } : {}),
      onClose: () => {
        openStreams--;
        deps.onStreamChange?.(openStreams);
        void unsubscribe?.();
      },
    });
    deps.onStreamChange?.(openStreams);

    /** Highest version this connection has been brought up to. */
    let sent = 0;

    const sendPut = (snapshot: Snapshot) => {
      // Serialised once per version and shared across every connection.
      stream.raw("put", snapshotJson(env.environmentId, snapshot), snapshot.version);
      sent = snapshot.version;
    };

    // Resume, per the §10.3 table. `null` from `patchesSince` covers all three
    // situations that require a full `put`, and the response is identical for
    // each, so they are not distinguished here.
    const lastEventId = Number(ctx.header("last-event-id"));
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      const replay = await deps.store.patchesSince(
        env.environmentId,
        lastEventId,
        deps.patchHistoryDepth ?? 200,
      );
      if (replay === null) {
        sendPut(current.snapshot);
      } else {
        // The client already holds this version -- that is what it just told
        // us. Without this, an empty replay (a client that is simply current)
        // leaves `sent` at 0 and triggers a full `put` of the entire snapshot
        // on every reconnect, which is the opposite of what resume is for.
        sent = lastEventId;
        for (const patch of replay) {
          stream.event(patch.op, patch.payload, patch.version);
          sent = patch.version;
        }
        // An SDK that resumed from history is at the version of the last patch,
        // which may still trail the current snapshot if history was trimmed
        // between the query and now.
        if (sent < current.version) sendPut(current.snapshot);
      }
    } else {
      sendPut(current.snapshot);
    }

    unsubscribe = await deps.store.subscribe(env.environmentId, (message) => {
      if (stream.closed || message.version <= sent) return;
      void (async () => {
        try {
          // Reuse the resume path rather than trusting the broadcast payload:
          // it is already correct about the three full-`put` cases, and it
          // means a node that missed a message still converges.
          const patches = await deps.store.patchesSince(
            env.environmentId,
            sent,
            deps.patchHistoryDepth ?? 200,
          );
          if (patches === null || patches.length === 0) {
            const latest = await deps.snapshots.get(env.environmentId);
            if (latest.version > sent) sendPut(latest.snapshot);
            return;
          }
          for (const patch of patches) {
            if (stream.closed) return;
            stream.event(patch.op, patch.payload, patch.version);
            sent = patch.version;
          }
        } catch (error) {
          deps.onError?.(error);
        }
      })();
    });

    // If the connection died while we were subscribing, drop it now — otherwise
    // this node leaks a subscriber for a socket nobody is reading.
    if (stream.closed) await unsubscribe();

    return undefined; // the handler owns the socket
  });

  /* ── POST /v1/events — batched summaries, fire and forget ───────────── */

  router.post("/v1/events", async (ctx) => {
    const env = await requireEnvironment(ctx, deps, ["server", "client", "mobile"]);

    // Validated before it reaches the sink. This body arrives from anyone
    // holding a public client key, and it used to be passed through as
    // `unknown` — an unbounded array of unbounded strings, straight into a
    // buffer (§15).
    const raw = await ctx.json<unknown>(BODY_LIMITS.events);
    const parsed = summaryBatchSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, "INVALID_BATCH", "malformed evaluation summary batch");
    }
    // A bucket from 1970 or 2170 lands in a partition nothing will ever drop,
    // or in none at all. Analytics is allowed to be lossy; it is not allowed to
    // corrupt the partitioned table (§10).
    if (!bucketIsAcceptable(parsed.data.bucketAt)) {
      return { status: 202, body: { dropped: "bucket_out_of_range" } };
    }

    try {
      await deps.ingestEvents?.(env.environmentId, parsed.data);
    } catch (error) {
      // Analytics ingest is the one path explicitly allowed to drop data (§14).
      // Failing the request would make an SDK retry a batch that is already
      // stale, on the same connection that carries nothing else important.
      deps.onError?.(error);
    }
    return { status: 202 };
  });

  return router;
}
