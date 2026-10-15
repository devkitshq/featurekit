/**
 * The management API.
 *
 * ```
 * GET    /v1/admin/projects
 * POST   /v1/admin/projects                                        admin
 * POST   /v1/admin/projects/:project/environments                  admin
 * GET    /v1/admin/projects/:project/flags
 * POST   /v1/admin/projects/:project/flags                         writer
 * GET    /v1/admin/projects/:project/environments/:env/flags/:flag
 * PATCH  /v1/admin/projects/:project/environments/:env/flags/:flag writer
 * POST   /v1/admin/projects/:project/environments/:env/flags/:flag/off   writer
 * POST   /v1/admin/projects/:project/environments/:env/flags/:flag/revert writer
 * GET    /v1/admin/projects/:project/audit
 * GET    /v1/admin/projects/:project/environments/:env/keys        admin
 * POST   /v1/admin/projects/:project/environments/:env/keys        admin
 * DELETE /v1/admin/projects/:project/environments/:env/keys/:keyId admin
 * GET    /v1/admin/projects/:project/environments/:env/segments    reader
 * POST   /v1/admin/projects/:project/environments/:env/segments    writer
 * POST   /v1/admin/projects/:project/environments/:env/segments/:segment/members writer
 * ```
 *
 * **Everything is addressed by key, never by uuid.** A route taking
 * `/flags/:flagId` invites exactly one bug — trusting an id from a URL — and
 * that bug is an IDOR. Keys are resolved through a join that
 * includes the project, and a resolution that finds nothing is a 404 whether
 * the object does not exist or belongs to somebody else. Those two cases must
 * be indistinguishable from outside, or the API is an existence oracle for
 * other tenants' flag keys.
 *
 * **The kill switch has its own route** so that turning something off during an
 * incident needs neither a read-modify-write nor a version the operator does
 * not have in front of them.
 */

import { HttpError, type RequestContext, type Router } from "../http/router.js";
import type { Database } from "../db/client.js";
import type { EvaluationContext, Snapshot } from "../sdk/index.js";
import { dryRunFlag, reassignmentWarning } from "../snapshot/dry-run.js";
import type { SnapshotService } from "../snapshot/service.js";
import type { AccessTokenRepository } from "../repositories/access-tokens.js";
import {
  principalFromSession,
  principalFromToken,
  requireEnvironmentAccess,
  requireRole,
  type Principal,
  type Role,
} from "../auth/principal.js";
import { clearCookie, parseCookies, serializeCookie } from "../http/cookies.js";
import {
  createMember,
  createToken,
  deleteMember,
  deleteSession,
  deleteSessionsFor,
  findMemberById,
  listMembers,
  listTokens,
  login,
  memberCount,
  ownerCount,
  resolveSession,
  revokeToken,
  touchSession,
  updateMember,
  SESSION_TTL_MS,
} from "../repositories/members.js";
import { PasswordError } from "../auth/passwords.js";
import {
  deleteSegment,
  listFlagsForDashboard,
  listProjectEnvironments,
  readFlagDefinition,
  readFlagMetrics,
  readSegment,
  recentlyChangedFlags,
  restoreFlag,
} from "../repositories/dashboard.js";
import {
  changePasswordSchema,
  changeRequestSchema,
  createAccessTokenSchema,
  createFlagSchema,
  createMemberSchema,
  loginSchema,
  updateMemberSchema,
  dryRunSchema,
  createEnvironmentSchema,
  createProjectSchema,
  createSdkKeySchema,
  createSegmentSchema,
  flagConfigSchema,
  killSwitchSchema,
  revertSchema,
  reviewSchema,
  scheduleChangeSchema,
  segmentMembersSchema,
} from "../contracts/admin.js";
import {
  approveChangeRequest,
  listChangeRequests,
  rejectChangeRequest,
} from "../scheduler/scheduled-changes.js";
import { changeRequests, scheduledChanges } from "../db/schema.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { BODY_LIMITS } from "../contracts/wire.js";
import { IdempotencyCache, idempotencyKeyOf } from "../http/idempotency.js";
import {
  killSwitch,
  listAudit,
  readAuditDiff,
  verifyAuditChain,
  readFlagConfig,
  resolveTarget,
  writeFlagConfig,
  type ResolvedTarget,
} from "../repositories/flags.js";
import {
  applySegmentMembers,
  archiveFlag,
  createEnvironment,
  createFlag,
  createProject,
  createSdkKey,
  createSegment,
  deleteProject,
  findEnvironmentByKeys,
  findProject,
  findSegment,
  listFlags,
  listProjects,
  listSdkKeys,
  listSegments,
  revokeSdkKey,
} from "../repositories/catalog.js";
import type { z } from "zod";

