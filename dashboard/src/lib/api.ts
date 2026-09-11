/**
 * The management API, typed.
 *
 * One place that knows about credentials, CSRF and error shapes, so no screen
 * has to. Two rules live here and nowhere else:
 *
 * - Every mutation carries the CSRF header. The server refuses a
 *   cookie-authenticated write without it, which is the point: a cross-site
 *   form can send your cookies but cannot set a header.
 * - A 401 anywhere means the session ended, and the app is told once rather
 *   than each caller inventing its own redirect.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** A 409 on a flag write carries the current configuration; a form uses it. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Listener = () => void;
const unauthorized = new Set<Listener>();

/** Called when any request finds the session gone. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorized.add(listener);
  return () => unauthorized.delete(listener);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    // Same-origin: the dashboard is served by the control plane, so the session
    // cookie is already the right cookie for these URLs.
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { "x-featurekit-csrf": "1" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 401) {
    // Not on the login endpoint itself — a wrong password is a form error, not
    // an expired session.
    if (!path.endsWith("/auth/login")) for (const listener of unauthorized) listener();
  }

  const text = await response.text();
  const payload: unknown = text.length === 0 ? {} : safeParse(text);

  if (!response.ok) {
    const shape = payload as { error?: string; message?: string; details?: unknown };
    throw new ApiError(
      response.status,
      shape.error ?? "ERROR",
      shape.message ?? `${method} ${path} failed with ${response.status}`,
      shape.details,
    );
  }
  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/* ─────────────────────────────── shapes ─────────────────────────────── */

export type Role = "owner" | "admin" | "writer" | "reader";
export type FlagKind = "boolean" | "string" | "number" | "json";

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  hasPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Principal {
  kind: "token" | "session";
  role: Role;
  email: string;
  environmentIds: string[] | null;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  environments: string[];
}

export interface Environment {
  id: string;
  key: string;
  name: string;
  color: string | null;
  isProduction: boolean;
  snapshotVersion: number;
  createdAt: string;
}

export interface Variation {
  idx: number;
  name: string | null;
  value: unknown;
}

export interface RolloutSlice {
  variation: number;
  weight: number;
}

export interface FlagEnvironmentSummary {
  enabled: boolean;
  version: number;
  updatedAt: string;
  offVariation: number | null;
  fallthroughVariation: number | null;
  fallthroughRollout: RolloutSlice[] | null;
  ruleCount: number;
  targetCount: number;
  prerequisiteCount: number;
}

export interface FlagRow {
  key: string;
  name: string;
  description: string | null;
  kind: FlagKind;
  tags: string[];
  temporary: boolean;
  clientAvailable: boolean;
  archived: boolean;
  createdAt: string;
  environment: FlagEnvironmentSummary | null;
  variations: Variation[];
}

export interface Clause {
  contextKind: string;
  attribute: string;
  op: string;
  values: unknown[];
  negate: boolean;
}

export interface Rule {
  description?: string;
  clauses: Clause[];
  variation?: number;
  rollout?: { contextKind?: string; bucketBy?: string; seed?: number; variations: Array<{ variationIndex: number; weight: number }> };
}

export interface FlagTarget {
  contextKind: string;
  variation: number;
  keys: string[];
}

export interface FlagConfig {
  flagKey: string;
  environmentKey: string;
  version: number;
  enabled: boolean;
  offVariation: number | null;
  fallthroughVariation?: number;
  fallthroughRollout?: { contextKind?: string; bucketBy?: string; seed?: number; variations: Array<{ variationIndex: number; weight: number }> };
  targets: FlagTarget[];
  rules: Rule[];
  prerequisites: Array<{ flagKey: string; variation: number }>;
}

export interface FlagDefinition {
  key: string;
  name: string;
  description: string | null;
  kind: FlagKind;
  tags: string[];
  temporary: boolean;
  clientAvailable: boolean;
  archived: boolean;
  createdAt: string;
  variations: Variation[];
}

export interface AuditEntry {
  id: string;
  action: string;
  entityKey: string | null;
  actorId: string | null;
  actorKind: string;
  actorName: string | null;
  actorEmail: string | null;
  environmentId: string | null;
  comment: string | null;
  createdAt: string;
  before?: unknown;
  after?: unknown;
}

export interface SdkKey {
  id: string;
  kind: "server" | "client" | "mobile";
  name: string | null;
  revokedAt: string | null;
  publicKey: string | null;
}

export interface Segment {
  key: string;
  name: string;
  external: boolean;
  memberCount: number | null;
}

export interface ScheduledChange {
  id: string;
  executeAt: string;
  executedAt: string | null;
  failedReason: string | null;
}

export interface ChangeRequest {
  id: string;
  status: string;
  patch: unknown;
  comment: string | null;
  requestedBy: string | null;
  createdAt: string;
}

export interface Health {
  status: string;
  version: string;
  checks: Record<string, { state: string; detail?: string }>;
  snapshots?: Array<{ environmentId: string; ageSeconds: number }>;
  partitionRunwayDays?: number;
}

