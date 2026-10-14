/**
 * Client-tier routes.
 *
 * ```
 * POST /v1/client/state    Context in -> evaluated values out
 * GET  /v1/client/stream   SSE value updates for the connection's context
 * ```
 *
 * **The client tier does not receive the ruleset.** Shipping rules to a browser
 * leaks the business, not just the values: a rule reading
 * `plan == "enterprise" -> new-pricing` tells anyone with devtools that an
 * unreleased pricing tier exists and what it is called. Segment definitions name
 * your churn-risk cohort. Rollout percentages disclose release plans.
 *
 * @see docs/client-tier/protocol.md
 */

import type { EvaluationContext } from "../sdk/index.js";
import { checkKey } from "../auth/keys.js";
import { verifyContext } from "../auth/secure-mode.js";
import { HttpError, type RequestContext, type Router } from "../http/router.js";
import { openSse, type SseStream } from "../http/server.js";
import type { SnapshotStore } from "../snapshot/store.js";
import type { SnapshotService } from "../snapshot/service.js";
import {
  ClientFanout,
  contextHash,
  type ClientConnection,
  type ClientValues,
} from "../evaluation-service/fanout.js";
import type { AuthenticatedEnvironment } from "./sdk.js";
import { checkContext, DEFAULT_CONTEXT_LIMITS, type ContextLimits } from "../contracts/context.js";
import { BODY_LIMITS, clientStateSchema } from "../contracts/wire.js";
import type { SseRegistry } from "../http/server.js";
import {
  MemoryClientConnectionStore,
  newConnectionId,
  type ClientConnectionStore,
} from "../client-tier/connection-store.js";

export interface ClientStateRequest {
  context: EvaluationContext;
  /** Monotonic per SDK instance. Echoed back so late responses can be dropped. */
  seq?: number;
  signature?: string;
  expiresAt?: number;
}

export interface FlagState {
  /** Hash of the context this state was evaluated for. Echoed on every response. */
  contextHash: string;
  seq: number;
  version: number;
  values: ClientValues;
  /** Opaque handle for `GET /v1/client/stream`. */
  connectionId: string;
}

export interface ClientRouteDeps {
  snapshots: SnapshotService;
  store: SnapshotStore;
  authenticate: (presentedKey: string) => Promise<AuthenticatedEnvironment | null>;
  /** Verification secrets, newest first. Empty disables secure mode. */
  secureModeSecrets?: readonly string[];
  secureModeMaxTtlSeconds?: number;
  /**
   * Environments that have explicitly opted out of secure mode, by id.
   *
   * The default is the safe one and it is **derived from the environment row**,
   * not from this option: a production environment requires a signature unless
   * its id appears here. Previously this was a boolean the caller had to
   * remember to pass, which meant the security boundary depended on wiring —
   * and the wiring is exactly what a new deployment gets wrong.
   */
  unsignedContextEnvironmentIds?: ReadonlySet<string>;
  /** Force the requirement on for non-production environments too. */
  requireSignature?: boolean;
  contextLimits?: ContextLimits;
  /**
   * Where connection state is shared between nodes.
   *
   * A browser POSTs `/v1/client/state` and then opens `/v1/client/stream` — two
   * requests, which any ordinary load balancer will send to two different
   * nodes. Without a shared store the second node has never heard of the
   * handle and answers 409, so the client tier only works behind sticky
   * routing. Defaults to an in-process store, which is exactly that old
   * behaviour; production passes the Postgres one.
   */
  connectionStore?: ClientConnectionStore;
  /** How long a handle stays resumable on another node. */
  connectionTtlSeconds?: number;
  sse?: SseRegistry;
  onConnectionChange?: (open: number) => void;
  maxClientConnections?: number;
  heartbeatMs?: number;
  fanout?: ClientFanout;
  onError?: (error: unknown) => void;
}

interface Registered extends ClientConnection {
  environmentId: string;
  stream?: SseStream;
  lastSentVersion: number;
  lastValues: ClientValues;
}

function presentedKey(ctx: RequestContext): string {
  const header = ctx.header("authorization");
  const fromQuery = ctx.query.get("key") ?? ctx.query.get("clientKey");
  const raw = header ?? fromQuery;
  if (raw === undefined || raw === null || raw.length === 0) {
    throw new HttpError(401, "MISSING_SDK_KEY", "a client key is required");
  }
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
}

