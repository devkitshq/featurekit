/**
 * What every admin route group shares: authentication, body parsing, scope
 * checks, and the idempotent `withPrincipal` wrapper.
 */

import { HttpError, type RequestContext } from "../../http/router.js";
import type { Database } from "../../db/client.js";
import type { SnapshotService } from "../../snapshot/service.js";
import type { AccessTokenRepository } from "../../repositories/access-tokens.js";
import { resolveSession, touchSession, SESSION_TTL_MS } from "../../repositories/members.js";
import { listProjectEnvironments, findEnvironmentByKeys } from "../../repositories/environments.js";
import { resolveTarget, type ResolvedTarget } from "../../repositories/flag-config.js";
import { findProject } from "../../repositories/projects.js";
import {
  principalFromSession,
  principalFromToken,
  requireEnvironmentAccess,
  requireRole,
  type Principal,
  type Role,
} from "../../auth/principal.js";
import { parseCookies, serializeCookie } from "../../http/cookies.js";
import { PasswordError } from "../../auth/passwords.js";
import { IdempotencyCache, idempotencyKeyOf } from "../../http/idempotency.js";
import type { z } from "zod";

export const SESSION_COOKIE = "fk_session";
/**
 * The header a cookie-authenticated mutation must carry.
 *
 * A cross-site form can POST with the browser's cookies attached; it cannot set
 * a custom header without a preflight, and the admin routes deliberately carry
 * no CORS headers, so that preflight fails. Together with `SameSite=Strict`
 * this is the whole CSRF story, and it needs no token store.
 */
export const CSRF_HEADER = "x-featurekit-csrf";

export interface AdminRouteDeps {
  db: Database;
  snapshots: SnapshotService;
  tokens: AccessTokenRepository;
  /** Invalidates cached SDK-key lookups the moment a key is revoked. */
  onKeyRevoked?: () => void;
  /** Replays a retried mutation instead of applying it twice. */
  idempotency?: IdempotencyCache;
  /**
   * Compile a proposed configuration without committing it.
   *
   * Supplied by the composition root because it needs the compiler and the row
   * loader, which the route layer deliberately does not know about.
   */
  /** `Secure` on the session cookie. On wherever the dashboard is not on localhost. */
  secureCookies?: boolean;
  onError?: (error: unknown) => void;
}

/* ─────────────────────────── authentication ─────────────────────────── */

export function presentedToken(ctx: RequestContext): string {
  const header = ctx.header("authorization");
  if (header === undefined || header.length === 0) {
    throw new HttpError(401, "MISSING_TOKEN", "an access token is required");
  }
  return header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
}

