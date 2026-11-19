/** Flags: definitions, per-environment configuration, the kill switch, revert,
 * metrics and dry runs. */

import { HttpError, type Router } from "../../http/router.js";
import type { EvaluationContext } from "../../sdk/evaluation/index.js";
import { dryRunFlag, reassignmentWarning } from "../../snapshot/dry-run.js";
import {
  listFlagsForDashboard,
  readFlagDefinition,
  readFlagMetrics,
  recentlyChangedFlags,
  restoreFlag,
  archiveFlag,
  createFlag,
  listFlags,
} from "../../repositories/flags.js";
import { findEnvironmentByKeys } from "../../repositories/environments.js";
import {
  applyFlagConfigToInput,
  killSwitch,
  readFlagConfig,
  writeFlagConfig,
} from "../../repositories/flag-config.js";
import { readAuditDiff } from "../../repositories/audit.js";
import { requireEnvironmentAccess } from "../../auth/principal.js";
import {
  createFlagSchema,
  dryRunSchema,
  flagConfigSchema,
  killSwitchSchema,
  revertSchema,
} from "../../contracts/admin.js";
import { BODY_LIMITS } from "../../contracts/wire.js";
import { type AdminContext, type AdminRouteDeps, body, requireEnvironment, requireFlagTarget, requireProject } from "./shared.js";

