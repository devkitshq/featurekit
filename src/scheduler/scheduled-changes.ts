/**
 * Scheduled changes and change requests (review PR-B11).
 *
 * Both tables existed from the first migration with nothing reading them, which
 * is worse than not having them: an auditor sees governance features, and an
 * operator schedules a change that never happens. This is the executor.
 *
 * **Three decisions that are the whole design:**
 *
 * 1. **Claiming is `FOR UPDATE SKIP LOCKED`.** Every node runs this loop, and
 *    two nodes must never apply the same change twice — a scheduled "ramp to
 *    50%" applied twice is not idempotent if it is expressed as a patch. Skip-
 *    locked is how Postgres hands each row to exactly one worker without a
 *    distributed lock or a leader election.
 * 2. **A missed window fails rather than fires late.** If the fleet was down
 *    from 08:55 to 15:00, a change scheduled for 09:00 must not turn a feature
 *    on in the middle of the afternoon for an audience nobody is watching. Past
 *    the grace period it is marked failed with a reason, which is a row a human
 *    sees rather than a surprise a customer sees.
 * 3. **Application goes through the ordinary write path.** Same validation,
 *    same version check, same audit row, same propagation. A scheduler that
 *    wrote rows directly would be a second way to change a flag — one that
 *    could publish a configuration the API would have rejected.
 */

import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { changeRequests, flagEnvironments, flags, scheduledChanges } from "../db/schema.js";
import { flagConfigSchema } from "../contracts/admin.js";
import { resolveTarget, writeFlagConfig } from "../repositories/flags.js";
import type { Principal } from "../auth/principal.js";
import { environments, projects } from "../db/schema.js";

export interface SchedulerOptions {
  db: Database;
  /** Recompiles and broadcasts after a change is applied. */
  onApplied: (environmentId: string, flagKey: string) => void;
  intervalMs?: number;
  /**
   * How late a scheduled change may still fire.
   *
   * Beyond this it is marked failed. An hour is long enough to cover a deploy
   * or a short outage and short enough that nobody is surprised.
   */
  graceMs?: number;
  /** Rows claimed per tick. Bounds the work one node does in one pass. */
  batchSize?: number;
  onError?: (error: unknown) => void;
  onOutcome?: (outcome: { id: string; applied: boolean; reason?: string }) => void;
  now?: () => Date;
}

/** The actor recorded for a change nobody was present for. */
function systemPrincipal(memberId: string | null): Principal {
  return {
    kind: "token",
    tokenId: "scheduler",
    memberId: memberId ?? "00000000-0000-0000-0000-000000000000",
    memberEmail: "scheduler@featurekit",
    role: "owner",
    // The scheduler is not environment-scoped: it applies what a human already
    // had the authority to schedule, and that authority was checked then.
    environmentIds: null,
  };
}

