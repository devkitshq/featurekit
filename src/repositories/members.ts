/**
 * Members, dashboard sessions and personal access tokens.
 *
 * Two ways to authenticate, one `Principal`. A session and a PAT resolve to the
 * same shape, so every `requireRole` and `requireEnvironmentAccess` already
 * written applies to both and `audit_log.actor_id` names a real member either
 * way — which is the entire reason the dashboard does not get its own
 * authorization path.
 */

import { and, asc, eq, lt, ne, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/client.js";
import { accessTokens, dashboardSessions, members } from "../db/schema.js";
import { hashKey } from "../auth/keys.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import type { Role } from "../auth/principal.js";

export interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  hasPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface SessionRow {
  sessionId: string;
  memberId: string;
  memberEmail: string;
  memberName: string | null;
  role: Role;
  expiresAt: Date;
  lastSeenAt: Date;
}

/** Sessions last half a day and slide on use. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** How stale `last_seen_at` may get before a read writes. One write per click is silly. */
const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;

/* ────────────────────────────── members ─────────────────────────────── */

const toMember = (row: {
  id: string;
  email: string;
  name: string | null;
  role: string;
  passwordHash: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}): MemberRow => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role as Role,
  hasPassword: row.passwordHash !== null,
  lastLoginAt: row.lastLoginAt,
  createdAt: row.createdAt,
});

const memberColumns = {
  id: members.id,
  email: members.email,
  name: members.name,
  role: members.role,
  passwordHash: members.passwordHash,
  lastLoginAt: members.lastLoginAt,
  createdAt: members.createdAt,
};

export async function listMembers(db: Database): Promise<MemberRow[]> {
  const rows = await db.select(memberColumns).from(members).orderBy(asc(members.email));
  return rows.map(toMember);
}

export async function findMemberByEmail(db: Database, email: string): Promise<MemberRow | null> {
  const [row] = await db
    .select(memberColumns)
    .from(members)
    .where(eq(members.email, normaliseEmail(email)))
    .limit(1);
  return row === undefined ? null : toMember(row);
}

export async function createMember(
  db: Database,
  input: { email: string; name?: string | null; role: Role; password?: string | undefined },
): Promise<MemberRow> {
  const passwordHash = input.password === undefined ? null : await hashPassword(input.password);
  const [row] = await db
    .insert(members)
    .values({
      email: normaliseEmail(input.email),
      name: input.name ?? null,
      role: input.role,
      passwordHash,
    })
    .returning(memberColumns);
  if (row === undefined) throw new Error("featurekit: member insert returned nothing");
  return toMember(row);
}

export async function updateMember(
  db: Database,
  memberId: string,
  patch: { name?: string | null; role?: Role; password?: string },
): Promise<MemberRow | null> {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values["name"] = patch.name;
  if (patch.role !== undefined) values["role"] = patch.role;
  if (patch.password !== undefined) values["passwordHash"] = await hashPassword(patch.password);
  if (Object.keys(values).length === 0) return findMemberById(db, memberId);

  const [row] = await db
    .update(members)
    .set(values)
    .where(eq(members.id, memberId))
    .returning(memberColumns);
  if (row === undefined) return null;

  // A password change ends every other session for that member. The ordinary
  // reason to change one is that you think somebody else has it.
  if (patch.password !== undefined) await deleteSessionsFor(db, memberId);
  return toMember(row);
}

export async function findMemberById(db: Database, memberId: string): Promise<MemberRow | null> {
  const [row] = await db.select(memberColumns).from(members).where(eq(members.id, memberId)).limit(1);
  return row === undefined ? null : toMember(row);
}

export async function deleteMember(db: Database, memberId: string): Promise<boolean> {
  const removed = await db.delete(members).where(eq(members.id, memberId)).returning({ id: members.id });
  return removed.length > 0;
}

/** How many owners remain — the check that stops a deployment locking itself out. */
export async function ownerCount(db: Database, excludingMemberId?: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(members)
    .where(
      excludingMemberId === undefined
        ? eq(members.role, "owner")
        : and(eq(members.role, "owner"), ne(members.id, excludingMemberId)),
    );
  return rows[0]?.count ?? 0;
}

export async function memberCount(db: Database): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(members);
  return rows[0]?.count ?? 0;
}

/* ────────────────────────────── sessions ────────────────────────────── */

export interface LoginResult {
  token: string;
  expiresAt: Date;
  member: MemberRow;
}

/**
 * Verify an email and password, and open a session.
 *
 * Returns null for every failure — unknown email, no password set, wrong
 * password — and takes a similar path through scrypt in each case, because a
 * login form that answers faster for an unknown address is an account
 * enumeration oracle.
 */
