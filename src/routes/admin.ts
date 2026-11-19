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

import type { Router } from "../http/router.js";
import { adminContext, type AdminRouteDeps } from "./admin/shared.js";
import { registerAccessRoutes } from "./admin/access.js";
import { registerProjectsRoutes } from "./admin/projects.js";
import { registerFlagsRoutes } from "./admin/flags.js";
import { registerAuditRoutes } from "./admin/audit.js";
import { registerKeysRoutes } from "./admin/keys.js";
import { registerChangesRoutes } from "./admin/changes.js";
import { registerSegmentsRoutes } from "./admin/segments.js";

export type { AdminRouteDeps } from "./admin/shared.js";

export function registerAdminRoutes(router: Router, deps: AdminRouteDeps): Router {
  const admin = adminContext(deps);
  registerAccessRoutes(router, deps, admin);
  registerProjectsRoutes(router, deps, admin);
  registerFlagsRoutes(router, deps, admin);
  registerAuditRoutes(router, deps, admin);
  registerKeysRoutes(router, deps, admin);
  registerChangesRoutes(router, deps, admin);
  registerSegmentsRoutes(router, deps, admin);
  return router;
}
