/** Scheduled changes and change requests. */

import { HttpError, type Router } from "../../http/router.js";
import { changeRequestSchema, reviewSchema, scheduleChangeSchema } from "../../contracts/admin.js";
import {
  approveChangeRequest,
  listChangeRequests,
  rejectChangeRequest,
} from "../../scheduler/scheduled-changes.js";
import { changeRequests, scheduledChanges } from "../../db/schema.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { BODY_LIMITS } from "../../contracts/wire.js";
import { type AdminContext, type AdminRouteDeps, body, requireFlagTarget } from "./shared.js";

export function registerChangesRoutes(router: Router, deps: AdminRouteDeps, admin: AdminContext): void {
  const { withPrincipal } = admin;

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
}
