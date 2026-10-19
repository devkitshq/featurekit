/**
 * The MCP tools.
 *
 * Built for how people actually ask: "roll out cart v2 page to 20% of users"
 * names a flag by a phrase, a rollout by a percentage, and an environment only
 * if they remember to. So flags are found by fuzzy match, percentages become
 * weights here, project and environment fall back to configured defaults, and
 * every result restates the change in words for the model to confirm.
 *
 * Writes are only registered in write mode, and never guess: an ambiguous flag
 * or a missing environment is an error listing the choices, not a pick.
 * Production writes go through, with a warning in the result.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, type Environment, type FeaturekitApi, type FlagRow } from "./api.js";
import {
  buildRollout,
  describeConfig,
  describeRow,
  matchScore,
  resolveVariation,
  variationLabel,
} from "./describe.js";

export interface ToolOptions {
  /** Register the tools that change flags. */
  write: boolean;
  defaultProject?: string;
  defaultEnvironment?: string;
}

/** Marks every write in the audit log, whatever the model writes in `comment`. */
const VIA = "via featurekit-mcp";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (body: string): Result => ({ content: [{ type: "text", text: body }] });
const failure = (body: string): Result => ({ content: [{ type: "text", text: body }], isError: true });

/** Tool errors are results the model can read and act on, not protocol failures. */
async function guarded(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) {
      const hint =
        error.status === 401
          ? " Check FEATUREKIT_TOKEN."
          : error.status === 403
            ? " The access token does not allow this (its role or environment scope)."
            : error.code === "VERSION_CONFLICT"
              ? " Someone changed the flag meanwhile; read it again and redo the change."
              : "";
      return failure(`featurekit refused (${error.status} ${error.code}): ${error.message}.${hint}`);
    }
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** The API caps comments at 1,000 characters. */
const comment = (given: string | undefined): string =>
  given !== undefined && given.length > 0 ? `${given.slice(0, 950)} (${VIA})` : VIA;

