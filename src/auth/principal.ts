/**
 * Who is making a management request, and what they may touch.
 *
 * **Authorization is checked at the data-access boundary, not at the route.**
 * The rule every IDOR in every product violates is the same one: the route
 * authenticated the caller, then trusted an id from the URL. So the shape here
 * is not `canEdit(user)` but `scopeFor(principal)` — a value the repository
 * layer requires as an argument and folds into the SQL `WHERE` clause. A query
 * that forgets it does not compile.
 *
 * The other half is the response code. A caller asking for another tenant's
 * flag gets **404, not 403**: 403 confirms the object exists, which turns any
 * list of ids into an existence oracle for other customers' flag keys.
 */

import { HttpError } from "../http/router.js";
import type { ResolvedToken } from "../repositories/access-tokens.js";
import type { SessionRow } from "../repositories/members.js";

export type Role = "owner" | "admin" | "writer" | "reader";

const RANK: Record<Role, number> = { reader: 0, writer: 1, admin: 2, owner: 3 };

export interface Principal {
  /**
   * How this caller proved who they are.
   *
   * The distinction exists for the audit log and for the CSRF rule — a
   * cookie-authenticated mutation needs a header a cross-site form cannot set —
   * and for nothing else. Authorization reads `role` and `environmentIds`,
   * which mean the same thing whichever way the caller arrived.
   */
  kind: "token" | "session";
  /** The access token id, or the session id. */
  tokenId: string;
  memberId: string;
  memberEmail: string;
  role: Role;
  /** `null` = every environment. Otherwise the exact set this token may touch. */
  environmentIds: string[] | null;
}

export function principalFromToken(token: ResolvedToken, now = new Date()): Principal | null {
  if (token.expiresAt !== null && token.expiresAt <= now) return null;
  if (RANK[token.role] === undefined) return null;
  return {
    kind: "token",
    tokenId: token.tokenId,
    memberId: token.memberId,
    memberEmail: token.memberEmail,
    role: token.role,
    environmentIds: token.environmentIds,
  };
}

/**
 * A dashboard session, as a principal.
 *
 * Deliberately the same shape a PAT produces: a session that resolved to its
 * own kind of principal would mean every authorization check had two cases, and
 * the second case is the one nobody updates.
 */
export function principalFromSession(session: SessionRow): Principal | null {
  if (RANK[session.role] === undefined) return null;
  return {
    kind: "session",
    tokenId: session.sessionId,
    memberId: session.memberId,
    memberEmail: session.memberEmail,
    role: session.role,
    // A session is a person, and people are not environment-scoped; their role
    // is. Scoping is a property of tokens, which are issued for a job.
    environmentIds: null,
  };
}

export function hasRole(principal: Principal, minimum: Role): boolean {
  return RANK[principal.role] >= RANK[minimum];
}

export function requireRole(principal: Principal, minimum: Role): void {
  if (!hasRole(principal, minimum)) {
    throw new HttpError(403, "INSUFFICIENT_ROLE", `requires ${minimum} or higher`);
  }
}

/**
 * The environment filter a repository must apply.
 *
 * `null` means unrestricted, which the repository still uses explicitly — the
 * calling convention is "you were given a scope and you used it", never "you
 * may skip the filter when it is empty".
 */
export function environmentScope(principal: Principal): string[] | null {
  return principal.environmentIds;
}

export function canAccessEnvironment(principal: Principal, environmentId: string): boolean {
  return principal.environmentIds === null || principal.environmentIds.includes(environmentId);
}

/**
 * Enforce environment scope.
 *
 * 404 rather than 403, so a token scoped to staging cannot enumerate which
 * production environments exist by watching status codes change.
 */
export function requireEnvironmentAccess(principal: Principal, environmentId: string): void {
  if (!canAccessEnvironment(principal, environmentId)) {
    throw new HttpError(404, "NOT_FOUND", "no such environment");
  }
}

/** What lands in `audit_log.actor_id` / `actor_kind`. */
export function actorOf(principal: Principal): { actorId: string; actorKind: string } {
  return { actorId: principal.memberId, actorKind: principal.kind };
}