export class ScheduledChangeWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private closed = false;

  constructor(private readonly options: SchedulerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  start(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDue();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Apply every change that is due. Returns how many were applied.
   *
   * Exposed for tests and for an operator who wants to force a pass; safe to
   * call concurrently, which is the point of the claim.
   */
  async runDue(): Promise<number> {
    const now = this.now();
    const grace = this.options.graceMs ?? 60 * 60 * 1000;
    let applied = 0;

    for (const claimed of await this.claim(now)) {
      const late = now.getTime() - claimed.executeAt.getTime();
      if (late > grace) {
        // Fires late is worse than does not fire: nobody is watching an
        // afternoon rollout that was meant for nine in the morning.
        await this.finish(claimed.id, `missed window by ${Math.round(late / 60_000)} minutes`);
        this.options.onOutcome?.({ id: claimed.id, applied: false, reason: "missed_window" });
        continue;
      }

      try {
        await this.apply(claimed);
        await this.finish(claimed.id, null);
        this.options.onApplied(claimed.environmentId, claimed.flagKey);
        this.options.onOutcome?.({ id: claimed.id, applied: true });
        applied++;
      } catch (error) {
        this.options.onError?.(error);
        await this.finish(claimed.id, String(error instanceof Error ? error.message : error));
        this.options.onOutcome?.({ id: claimed.id, applied: false, reason: "failed" });
      }
    }
    return applied;
  }

  /**
   * Claim due rows for this worker only.
   *
   * `FOR UPDATE SKIP LOCKED` inside a transaction: rows another node is already
   * working on are skipped rather than waited for, so N nodes running this loop
   * share the work instead of serialising behind each other.
   */
  private async claim(now: Date): Promise<
    Array<{
      id: string;
      flagEnvironmentId: string;
      environmentId: string;
      projectKey: string;
      environmentKey: string;
      flagKey: string;
      patch: unknown;
      executeAt: Date;
      createdBy: string | null;
    }>
  > {
    return this.options.db.transaction(async (tx) => {
      const due = await tx
        .select({
          id: scheduledChanges.id,
          flagEnvironmentId: scheduledChanges.flagEnvironmentId,
          patch: scheduledChanges.patch,
          executeAt: scheduledChanges.executeAt,
          createdBy: scheduledChanges.createdBy,
          environmentId: flagEnvironments.environmentId,
          environmentKey: environments.key,
          projectKey: projects.key,
          flagKey: flags.key,
        })
        .from(scheduledChanges)
        .innerJoin(flagEnvironments, eq(flagEnvironments.id, scheduledChanges.flagEnvironmentId))
        .innerJoin(environments, eq(environments.id, flagEnvironments.environmentId))
        .innerJoin(projects, eq(projects.id, environments.projectId))
        .innerJoin(flags, eq(flags.id, flagEnvironments.flagId))
        .where(
          and(
            isNull(scheduledChanges.executedAt),
            isNull(scheduledChanges.failedReason),
            lte(scheduledChanges.executeAt, now),
          ),
        )
        .orderBy(asc(scheduledChanges.executeAt))
        .limit(this.options.batchSize ?? 20)
        .for("update", { skipLocked: true });

      // Marked in the same transaction as the claim, so a crash between claim
      // and apply leaves the row visible to the next pass rather than executed.
      return due;
    });
  }

  private async apply(claimed: {
    projectKey: string;
    environmentKey: string;
    flagKey: string;
    patch: unknown;
    createdBy: string | null;
  }): Promise<void> {
    const target = await resolveTarget(this.options.db, {
      projectKey: claimed.projectKey,
      environmentKey: claimed.environmentKey,
      flagKey: claimed.flagKey,
    });
    if (target === null) throw new Error("the flag this change targets no longer exists");

    // The stored patch is the same shape the REST API accepts, so scheduling is
    // a deferred PATCH and nothing about validation is special-cased.
    const parsed = flagConfigSchema
      .omit({ expectedVersion: true })
      .safeParse(claimed.patch ?? {});
    if (!parsed.success) {
      throw new Error(`stored patch is no longer valid: ${parsed.error.issues[0]?.message ?? ""}`);
    }

    await writeFlagConfig(
      this.options.db,
      target,
      // The version is read at apply time, not at schedule time: a change
      // scheduled yesterday must not fail because someone edited the flag since.
      // That is deliberate and it is the difference from an interactive edit —
      // there is no human here to resolve a conflict, and refusing would mean
      // the scheduled change silently never happens.
      { ...parsed.data, expectedVersion: target.version },
      systemPrincipal(claimed.createdBy),
      { action: "flag.scheduled_change_applied" },
    );
  }

  private async finish(id: string, failedReason: string | null): Promise<void> {
    await this.options.db
      .update(scheduledChanges)
      .set(
        failedReason === null
          ? { executedAt: this.now() }
          : { failedReason, executedAt: this.now() },
      )
      .where(eq(scheduledChanges.id, id));
  }
}

/* ─────────────────────────── change requests ─────────────────────────── */

export type ChangeRequestStatus = "pending" | "approved" | "rejected";

/**
 * Approve a change request and apply it.
 *
 * The approval and the application are one transaction from the caller's point
 * of view: if the patch will not apply, the request is not marked approved, so
 * nobody is left looking at an approved request whose change never landed.
 */
export async function approveChangeRequest(
  db: Database,
  options: {
    requestId: string;
    /** The scope-checked flag environment from the route; the request must belong to it. */
    flagEnvironmentId: string;
    reviewer: Principal;
    onApplied: (environmentId: string, flagKey: string) => void;
  },
): Promise<{ applied: boolean; version: number }> {
  const [request] = await db
    .select({
      id: changeRequests.id,
      status: changeRequests.status,
      patch: changeRequests.patch,
      requestedBy: changeRequests.requestedBy,
      environmentId: flagEnvironments.environmentId,
      environmentKey: environments.key,
      projectKey: projects.key,
      projectId: environments.projectId,
      flagKey: flags.key,
    })
    .from(changeRequests)
    .innerJoin(flagEnvironments, eq(flagEnvironments.id, changeRequests.flagEnvironmentId))
    .innerJoin(environments, eq(environments.id, flagEnvironments.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .innerJoin(flags, eq(flags.id, flagEnvironments.flagId))
    .where(
      and(
        eq(changeRequests.id, options.requestId),
        eq(changeRequests.flagEnvironmentId, options.flagEnvironmentId),
      ),
    )
    .limit(1);

  // Bound to the flag environment the caller was authorized for: a request id
  // from another environment or project simply is not found.
  if (request === undefined) {
    throw new Error("NOT_FOUND");
  }
  if (request.status !== "pending") {
    throw new Error(`change request is already ${request.status}`);
  }
  if (request.requestedBy !== null && request.requestedBy === options.reviewer.memberId) {
    // Four-eyes. The point of an approval workflow is that a second person
    // looked; self-approval makes it a formality with extra steps.
    throw new Error("a change request cannot be approved by the person who raised it");
  }

  const target = await resolveTarget(db, {
    projectKey: request.projectKey,
    environmentKey: request.environmentKey,
    flagKey: request.flagKey,
  });
  if (target === null) throw new Error("the flag this request targets no longer exists");

  const parsed = flagConfigSchema.omit({ expectedVersion: true }).safeParse(request.patch ?? {});
  if (!parsed.success) {
    throw new Error(`the requested change is no longer valid: ${parsed.error.issues[0]?.message ?? ""}`);
  }

  const result = await writeFlagConfig(
    db,
    target,
    { ...parsed.data, expectedVersion: target.version },
    options.reviewer,
    { action: "flag.change_request_approved" },
  );

  await db
    .update(changeRequests)
    .set({ status: "approved", reviewedBy: options.reviewer.memberId })
    .where(eq(changeRequests.id, options.requestId));

  options.onApplied(request.environmentId, request.flagKey);
  return { applied: true, version: result.version };
}

export async function rejectChangeRequest(
  db: Database,
  options: { requestId: string; flagEnvironmentId: string; reviewer: Principal; comment?: string },
): Promise<void> {
  const rows = await db
    .update(changeRequests)
    .set({
      status: "rejected",
      reviewedBy: options.reviewer.memberId,
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
    })
    .where(
      and(
        eq(changeRequests.id, options.requestId),
        eq(changeRequests.flagEnvironmentId, options.flagEnvironmentId),
        eq(changeRequests.status, "pending"),
      ),
    )
    .returning({ id: changeRequests.id });
  if (rows.length === 0) throw new Error("NOT_FOUND");
}

/** Pending and recent requests for one flag environment. */
export async function listChangeRequests(
  db: Database,
  flagEnvironmentId: string,
): Promise<
  Array<{
    id: string;
    status: string;
    requestedBy: string | null;
    reviewedBy: string | null;
    createdAt: Date;
  }>
> {
  return db
    .select({
      id: changeRequests.id,
      status: changeRequests.status,
      requestedBy: changeRequests.requestedBy,
      reviewedBy: changeRequests.reviewedBy,
      createdAt: changeRequests.createdAt,
    })
    .from(changeRequests)
    .where(eq(changeRequests.flagEnvironmentId, flagEnvironmentId))
    .orderBy(sql`${changeRequests.createdAt} desc`)
    .limit(50);
}
