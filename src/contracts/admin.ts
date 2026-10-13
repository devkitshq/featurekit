/**
 * Management API request schemas.
 *
 * **Variations are referenced by index, not by uuid.** The database stores rule
 * outcomes as `variation_id` foreign keys — which is right, because an array of
 * bare indices has no referential integrity and reordering silently rewrites
 * every rule. But an *API* that requires callers to look up uuids to
 * turn a flag off is an API people script around, and the wire snapshot already
 * speaks indices. So indices are resolved to ids inside the write transaction,
 * where a bad index is a 400 rather than a dangling reference.
 *
 * `expectedVersion` is required on every mutation. That is optimistic
 * concurrency, for the concurrent-edit scenario: two engineers save the same flag,
 * one editing targeting and one editing rollout. Without it the second write
 * silently discards the first — the review's "lost configuration" P0.
 */

import { z } from "zod";
import { checkRegexPattern } from "../sdk/index.js";

/* ── shared pieces ───────────────────────────────────────────────────── */

/** Weights are integers out of 100,000 (`WEIGHT_SCALE`), never percentages. */
export const rolloutSchema = z.object({
  contextKind: z.string().min(1).max(64).optional(),
  bucketBy: z.string().min(1).max(128).optional(),
  /**
   * Freezing the seed is what lets a flag key be renamed without re-bucketing
   * everyone. Callers rarely set it; the compiler preserves it when they do.
   */
  seed: z.number().int().optional(),
  variations: z
    .array(
      z.object({
        variation: z.number().int().min(0).max(10_000),
        weight: z.number().int().min(0).max(100_000),
      }),
    )
    .min(1)
    .max(100),
});

/**
 * Clause values are capped at 1,000 entries and 1,024 characters each.
 *
 * A `in` clause with a million strings is a snapshot every SDK in the fleet has
 * to hold in memory, sent to them over a stream that then has to carry it on
 * every reconnect (Scenario N). Large lists are what segments are for, and
 * the error message says so.
 */
export const clauseSchema = z
  .object({
    contextKind: z.string().min(1).max(64).default("user"),
    attribute: z.string().min(1).max(256),
    op: z.string().min(1).max(32),
    values: z.array(z.unknown()).max(1_000),
    negate: z.boolean().default(false),
  })
  /**
   * A `matches` clause is checked here, at the point somebody writes it.
   *
   * The SDK also refuses a catastrophic pattern at evaluation time — it has to,
   * because a snapshot is a wire format and the SDK does not get to assume the
   * writer validated anything. But a rule that silently never matches is a
   * terrible way to learn your regex was rejected, and the author is right here
   * with a request to fail. `^(a+)+$` inside a customer's request path is the
   * one operator whose cost a rule author controls.
   */
  .refine(
    (clause) =>
      clause.op !== "matches" ||
      clause.values.every((value) => checkRegexPattern(value).ok),
    {
      message:
        "a `matches` pattern was rejected: patterns must be under 1000 characters and " +
        "must not nest an unbounded quantifier inside a repeated group (e.g. `(a+)+`), " +
        "which can hang the evaluator on a non-matching input",
      path: ["values"],
    },
  );

export const ruleSchema = z
  .object({
    description: z.string().max(512).optional(),
    clauses: z.array(clauseSchema).max(50),
    variation: z.number().int().min(0).max(10_000).optional(),
    rollout: rolloutSchema.optional(),
  })
  .refine((r) => (r.variation === undefined) !== (r.rollout === undefined), {
    message: "a rule serves exactly one of `variation` or `rollout` (rule_outcome_xor)",
  });

export const targetSchema = z.object({
  contextKind: z.string().min(1).max(64).default("user"),
  variation: z.number().int().min(0).max(10_000),
  keys: z.array(z.string().min(1).max(512)).max(10_000),
});

export const prerequisiteSchema = z.object({
  flagKey: z.string().min(1).max(255),
  variation: z.number().int().min(0).max(10_000),
});

/* ── flags ───────────────────────────────────────────────────────────── */

export const flagKeySchema = z
  .string()
  .min(1)
  .max(255)
  // Keys appear in URLs, snapshots, metrics-adjacent logs and customer code.
  .regex(/^[A-Za-z0-9._-]+$/, "flag keys are [A-Za-z0-9._-]");

export const createFlagSchema = z.object({
  key: flagKeySchema,
  name: z.string().min(1).max(255),
  description: z.string().max(2_000).optional(),
  kind: z.enum(["boolean", "string", "number", "json"]),
  temporary: z.boolean().default(true),
  clientAvailable: z.boolean().default(false),
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
  variations: z
    .array(z.object({ name: z.string().max(128).optional(), value: z.unknown() }))
    .min(2)
    .max(100),
});

/**
 * The whole per-environment configuration, replaced as one unit.
 *
 * Replace rather than merge, deliberately: a partial merge of an *ordered* rule
 * list has no sane semantics ("insert rule 3" against a list someone else just
 * reordered), and `expectedVersion` already makes a full replace safe. The
 * dashboard sends back what it read, edited.
 */
