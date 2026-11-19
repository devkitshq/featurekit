/** The audit log and its chain verification. */

import type { Router } from "../../http/router.js";
import { listAudit, verifyAuditChain } from "../../repositories/audit.js";
import { type AdminContext, type AdminRouteDeps, requireProject } from "./shared.js";

export function registerAuditRoutes(router: Router, deps: AdminRouteDeps, admin: AdminContext): void {
  const { withPrincipal } = admin;

  router.get(
    "/v1/admin/projects/:project/audit",
    withPrincipal("reader", async (ctx, principal) => {
      const project = await requireProject(ctx, deps);
      const limit = Number(ctx.query.get("limit") ?? "50");
      const entityKey = ctx.query.get("flag") ?? undefined;
      return {
        entries: await listAudit(deps.db, project.id, {
          limit: Number.isFinite(limit) ? limit : 50,
          environmentIds: principal.environmentIds,
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
}
