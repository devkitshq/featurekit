/**
 * Personal access tokens for the management API.
 *
 * PATs are hashed at rest exactly like server SDK keys and for the same reason:
 * they carry write access to production flag configuration, so a database leak
 * must not yield usable credentials.
 *
 * `environmentIds` is the scope, and `null` means "every environment". That
 * default is deliberate and deliberately visible — a CI token that can toggle
 * production is a normal thing to want and an abnormal thing to create by
 * accident, so the dashboard shows the scope and the audit log records which
 * token acted.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { accessTokens, members } from "../db/schema.js";
import { hashKey } from "../auth/keys.js";
import type { Role } from "../auth/principal.js";

export interface ResolvedToken {
  tokenId: string;
  memberId: string;
  memberEmail: string;
  role: Role;
  /** `null` = unscoped: every environment. */
  environmentIds: string[] | null;
  expiresAt: Date | null;
}

interface CacheEntry {
  value: ResolvedToken | null;
  expiresAt: number;
}

export class AccessTokenRepository {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Database,
    private readonly options: { ttlMs?: number; negativeTtlMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get revocationBoundMs(): number {
    return this.options.ttlMs ?? 15_000;
  }

  /**
   * Resolve a presented token.
   *
   * Shorter TTL than the SDK-key cache: a management token is used at human
   * frequency, so caching buys little, while "I revoked that engineer's token"
   * wants to be true quickly.
   */
  async resolve(presented: string): Promise<ResolvedToken | null> {
    if (presented.length === 0 || presented.length > 256) return null;
    const digest = hashKey(presented);
    const now = this.now();

    const cached = this.cache.get(digest);
    if (cached !== undefined && cached.expiresAt > now) return cached.value;

    const rows = await this.db
      .select({
        tokenId: accessTokens.id,
        memberId: accessTokens.memberId,
        environmentIds: accessTokens.environmentIds,
        expiresAt: accessTokens.expiresAt,
        memberEmail: members.email,
        role: members.role,
      })
      .from(accessTokens)
      .innerJoin(members, eq(members.id, accessTokens.memberId))
      .where(eq(accessTokens.tokenHash, digest))
      .limit(1);

    const row = rows[0];
    const value: ResolvedToken | null =
      row === undefined
        ? null
        : {
            tokenId: row.tokenId,
            memberId: row.memberId,
            memberEmail: row.memberEmail,
            role: row.role as Role,
            environmentIds: row.environmentIds ?? null,
            expiresAt: row.expiresAt,
          };

    if (this.cache.size > 5_000) this.cache.clear();
    this.cache.set(digest, {
      value,
      expiresAt: now + (value === null ? (this.options.negativeTtlMs ?? 5_000) : this.revocationBoundMs),
    });
    return value;
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  /** Best-effort usage timestamp; never blocks or fails a request. */
  touch(tokenId: string): void {
    void this.db
      .update(accessTokens)
      .set({ lastUsedAt: new Date(this.now()) })
      .where(eq(accessTokens.id, tokenId))
      .catch(() => undefined);
  }
}