export function registerTools(server: McpServer, api: FeaturekitApi, options: ToolOptions): void {
  /* ── resolution ─────────────────────────────────────────────────────── */

  async function project(given: string | undefined): Promise<string> {
    if (given !== undefined && given.length > 0) return given;
    if (options.defaultProject !== undefined) return options.defaultProject;
    const projects = await api.listProjects();
    if (projects.length === 1) return projects[0]!.key;
    throw new Error(
      `which project? ${projects.map((p) => `${p.key} ("${p.name}")`).join(", ") || "none exist"}`,
    );
  }

  async function environment(projectKey: string, given: string | undefined): Promise<Environment> {
    const environments = await api.listEnvironments(projectKey);
    const wanted = given ?? options.defaultEnvironment;
    if (wanted === undefined) {
      // Never guessed: the difference between staging and production is the
      // whole question.
      throw new Error(
        `which environment? ${environments.map((e) => `${e.key}${e.isProduction ? " (production)" : ""}`).join(", ")}`,
      );
    }
    const match =
      environments.find((e) => e.key === wanted) ??
      environments.find((e) => e.key.toLowerCase() === wanted.toLowerCase() || e.name.toLowerCase() === wanted.toLowerCase());
    if (match === undefined) {
      throw new Error(
        `no environment ${JSON.stringify(wanted)} in ${projectKey}; it has: ${environments.map((e) => e.key).join(", ")}`,
      );
    }
    return match;
  }

  /** A flag by exact key, or by a phrase when exactly one flag clearly matches it. */
  async function flag(projectKey: string, environmentKey: string, phrase: string): Promise<FlagRow> {
    const rows = (await api.listFlags(projectKey, environmentKey)).filter((r) => !r.archived);
    const exact = rows.find((r) => r.key === phrase);
    if (exact !== undefined) return exact;
    const ranked = rows
      .map((row) => ({ row, score: matchScore(phrase, row) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    const [best, second] = ranked;
    if (best !== undefined && best.score >= 60 && (second === undefined || best.score - second.score >= 20)) {
      return best.row;
    }
    if (ranked.length === 0) {
      throw new Error(`no flag in ${projectKey} matches ${JSON.stringify(phrase)}. Use find_flags, or create_flag.`);
    }
    throw new Error(
      `${JSON.stringify(phrase)} could mean: ${ranked
        .slice(0, 5)
        .map((r) => `${r.row.key} ("${r.row.name}")`)
        .join(", ")}. Ask which one, then call again with the exact key.`,
    );
  }

  const productionWarning = (env: Environment): string =>
    env.isProduction ? `\n\n⚠ ${env.key} is a PRODUCTION environment: this change is live for real users now.` : "";

  const projectArg = z.string().optional().describe("Project key. Optional when a default is configured or only one project exists.");
  const environmentArg = z
    .string()
    .optional()
    .describe("Environment key, e.g. staging or production. Optional only when a default is configured.");
  const flagArg = z
    .string()
    .describe("The flag's key, or how the user referred to it (\"cart v2 page\" finds cart-v2-page).");
  const commentArg = z.string().max(900).optional().describe("Why, for the audit log.");

  /* ── read ───────────────────────────────────────────────────────────── */

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "The featurekit projects this token can see, with their environments.",
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const projects = await api.listProjects();
        if (projects.length === 0) return text("No projects.");
        return text(projects.map((p) => `${p.key} — "${p.name}": ${p.environments.join(", ")}`).join("\n"));
      }),
  );

  server.registerTool(
    "list_environments",
    {
      title: "List environments",
      description: "A project's environments, and which of them are production.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const environments = await api.listEnvironments(projectKey);
        return text(
          environments.map((e) => `${e.key} — "${e.name}"${e.isProduction ? " (production)" : ""}`).join("\n"),
        );
      }),
  );

  server.registerTool(
    "find_flags",
    {
      title: "Find flags",
      description:
        "Search a project's flags by key, name, description or tag, and show each one's state in an " +
        "environment (on/off, what it serves, rollout percentages). Leave query empty to list all.",
      inputSchema: {
        query: z.string().optional().describe("Words to match, e.g. \"cart v2\". Empty lists every flag."),
        project: projectArg,
        environment: environmentArg,
        includeArchived: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const env = await environment(projectKey, args.environment);
        const rows = (await api.listFlags(projectKey, env.key)).filter(
          (r) => args.includeArchived === true || !r.archived,
        );
        const query = args.query ?? "";
        const matched =
          query.length === 0
            ? rows
            : rows
                .map((row) => ({ row, score: matchScore(query, row) }))
                .filter((r) => r.score > 0)
                .sort((a, b) => b.score - a.score)
                .map((r) => r.row);
        if (matched.length === 0) return text(`No flags in ${projectKey} match ${JSON.stringify(query)}.`);
        return text(`${projectKey} / ${env.key}:\n${matched.slice(0, 50).map(describeRow).join("\n")}`);
      }),
  );

  server.registerTool(
    "get_flag",
    {
      title: "Get a flag",
      description:
        "A flag's variations and its full configuration in one environment: on/off, targets, rules, " +
        "the default rollout, prerequisites, and its version.",
      inputSchema: { flag: flagArg, project: projectArg, environment: environmentArg },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const env = await environment(projectKey, args.environment);
        const row = await flag(projectKey, env.key, args.flag);
        const config = await api.getFlagConfig(projectKey, env.key, row.key);
        const variations = row.variations
          .map((v) => `  ${v.idx}: ${variationLabel(row.variations, v.idx)}`)
          .join("\n");
        return text(
          `"${row.name}" (${row.kind})${row.description ? ` — ${row.description}` : ""}\n` +
            `variations:\n${variations}\n\n${describeConfig(row.variations, config)}`,
        );
      }),
  );

  server.registerTool(
    "get_audit_log",
    {
      title: "Audit log",
      description: "Recent changes in a project, newest first: who changed what, when, and why.",
      inputSchema: {
        project: projectArg,
        flag: z.string().optional().describe("Only this flag's history (exact key)."),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const entries = await api.listAudit(projectKey, {
          ...(args.flag !== undefined ? { flag: args.flag } : {}),
          limit: args.limit ?? 20,
        });
        if (entries.length === 0) return text("No changes recorded.");
        return text(
          entries
            .map(
              (e) =>
                `${e.createdAt} ${e.action} ${e.entityKey ?? ""} by ${e.actorName ?? e.actorEmail ?? e.actorKind}` +
                `${e.comment ? ` — "${e.comment}"` : ""} [audit id ${e.id}]`,
            )
            .join("\n"),
        );
      }),
  );

  if (!options.write) return;

  /* ── write ──────────────────────────────────────────────────────────── */

  server.registerTool(
    "set_rollout",
    {
      title: "Roll a flag out to a percentage",
      description:
        "Serve a variation to a percentage of contexts by default, e.g. \"roll out cart v2 page to 20% of users\". " +
        "For a boolean flag the rolled-out variation is `true` unless told otherwise; everyone else gets `false`. " +
        "Turns the flag on if it is off. Raising a percentage keeps everyone already in the rollout: it adds " +
        "people rather than reshuffling. Targets and rules are left alone, and still win over the rollout.",
      inputSchema: {
        flag: flagArg,
        percentage: z.number().min(0).max(100).describe("0–100, up to three decimals."),
        variation: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe("The variation to roll out: its value, name or index. Defaults to true for boolean flags."),
        otherVariation: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe("What everyone else gets. Defaults to false for boolean flags, or what the flag serves now."),
        project: projectArg,
        environment: environmentArg,
        comment: commentArg,
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const env = await environment(projectKey, args.environment);
        const row = await flag(projectKey, env.key, args.flag);
        const config = await api.getFlagConfig(projectKey, env.key, row.key);

        const on = resolveVariation(row.variations, row.kind, args.variation);
        let rest;
        if (args.otherVariation !== undefined) {
          rest = resolveVariation(row.variations, row.kind, args.otherVariation);
        } else if (row.kind === "boolean") {
          rest = row.variations.find((v) => v.value !== on.value && typeof v.value === "boolean");
        } else {
          const current = config.fallthroughVariation;
          rest = row.variations.find((v) => v.idx === current && v.idx !== on.idx);
        }
        if (rest === undefined || rest.idx === on.idx) {
          throw new Error(
            `say what everyone outside the ${args.percentage}% gets (otherVariation): ` +
              row.variations.map((v) => `${v.idx} = ${variationLabel(row.variations, v.idx)}`).join(", "),
          );
        }

        const rollout = buildRollout(config.fallthroughRollout, on.idx, rest.idx, args.percentage);
        const result = await api.updateFlagConfig(projectKey, env.key, row.key, {
          expectedVersion: config.version,
          enabled: true,
          fallthroughRollout: rollout,
          comment: comment(args.comment ?? `roll out ${variationLabel(row.variations, on.idx)} to ${args.percentage}%`),
        });
        const turnedOn = config.enabled ? "" : "\nThe flag was off; it is now on.";
        const precedence =
          result.config.rules.length > 0 || result.config.targets.length > 0
            ? "\nIts targets and rules still apply first; the rollout is for everyone they do not match."
            : "";
        return text(
          `Done. ${row.key} in ${env.key}: ${args.percentage}% get ${variationLabel(row.variations, on.idx)}, ` +
            `the rest get ${variationLabel(row.variations, rest.idx)}.${turnedOn}${precedence}\n\n` +
            `${describeConfig(row.variations, result.config)}${productionWarning(env)}`,
        );
      }),
  );

  server.registerTool(
    "serve_variation",
    {
      title: "Serve one variation to everyone",
      description:
        "Make a flag serve one variation to everyone by default, e.g. \"turn cart v2 on for everyone\" (100% " +
        "rollout) or \"set the banner to blue\". Replaces any default rollout; targets and rules are left alone. " +
        "Turns the flag on if it is off.",
      inputSchema: {
        flag: flagArg,
        variation: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe("Its value, name or index. Defaults to true for boolean flags."),
        project: projectArg,
        environment: environmentArg,
        comment: commentArg,
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const env = await environment(projectKey, args.environment);
        const row = await flag(projectKey, env.key, args.flag);
        const config = await api.getFlagConfig(projectKey, env.key, row.key);
        const chosen = resolveVariation(row.variations, row.kind, args.variation);
        const result = await api.updateFlagConfig(projectKey, env.key, row.key, {
          expectedVersion: config.version,
          enabled: true,
          fallthroughVariation: chosen.idx,
          comment: comment(args.comment ?? `serve ${variationLabel(row.variations, chosen.idx)} to everyone`),
        });
        return text(
          `Done. ${row.key} in ${env.key} now serves ${variationLabel(row.variations, chosen.idx)} by default.\n\n` +
            `${describeConfig(row.variations, result.config)}${productionWarning(env)}`,
        );
      }),
  );

  server.registerTool(
    "turn_flag_on",
    {
      title: "Turn a flag on",
      description:
        "Turn a flag on, keeping its targets, rules and default as they are. To also change who gets what, " +
        "use set_rollout or serve_variation instead.",
      inputSchema: { flag: flagArg, project: projectArg, environment: environmentArg, comment: commentArg },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const env = await environment(projectKey, args.environment);
        const row = await flag(projectKey, env.key, args.flag);
        const config = await api.getFlagConfig(projectKey, env.key, row.key);
        if (config.enabled) {
          return text(`${row.key} is already on in ${env.key}.\n\n${describeConfig(row.variations, config)}`);
        }
        const result = await api.updateFlagConfig(projectKey, env.key, row.key, {
          expectedVersion: config.version,
          enabled: true,
          comment: comment(args.comment ?? "turn on"),
        });
        return text(`Done.\n\n${describeConfig(row.variations, result.config)}${productionWarning(env)}`);
      }),
  );

  server.registerTool(
    "turn_flag_off",
    {
      title: "Turn a flag off (kill switch)",
      description:
        "Turn a flag off immediately: everyone gets its off variation. This is the kill switch, and takes " +
        "effect at once, without waiting on other edits.",
      inputSchema: { flag: flagArg, project: projectArg, environment: environmentArg, comment: commentArg },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const env = await environment(projectKey, args.environment);
        const row = await flag(projectKey, env.key, args.flag);
        const result = await api.killSwitch(projectKey, env.key, row.key, comment(args.comment));
        if (result.alreadyOff) return text(`${row.key} was already off in ${env.key}.`);
        const config = await api.getFlagConfig(projectKey, env.key, row.key);
        return text(`Done. ${row.key} is off in ${env.key}.\n\n${describeConfig(row.variations, config)}${productionWarning(env)}`);
      }),
  );

  server.registerTool(
    "create_flag",
    {
      title: "Create a flag",
      description:
        "Create a flag in a project. It starts off in every environment. A boolean flag gets false/true " +
        "variations unless others are given. Follow with set_rollout or serve_variation to turn it on somewhere.",
      inputSchema: {
        key: z
          .string()
          .regex(/^[A-Za-z0-9._-]+$/)
          .describe("The key code uses, e.g. cart-v2-page. Letters, digits, . _ - only."),
        name: z.string().min(1).max(255).describe("Human name, e.g. \"Cart v2 page\"."),
        description: z.string().max(2_000).optional(),
        kind: z.enum(["boolean", "string", "number", "json"]).optional().describe("Default boolean."),
        variations: z
          .array(z.object({ value: z.unknown(), name: z.string().max(128).optional() }))
          .min(2)
          .optional()
          .describe("Required for non-boolean flags."),
        clientAvailable: z
          .boolean()
          .optional()
          .describe("Whether browser and mobile SDKs may see it. Default false."),
        tags: z.array(z.string()).optional(),
        project: projectArg,
      },
      annotations: { destructiveHint: false },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const kind = args.kind ?? "boolean";
        const variations =
          args.variations ??
          (kind === "boolean"
            ? [
                { name: "off", value: false },
                { name: "on", value: true },
              ]
            : undefined);
        if (variations === undefined) throw new Error(`a ${kind} flag needs its variations`);
        await api.createFlag(projectKey, {
          key: args.key,
          name: args.name,
          kind,
          variations: variations.map((v) => ({ value: v.value, ...(v.name !== undefined ? { name: v.name } : {}) })),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.clientAvailable !== undefined ? { clientAvailable: args.clientAvailable } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
        });
        return text(`Created ${args.key} in ${projectKey}. It is off in every environment.`);
      }),
  );

  server.registerTool(
    "update_flag_config",
    {
      title: "Edit targets, rules or prerequisites",
      description:
        "The general edit, for what the other tools do not cover: targeting rules (e.g. \"country in [NL]\" " +
        "gets true), individual targets, prerequisites, the off variation. Read the flag with get_flag first. " +
        "Each list given REPLACES the current one, so include the entries to keep. Variations are referenced " +
        "by index. Rollout weights are out of 100000 (20% = 20000) and must sum to 100000.",
      inputSchema: {
        flag: z.string().describe("The exact flag key."),
        project: projectArg,
        environment: environmentArg,
        enabled: z.boolean().optional(),
        offVariation: z.number().int().min(0).nullable().optional(),
        targets: z
          .array(z.object({ contextKind: z.string().default("user"), variation: z.number().int(), keys: z.array(z.string()) }))
          .optional(),
        rules: z
          .array(
            z.object({
              description: z.string().optional(),
              clauses: z.array(
                z.object({
                  contextKind: z.string().default("user"),
                  attribute: z.string(),
                  op: z
                    .string()
                    .describe("in, startsWith, endsWith, contains, matches, lessThan, greaterThan, semVerEqual, …"),
                  values: z.array(z.unknown()),
                  negate: z.boolean().default(false),
                }),
              ),
              variation: z.number().int().optional(),
              rollout: z
                .object({
                  contextKind: z.string().optional(),
                  bucketBy: z.string().optional(),
                  variations: z.array(z.object({ variation: z.number().int(), weight: z.number().int() })),
                })
                .optional(),
            }),
          )
          .optional(),
        prerequisites: z.array(z.object({ flagKey: z.string(), variation: z.number().int() })).optional(),
        comment: commentArg,
      },
      annotations: { destructiveHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const env = await environment(projectKey, args.environment);
        const row = await flag(projectKey, env.key, args.flag);
        if (row.key !== args.flag) throw new Error(`use the exact key: did you mean ${row.key}?`);
        const config = await api.getFlagConfig(projectKey, env.key, row.key);
        const result = await api.updateFlagConfig(projectKey, env.key, row.key, {
          expectedVersion: config.version,
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.offVariation !== undefined ? { offVariation: args.offVariation } : {}),
          ...(args.targets !== undefined ? { targets: args.targets } : {}),
          ...(args.rules !== undefined
            ? {
                rules: args.rules.map((rule) => ({
                  clauses: rule.clauses,
                  ...(rule.description !== undefined ? { description: rule.description } : {}),
                  ...(rule.variation !== undefined ? { variation: rule.variation } : {}),
                  ...(rule.rollout !== undefined
                    ? {
                        rollout: {
                          variations: rule.rollout.variations,
                          ...(rule.rollout.contextKind !== undefined ? { contextKind: rule.rollout.contextKind } : {}),
                          ...(rule.rollout.bucketBy !== undefined ? { bucketBy: rule.rollout.bucketBy } : {}),
                        },
                      }
                    : {}),
                })),
              }
            : {}),
          ...(args.prerequisites !== undefined ? { prerequisites: args.prerequisites } : {}),
          comment: comment(args.comment),
        });
        return text(`Done.\n\n${describeConfig(row.variations, result.config)}${productionWarning(env)}`);
      }),
  );

  server.registerTool(
    "revert_flag",
    {
      title: "Revert a flag change",
      description:
        "Put a flag back to the state before a change in the audit log. Find the audit id with get_audit_log.",
      inputSchema: {
        flag: z.string().describe("The exact flag key."),
        auditId: z.string().uuid(),
        project: projectArg,
        environment: environmentArg,
        comment: commentArg,
      },
      annotations: { destructiveHint: true },
    },
    (args) =>
      guarded(async () => {
        const projectKey = await project(args.project);
        const env = await environment(projectKey, args.environment);
        const row = await flag(projectKey, env.key, args.flag);
        await api.revertFlag(projectKey, env.key, row.key, args.auditId, comment(args.comment));
        const config = await api.getFlagConfig(projectKey, env.key, row.key);
        return text(`Reverted.\n\n${describeConfig(row.variations, config)}${productionWarning(env)}`);
      }),
  );
}

