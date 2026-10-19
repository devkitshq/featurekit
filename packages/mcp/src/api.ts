/**
 * The admin API, as the MCP server sees it.
 *
 * Every tool goes through here and nothing else: no database, no shortcut. A
 * tool can only do what the configured access token could do with curl, which
 * keeps roles, environment scopes, rate limits, change history and the audit log
 * in force for anything a model asks for.
 */

import { randomUUID } from "node:crypto";

/** Weights are integers out of this, never percentages. */
export const WEIGHT_SCALE = 100_000;

export interface Project {
  key: string;
  name: string;
  environments: string[];
}

export interface Environment {
  key: string;
  name: string;
  isProduction: boolean;
}

export interface Variation {
  idx: number;
  name: string | null;
  value: unknown;
}

export interface FlagRow {
  key: string;
  name: string;
  description: string | null;
  kind: string;
  tags: string[];
  archived: boolean;
  environment: {
    enabled: boolean;
    version: number;
    offVariation: number | null;
    fallthroughVariation: number | null;
    fallthroughRollout: { variation: number; weight: number }[] | null;
    ruleCount: number;
    targetCount: number;
    prerequisiteCount: number;
  } | null;
  variations: Variation[];
}

export interface FlagDefinition {
  key: string;
  name: string;
  description: string | null;
  kind: string;
  tags: string[];
  archived: boolean;
  variations: Variation[];
}

/** A rollout as the config read returns it: wire format, `variationIndex`. */
export interface WireRollout {
  contextKind?: string;
  bucketBy?: string;
  seed?: number;
  variations: { variationIndex: number; weight: number }[];
}

/** A rollout as writes take it: `variation`. */
export interface RolloutBody {
  contextKind?: string;
  bucketBy?: string;
  seed?: number;
  variations: { variation: number; weight: number }[];
}

export interface Clause {
  contextKind: string;
  attribute: string;
  op: string;
  values: unknown[];
  negate: boolean;
}

export interface FlagConfig {
  flagKey: string;
  environmentKey: string;
  version: number;
  enabled: boolean;
  offVariation: number | null;
  fallthroughVariation?: number;
  fallthroughRollout?: WireRollout;
  targets: { contextKind: string; variation: number; keys: string[] }[];
  rules: { description?: string; clauses: Clause[]; variation?: number; rollout?: WireRollout }[];
  prerequisites: { flagKey: string; variation: number }[];
}

/** The body of a configuration write. Omitted fields are left as they are. */
export interface ConfigPatch {
  enabled?: boolean;
  offVariation?: number | null;
  fallthroughVariation?: number;
  fallthroughRollout?: RolloutBody;
  rules?: { description?: string; clauses: Clause[]; variation?: number; rollout?: RolloutBody }[];
  targets?: { contextKind: string; variation: number; keys: string[] }[];
  prerequisites?: { flagKey: string; variation: number }[];
  comment?: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityKey: string | null;
  actorKind: string;
  actorName: string | null;
  actorEmail: string | null;
  createdAt: string;
  comment: string | null;
  before?: unknown;
  after?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  /** The control plane, e.g. `https://flags.example.com`. */
  baseUrl: string;
  /** A personal access token. */
  token: string;
  fetch?: typeof fetch;
}

export function toRolloutBody(rollout: WireRollout): RolloutBody {
  return {
    ...(rollout.contextKind !== undefined ? { contextKind: rollout.contextKind } : {}),
    ...(rollout.bucketBy !== undefined ? { bucketBy: rollout.bucketBy } : {}),
    ...(rollout.seed !== undefined ? { seed: rollout.seed } : {}),
    variations: rollout.variations.map((v) => ({ variation: v.variationIndex, weight: v.weight })),
  };
}

const segment = encodeURIComponent;

export class FeaturekitApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    // A retried write must not apply twice; the server binds the key to this token.
    if (method !== "GET") headers["idempotency-key"] = randomUUID();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
      throw new Error(`could not reach featurekit at ${this.baseUrl} (${cause}). Check FEATUREKIT_URL.`);
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const error = (parsed ?? {}) as { error?: string; message?: string; details?: unknown };
      throw new ApiError(
        response.status,
        error.error ?? `HTTP_${response.status}`,
        error.message ?? (typeof parsed === "string" && parsed.length > 0 ? parsed : response.statusText),
        error.details,
      );
    }
    return parsed as T;
  }

  private flagPath(project: string, environment: string, flag: string): string {
    return `/v1/admin/projects/${segment(project)}/environments/${segment(environment)}/flags/${segment(flag)}`;
  }

  async listProjects(): Promise<Project[]> {
    return (await this.request<{ projects: Project[] }>("GET", "/v1/admin/projects")).projects;
  }

  async listEnvironments(project: string): Promise<Environment[]> {
    const result = await this.request<{ environments: Environment[] }>(
      "GET",
      `/v1/admin/projects/${segment(project)}/environments`,
    );
    return result.environments;
  }

  async listFlags(project: string, environment: string): Promise<FlagRow[]> {
    const result = await this.request<{ flags: FlagRow[] }>(
      "GET",
      `/v1/admin/projects/${segment(project)}/flags?environment=${segment(environment)}`,
    );
    return result.flags;
  }

  getFlagDefinition(project: string, flag: string): Promise<FlagDefinition> {
    return this.request("GET", `/v1/admin/projects/${segment(project)}/flags/${segment(flag)}`);
  }

  getFlagConfig(project: string, environment: string, flag: string): Promise<FlagConfig> {
    return this.request("GET", this.flagPath(project, environment, flag));
  }

  updateFlagConfig(
    project: string,
    environment: string,
    flag: string,
    patch: ConfigPatch & { expectedVersion: number },
  ): Promise<{ version: number; auditId: string; config: FlagConfig }> {
    return this.request("PATCH", this.flagPath(project, environment, flag), patch);
  }

  killSwitch(
    project: string,
    environment: string,
    flag: string,
    comment?: string,
  ): Promise<{ version: number; auditId: string; alreadyOff: boolean }> {
    return this.request(
      "POST",
      `${this.flagPath(project, environment, flag)}/off`,
      comment !== undefined ? { comment } : {},
    );
  }

  revertFlag(
    project: string,
    environment: string,
    flag: string,
    auditId: string,
    comment?: string,
  ): Promise<{ version: number; auditId: string }> {
    return this.request("POST", `${this.flagPath(project, environment, flag)}/revert`, {
      auditId,
      ...(comment !== undefined ? { comment } : {}),
    });
  }

  createFlag(
    project: string,
    input: {
      key: string;
      name: string;
      description?: string;
      kind: "boolean" | "string" | "number" | "json";
      clientAvailable?: boolean;
      tags?: string[];
      variations: { name?: string; value: unknown }[];
    },
  ): Promise<{ id: string; key: string }> {
    return this.request("POST", `/v1/admin/projects/${segment(project)}/flags`, input);
  }

  async listAudit(project: string, options: { flag?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    const query = new URLSearchParams();
    if (options.flag !== undefined) query.set("flag", options.flag);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const result = await this.request<{ entries: AuditEntry[] }>(
      "GET",
      `/v1/admin/projects/${segment(project)}/audit${suffix}`,
    );
    return result.entries;
  }
}
