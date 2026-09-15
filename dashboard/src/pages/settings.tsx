/**
 * Settings: the people, the tokens, the environments, and the machine.
 *
 * Four small panels rather than four pages, because each is a thing somebody
 * touches once a quarter and none of them is worth a navigation step.
 */

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { A, type Member, type Role } from "../lib/api";
import { useAction, useResource } from "../lib/hooks";
import { useSession } from "../lib/session";
import { absoluteTime, environmentTint, relativeTime } from "../lib/utils";
import { Page } from "../components/page";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  CopyableKey,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  InfoNote,
  Select,
  Spinner,
  useToast,
} from "../components/ui";

const ROLES: Role[] = ["reader", "writer", "admin", "owner"];

export function SettingsPage() {
  return (
    <Page title="Settings" description="Manage projects, environments, team members, access tokens, and security">
      <div className="grid gap-4 lg:grid-cols-2">
        <ProjectsCard />
        <EnvironmentsCard />
        <MembersCard />
        <TokensCard />
        <PasswordCard />
      </div>
    </Page>
  );
}

/* ─────────────────────────────── members ────────────────────────────── */

function MembersCard() {
  const { can, member: me } = useSession();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const members = useResource(() => A.members(), [], { enabled: can("admin") });

  if (!can("admin")) {
    return <Card title="Team members" description="Administrator permissions are required to view and manage team members." />;
  }

  const rows = members.data?.members ?? [];

  return (
    <Card
      title="Team members"
      description="Manage account roles and permissions across your team"
      actions={
        can("owner") ? (
          <Button variant="secondary" size="sm" onClick={() => setInviting(true)}>
            <Plus className="size-3.5" />
            Add member
          </Button>
        ) : undefined
      }
    >
      {members.loading ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.email}
                  {row.id === me?.id ? <span className="ml-1 text-xs text-muted-foreground font-normal">(you)</span> : null}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {row.hasPassword ? "Password configured" : "API token access only"} · Last login:{" "}
                  <span title={absoluteTime(row.lastLoginAt)}>{relativeTime(row.lastLoginAt)}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {can("owner") ? (
                  <Select
                    className="h-7 w-24 text-xs capitalize"
                    value={row.role}
                    onChange={(event) => {
                      void A.updateMember(row.id, { role: event.target.value as Role })
                        .then(() => toast.push("ok", `Updated ${row.email} to ${event.target.value}`))
                        .catch((error: Error) => toast.push("error", error.message))
                        .finally(() => void members.reload());
                    }}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role} className="capitalize">
                        {role}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge tone="neutral" className="capitalize">{row.role}</Badge>
                )}
                {can("owner") && row.id !== me?.id ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${row.email}`}
                    title={`Remove ${row.email}`}
                    className="hover:text-danger"
                    onClick={() => setRemoving(row)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <InviteDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onCreated={() => void members.reload()}
      />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove member "${removing?.email ?? ""}"?`}
        confirmLabel="Remove member"
        body={
          <p>
            Their active sessions will end immediately and their personal access tokens will be revoked. All existing audit log entries created by this account are preserved.
          </p>
        }
        onConfirm={async () => {
          if (removing === null) return;
          try {
            await A.deleteMember(removing.id);
            toast.push("ok", `${removing.email} removed`);
          } catch (error) {
            toast.push("error", error instanceof Error ? error.message : String(error));
          }
          await members.reload();
        }}
      />
    </Card>
  );
}

function InviteDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("writer");
  const [password, setPassword] = useState("");

  const create = useAction(async () => {
    const created = await A.createMember({
      email: email.trim(),
      role,
      ...(password === "" ? {} : { password }),
    });
    toast.push("ok", `Member ${created.email} added`);
    setEmail("");
    setPassword("");
    onCreated();
    onClose();
    return created;
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add team member"
      description="Create an account and assign an initial role. You can set an initial temporary password or leave it blank for token-only access."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.busy}
            disabled={email.trim() === ""}
            onClick={() => void create.run()}
          >
            Add member
          </Button>
        </>
      }
    >
      <Field label="Email address">
        <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="colleague@example.com" />
      </Field>
      <Field label="Role">
        <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {ROLES.map((entry) => (
            <option key={entry} value={entry} className="capitalize">
              {entry.charAt(0).toUpperCase() + entry.slice(1)}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Initial password"
        hint="Must be at least 12 characters. Leave empty for an account using only personal access tokens."
      >
        <Input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          autoComplete="new-password"
        />
      </Field>
      {create.error !== null ? <ErrorNote>{create.error.message}</ErrorNote> : null}
    </Dialog>
  );
}

/* ──────────────────────────────── tokens ────────────────────────────── */

function TokensCard() {
  const { environments } = useSession();
  const toast = useToast();
  const tokens = useResource(() => A.tokens(), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string>("");
  const [minted, setMinted] = useState<string | null>(null);

  const create = useAction(async () => {
    const created = await A.createToken({
      ...(name.trim() === "" ? {} : { name: name.trim() }),
      ...(scope === "" ? {} : { environmentIds: [scope] }),
    });
    setMinted(created.token);
    setName("");
    setCreating(false);
    await tokens.reload();
    return created;
  });

  return (
    <Card
      title="Personal access tokens"
      description="Manage API tokens for CI/CD pipelines, automated scripts, and integrations"
      actions={
        <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          New token
        </Button>
      }
    >
      {tokens.loading ? (
        <Spinner />
      ) : (tokens.data?.tokens?.length ?? 0) === 0 ? (
        <EmptyState
          title="No access tokens created yet"
          body="Access tokens allow external scripts and CI/CD tools to authenticate with the management API."
          action={
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New token
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {tokens.data?.tokens?.map((token) => (
            <li key={token.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{token.name ?? "unnamed token"}</p>
                <p className="text-[11px] text-muted-foreground">
                  {token.environmentIds === null
                    ? "All environments"
                    : `Scoped to ${token.environmentIds.length} environment(s)`}{" "}
                  · Last used: {relativeTime(token.lastUsedAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Revoke token"
                title="Revoke token"
                className="hover:text-danger"
                onClick={() => {
                  void A.revokeToken(token.id)
                    .then(() => toast.push("ok", "Token revoked"))
                    .catch((error: Error) => toast.push("error", error.message))
                    .finally(() => void tokens.reload());
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create access token"
        description="Generate an API token for management automation and CI/CD workflows."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.busy} onClick={() => void create.run()}>
              Create token
            </Button>
          </>
        }
      >
        <Field label="Token name" hint="Descriptive label (e.g. github-actions-ci)">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="github-actions-ci" />
        </Field>
        <Field
          label="Environment scope"
          hint="Limit this token's access to a single environment or allow all environments."
        >
          <Select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="">All environments</option>
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </Select>
        </Field>
        {create.error !== null ? <ErrorNote>{create.error.message}</ErrorNote> : null}
      </Dialog>

      <Dialog
        open={minted !== null}
        onClose={() => setMinted(null)}
        title="Copy your access token"
        description="Access tokens are hashed and stored securely. This is the only time your token will be displayed."
        footer={
          <Button variant="primary" onClick={() => setMinted(null)}>
            Done
          </Button>
        }
      >
        <CopyableKey value={minted ?? ""} className="w-full" />
      </Dialog>
    </Card>
  );
}

/* ─────────────────────────────── projects ───────────────────────────── */

function ProjectsCard() {
  const { projects, project: activeProject, setProject, refreshProjects, can } = useSession();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; key: string; name: string } | null>(null);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");

  const create = useAction(async () => {
    const created = await A.createProject(
      key.trim(),
      name.trim() === "" ? key.trim() : name.trim(),
    );
    toast.push("ok", `Project ${created.key} created`);
    setKey("");
    setName("");
    setCreating(false);
    await refreshProjects();
    setProject(created.key);
    return created;
  });

  return (
    <Card
      title="Projects"
      description="Manage workspaces and applications in this deployment"
      actions={
        can("admin") ? (
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New project
          </Button>
        ) : undefined
      }
    >
      {projects.length === 0 ? (
        <EmptyState title="No projects created" body="Create a project to start organizing flags and environments." />
      ) : (
        <ul className="divide-y divide-border">
          {projects.map((p) => {
            const isActive = p.key === activeProject;
            return (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">({p.key})</span>
                    {isActive ? <Badge tone="neutral">active</Badge> : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {p.environments.length === 1
                      ? "1 environment"
                      : `${p.environments.length} environments`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!isActive ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setProject(p.key)}
                      className="text-xs"
                    >
                      Switch
                    </Button>
                  ) : null}
                  {can("admin") ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete project ${p.key}`}
                      title={`Delete project ${p.key}`}
                      className="hover:text-danger"
                      onClick={() => setDeleting(p)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create project"
        description="Projects group environments, feature flags, and segments together."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.busy}
              disabled={key.trim() === ""}
              onClick={() => void create.run()}
            >
              Create project
            </Button>
          </>
        }
      >
        <Field label="Project key" hint="Unique identifier (e.g. web-app or billing)">
          <Input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="web-app"
          />
        </Field>
        <Field label="Project name" hint="Display name for your team">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Web App"
          />
        </Field>
        {create.error !== null ? <ErrorNote>{create.error.message}</ErrorNote> : null}
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete project "${deleting?.name ?? ""}" (${deleting?.key ?? ""})?`}
        confirmLabel="Delete project"
        body={
          <p>
            This will permanently delete this project along with all its feature flags, environments, targeting rules, segments, and SDK keys. This action cannot be undone.
          </p>
        }
        onConfirm={async () => {
          if (deleting === null) return;
          try {
            await A.deleteProject(deleting.key);
            toast.push("ok", `Project ${deleting.key} deleted`);
          } catch (error) {
            toast.push("error", error instanceof Error ? error.message : String(error));
          }
          await refreshProjects();
        }}
      />
    </Card>
  );
}

/* ───────────────────────────── environments ─────────────────────────── */

function EnvironmentsCard() {
  const { project, environments, can } = useSession();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [isProduction, setIsProduction] = useState(false);

  const create = useAction(async () => {
    const created = await A.createEnvironment(project, {
      key: key.trim(),
      name: name.trim() === "" ? key.trim() : name.trim(),
      isProduction,
    });
    toast.push("ok", `Environment ${created.key} created`);
    setKey("");
    setName("");
    setCreating(false);
    return created;
  });

  return (
    <Card
      title="Environments"
      description={`Configured environments in ${project}`}
      actions={
        can("admin") ? (
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New environment
          </Button>
        ) : undefined
      }
    >
      <ul className="divide-y divide-border">
        {environments.map((environment) => (
          <li key={environment.id} className="flex items-center justify-between gap-3 py-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <span
                className="size-2 rounded-full"
                style={{ background: environmentTint(environment.key, environment.color) }}
              />
              {environment.name}
              {environment.isProduction ? <Badge tone="danger">production</Badge> : null}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              Snapshot v{environment.snapshotVersion}
            </span>
          </li>
        ))}
      </ul>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create environment"
        description="Add a new deployment environment for this project."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.busy}
              disabled={key.trim() === ""}
              onClick={() => void create.run()}
            >
              Create environment
            </Button>
          </>
        }
      >
        <Field label="Environment key" hint="Unique slug (e.g. staging or production)">
          <Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="staging" />
        </Field>
        <Field label="Environment name" hint="Display name (e.g. Staging or QA)">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Staging" />
        </Field>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={isProduction}
            onChange={(event) => setIsProduction(event.target.checked)}
          />
          <span>Production environment — requires signed evaluation contexts and heightened visual safety alerts</span>
        </label>
        {create.error !== null ? <ErrorNote>{create.error.message}</ErrorNote> : null}
      </Dialog>
    </Card>
  );
}

/* ────────────────────────────── password ────────────────────────────── */

function PasswordCard() {
  const session = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  const change = useAction(async () => {
    await A.changePassword(current, next);
    toast.push("ok", "Password updated successfully. Please sign in again.");
    setCurrent("");
    setNext("");
    await session.signOut();
    return null;
  });

  return (
    <Card title="Change password" description="Update your login password. You will need to sign in again after updating.">
      <div className="space-y-3">
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>
        <Field label="New password" hint="Must be at least 12 characters.">
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </Field>
        {change.error !== null ? <ErrorNote>{change.error.message}</ErrorNote> : null}
        {session.principal?.kind === "token" ? (
          <InfoNote>You are authenticated via personal access token rather than password.</InfoNote>
        ) : null}
        <Button
          variant="secondary"
          loading={change.busy}
          disabled={current === "" || next === ""}
          onClick={() => void change.run()}
        >
          Update password
        </Button>
      </div>
    </Card>
  );
}