/** The cookie a dashboard session lives in. */
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
  dryRun?: (target: ResolvedTarget, patch: unknown) => Promise<Snapshot>;
  /** `Secure` on the session cookie. On wherever the dashboard is not on localhost. */
  secureCookies?: boolean;
  onError?: (error: unknown) => void;
}

/* ─────────────────────────── authentication ─────────────────────────── */

function presentedToken(ctx: RequestContext): string {
  const header = ctx.header("authorization");
  if (header === undefined || header.length === 0) {
    throw new HttpError(401, "MISSING_TOKEN", "an access token is required");
  }
  return header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
}

function sessionCookie(ctx: RequestContext): string | null {
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
async function authenticate(ctx: RequestContext, deps: AdminRouteDeps): Promise<Principal> {
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
async function body<T extends z.ZodType>(
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

async function requireProject(
  ctx: RequestContext,
  deps: AdminRouteDeps,
): Promise<{ id: string; key: string }> {
  const projectKey = ctx.params["project"] ?? "";
  const project = await findProject(deps.db, projectKey);
  if (project === null) throw new HttpError(404, "NOT_FOUND", "no such project");
  return project;
}

async function requireEnvironment(
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

async function requireFlagTarget(
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

/* ────────────────────────────── the routes ──────────────────────────── */

export function registerAdminRoutes(router: Router, deps: AdminRouteDeps): Router {
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

  /* -- who is using the dashboard (dashboard/PLAN.md 2) -------------- */

  const sessionCookieFor = (token: string, expiresAt: Date): string =>
    serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: deps.secureCookies === true,
      expires: expiresAt,
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
    });

  /**
   * Whether this deployment has any account at all.
   *
   * Unauthenticated, deliberately: without it a fresh install shows a login
   * form nobody can pass and no way to find out why. It discloses a count, not
   * an address, which is the least that answers the question.
   */
  router.get("/v1/admin/auth/bootstrap", async () => ({
    status: 200,
    body: { members: await memberCount(deps.db) },
  }));

  router.post("/v1/admin/auth/login", async (ctx) => {
    const input = await body(ctx, loginSchema, 4 * 1024);
    const result = await login(deps.db, {
      email: input.email,
      password: input.password,
      userAgent: ctx.header("user-agent"),
    });
    if (result === null) {
      // One answer for unknown email, no password set, and wrong password.
      throw new HttpError(401, "CREDENTIALS_REJECTED", "email or password is wrong");
    }
    return {
      status: 200,
      headers: { "set-cookie": sessionCookieFor(result.token, result.expiresAt) },
      body: { member: publicMember(result.member) },
    };
  });

  router.post("/v1/admin/auth/logout", async (ctx) => {
    // Deletes the row, not just the cookie: a logout that leaves the session
    // valid is a logout in name only.
    const token = sessionCookie(ctx);
    if (token !== null) await deleteSession(deps.db, token);
    return {
      status: 200,
      headers: {
        "set-cookie": clearCookie(SESSION_COOKIE, { secure: deps.secureCookies === true }),
      },
      body: { ok: true },
    };
  });

  router.get(
    "/v1/admin/auth/me",
    withPrincipal("reader", async (_ctx, principal) => {
      const member = await findMemberById(deps.db, principal.memberId);
      return {
        member: member === null ? null : publicMember(member),
        principal: {
          kind: principal.kind,
          role: principal.role,
          email: principal.memberEmail,
          environmentIds: principal.environmentIds,
        },
      };
    }),
  );

  router.post(
    "/v1/admin/auth/password",
    withPrincipal("reader", async (ctx, principal) => {
      const input = await body(ctx, changePasswordSchema, 4 * 1024);
      // Re-authenticating proves this is the account's owner and not a borrowed
      // session, which is the whole point of asking for the current password.
      const member = await findMemberById(deps.db, principal.memberId);
      if (member === null) throw new HttpError(404, "NOT_FOUND", "no such member");
      const verified = await login(deps.db, {
        email: member.email,
        password: input.currentPassword,
      });
      if (verified === null) {
        throw new HttpError(401, "CREDENTIALS_REJECTED", "current password is wrong");
      }
      await withPasswordErrors(() =>
        updateMember(deps.db, principal.memberId, { password: input.newPassword }),
      );
      // Every session ends, including this one: a password change is what you do
      // when you think somebody else has the old one.
      return {
        status: 200,
        headers: {
          "set-cookie": clearCookie(SESSION_COOKIE, { secure: deps.secureCookies === true }),
        },
        body: { ok: true },
      };
    }),
  );

  /* -- members and tokens -------------------------------------------- */

  router.get(
    "/v1/admin/members",
    withPrincipal("admin", async () => ({
      members: (await listMembers(deps.db)).map(publicMember),
    })),
  );

  router.post(
    "/v1/admin/members",
    withPrincipal("owner", async (ctx) => {
      const input = await body(ctx, createMemberSchema, 4 * 1024);
      const member = await withPasswordErrors(() =>
        createMember(deps.db, {
          email: input.email,
          name: input.name ?? null,
          role: input.role,
          ...(input.password !== undefined ? { password: input.password } : {}),
        }),
      );
      return publicMember(member);
    }),
  );

  router.patch(
    "/v1/admin/members/:memberId",
    withPrincipal("reader", async (ctx, principal) => {
      const memberId = ctx.params["memberId"] ?? "";
      const input = await body(ctx, updateMemberSchema, 4 * 1024);
      const self = memberId === principal.memberId;

      // You may rename yourself. Everything else about anyone -- including your
      // own role -- is an owner's decision.
      if (!self || input.role !== undefined || input.password !== undefined) {
        requireRole(principal, "owner");
      }
      if (input.role !== undefined && input.role !== "owner") {
        // Demoting the last owner leaves a deployment nobody can administer.
        const target = await findMemberById(deps.db, memberId);
        if (target?.role === "owner" && (await ownerCount(deps.db, memberId)) === 0) {
          throw new HttpError(409, "LAST_OWNER", "this is the only owner");
        }
      }

      const updated = await withPasswordErrors(() =>
        updateMember(deps.db, memberId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.password !== undefined ? { password: input.password } : {}),
        }),
      );
      if (updated === null) throw new HttpError(404, "NOT_FOUND", "no such member");
      return publicMember(updated);
    }),
  );

  router.delete(
    "/v1/admin/members/:memberId",
    withPrincipal("owner", async (ctx, principal) => {
      const memberId = ctx.params["memberId"] ?? "";
      if (memberId === principal.memberId) {
        throw new HttpError(409, "SELF_DELETE", "you cannot remove your own account");
      }
      const target = await findMemberById(deps.db, memberId);
      if (target === null) throw new HttpError(404, "NOT_FOUND", "no such member");
      if (target.role === "owner" && (await ownerCount(deps.db, memberId)) === 0) {
        throw new HttpError(409, "LAST_OWNER", "this is the only owner");
      }
      await deleteSessionsFor(deps.db, memberId);
      await deleteMember(deps.db, memberId);
      // Their access tokens went with them (ON DELETE CASCADE); the cache in
      // front of that table has to be told.
      deps.tokens.invalidateAll();
      return { removed: true };
    }),
  );

  router.get(
    "/v1/admin/tokens",
    withPrincipal("reader", async (_ctx, principal) => ({
      tokens: await listTokens(deps.db, principal.memberId),
    })),
  );

  router.post(
    "/v1/admin/tokens",
    withPrincipal("writer", async (ctx, principal) => {
      const input = await body(ctx, createAccessTokenSchema, 8 * 1024);
      // A token cannot grant more than its creator has: an environment-scoped
      // principal minting an unscoped token would be a privilege escalation
      // with extra steps.
      const scope = input.environmentIds ?? principal.environmentIds ?? undefined;
      if (principal.environmentIds !== null) {
        const allowed = new Set(principal.environmentIds);
        for (const id of scope ?? []) {
          if (!allowed.has(id)) throw new HttpError(403, "TOKEN_SCOPED", "outside your scope");
        }
      }
      const created = await createToken(deps.db, {
        memberId: principal.memberId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(scope !== undefined ? { environmentIds: scope } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: new Date(input.expiresAt) } : {}),
      });
      // The plaintext is in this response and nowhere else, ever again.
      return { id: created.id, token: created.token };
    }),
  );

  router.delete(
    "/v1/admin/tokens/:tokenId",
    withPrincipal("reader", async (ctx, principal) => {
      const removed = await revokeToken(deps.db, principal.memberId, ctx.params["tokenId"] ?? "");
      if (!removed) throw new HttpError(404, "NOT_FOUND", "no such token");
      // The lookup cache is what decides whether a revoked token still works,
      // so revocation drops it rather than waiting out its TTL. Without this a
      // deleted token keeps authenticating for another fifteen seconds.
      deps.tokens.invalidateAll();
      return { revoked: true };
    }),
  );

  /* ── projects and environments ────────────────────────────────────── */

  router.get(
    "/v1/admin/projects",
    withPrincipal("reader", async (_ctx, principal) => ({
      projects: await listProjects(deps.db, principal),
    })),
  );

  router.post(
    "/v1/admin/projects",
    withPrincipal("admin", async (ctx) => {
      const input = await body(ctx, createProjectSchema, BODY_LIMITS.adminWrite);
      return createProject(deps.db, input);
    }),
  );

  router.delete(
    "/v1/admin/projects/:project",
    withPrincipal("admin", async (ctx, principal) => {
      const project = await requireProject(ctx, deps);
      if (principal.environmentIds !== null) {
        throw new HttpError(403, "TOKEN_SCOPED", "an environment-scoped token cannot delete projects");
      }
      deps.tokens.invalidateAll();
      await deleteProject(deps.db, project.key);
      return { deleted: true };
    }),
  );

  router.post(
    "/v1/admin/projects/:project/environments",
    withPrincipal("admin", async (ctx, principal) => {
      const project = await requireProject(ctx, deps);
      // Creating an environment is only for tokens that are not environment
      // scoped: a token restricted to staging must not be able to mint itself a
      // new environment outside its own scope.
      if (principal.environmentIds !== null) {
        throw new HttpError(403, "TOKEN_SCOPED", "an environment-scoped token cannot create environments");
      }
      const input = await body(ctx, createEnvironmentSchema, BODY_LIMITS.adminWrite);
      return createEnvironment(deps.db, {
        projectId: project.id,
        key: input.key,
        name: input.name,
        ...(input.color !== undefined ? { color: input.color } : {}),
        isProduction: input.isProduction,
      });
    }),
  );

  /* ── flags ────────────────────────────────────────────────────────── */

  /**
   * The environments of a project, in full.
   *
   * `GET /v1/admin/projects` returns environment *keys*, which is enough for a
   * script and not enough for a switcher that has to colour production
   * differently from staging.
   */
  router.get(
    "/v1/admin/projects/:project/environments",
    withPrincipal("reader", async (ctx, principal) => {
      const project = await requireProject(ctx, deps);
      const all = await listProjectEnvironments(deps.db, project.id);
      // A scoped token sees only its own environments, and learns nothing about
      // the existence of the others.
      return {
        environments: all.filter(
          (environment) =>
            principal.environmentIds === null ||
            principal.environmentIds.includes(environment.id),
        ),
      };
    }),
  );

  /**
   * Every flag in the project.
   *
   * With `?environment=`, each flag also carries its state there — on/off, the
   * served default, how many rules and targets. Without it, the plain list.
   *
   * The parameter is what makes the flags table one request instead of one per
   * row, which at two hundred flags is the difference between a page and an
   * outage of your own making.
   */
  router.get(
    "/v1/admin/projects/:project/flags",
    withPrincipal("reader", async (ctx, principal) => {
      const project = await requireProject(ctx, deps);
      const environmentKey = ctx.query.get("environment");
      const includeArchived = ctx.query.get("archived") === "true";

      if (environmentKey === null) {
        return { flags: await listFlags(deps.db, project.id) };
      }

      const environment = await findEnvironmentByKeys(deps.db, project.key, environmentKey);
      if (environment === null) throw new HttpError(404, "NOT_FOUND", "no such environment");
      requireEnvironmentAccess(principal, environment.id);

      return {
        environment: environment.key,
        flags: await listFlagsForDashboard(deps.db, project.id, environment.id, {
          includeArchived,
        }),
      };
    }),
  );

  /** The flag itself: metadata and variation **values**, which speak no indices. */
  router.get(
    "/v1/admin/projects/:project/flags/:flag",
    withPrincipal("reader", async (ctx) => {
      const project = await requireProject(ctx, deps);
      const definition = await readFlagDefinition(deps.db, project.id, ctx.params["flag"] ?? "");
      if (definition === null) throw new HttpError(404, "NOT_FOUND", "no such flag");
      return definition;
    }),
  );

  router.post(
    "/v1/admin/projects/:project/flags/:flag/restore",
    withPrincipal("writer", async (ctx) => {
      const project = await requireProject(ctx, deps);
      await restoreFlag(deps.db, project.id, ctx.params["flag"] ?? "");
      return { archived: false };
    }),
  );

  router.post(
    "/v1/admin/projects/:project/flags",
    withPrincipal("writer", async (ctx) => {
      const project = await requireProject(ctx, deps);
      const input = await body(ctx, createFlagSchema, BODY_LIMITS.adminWrite);
      const flag = await createFlag(deps.db, { projectId: project.id, ...input });
      return { id: flag.id, key: input.key };
    }),
  );

  router.delete(
    "/v1/admin/projects/:project/flags/:flag",
    withPrincipal("writer", async (ctx) => {
      const project = await requireProject(ctx, deps);
      await archiveFlag(deps.db, project.id, ctx.params["flag"] ?? "");
      // Archiving removes the flag from every environment's next snapshot, so
      // every environment has to recompile — not just one.
      return { archived: true };
    }),
  );

  router.get(
    "/v1/admin/projects/:project/environments/:env/flags/:flag",
    withPrincipal("reader", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      return readFlagConfig(deps.db, target);
    }),
  );

  /**
   * The general configuration write.
   *
   * Version-checked, transactional, audited, and only then propagated. The
   * propagation is debounced: a dashboard session is several PATCHes for one
   * logical change, and broadcasting each of them makes every connected SDK
   * apply five snapshots for one edit.
   */
  router.patch(
    "/v1/admin/projects/:project/environments/:env/flags/:flag",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, flagConfigSchema, BODY_LIMITS.adminWrite);
      const result = await writeFlagConfig(deps.db, target, input, principal);
      deps.snapshots.notifyChange(target.environmentId, target.flagKey);
      return { version: result.version, auditId: result.auditId, config: result.after };
    }),
  );

  /**
   * The kill switch.
   *
   * No expected version, and propagation is immediate rather than debounced:
   * "off" cannot lose anyone else's edit, and an operator reducing blast radius
   * during an incident must not wait behind a coalescing timer.
   */
  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/off",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, killSwitchSchema, 4 * 1024);
      const result = await killSwitch(
        deps.db,
        target,
        principal,
        ...(input.comment !== undefined ? ([input.comment] as const) : ([] as const)),
      );
      await deps.snapshots.notifyChangeImmediate(target.environmentId, target.flagKey);
      return { version: result.version, auditId: result.auditId, alreadyOff: result.alreadyOff };
    }),
  );

  /**
   * Revert to the state recorded in an audit row.
   *
   * A replay through the ordinary write path, not a direct row rewrite: the
   * revert is validated, version-checked and audited exactly like the change it
   * undoes. A revert that bypassed validation could restore a configuration
   * that no longer compiles — a rule naming a segment deleted since.
   */
  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/revert",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, revertSchema, 4 * 1024);
      const historical = await readAuditDiff(deps.db, target.projectId, input.auditId);
      if (historical === null) throw new HttpError(404, "NOT_FOUND", "no such audit entry");
      if (historical.entityKey !== target.flagKey) {
        throw new HttpError(400, "AUDIT_MISMATCH", "that audit entry is for a different flag");
      }

      const before = historical.before;
      const result = await writeFlagConfig(
        deps.db,
        target,
        {
          expectedVersion: target.version,
          enabled: before.enabled,
          offVariation: before.offVariation,
          ...(before.fallthroughVariation !== undefined
            ? { fallthroughVariation: before.fallthroughVariation }
            : {}),
          ...(before.fallthroughRollout !== undefined
            ? {
                fallthroughRollout: {
                  ...(before.fallthroughRollout.contextKind !== undefined
                    ? { contextKind: before.fallthroughRollout.contextKind }
                    : {}),
                  ...(before.fallthroughRollout.bucketBy !== undefined
                    ? { bucketBy: before.fallthroughRollout.bucketBy }
                    : {}),
                  ...(before.fallthroughRollout.seed !== undefined
                    ? { seed: before.fallthroughRollout.seed }
                    : {}),
                  variations: before.fallthroughRollout.variations.map((v) => ({
                    variation: v.variationIndex,
                    weight: v.weight,
                  })),
                },
              }
            : {}),
          rules: before.rules.map((rule) => ({
            ...(rule.description !== undefined ? { description: rule.description } : {}),
            clauses: rule.clauses,
            ...(rule.variation !== undefined ? { variation: rule.variation } : {}),
            ...(rule.rollout !== undefined
              ? {
                  rollout: {
                    ...(rule.rollout.contextKind !== undefined
                      ? { contextKind: rule.rollout.contextKind }
                      : {}),
                    ...(rule.rollout.bucketBy !== undefined
                      ? { bucketBy: rule.rollout.bucketBy }
                      : {}),
                    ...(rule.rollout.seed !== undefined ? { seed: rule.rollout.seed } : {}),
                    variations: rule.rollout.variations.map((v) => ({
                      variation: v.variationIndex,
                      weight: v.weight,
                    })),
                  },
                }
              : {}),
          })),
          targets: before.targets,
          prerequisites: before.prerequisites,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
        },
        principal,
        { action: "flag.reverted" },
      );
      deps.snapshots.notifyChange(target.environmentId, target.flagKey);
      return { version: result.version, auditId: result.auditId, config: result.after };
    }),
  );

  /**
   * What the fleet evaluated, by variation, over the last day.
   *
   * The question behind it is "can this temporary flag be deleted yet" — which
   * has no answer without evidence that nothing is still reading it.
   */
  router.get(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/metrics",
    withPrincipal("reader", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const hours = Number(ctx.query.get("hours") ?? "24");
      return {
        flagKey: target.flagKey,
        points: await readFlagMetrics(deps.db, target.environmentId, target.flagKey, {
          sinceHours: Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24 * 30) : 24,
        }),
      };
    }),
  );

  /** The home page: what changed here most recently. */
  router.get(
    "/v1/admin/projects/:project/environments/:env/recent",
    withPrincipal("reader", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      return { flags: await recentlyChangedFlags(deps.db, environment.id) };
    }),
  );

  /* ── audit ────────────────────────────────────────────────────────── */

  router.get(
    "/v1/admin/projects/:project/audit",
    withPrincipal("reader", async (ctx) => {
      const project = await requireProject(ctx, deps);
      const limit = Number(ctx.query.get("limit") ?? "50");
      const entityKey = ctx.query.get("flag") ?? undefined;
      return {
        entries: await listAudit(deps.db, project.id, {
          limit: Number.isFinite(limit) ? limit : 50,
          ...(entityKey !== undefined ? { entityKey } : {}),
        }),
      };
    }),
  );

  /**
   * Verify the audit chain.
   *
   * Admin-only, because the answer ("somebody edited the audit log") is itself
   * sensitive, and because running it walks the project's whole history.
   */
  router.get(
    "/v1/admin/projects/:project/audit/verify",
    withPrincipal("admin", async (ctx) => {
      const project = await requireProject(ctx, deps);
      return verifyAuditChain(deps.db, project.id);
    }),
  );

  /* ── SDK keys ─────────────────────────────────────────────────────── */

  router.get(
    "/v1/admin/projects/:project/environments/:env/keys",
    withPrincipal("admin", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      return { keys: await listSdkKeys(deps.db, environment.id) };
    }),
  );

  router.post(
    "/v1/admin/projects/:project/environments/:env/keys",
    withPrincipal("admin", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      const input = await body(ctx, createSdkKeySchema, 4 * 1024);
      const created = await createSdkKey(deps.db, {
        environmentId: environment.id,
        kind: input.kind,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: new Date(input.expiresAt) } : {}),
      });
      // The plaintext is in this response and nowhere else, ever again.
      return { id: created.id, kind: created.kind, key: created.key };
    }),
  );

  router.delete(
    "/v1/admin/projects/:project/environments/:env/keys/:keyId",
    withPrincipal("admin", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      await revokeSdkKey(deps.db, environment.id, ctx.params["keyId"] ?? "");
      // Revocation is only as fast as the lookup cache lets it be, so the cache
      // is dropped here rather than waited out.
      deps.onKeyRevoked?.();
      return { revoked: true };
    }),
  );

  /**
   * Preview a change without applying it.
   *
   * Compiles the proposed configuration, evaluates the caller's contexts
   * against both snapshots, and reports who moves — including the churn figure
   * that distinguishes "5% more users" from "the same 5%, different users",
   * which is the failure no chart makes visible after the fact.
   *
   * Nothing is written. Deliberately a POST anyway: the body carries thousands
   * of contexts, and those do not belong in a URL or an access log.
   */
  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/dry-run",
    withPrincipal("reader", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, dryRunSchema, BODY_LIMITS.adminWrite);

      const current = await deps.snapshots.get(target.environmentId);
      const proposed = await deps.dryRun?.(target, input.patch);
      if (proposed === undefined) {
        throw new HttpError(501, "DRY_RUN_UNAVAILABLE", "dry run is not configured on this node");
      }

      const result = dryRunFlag(
        target.flagKey,
        current.snapshot,
        proposed,
        input.contexts as EvaluationContext[],
        input.maxExamples !== undefined ? { maxExamples: input.maxExamples } : {},
      );
      const warning = reassignmentWarning(result);
      return warning === null ? result : { ...result, warning };
    }),
  );

  /* ── scheduled changes ───────────────────────────────── */

  /**
   * Schedule a change for later.
   *
   * Validated now, applied later by `ScheduledChangeWorker`. Validating at
   * schedule time is what stops a typo sitting in a table until 3am on a
   * Saturday and then failing.
   */
  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/schedule",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, scheduleChangeSchema, BODY_LIMITS.adminWrite);

      const executeAt = new Date(input.executeAt);
      if (executeAt.getTime() <= Date.now()) {
        throw new HttpError(400, "EXECUTE_AT_IN_PAST", "executeAt must be in the future");
      }

      const [row] = await deps.db
        .insert(scheduledChanges)
        .values({
          flagEnvironmentId: target.flagEnvironmentId,
          patch: input.patch as Record<string, unknown>,
          executeAt,
          createdBy: principal.memberId,
        })
        .returning({ id: scheduledChanges.id });
      return { id: row?.id, executeAt: executeAt.toISOString() };
    }),
  );

  router.get(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/schedule",
    withPrincipal("reader", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const rows = await deps.db
        .select({
          id: scheduledChanges.id,
          executeAt: scheduledChanges.executeAt,
          executedAt: scheduledChanges.executedAt,
          failedReason: scheduledChanges.failedReason,
        })
        .from(scheduledChanges)
        .where(eq(scheduledChanges.flagEnvironmentId, target.flagEnvironmentId))
        .orderBy(asc(scheduledChanges.executeAt))
        .limit(100);
      return { scheduled: rows };
    }),
  );

  router.delete(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/schedule/:scheduleId",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const removed = await deps.db
        .delete(scheduledChanges)
        .where(
          and(
            eq(scheduledChanges.id, ctx.params["scheduleId"] ?? ""),
            // Scoped to this flag environment: an id from another tenant
            // matches nothing.
            eq(scheduledChanges.flagEnvironmentId, target.flagEnvironmentId),
            isNull(scheduledChanges.executedAt),
          ),
        )
        .returning({ id: scheduledChanges.id });
      if (removed.length === 0) {
        throw new HttpError(404, "NOT_FOUND", "no such pending scheduled change");
      }
      return { cancelled: true };
    }),
  );

  /* ── change requests (four-eyes) ──────────────────────────────────── */

  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/requests",
    withPrincipal("reader", async (ctx, principal) => {
      // Deliberately `reader`: raising a request is how somebody without write
      // access proposes a change. Approving it still requires a writer.
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, changeRequestSchema, BODY_LIMITS.adminWrite);
      const [row] = await deps.db
        .insert(changeRequests)
        .values({
          flagEnvironmentId: target.flagEnvironmentId,
          patch: input.patch as Record<string, unknown>,
          requestedBy: principal.memberId,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
        })
        .returning({ id: changeRequests.id });
      return { id: row?.id, status: "pending" };
    }),
  );

  router.get(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/requests",
    withPrincipal("reader", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      return { requests: await listChangeRequests(deps.db, target.flagEnvironmentId) };
    }),
  );

  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/requests/:requestId/approve",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      try {
        const result = await approveChangeRequest(deps.db, {
          requestId: ctx.params["requestId"] ?? "",
          flagEnvironmentId: target.flagEnvironmentId,
          reviewer: principal,
          onApplied: (environmentId, flagKey) => deps.snapshots.notifyChange(environmentId, flagKey),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "NOT_FOUND") throw new HttpError(404, "NOT_FOUND", "no such change request");
        throw new HttpError(409, "CHANGE_REQUEST_REJECTED", message);
      }
    }),
  );

  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/requests/:requestId/reject",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, reviewSchema, 4 * 1024);
      try {
        await rejectChangeRequest(deps.db, {
          requestId: ctx.params["requestId"] ?? "",
          flagEnvironmentId: target.flagEnvironmentId,
          reviewer: principal,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
        });
      } catch {
        throw new HttpError(404, "NOT_FOUND", "no such pending change request");
      }
      return { status: "rejected" };
    }),
  );

  /* ── segments ─────────────────────────────────────────────────────── */

  router.get(
    "/v1/admin/projects/:project/environments/:env/segments",
    withPrincipal("reader", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      return { segments: await listSegments(deps.db, environment.id) };
    }),
  );

  router.post(
    "/v1/admin/projects/:project/environments/:env/segments",
    withPrincipal("writer", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      const input = await body(ctx, createSegmentSchema, BODY_LIMITS.adminWrite);
      const segment = await createSegment(deps.db, {
        projectId: environment.projectId,
        environmentId: environment.id,
        ...input,
      });
      deps.snapshots.notifyChange(environment.id);
      return { id: segment.id, key: input.key };
    }),
  );

  router.get(
    "/v1/admin/projects/:project/environments/:env/segments/:segment",
    withPrincipal("reader", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      const segment = await readSegment(deps.db, environment.id, ctx.params["segment"] ?? "");
      if (segment === null) throw new HttpError(404, "NOT_FOUND", "no such segment");
      return segment;
    }),
  );

  router.delete(
    "/v1/admin/projects/:project/environments/:env/segments/:segment",
    withPrincipal("writer", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      // Refused while a rule still names it: an unresolved segment fails its
      // rule closed, so deleting one silently changes who is targeted.
      await deleteSegment(deps.db, environment.id, ctx.params["segment"] ?? "");
      deps.snapshots.notifyChange(environment.id);
      return { deleted: true };
    }),
  );

  /**
   * One page of a segment import.
   *
   * Paged rather than whole-file, so a 10-million-member import is 200 bounded
   * transactions instead of one that holds a lock for minutes and cannot be
   * resumed if it fails (Scenario F). Each page recompiles once, which is
   * debounced away for pages arriving faster than the debounce window.
   */
  router.post(
    "/v1/admin/projects/:project/environments/:env/segments/:segment/members",
    withPrincipal("writer", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      const segment = await findSegment(deps.db, environment.id, ctx.params["segment"] ?? "");
      if (segment === null) throw new HttpError(404, "NOT_FOUND", "no such segment");

      const input = await body(ctx, segmentMembersSchema, BODY_LIMITS.segmentImport);
      const result = await applySegmentMembers(deps.db, segment.id, {
        add: input.add,
        remove: input.remove,
      });
      deps.snapshots.notifyChange(environment.id);
      return { version: result.version, memberCount: result.memberCount };
    }),
  );

  return router;
}

/** What a member looks like over the wire: never the hash, never the sessions. */
function publicMember(member: {
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
async function withPasswordErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PasswordError) {
      throw new HttpError(400, "PASSWORD_REJECTED", error.message);
    }
    throw error;
  }
}