export async function login(
  db: Database,
  input: { email: string; password: string; userAgent?: string | undefined },
): Promise<LoginResult | null> {
  const [row] = await db
    .select({ ...memberColumns })
    .from(members)
    .where(eq(members.email, normaliseEmail(input.email)))
    .limit(1);

  // Hash against a decoy so an unknown address costs what a known one costs.
  const stored = row?.passwordHash ?? DECOY_HASH;
  const ok = await verifyPassword(input.password, stored);
  if (!ok || row === undefined || row.passwordHash === null) return null;

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(dashboardSessions).values({
    memberId: row.id,
    tokenHash: hashKey(token),
    userAgent: input.userAgent ?? null,
    expiresAt,
  });
  await db.update(members).set({ lastLoginAt: new Date() }).where(eq(members.id, row.id));

  return { token, expiresAt, member: toMember(row) };
}

export async function resolveSession(db: Database, token: string): Promise<SessionRow | null> {
  if (token.length === 0 || token.length > 256) return null;
  const [row] = await db
    .select({
      sessionId: dashboardSessions.id,
      memberId: dashboardSessions.memberId,
      expiresAt: dashboardSessions.expiresAt,
      lastSeenAt: dashboardSessions.lastSeenAt,
      memberEmail: members.email,
      memberName: members.name,
      role: members.role,
    })
    .from(dashboardSessions)
    .innerJoin(members, eq(members.id, dashboardSessions.memberId))
    .where(eq(dashboardSessions.tokenHash, hashKey(token)))
    .limit(1);

  if (row === undefined) return null;
  if (row.expiresAt <= new Date()) {
    // Expired sessions are deleted on sight rather than swept later: the row is
    // in hand, and a sweep is one more thing to forget to schedule.
    await db.delete(dashboardSessions).where(eq(dashboardSessions.id, row.sessionId));
    return null;
  }
  return { ...row, role: row.role as Role };
}

/** Slide the expiry, at most once per `SESSION_TOUCH_INTERVAL_MS`. */
export function touchSession(db: Database, session: SessionRow): void {
  if (Date.now() - session.lastSeenAt.getTime() < SESSION_TOUCH_INTERVAL_MS) return;
  const now = new Date();
  void db
    .update(dashboardSessions)
    .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .where(eq(dashboardSessions.id, session.sessionId))
    .catch(() => undefined);
}

export async function deleteSession(db: Database, token: string): Promise<void> {
  await db.delete(dashboardSessions).where(eq(dashboardSessions.tokenHash, hashKey(token)));
}

export async function deleteSessionsFor(db: Database, memberId: string): Promise<void> {
  await db.delete(dashboardSessions).where(eq(dashboardSessions.memberId, memberId));
}

/** Housekeeping, safe to call whenever. */
export async function purgeExpiredSessions(db: Database): Promise<number> {
  const removed = await db
    .delete(dashboardSessions)
    .where(lt(dashboardSessions.expiresAt, new Date()))
    .returning({ id: dashboardSessions.id });
  return removed.length;
}

/* ─────────────────────── personal access tokens ─────────────────────── */

export interface TokenRow {
  id: string;
  name: string | null;
  environmentIds: string[] | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

export async function listTokens(db: Database, memberId: string): Promise<TokenRow[]> {
  return db
    .select({
      id: accessTokens.id,
      name: accessTokens.name,
      environmentIds: accessTokens.environmentIds,
      lastUsedAt: accessTokens.lastUsedAt,
      expiresAt: accessTokens.expiresAt,
    })
    .from(accessTokens)
    .where(eq(accessTokens.memberId, memberId));
}

export async function createToken(
  db: Database,
  input: {
    memberId: string;
    name?: string | undefined;
    environmentIds?: string[] | undefined;
    expiresAt?: Date | undefined;
  },
): Promise<{ id: string; token: string }> {
  const token = `fk_pat_${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(accessTokens)
    .values({
      memberId: input.memberId,
      tokenHash: hashKey(token),
      name: input.name ?? null,
      environmentIds: input.environmentIds ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({ id: accessTokens.id });
  if (row === undefined) throw new Error("featurekit: token insert returned nothing");
  return { id: row.id, token };
}

/** Scoped to the owning member: an id from someone else's list matches nothing. */
export async function revokeToken(db: Database, memberId: string, tokenId: string): Promise<boolean> {
  const removed = await db
    .delete(accessTokens)
    .where(and(eq(accessTokens.id, tokenId), eq(accessTokens.memberId, memberId)))
    .returning({ id: accessTokens.id });
  return removed.length > 0;
}

/* ─────────────────────────────── helpers ────────────────────────────── */

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A well-formed hash of a value nobody knows, used when the email is unknown.
 *
 * Computed once at module load; the point is only that `verifyPassword` does
 * the same scrypt work it would have done for a real account.
 */
const DECOY_HASH = `scrypt$16384$8$1$${randomBytes(16).toString("base64url")}$${createHash("sha256")
  .update(randomBytes(32))
  .digest()
  .toString("base64url")}`;
