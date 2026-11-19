/** Projects and environments. */

import { HttpError, type Router } from "../../http/router.js";
import { listProjectEnvironments, createEnvironment } from "../../repositories/environments.js";
import { createProject, deleteProject, listProjects } from "../../repositories/projects.js";
import { createEnvironmentSchema, createProjectSchema } from "../../contracts/admin.js";
import { BODY_LIMITS } from "../../contracts/wire.js";
import { type AdminContext, type AdminRouteDeps, body, requireProject } from "./shared.js";

export function registerProjectsRoutes(router: Router, deps: AdminRouteDeps, admin: AdminContext): void {
  const { withPrincipal, rejectScoped } = admin;

  router.get(
    "/v1/admin/projects",
    withPrincipal("reader", async (_ctx, principal) => ({
      projects: await listProjects(deps.db, principal),
    })),
  );

  router.post(
    "/v1/admin/projects",
    withPrincipal("admin", async (ctx, principal) => {
      rejectScoped(principal, "create projects");
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
      await deleteProject(deps.db, project.key);
      // Its SDK keys went with it (ON DELETE CASCADE). Both caches are dropped
      // after the delete, so a request in between cannot re-cache a key that
      // is about to stop existing.
      deps.tokens.invalidateAll();
      deps.onKeyRevoked?.();
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
}