export function sessionCookie(ctx: RequestContext): string | null {
  const cookies = parseCookies(ctx.header("cookie"));
  const value = cookies[SESSION_COOKIE];
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * Who is calling: a personal access token, or a dashboard session.
 *
 * `Authorization` wins when present, so a script running in a browser tab with
 * a session cookie still acts as the token it was given rather than silently
 * borrowing the human's privileges.
 */
export async function authenticate(ctx: RequestContext, deps: AdminRouteDeps): Promise<Principal> {
  const header = ctx.header("authorization");
  if (header !== undefined && header.length > 0) {
    const token = await deps.tokens.resolve(presentedToken(ctx));
    const principal = token === null ? null : principalFromToken(token);
    if (principal === null) {
      // One shape for unknown, expired and malformed. Distinguishing them is a
      // token-probing oracle, exactly as it is for SDK keys.
      throw new HttpError(401, "TOKEN_REJECTED", "access token rejected");
    }
    deps.tokens.touch(token!.tokenId);
    return principal;
  }

  const cookie = sessionCookie(ctx);
  if (cookie === null) throw new HttpError(401, "MISSING_TOKEN", "an access token is required");

  const session = await resolveSession(deps.db, cookie);
  const principal = session === null ? null : principalFromSession(session);
  if (principal === null || session === null) {
    throw new HttpError(401, "SESSION_REJECTED", "session expired or rejected");
  }

  // A cookie is attached by the browser whoever caused the request, so a
  // mutation has to prove the caller could read the response too.
  if (
    ctx.method !== "GET" &&
    ctx.method !== "HEAD" &&
    ctx.header(CSRF_HEADER) === undefined
  ) {
    throw new HttpError(403, "CSRF_HEADER_REQUIRED", `${CSRF_HEADER} is required for cookie auth`);
  }

  touchSession(deps.db, session);
  return principal;
}

/** Parse a body against a schema, with the endpoint's own byte ceiling. */
export async function body<T extends z.ZodType>(
  ctx: RequestContext,
  schema: T,
  maxBytes: number,
): Promise<z.infer<T>> {
  const raw = await ctx.json<unknown>(maxBytes);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new HttpError(
      400,
      "INVALID_BODY",
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data as z.infer<T>;
}

/* ───────────────────────────── resolution ───────────────────────────── */

export async function requireProject(
  ctx: RequestContext,
  deps: AdminRouteDeps,
): Promise<{ id: string; key: string }> {
  const projectKey = ctx.params["project"] ?? "";
  const project = await findProject(deps.db, projectKey);
  if (project === null) throw new HttpError(404, "NOT_FOUND", "no such project");
  return project;
}

export async function requireEnvironment(
  ctx: RequestContext,
  deps: AdminRouteDeps,
  principal: Principal,
): Promise<{ id: string; projectId: string; key: string; isProduction: boolean }> {
  const environment = await findEnvironmentByKeys(
    deps.db,
    ctx.params["project"] ?? "",
    ctx.params["env"] ?? "",
  );
  if (environment === null) throw new HttpError(404, "NOT_FOUND", "no such environment");
  // Scope check immediately after resolution, before the id is used for
  // anything. A 404 rather than a 403 — see the module comment.
  requireEnvironmentAccess(principal, environment.id);
  return environment;
}

export async function requireFlagTarget(
  ctx: RequestContext,
  deps: AdminRouteDeps,
  principal: Principal,
): Promise<ResolvedTarget> {
  const target = await resolveTarget(deps.db, {
    projectKey: ctx.params["project"] ?? "",
    environmentKey: ctx.params["env"] ?? "",
    flagKey: ctx.params["flag"] ?? "",
  });
  if (target === null) throw new HttpError(404, "NOT_FOUND", "no such flag in that environment");
  requireEnvironmentAccess(principal, target.environmentId);
  return target;
}


/** What a member looks like over the wire: never the hash, never the sessions. */
export function publicMember(member: {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  hasPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: member.id,
    email: member.email,
    name: member.name,
    role: member.role,
    hasPassword: member.hasPassword,
    lastLoginAt: member.lastLoginAt,
    createdAt: member.createdAt,
  };
}

/**
 * Turn a policy failure into a 400 the form can render.
 *
 * `PasswordError` is thrown inside the repository, which has no idea it is on an
 * HTTP request; without this it would surface as a 500 and the person typing
 * would be told nothing about why their password was refused.
 */
export async function withPasswordErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PasswordError) {
      throw new HttpError(400, "PASSWORD_REJECTED", error.message);
    }
    throw error;
  }
}


/**
 * The per-registration helpers every admin route group shares. Built once in
 * `registerAdminRoutes`, so one idempotency cache serves every route.
 */
export function adminContext(deps: AdminRouteDeps) {
  const idempotency = deps.idempotency ?? new IdempotencyCache();

  const withPrincipal =
    (minimum: Role, handler: (ctx: RequestContext, principal: Principal) => Promise<unknown>) =>
    async (ctx: RequestContext) => {
      const principal = await authenticate(ctx, deps);
      requireRole(principal, minimum);

      const run = async () => {
        const result = await handler(ctx, principal);
        return result === undefined
          ? { status: 204 }
          : { status: 200, body: result as Record<string, unknown> };
      };

      // Idempotency is opt-in and only meaningful for mutations. A GET that
      // runs twice is a GET that ran twice.
      const routeKey = ctx.method === "GET" ? null : idempotencyKeyOf(ctx);
      if (routeKey === null) return run();
      // Bound to the caller: a cached response can hold a freshly minted secret,
      // and a replay skips the handler's own scope checks, so another principal
      // presenting the same key must never be served it.
      const key = `${principal.kind}:${principal.tokenId} ${routeKey}`;
      // The body is read inside the handler, so the fingerprint is over the
      // path and params — enough to catch the same key reused for a different
      // resource, which is the mistake that actually happens.
      return idempotency.run(key, { path: ctx.path, params: ctx.params }, run);
    };

  const sessionCookieFor = (token: string, expiresAt: Date): string =>
    serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: deps.secureCookies === true,
      expires: expiresAt,
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
    });

  /**
   * Deployment-wide and project-wide actions are refused to environment-scoped
   * tokens: a token limited to staging must not be able to act outside it, or
   * mint itself an unscoped identity (a dashboard session is never scoped).
   */
  const rejectScoped = (principal: Principal, what: string): void => {
    if (principal.environmentIds !== null) {
      throw new HttpError(403, "TOKEN_SCOPED", `an environment-scoped token cannot ${what}`);
    }
  };

  /** Recompile every environment of a project after a project-wide change. */
  const recompileProject = async (projectId: string, flagKey: string): Promise<void> => {
    for (const environment of await listProjectEnvironments(deps.db, projectId)) {
      deps.snapshots.notifyChange(environment.id, flagKey);
    }
  };

  return { idempotency, withPrincipal, sessionCookieFor, rejectScoped, recompileProject };
}

export type AdminContext = ReturnType<typeof adminContext>;
