/**
 * Flags as code, applied on start (§11.3).
 *
 * A file in your repository describes the project, the environment and the
 * flags; this reconciles the database against it. It is what makes a fresh
 * checkout and a fresh database produce the same system, and it is why an
 * example server is four lines rather than two hundred.
 *
 * **Definitions are code; operational state is not.** A flag's key, kind and
 * variations belong in a repository and are reviewed in a pull request. Whether
 * it is on, and who it targets, belongs to whoever is carrying the pager — so
 * an existing flag's configuration is left alone unless `reset` says otherwise.
 * Re-applying it on every boot would undo an incident response the moment
 * somebody redeployed, which is precisely when nobody is watching.
 *
 * Everything here goes through the same repository functions the management API
 * uses, so a flag created this way is created by the same code, validated by
 * the same schema, and written to the audit log like any other change — under
 * an actor that says it came from a file.
 */

import { z } from "zod";
import type { Database } from "./db/client.js";
import type { Principal } from "./auth/principal.js";
import { createFlagSchema, flagConfigSchema, type FlagConfigBody } from "./contracts/admin.js";
import {
  createEnvironment,
  createFlag,
  createProject,
  findEnvironmentByKeys,
  findProject,
  listFlags,
  updateFlagDefinition,
} from "./repositories/catalog.js";
import { readFlagConfig, resolveTarget, writeFlagConfig } from "./repositories/flags.js";

/* ─────────────────────────────── the file ───────────────────────────── */

const projectSchema = z.object({
  key: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
});

const environmentSchema = z.object({
  key: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  color: z.string().max(32).optional(),
  isProduction: z.boolean().default(false),
});

/** Allow referencing variations by name (e.g. "on") or index (e.g. 1) */
const variationRefSchema = z.union([z.number().int().min(0), z.string().min(1)]);

const provisioningRolloutSchema = z.object({
  contextKind: z.string().min(1).max(64).optional(),
  bucketBy: z.string().min(1).max(128).optional(),
  seed: z.number().int().optional(),
  variations: z
    .array(
      z.object({
        variation: variationRefSchema,
        weight: z.number().int().min(0).max(100_000),
      }),
    )
    .min(1)
    .max(100),
});

const provisioningRuleSchema = z
  .object({
    description: z.string().max(512).optional(),
    clauses: z.array(z.any()).max(50),
    variation: variationRefSchema.optional(),
    rollout: provisioningRolloutSchema.optional(),
  })
  .refine((r) => (r.variation === undefined) !== (r.rollout === undefined), {
    message: "a rule serves exactly one of `variation` or `rollout` (rule_outcome_xor)",
  });

const provisioningTargetSchema = z.object({
  contextKind: z.string().min(1).max(64).default("user"),
  variation: variationRefSchema,
  keys: z.array(z.string().min(1).max(512)).max(10_000),
});

const provisioningConfigSchema = z.object({
  enabled: z.boolean().optional(),
  offVariation: variationRefSchema.optional(),
  fallthroughVariation: variationRefSchema.optional(),
  fallthroughRollout: provisioningRolloutSchema.optional(),
  rules: z.array(provisioningRuleSchema).max(100).optional(),
  targets: z.array(provisioningTargetSchema).max(1_000).optional(),
  prerequisites: z.array(z.any()).max(50).optional(),
});

export function resolveVariationIndex(
  ref: number | string | undefined,
  variations: Array<{ name?: string | undefined; value: unknown }>,
): number | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === "number") return ref;
  const idx = variations.findIndex((v) => v.name === ref);
  if (idx !== -1) return idx;
  const asNum = Number(ref);
  return Number.isInteger(asNum) ? asNum : undefined;
}

export function resolveConfigVariations(
  raw: z.infer<typeof provisioningConfigSchema>,
  variations: Array<{ name?: string | undefined; value: unknown }>,
): Omit<FlagConfigBody, "expectedVersion"> {
  const offVariation = resolveVariationIndex(raw.offVariation, variations);
  const fallthroughVariation = resolveVariationIndex(raw.fallthroughVariation, variations);

  const fallthroughRollout =
    raw.fallthroughRollout === undefined
      ? undefined
      : {
          ...(raw.fallthroughRollout.contextKind !== undefined
            ? { contextKind: raw.fallthroughRollout.contextKind }
            : {}),
          ...(raw.fallthroughRollout.bucketBy !== undefined
            ? { bucketBy: raw.fallthroughRollout.bucketBy }
            : {}),
          ...(raw.fallthroughRollout.seed !== undefined ? { seed: raw.fallthroughRollout.seed } : {}),
          variations: raw.fallthroughRollout.variations.map((v) => ({
            variation: resolveVariationIndex(v.variation, variations) ?? 0,
            weight: v.weight,
          })),
        };

  const rules = raw.rules?.map((r) => ({
    ...(r.description !== undefined ? { description: r.description } : {}),
    clauses: r.clauses,
    ...(r.variation !== undefined ? { variation: resolveVariationIndex(r.variation, variations) } : {}),
    ...(r.rollout !== undefined
      ? {
          rollout: {
            ...(r.rollout.contextKind !== undefined ? { contextKind: r.rollout.contextKind } : {}),
            ...(r.rollout.bucketBy !== undefined ? { bucketBy: r.rollout.bucketBy } : {}),
            ...(r.rollout.seed !== undefined ? { seed: r.rollout.seed } : {}),
            variations: r.rollout.variations.map((v) => ({
              variation: resolveVariationIndex(v.variation, variations) ?? 0,
              weight: v.weight,
            })),
          },
        }
      : {}),
  }));

  const targets = raw.targets?.map((t) => ({
    contextKind: t.contextKind,
    variation: resolveVariationIndex(t.variation, variations) ?? 0,
    keys: t.keys,
  }));

  return {
    ...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
    ...(offVariation !== undefined ? { offVariation } : {}),
    ...(fallthroughVariation !== undefined ? { fallthroughVariation } : {}),
    ...(fallthroughRollout !== undefined ? { fallthroughRollout } : {}),
    ...(rules !== undefined ? { rules } : {}),
    ...(targets !== undefined ? { targets } : {}),
    ...(raw.prerequisites !== undefined ? { prerequisites: raw.prerequisites } : {}),
  };
}