export function registerFlagsRoutes(router: Router, deps: AdminRouteDeps, admin: AdminContext): void {
  const { withPrincipal, rejectScoped, recompileProject } = admin;

  /**
   * Every flag in the project.
   *
   * With `?environment=`, each flag also carries its state there — on/off, the
   * served default, how many rules and targets. Without it, the plain list.
   *
   * The parameter is what makes the flags table one request instead of one per
   * row, which at two hundred flags is the difference between a page and an
   * outage of your own making.
   */
  router.get(
    "/v1/admin/projects/:project/flags",
    withPrincipal("reader", async (ctx, principal) => {
      const project = await requireProject(ctx, deps);
      const environmentKey = ctx.query.get("environment");
      const includeArchived = ctx.query.get("archived") === "true";

      if (environmentKey === null) {
        return { flags: await listFlags(deps.db, project.id) };
      }

      const environment = await findEnvironmentByKeys(deps.db, project.key, environmentKey);
      if (environment === null) throw new HttpError(404, "NOT_FOUND", "no such environment");
      requireEnvironmentAccess(principal, environment.id);

      return {
        environment: environment.key,
        flags: await listFlagsForDashboard(deps.db, project.id, environment.id, {
          includeArchived,
        }),
      };
    }),
  );

  /** The flag itself: metadata and variation **values**, which speak no indices. */
  router.get(
    "/v1/admin/projects/:project/flags/:flag",
    withPrincipal("reader", async (ctx) => {
      const project = await requireProject(ctx, deps);
      const definition = await readFlagDefinition(deps.db, project.id, ctx.params["flag"] ?? "");
      if (definition === null) throw new HttpError(404, "NOT_FOUND", "no such flag");
      return definition;
    }),
  );

  router.post(
    "/v1/admin/projects/:project/flags/:flag/restore",
    withPrincipal("writer", async (ctx, principal) => {
      rejectScoped(principal, "restore flags, which affects every environment");
      const project = await requireProject(ctx, deps);
      const flagKey = ctx.params["flag"] ?? "";
      await restoreFlag(deps.db, project.id, flagKey);
      await recompileProject(project.id, flagKey);
      return { archived: false };
    }),
  );

  router.post(
    "/v1/admin/projects/:project/flags",
    withPrincipal("writer", async (ctx, principal) => {
      rejectScoped(principal, "create flags, which affects every environment");
      const project = await requireProject(ctx, deps);
      const input = await body(ctx, createFlagSchema, BODY_LIMITS.adminWrite);
      const flag = await createFlag(deps.db, { projectId: project.id, ...input });
      return { id: flag.id, key: input.key };
    }),
  );

  router.delete(
    "/v1/admin/projects/:project/flags/:flag",
    withPrincipal("writer", async (ctx, principal) => {
      rejectScoped(principal, "archive flags, which affects every environment");
      const project = await requireProject(ctx, deps);
      const flagKey = ctx.params["flag"] ?? "";
      await archiveFlag(deps.db, project.id, flagKey);
      // Archiving removes the flag from every environment's next snapshot, so
      // every environment has to recompile — not just one. Without this an
      // archived flag (and anything it gated) kept serving until an unrelated
      // change happened to recompile.
      await recompileProject(project.id, flagKey);
      return { archived: true };
    }),
  );

  router.get(
    "/v1/admin/projects/:project/environments/:env/flags/:flag",
    withPrincipal("reader", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      return readFlagConfig(deps.db, target);
    }),
  );

  /**
   * The general configuration write.
   *
   * Version-checked, transactional, audited, and only then propagated. The
   * propagation is debounced: a dashboard session is several PATCHes for one
   * logical change, and broadcasting each of them makes every connected SDK
   * apply five snapshots for one edit.
   */
  router.patch(
    "/v1/admin/projects/:project/environments/:env/flags/:flag",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, flagConfigSchema, BODY_LIMITS.adminWrite);
      const result = await writeFlagConfig(deps.db, target, input, principal);
      deps.snapshots.notifyChange(target.environmentId, target.flagKey);
      return { version: result.version, auditId: result.auditId, config: result.after };
    }),
  );

  /**
   * The kill switch.
   *
   * No expected version, and propagation is immediate rather than debounced:
   * "off" cannot lose anyone else's edit, and an operator reducing blast radius
   * during an incident must not wait behind a coalescing timer.
   */
  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/off",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, killSwitchSchema, 4 * 1024);
      const result = await killSwitch(
        deps.db,
        target,
        principal,
        ...(input.comment !== undefined ? ([input.comment] as const) : ([] as const)),
      );
      await deps.snapshots.notifyChangeImmediate(target.environmentId, target.flagKey);
      return { version: result.version, auditId: result.auditId, alreadyOff: result.alreadyOff };
    }),
  );

  /**
   * Revert to the state recorded in an audit row.
   *
   * A replay through the ordinary write path, not a direct row rewrite: the
   * revert is validated, version-checked and audited exactly like the change it
   * undoes. A revert that bypassed validation could restore a configuration
   * that no longer compiles — a rule naming a segment deleted since.
   */
  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/revert",
    withPrincipal("writer", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, revertSchema, 4 * 1024);
      const historical = await readAuditDiff(deps.db, target.projectId, target.environmentId, input.auditId);
      if (historical === null) throw new HttpError(404, "NOT_FOUND", "no such audit entry");
      if (historical.entityKey !== target.flagKey) {
        throw new HttpError(400, "AUDIT_MISMATCH", "that audit entry is for a different flag");
      }

      const before = historical.before;
      const result = await writeFlagConfig(
        deps.db,
        target,
        {
          expectedVersion: target.version,
          enabled: before.enabled,
          offVariation: before.offVariation,
          ...(before.fallthroughVariation !== undefined
            ? { fallthroughVariation: before.fallthroughVariation }
            : {}),
          ...(before.fallthroughRollout !== undefined
            ? {
                fallthroughRollout: {
                  ...(before.fallthroughRollout.contextKind !== undefined
                    ? { contextKind: before.fallthroughRollout.contextKind }
                    : {}),
                  ...(before.fallthroughRollout.bucketBy !== undefined
                    ? { bucketBy: before.fallthroughRollout.bucketBy }
                    : {}),
                  ...(before.fallthroughRollout.seed !== undefined
                    ? { seed: before.fallthroughRollout.seed }
                    : {}),
                  variations: before.fallthroughRollout.variations.map((v) => ({
                    variation: v.variationIndex,
                    weight: v.weight,
                  })),
                },
              }
            : {}),
          rules: before.rules.map((rule) => ({
            ...(rule.description !== undefined ? { description: rule.description } : {}),
            clauses: rule.clauses,
            ...(rule.variation !== undefined ? { variation: rule.variation } : {}),
            ...(rule.rollout !== undefined
              ? {
                  rollout: {
                    ...(rule.rollout.contextKind !== undefined
                      ? { contextKind: rule.rollout.contextKind }
                      : {}),
                    ...(rule.rollout.bucketBy !== undefined
                      ? { bucketBy: rule.rollout.bucketBy }
                      : {}),
                    ...(rule.rollout.seed !== undefined ? { seed: rule.rollout.seed } : {}),
                    variations: rule.rollout.variations.map((v) => ({
                      variation: v.variationIndex,
                      weight: v.weight,
                    })),
                  },
                }
              : {}),
          })),
          targets: before.targets,
          prerequisites: before.prerequisites,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
        },
        principal,
        { action: "flag.reverted" },
      );
      deps.snapshots.notifyChange(target.environmentId, target.flagKey);
      return { version: result.version, auditId: result.auditId, config: result.after };
    }),
  );

  /**
   * What the fleet evaluated, by variation, over the last day.
   *
   * The question behind it is "can this temporary flag be deleted yet" — which
   * has no answer without evidence that nothing is still reading it.
   */
  router.get(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/metrics",
    withPrincipal("reader", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const hours = Number(ctx.query.get("hours") ?? "24");
      return {
        flagKey: target.flagKey,
        points: await readFlagMetrics(deps.db, target.environmentId, target.flagKey, {
          sinceHours: Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24 * 30) : 24,
        }),
      };
    }),
  );

  /** The home page: what changed here most recently. */
  router.get(
    "/v1/admin/projects/:project/environments/:env/recent",
    withPrincipal("reader", async (ctx, principal) => {
      const environment = await requireEnvironment(ctx, deps, principal);
      return { flags: await recentlyChangedFlags(deps.db, environment.id) };
    }),
  );

  /**
   * Preview a change without applying it.
   *
   * Compiles the proposed configuration, evaluates the caller's contexts
   * against both snapshots, and reports who moves — including the churn figure
   * that distinguishes "5% more users" from "the same 5%, different users",
   * which is the failure no chart makes visible after the fact.
   *
   * Nothing is written. Deliberately a POST anyway: the body carries thousands
   * of contexts, and those do not belong in a URL or an access log.
   */
  router.post(
    "/v1/admin/projects/:project/environments/:env/flags/:flag/dry-run",
    withPrincipal("reader", async (ctx, principal) => {
      const target = await requireFlagTarget(ctx, deps, principal);
      const input = await body(ctx, dryRunSchema, BODY_LIMITS.adminWrite);

      const current = await deps.snapshots.get(target.environmentId);
      const proposed = await deps.snapshots.preview(
        target.environmentId,
        (compilerInput) => applyFlagConfigToInput(deps.db, compilerInput, target, input.patch),
        target.version + 1,
      );

      const result = dryRunFlag(
        target.flagKey,
        current.snapshot,
        proposed,
        input.contexts as EvaluationContext[],
        input.maxExamples !== undefined ? { maxExamples: input.maxExamples } : {},
      );
      const warning = reassignmentWarning(result);
      return warning === null ? result : { ...result, warning };
    }),
  );
}