/* ───────────────────────────── endpoints ────────────────────────────── */

const admin = "/v1/admin";
/**
 * A path segment, refused when it is empty.
 *
 * `project` and `environment` start as `""` in the session and are filled in
 * once the lists load — so every screen has a window, and a fresh deployment
 * with no project yet has a permanent state, where they are blank. Interpolated
 * straight into a template that produced
 * `/v1/admin/projects//environments//keys`: two empty segments, no route match,
 * and a 404 whose message says nothing about the actual problem.
 *
 * Reads were already gated on a `scoped` flag per page. Writes were not, and
 * could not be caught by that pattern anyway — the dialogs that perform them
 * read the session themselves, several components away from the guard. This is
 * the one place every URL is built, so it is the one place worth checking.
 *
 * Throwing beats returning a broken URL: the caller's `useAction` already
 * surfaces the message, so the user sees what is missing instead of a 404.
 */
function enc(segment: string, what = "path segment"): string {
  if (segment === "") {
    throw new Error(`featurekit: no ${what} selected — pick one before continuing`);
  }
  return encodeURIComponent(segment);
}

/** Named so the error says "project" rather than "path segment". */
const encProject = (value: string): string => enc(value, "project");
const encEnvironment = (value: string): string => enc(value, "environment");

export const A = {
  bootstrap: () => api.get<{ members: number }>(`${admin}/auth/bootstrap`),
  login: (email: string, password: string) =>
    api.post<{ member: Member }>(`${admin}/auth/login`, { email, password }),
  logout: () => api.post<{ ok: boolean }>(`${admin}/auth/logout`),
  me: () => api.get<{ member: Member | null; principal: Principal }>(`${admin}/auth/me`),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: boolean }>(`${admin}/auth/password`, { currentPassword, newPassword }),

  projects: () => api.get<{ projects: Project[] }>(`${admin}/projects`),
  createProject: (key: string, name: string) =>
    api.post<{ id: string; key: string }>(`${admin}/projects`, { key, name }),
  environments: (project: string) =>
    api.get<{ environments: Environment[] }>(`${admin}/projects/${encProject(project)}/environments`),
  createEnvironment: (
    project: string,
    input: { key: string; name: string; color?: string; isProduction: boolean },
  ) => api.post<{ id: string; key: string }>(`${admin}/projects/${encProject(project)}/environments`, input),

  flags: (project: string, environment: string, includeArchived = false) =>
    api.get<{ environment: string; flags: FlagRow[] }>(
      `${admin}/projects/${encProject(project)}/flags?environment=${encEnvironment(environment)}` +
        (includeArchived ? "&archived=true" : ""),
    ),
  flag: (project: string, key: string) =>
    api.get<FlagDefinition>(`${admin}/projects/${encProject(project)}/flags/${enc(key)}`),
  createFlag: (
    project: string,
    input: {
      key: string;
      name: string;
      description?: string;
      kind: FlagKind;
      temporary: boolean;
      clientAvailable: boolean;
      tags: string[];
      variations: Array<{ name?: string; value: unknown }>;
    },
  ) => api.post<{ id: string; key: string }>(`${admin}/projects/${encProject(project)}/flags`, input),
  archiveFlag: (project: string, key: string) =>
    api.delete<{ archived: boolean }>(`${admin}/projects/${encProject(project)}/flags/${enc(key)}`),
  restoreFlag: (project: string, key: string) =>
    api.post<{ archived: boolean }>(`${admin}/projects/${encProject(project)}/flags/${enc(key)}/restore`),

  config: (project: string, environment: string, key: string) =>
    api.get<FlagConfig>(flagPath(project, environment, key)),
  writeConfig: (project: string, environment: string, key: string, patch: unknown) =>
    api.patch<{ version: number; auditId: string; config: FlagConfig }>(
      flagPath(project, environment, key),
      patch,
    ),
  killSwitch: (project: string, environment: string, key: string, comment?: string) =>
    api.post<{ version: number; alreadyOff: boolean }>(
      `${flagPath(project, environment, key)}/off`,
      comment === undefined ? {} : { comment },
    ),
  revert: (project: string, environment: string, key: string, auditId: string) =>
    api.post<{ version: number }>(`${flagPath(project, environment, key)}/revert`, { auditId }),
  dryRun: (project: string, environment: string, key: string, patch: unknown, contexts: unknown[]) =>
    api.post<DryRunResult>(`${flagPath(project, environment, key)}/dry-run`, {
      patch,
      contexts,
      maxExamples: 10,
    }),
  metrics: (project: string, environment: string, key: string, hours = 24) =>
    api.get<{ flagKey: string; points: MetricPoint[] }>(
      `${flagPath(project, environment, key)}/metrics?hours=${hours}`,
    ),

  schedule: (project: string, environment: string, key: string) =>
    api.get<{ scheduled: ScheduledChange[] }>(`${flagPath(project, environment, key)}/schedule`),
  createSchedule: (
    project: string,
    environment: string,
    key: string,
    patch: unknown,
    executeAt: string,
  ) => api.post<{ id: string }>(`${flagPath(project, environment, key)}/schedule`, { patch, executeAt }),
  cancelSchedule: (project: string, environment: string, key: string, id: string) =>
    api.delete<{ cancelled: boolean }>(`${flagPath(project, environment, key)}/schedule/${enc(id)}`),

  requests: (project: string, environment: string, key: string) =>
    api.get<{ requests: ChangeRequest[] }>(`${flagPath(project, environment, key)}/requests`),
  approveRequest: (project: string, environment: string, key: string, id: string) =>
    api.post<{ status: string }>(`${flagPath(project, environment, key)}/requests/${enc(id)}/approve`),
  rejectRequest: (project: string, environment: string, key: string, id: string, comment?: string) =>
    api.post<{ status: string }>(
      `${flagPath(project, environment, key)}/requests/${enc(id)}/reject`,
      comment === undefined ? {} : { comment },
    ),

  audit: (project: string, options: { limit?: number; flag?: string } = {}) =>
    api.get<{ entries: AuditEntry[] }>(
      `${admin}/projects/${encProject(project)}/audit?limit=${options.limit ?? 50}` +
        (options.flag === undefined ? "" : `&flag=${encodeURIComponent(options.flag)}`),
    ),
  verifyAudit: (project: string) =>
    api.get<{ ok: boolean; checked: number; brokenAt?: string }>(
      `${admin}/projects/${encProject(project)}/audit/verify`,
    ),

  keys: (project: string, environment: string) =>
    api.get<{ keys: SdkKey[] }>(
      `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/keys`,
    ),
  createKey: (project: string, environment: string, kind: SdkKey["kind"], name?: string) =>
    api.post<{ id: string; kind: string; key: string }>(
      `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/keys`,
      name === undefined ? { kind } : { kind, name },
    ),
  revokeKey: (project: string, environment: string, id: string) =>
    api.delete<{ revoked: boolean }>(
      `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/keys/${enc(id)}`,
    ),

  segments: (project: string, environment: string) =>
    api.get<{ segments: Segment[] }>(
      `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/segments`,
    ),
  createSegment: (
    project: string,
    environment: string,
    input: { key: string; name: string; description?: string; external: boolean },
  ) =>
    api.post<{ id: string; key: string }>(
      `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/segments`,
      input,
    ),
  deleteSegment: (project: string, environment: string, key: string) =>
    api.delete<{ deleted: boolean }>(
      `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/segments/${enc(key)}`,
    ),
  segmentMembers: (
    project: string,
    environment: string,
    key: string,
    body: { add?: Array<{ contextKey: string }>; remove?: Array<{ contextKey: string }> },
  ) =>
    api.post<{ version: number; memberCount: number }>(
      `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/segments/${enc(key)}/members`,
      body,
    ),

  members: () => api.get<{ members: Member[] }>(`${admin}/members`),
  createMember: (input: { email: string; name?: string; role: Role; password?: string }) =>
    api.post<Member>(`${admin}/members`, input),
  updateMember: (id: string, patch: { name?: string | null; role?: Role; password?: string }) =>
    api.patch<Member>(`${admin}/members/${enc(id)}`, patch),
  deleteMember: (id: string) => api.delete<{ removed: boolean }>(`${admin}/members/${enc(id)}`),

  tokens: () =>
    api.get<{ tokens: Array<{ id: string; name: string | null; environmentIds: string[] | null; lastUsedAt: string | null; expiresAt: string | null }> }>(
      `${admin}/tokens`,
    ),
  createToken: (input: { name?: string; environmentIds?: string[]; expiresAt?: string }) =>
    api.post<{ id: string; token: string }>(`${admin}/tokens`, input),
  revokeToken: (id: string) => api.delete<{ revoked: boolean }>(`${admin}/tokens/${enc(id)}`),

  recent: (project: string, environment: string) =>
    api.get<{ flags: Array<{ key: string; name: string; enabled: boolean; updatedAt: string }> }>(
      `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/recent`,
    ),

  health: () => api.get<Health>("/health"),
};

export interface MetricPoint {
  bucketAt: string;
  variationIdx: number | null;
  reason: string;
  count: number;
}

export interface DryRunResult {
  flagKey: string;
  evaluated: number;
  changed: number;
  churn?: number;
  before: Record<string, number>;
  after: Record<string, number>;
  examples: Array<{ context: unknown; before: unknown; after: unknown }>;
  warning?: string;
}

function flagPath(project: string, environment: string, key: string): string {
  return `${admin}/projects/${encProject(project)}/environments/${encEnvironment(environment)}/flags/${enc(key)}`;
}

/** Weights are integers out of 100,000. Percentages are for humans only. */
export const WEIGHT_SCALE = 100_000;
export const toPercent = (weight: number): number => weight / (WEIGHT_SCALE / 100);
export const fromPercent = (percent: number): number => Math.round(percent * (WEIGHT_SCALE / 100));