export function registerClientRoutes(router: Router, deps: ClientRouteDeps): Router {
  const fanout = deps.fanout ?? new ClientFanout();
  /** Connections whose socket this node holds. The hot path never leaves here. */
  const connections = new Map<string, Registered>();
  const shared = deps.connectionStore ?? new MemoryClientConnectionStore();
  const connectionTtl = deps.connectionTtlSeconds ?? 900;
  /** Subscriptions are per environment, not per connection. */
  const subscriptions = new Map<string, () => Promise<void>>();

  async function authenticate(ctx: RequestContext): Promise<AuthenticatedEnvironment> {
    const record = await deps.authenticate(presentedKey(ctx));
    // Client and mobile only. A server key used from a browser is a leaked
    // ruleset, so the check is symmetric with the server tier's.
    const checked = checkKey(record, { requireKind: ["client", "mobile"] });
    if (!checked.ok) throw new HttpError(401, checked.reason, "client key rejected");
    return checked.record as AuthenticatedEnvironment;
  }

  /**
   * Whether this environment demands a signed context.
   *
   * Production does, always, unless it has been explicitly and visibly opted
   * out. Because the server evaluates *as* a claimed identity, an unsigned key
   * in production lets anyone read the flags targeted at any named account
   *.
   */
  function signatureRequired(env: AuthenticatedEnvironment): boolean {
    if (deps.unsignedContextEnvironmentIds?.has(env.environmentId) === true) return false;
    return env.isProduction || deps.requireSignature === true;
  }

  function verifySignature(
    body: ClientStateRequest,
    context: EvaluationContext,
    env: AuthenticatedEnvironment,
  ): void {
    const required = signatureRequired(env);
    const secrets = deps.secureModeSecrets ?? [];
    if (secrets.length === 0) {
      if (required) {
        // Fail closed. A production deployment with client keys and no secret
        // is a misconfiguration, and serving unsigned contexts anyway would
        // silently turn the boundary off.
        throw new HttpError(500, "SECURE_MODE_UNCONFIGURED", "secure mode required but no secret");
      }
      return;
    }
    const key = (context as { key?: unknown }).key;
    const hash = contextHash(context);
    const result = verifyContext(
      {
        key: typeof key === "string" ? key : "",
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        ...(body.signature !== undefined ? { signature: body.signature } : {}),
        attributesHash: hash,
      },
      { secrets, maxTtlSeconds: deps.secureModeMaxTtlSeconds ?? 86_400 },
    );
    if (result.ok) return;
    // Never a silent downgrade to unsigned in a signed deployment.
    if (result.reason === "SIGNATURE_MISSING" && !required) return;
    // `SIGNATURE_EXPIRED` stays distinct: the SDK keeps serving its last values
    // and refreshes, whereas invalid drops to caller defaults.
    throw new HttpError(401, result.reason, "context signature rejected");
  }

  async function ensureSubscription(environmentId: string): Promise<void> {
    if (subscriptions.has(environmentId)) return;
    const unsubscribe = await deps.store.subscribe(environmentId, (message) => {
      void pushChanges(environmentId, message.version, message.flagKey).catch((error: unknown) =>
        deps.onError?.(error),
      );
    });
    subscriptions.set(environmentId, unsubscribe);
  }

  /**
   * Re-evaluate and push to every connection in an environment.
   *
   * This is the hot path for fan-out: without the fingerprint collapse, one
   * toggle against 50,000 connections is 50,000 evaluations and 50,000 SSE
   * writes, triggered by the most routine action in the product.
   */
  async function pushChanges(
    environmentId: string,
    version: number,
    flagKey: string | undefined,
  ): Promise<void> {
    const live = [...connections.values()].filter(
      (c) => c.environmentId === environmentId && c.stream !== undefined && !c.stream.closed,
    );
    if (live.length === 0) return;

    const { snapshot } = await deps.snapshots.get(environmentId);
    const changed =
      flagKey === undefined
        ? Object.values(snapshot.flags)
            .filter((f) => f.clientAvailable === true)
            .map((f) => f.key)
        : [flagKey];

    const computed = fanout.fanout(snapshot, changed, live);

    for (const connection of live) {
      const values = computed.get(connection.id);
      if (values === undefined) continue;

      // Only send what actually moved. A connection whose values are unchanged
      // gets nothing, which is most of them for a targeted toggle.
      const delta: ClientValues = {};
      let any = false;
      for (const [key, value] of Object.entries(values)) {
        const previous = connection.lastValues[key];
        if (previous === undefined || previous.value !== value.value) {
          delta[key] = value;
          any = true;
        }
        connection.lastValues[key] = value;
      }
      connection.lastSentVersion = version;
      if (any) {
        connection.stream!.event("values", { version, values: delta }, version);
      }
    }
  }

  /* ── POST /v1/client/state ──────────────────────────────────────────── */

  router.post("/v1/client/state", async (ctx) => {
    const env = await authenticate(ctx);
    const raw = await ctx.json<unknown>(BODY_LIMITS.clientState);
    const parsed = clientStateSchema.safeParse(raw);
    if (!parsed.success || parsed.data.context === undefined) {
      throw new HttpError(400, "MISSING_CONTEXT", "a context is required");
    }
    const body = parsed.data as ClientStateRequest;

    // Capped before it is hashed, normalised, evaluated against every flag, and
    // retained for the life of the connection. Each of those is proportional to
    // a size the caller chose.
    const contextCheck = checkContext(body.context, deps.contextLimits ?? DEFAULT_CONTEXT_LIMITS);
    if (!contextCheck.ok) {
      throw new HttpError(400, contextCheck.reason, "context rejected");
    }

    verifySignature(body, body.context, env);

    const { snapshot, version } = await deps.snapshots.get(env.environmentId);
    const values = fanout.evaluateAll(snapshot, body.context);
    const hash = contextHash(body.context);

    const cap = deps.maxClientConnections ?? 50_000;
    let connectionId = ctx.query.get("connection") ?? newConnectionId();
    if (connections.size >= cap) {
      // Above the cap the tier degrades to short-TTL polling rather than
      // accepting a connection it cannot serve: a curve, not a cliff.
      connectionId = "";
    } else {
      connections.set(connectionId, {
        id: connectionId,
        environmentId: env.environmentId,
        context: body.context,
        lastSentVersion: version,
        lastValues: { ...values },
      });
      // Published so that whichever node receives the stream request can take
      // it over. Awaited rather than fire-and-forget: the stream request is
      // already in flight by the time this response reaches the browser, and a
      // race against our own write would produce exactly the 409 this fixes.
      //
      // Best effort, and the `catch` is the point: the identify is what hands a
      // browser its flag values, and it must not fail because a *cache* is
      // unavailable. Losing the shared copy costs a re-identify if this
      // browser's stream lands elsewhere; failing here costs it every flag.
      await shared
        .save(
          connectionId,
          { environmentId: env.environmentId, context: body.context, lastSentVersion: version },
          connectionTtl,
        )
        .catch((error: unknown) => deps.onError?.(error));
    }

    const state: FlagState = {
      contextHash: hash,
      // Echoed, never generated here: the SDK uses it to drop a response that
      // was superseded while in flight.
      seq: body.seq ?? 0,
      version,
      values,
      connectionId,
    };
    return { status: 200, body: state };
  });

  /* ── GET /v1/client/stream ──────────────────────────────────────────── */

  router.get("/v1/client/stream", async (ctx) => {
    const env = await authenticate(ctx);
    const connectionId = ctx.query.get("connection");
    if (connectionId === null || connectionId.length === 0) {
      throw new HttpError(409, "UNKNOWN_CONNECTION", "call POST /v1/client/state first");
    }

    let registered = connections.get(connectionId);

    // Not ours: another node took the POST. Rehydrate from the shared store
    // rather than refusing — this is the whole reason the store exists.
    if (registered === undefined) {
      const stored = await shared.load(connectionId).catch((error: unknown) => {
        deps.onError?.(error);
        return null;
      });
      if (stored !== null && stored.environmentId === env.environmentId) {
        const { snapshot } = await deps.snapshots.get(env.environmentId);
        registered = {
          id: connectionId,
          environmentId: stored.environmentId,
          context: stored.context,
          lastSentVersion: stored.lastSentVersion,
          // Recomputed rather than transported: `lastValues` exists to suppress
          // no-op pushes, and evaluating it here is cheaper than shipping every
          // flag value through the shared store on every identify.
          lastValues: fanout.evaluateAll(snapshot, stored.context),
        };
        connections.set(connectionId, registered);
      }
    }

    if (registered === undefined || registered.environmentId !== env.environmentId) {
      // The connection must be established by POST /v1/client/state first: the
      // stream carries no context of its own, and inventing one here would mean
      // evaluating as an identity nobody proved.
      throw new HttpError(409, "UNKNOWN_CONNECTION", "call POST /v1/client/state first");
    }
    // The browser is here and streaming; keep the shared record alive for a
    // reconnect that may land somewhere else again. Best effort for the same
    // reason as the write above.
    await shared.touch(connectionId, connectionTtl).catch((error: unknown) => deps.onError?.(error));

    await ensureSubscription(env.environmentId);

    const stream = openSse(ctx.res, {
      ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
      ...(deps.sse !== undefined ? { registry: deps.sse } : {}),
      onClose: () => {
        connections.delete(registered.id);
        deps.onConnectionChange?.(connections.size);
        // The shared record is left to expire rather than deleted: a browser
        // whose stream dropped is about to reconnect, quite possibly to another
        // node, and deleting here would force a re-identify every time.
      },
    });
    deps.onConnectionChange?.(connections.size);
    registered.stream = stream;
    stream.event("ready", { version: registered.lastSentVersion }, registered.lastSentVersion);

    // Catch up before streaming live.
    //
    // `POST /v1/client/state` returned values at some version V; the stream
    // opens a round trip later. A change landing in that window is broadcast to
    // connections that exist *at broadcast time*, and this one did not — so
    // without this it would be missed permanently, not merely late. The server
    // tier solves the same problem with `Last-Event-ID` replay; here the
    // connection's own last-sent version is the equivalent.
    const latest = await deps.snapshots.get(env.environmentId);
    if (latest.version > registered.lastSentVersion) {
      await pushChanges(env.environmentId, latest.version, undefined);
    }

    if (stream.closed) connections.delete(registered.id);
    return undefined;
  });

  return router;
}
