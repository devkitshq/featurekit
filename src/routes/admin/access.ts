/** Sign-in, the signed-in member, members and access tokens. */

import { HttpError, type Router } from "../../http/router.js";
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
  revokeToken,
  updateMember,
} from "../../repositories/members.js";
import { requireRole } from "../../auth/principal.js";
import { clearCookie } from "../../http/cookies.js";
import {
  changePasswordSchema,
  createAccessTokenSchema,
  createMemberSchema,
  loginSchema,
  updateMemberSchema,
} from "../../contracts/admin.js";
import { type AdminContext, type AdminRouteDeps, SESSION_COOKIE, body, publicMember, sessionCookie, withPasswordErrors } from "./shared.js";

export function registerAccessRoutes(router: Router, deps: AdminRouteDeps, admin: AdminContext): void {
  const { withPrincipal, sessionCookieFor, rejectScoped } = admin;

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
      // Every session ends, including this one, and every access token is
      // revoked: a password change is what you do when you think somebody else
      // has the old one. The token cache is dropped so revocation is immediate.
      deps.tokens.invalidateAll();
      return {
        status: 200,
        headers: {
          "set-cookie": clearCookie(SESSION_COOKIE, { secure: deps.secureCookies === true }),
        },
        body: { ok: true },
      };
    }),
  );

  router.get(
    "/v1/admin/members",
    withPrincipal("admin", async () => ({
      members: (await listMembers(deps.db)).map(publicMember),
    })),
  );

  router.post(
    "/v1/admin/members",
    withPrincipal("owner", async (ctx, principal) => {
      rejectScoped(principal, "manage members");
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
        rejectScoped(principal, "manage members");
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
      // The token cache holds the member's role, and a password reset revoked
      // their tokens; either must take effect now, not when the cache expires.
      if (input.role !== undefined || input.password !== undefined) deps.tokens.invalidateAll();
      return publicMember(updated);
    }),
  );

  router.delete(
    "/v1/admin/members/:memberId",
    withPrincipal("owner", async (ctx, principal) => {
      rejectScoped(principal, "manage members");
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
      // Lifetime is attenuated the same way: a token minted by a token cannot
      // outlive it, or a short-lived CI token could mint itself a permanent one.
      let expiresAt = input.expiresAt !== undefined ? new Date(input.expiresAt) : undefined;
      const parentExpiry = principal.kind === "token" ? (principal.tokenExpiresAt ?? null) : null;
      if (parentExpiry !== null && (expiresAt === undefined || expiresAt > parentExpiry)) {
        expiresAt = parentExpiry;
      }
      const created = await createToken(deps.db, {
        memberId: principal.memberId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(scope !== undefined ? { environmentIds: scope } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
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
}
