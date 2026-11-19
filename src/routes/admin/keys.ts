/** SDK keys. */

import type { Router } from "../../http/router.js";
import { createSdkKey, listSdkKeys, revokeSdkKey } from "../../repositories/sdk-keys.js";
import { createSdkKeySchema } from "../../contracts/admin.js";
import { type AdminContext, type AdminRouteDeps, body, requireEnvironment } from "./shared.js";

export function registerKeysRoutes(router: Router, deps: AdminRouteDeps, admin: AdminContext): void {
  const { withPrincipal } = admin;

  router.get(
    "/v1/admin/projects/:project/environments/:env/keys",
    withPrincipal("admin", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      return { keys: await listSdkKeys(deps.db, environment.id) };
    }),
  );

  router.post(
    "/v1/admin/projects/:project/environments/:env/keys",
    withPrincipal("admin", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      const input = await body(ctx, createSdkKeySchema, 4 * 1024);
      const created = await createSdkKey(deps.db, {
        environmentId: environment.id,
        kind: input.kind,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: new Date(input.expiresAt) } : {}),
      });
      // The plaintext is in this response and nowhere else, ever again.
      return { id: created.id, kind: created.kind, key: created.key };
    }),
  );

  router.delete(
    "/v1/admin/projects/:project/environments/:env/keys/:keyId",
    withPrincipal("admin", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      await revokeSdkKey(deps.db, environment.id, ctx.params["keyId"] ?? "");
      // Revocation is only as fast as the lookup cache lets it be, so the cache
      // is dropped here rather than waited out.
      deps.onKeyRevoked?.();
      return { revoked: true };
    }),
  );
}