export const flagConfigSchema = z.object({
  expectedVersion: z.number().int().min(1),
  enabled: z.boolean().optional(),
  offVariation: z.number().int().min(0).max(10_000).nullable().optional(),
  fallthroughVariation: z.number().int().min(0).max(10_000).optional(),
  fallthroughRollout: rolloutSchema.optional(),
  rules: z.array(ruleSchema).max(200).optional(),
  targets: z.array(targetSchema).max(50).optional(),
  prerequisites: z.array(prerequisiteSchema).max(20).optional(),
  comment: z.string().max(1_000).optional(),
});

export type FlagConfigBody = z.infer<typeof flagConfigSchema>;

/**
 * The kill switch: its own endpoint, its own tiny body.
 *
 * Separate from the general PATCH on purpose. During an incident the operator
 * must not have to send a full configuration — which requires reading the
 * current one first, from a control plane that may be the thing degrading — to
 * turn something off. And no `expectedVersion`: "off" is not a merge, it cannot
 * lose anyone else's edit, and refusing a kill switch because someone else
 * touched the flag ten seconds ago is exactly wrong.
 */
export const killSwitchSchema = z.object({
  comment: z.string().max(1_000).optional(),
});

/* ── segments ────────────────────────────────────────────────────────── */

export const createSegmentSchema = z.object({
  key: flagKeySchema,
  name: z.string().min(1).max(255),
  description: z.string().max(2_000).optional(),
  external: z.boolean().default(false),
});

/**
 * One page of a segment import. 50,000 members per request, and the client
 * pages — a 10M-member import is 200 requests, each of which is a bounded
 * transaction that can fail and be retried independently (Scenario F).
 */
export const segmentMembersSchema = z.object({
  add: z
    .array(
      z.object({
        contextKind: z.string().min(1).max(64).default("user"),
        contextKey: z.string().min(1).max(512),
        excluded: z.boolean().default(false),
      }),
    )
    .max(50_000)
    .default([]),
  remove: z
    .array(
      z.object({
        contextKind: z.string().min(1).max(64).default("user"),
        contextKey: z.string().min(1).max(512),
      }),
    )
    .max(50_000)
    .default([]),
});

/* ── keys and tenancy ────────────────────────────────────────────────── */

export const createProjectSchema = z.object({
  key: flagKeySchema,
  name: z.string().min(1).max(255),
});

export const createEnvironmentSchema = z.object({
  key: flagKeySchema,
  name: z.string().min(1).max(255),
  color: z.string().max(32).optional(),
  isProduction: z.boolean().default(false),
});

export const createSdkKeySchema = z.object({
  kind: z.enum(["server", "client", "mobile"]),
  name: z.string().max(128).optional(),
  expiresAt: z.string().datetime().optional(),
});

/**
 * A change to apply later, or one that needs a second pair of eyes.
 *
 * The patch is the same shape `PATCH .../flags/:flag` accepts minus
 * `expectedVersion` — scheduling is a deferred PATCH, and a scheduled change
 * that could express something the API would reject is a second way to
 * configure a flag.
 */
export const scheduleChangeSchema = z.object({
  patch: flagConfigSchema.omit({ expectedVersion: true }),
  executeAt: z.string().datetime(),
  comment: z.string().max(1_000).optional(),
});

export const changeRequestSchema = z.object({
  patch: flagConfigSchema.omit({ expectedVersion: true }),
  comment: z.string().max(1_000).optional(),
});

export const reviewSchema = z.object({
  comment: z.string().max(1_000).optional(),
});

/**
 * A change to preview, against contexts the caller supplies.
 *
 * Real contexts, not synthesised ones: the question a dry run answers is "does
 * this move the people I meant", and synthetic keys answer it about nobody.
 */
export const dryRunSchema = z.object({
  patch: flagConfigSchema.omit({ expectedVersion: true }),
  contexts: z.array(z.unknown()).min(1).max(10_000),
  maxExamples: z.number().int().min(0).max(100).optional(),
});

export const revertSchema = z.object({
  auditId: z.string().uuid(),
  comment: z.string().max(1_000).optional(),
});

/* ── dashboard accounts ────────────────────────────────────────────── */

const emailSchema = z.string().email().max(320);
/**
 * The password bound here is a denial-of-service bound, not a policy.
 * `checkPasswordPolicy` in `auth/passwords.ts` owns the minimum, so that a
 * password set by the CLI and one set over HTTP obey the same rule.
 */
const passwordSchema = z.string().min(1).max(512);

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

export const roleSchema = z.enum(["owner", "admin", "writer", "reader"]);

export const createMemberSchema = z.object({
  email: emailSchema,
  name: z.string().max(255).optional(),
  role: roleSchema.default("writer"),
  /** Optional: a member with no password can only authenticate with a PAT. */
  password: passwordSchema.optional(),
});

export const updateMemberSchema = z.object({
  name: z.string().max(255).nullable().optional(),
  role: roleSchema.optional(),
  password: passwordSchema.optional(),
});

export const createAccessTokenSchema = z.object({
  name: z.string().max(128).optional(),
  /**
   * The environments this token may touch. Omit for every environment — which
   * is a normal thing to want and an abnormal thing to create by accident, so
   * the dashboard shows the scope on the list afterwards.
   */
  environmentIds: z.array(z.string().uuid()).max(100).optional(),
  expiresAt: z.string().datetime().optional(),
});
