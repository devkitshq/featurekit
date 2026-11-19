/**
 * Projects: the tenancy root every other row hangs from.
 */

import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { environments, projects } from "../db/schema.js";
import { HttpError } from "../http/router.js";
import { type Principal, canAccessEnvironment } from "../auth/principal.js";

export async function listProjects(
  db: Database,
  principal: Principal,
): Promise<Array<{ id: string; key: string; name: string; environments: string[] }>> {
  const rows = await db
    .select({
      projectId: projects.id,
      projectKey: projects.key,
      projectName: projects.name,
      environmentId: environments.id,
      environmentKey: environments.key,
    })
    .from(projects)
    .leftJoin(environments, eq(environments.projectId, projects.id))
    .orderBy(asc(projects.key));

  const byProject = new Map<string, { id: string; key: string; name: string; environments: string[] }>();
  for (const row of rows) {
    // Scope filtering happens here rather than in SQL because a token scoped to
    // one environment should still see the project that contains it — with only
    // that environment listed.
    if (row.environmentId !== null && !canAccessEnvironment(principal, row.environmentId)) continue;
    const entry = byProject.get(row.projectId) ?? {
      id: row.projectId,
      key: row.projectKey,
      name: row.projectName,
      environments: [],
    };
    if (row.environmentKey !== null) entry.environments.push(row.environmentKey);
    byProject.set(row.projectId, entry);
  }
  // A scoped token sees no project it has no environment in.
  return [...byProject.values()].filter(
    (p) => p.environments.length > 0 || principal.environmentIds === null,
  );
}

export async function createProject(
  db: Database,
  input: { key: string; name: string },
): Promise<{ id: string; key: string }> {
  const [row] = await db
    .insert(projects)
    .values({ key: input.key, name: input.name })
    .onConflictDoNothing()
    .returning({ id: projects.id, key: projects.key });
  if (row === undefined) throw new HttpError(409, "ALREADY_EXISTS", "a project with that key exists");
  return row;
}

export async function findProject(
  db: Database,
  projectKey: string,
): Promise<{ id: string; key: string } | null> {
  const [row] = await db
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(eq(projects.key, projectKey))
    .limit(1);
  return row ?? null;
}

export async function deleteProject(
  db: Database,
  projectKey: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(projects)
    .where(eq(projects.key, projectKey))
    .returning({ id: projects.id });
  return { deleted: result.length > 0 };
}