/**
 * A flag definition, plus the configuration it starts with.
 */
const flagDefinitionSchema = createFlagSchema.extend({
  config: provisioningConfigSchema.default({}),
});

export const flagFileSchema = z.object({
  project: projectSchema,
  environment: environmentSchema,
  flags: z.array(flagDefinitionSchema).max(1_000),
});

export type FlagFile = z.input<typeof flagFileSchema>;

export interface ApplyOptions {
  /**
   * Re-apply configuration to flags that already exist.
   *
   * Off by default, and deliberately loud when on: this is the switch that
   * overwrites what somebody changed in the dashboard.
   */
  reset?: boolean;
}

export interface AppliedChange {
  /** `created` | `configured` | `reset` | `unchanged` */
  action: "created" | "configured" | "reset" | "unchanged";
  entity: string;
}

/**
 * The actor recorded for a change that came from a file.
 *
 * A real member id would be a lie about who decided; the all-zero uuid is the
 * same convention the dry-run path uses, and `config-as-code` is what shows up
 * in the audit log next to it.
 */
const FILE_PRINCIPAL: Principal = {
  kind: "token",
  tokenId: "config-as-code",
  memberId: "00000000-0000-0000-0000-000000000000",
  memberEmail: "config-as-code@togglekit",
  role: "owner",
  environmentIds: null,
};

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/* ──────────────────────────── the reconcile ─────────────────────────── */

export async function applyFlagFile(
  db: Database,
  file: FlagFile,
  options: ApplyOptions = {},
): Promise<AppliedChange[]> {
  const parsed = flagFileSchema.safeParse(file);
  if (!parsed.success) {
    // Every problem at once, in the shape the API would have reported.
    throw new ProvisioningError(
      `togglekit: the flag file is not valid\n${parsed.error.issues
        .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  const { project, environment, flags } = parsed.data;
  const changes: AppliedChange[] = [];

  /* project */

  let projectRow = await findProject(db, project.key);
  if (projectRow === null) {
    projectRow = await createProject(db, project);
    changes.push({ action: "created", entity: `project ${project.key}` });
  } else {
    changes.push({ action: "unchanged", entity: `project ${project.key}` });
  }

  /* environment — before the flags, because creating a flag is what gives it a
     row in every environment that exists at that moment */

  let environmentRow = await findEnvironmentByKeys(db, project.key, environment.key);
  if (environmentRow === null) {
    await createEnvironment(db, {
      projectId: projectRow.id,
      key: environment.key,
      name: environment.name,
      ...(environment.color === undefined ? {} : { color: environment.color }),
      isProduction: environment.isProduction,
    });
    environmentRow = await findEnvironmentByKeys(db, project.key, environment.key);
    changes.push({ action: "created", entity: `environment ${environment.key}` });
  } else {
    changes.push({ action: "unchanged", entity: `environment ${environment.key}` });
  }
  if (environmentRow === null) {
    throw new ProvisioningError(`togglekit: could not resolve environment ${environment.key}`);
  }

  /* flags */

  const live = await listFlags(db, projectRow.id);
  const existing = new Set(live.filter((flag) => !flag.archived).map((flag) => flag.key));

  for (const flag of flags) {
    const { config, ...definition } = flag;
    const isNew = !existing.has(flag.key);

    if (isNew) {
      await createFlag(db, { projectId: projectRow.id, ...definition });
    } else {
      await updateFlagDefinition(db, { projectId: projectRow.id, ...definition });
      if (options.reset !== true) {
        changes.push({ action: "configured", entity: `flag ${flag.key} (definition updated)` });
        continue;
      }
    }

    const target = await resolveTarget(db, {
      projectKey: project.key,
      environmentKey: environment.key,
      flagKey: flag.key,
    });
    if (target === null) {
      throw new ProvisioningError(
        `togglekit: ${flag.key} has no configuration in ${environment.key} — ` +
          `it was created before that environment existed`,
      );
    }

    const resolvedConfig = resolveConfigVariations(config, definition.variations);
    const current = await readFlagConfig(db, target);
    const result = await writeFlagConfig(
      db,
      target,
      { ...resolvedConfig, expectedVersion: current.version },
      FILE_PRINCIPAL,
      { action: isNew ? "flag.created" : "flag.reset" },
    );
    changes.push({
      action: isNew ? "created" : "reset",
      entity: `flag ${flag.key} → v${result.version}`,
    });
  }

  return changes;
}

/** The environment a flag file names, for callers that need its id. */
export async function environmentOf(
  db: Database,
  file: FlagFile,
): Promise<{ id: string; key: string; projectId: string; isProduction: boolean } | null> {
  return findEnvironmentByKeys(db, file.project.key, file.environment.key);
}
