/** Segments and their members. */

import { HttpError, type Router } from "../../http/router.js";
import {
  deleteSegment,
  readSegment,
  applySegmentMembers,
  createSegment,
  findSegment,
  listSegments,
} from "../../repositories/segments.js";
import { createSegmentSchema, segmentMembersSchema } from "../../contracts/admin.js";
import { BODY_LIMITS } from "../../contracts/wire.js";
import { type AdminContext, type AdminRouteDeps, body, requireEnvironment } from "./shared.js";

export function registerSegmentsRoutes(router: Router, deps: AdminRouteDeps, admin: AdminContext): void {
  const { withPrincipal } = admin;

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
}
