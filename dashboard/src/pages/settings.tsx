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
    <Page title="Settings" description="Projects, environments, accounts, tokens and health">
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
    return <Card title="Members" description="Admins and owners can see the account list." />;
  }

  const rows = members.data?.members ?? [];

  return (
    <Card
      title="Members"
      description="Who can sign in, and what they may do"
      actions={
        can("owner") ? (
          <Button variant="secondary" size="sm" onClick={() => setInviting(true)}>
            <Plus className="size-3.5" />
            Add
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
                <p className="truncate text-sm">
                  {row.email}
                  {row.id === me?.id ? <span className="ml-1 text-xs text-faint">(you)</span> : null}
                </p>
                <p className="text-[11px] text-faint">
                  {row.hasPassword ? "password set" : "token only"} · last login{" "}
                  <span title={absoluteTime(row.lastLoginAt)}>{relativeTime(row.lastLoginAt)}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {can("owner") ? (
                  <Select
                    className="h-7 w-24 text-xs"
                    value={row.role}
                    onChange={(event) => {
                      void A.updateMember(row.id, { role: event.target.value as Role })
                        .then(() => toast.push("ok", `${row.email} is now ${event.target.value}`))
                        .catch((error: Error) => toast.push("error", error.message))
                        .finally(() => void members.reload());
                    }}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge tone="neutral">{row.role}</Badge>
                )}
                {can("owner") && row.id !== me?.id ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${row.email}`}
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
        title={`Remove ${removing?.email ?? ""}?`}
        confirmLabel="Remove"
        body={
          <p>
            Their sessions end immediately and their personal access tokens stop working. Audit
            entries they wrote are kept.
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
    toast.push("ok", `${created.email} added`);
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
      title="Add a member"
      description="There is no email flow here: you set the first password and tell them, and they change it."
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
      <Field label="Email">
        <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
      </Field>
      <Field label="Role">
        <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {ROLES.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Initial password"
        hint="At least 12 characters. Leave empty for an account that can only use access tokens."
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
      title="Access tokens"
      description="For CI and scripts. Yours only — nobody else can list them."
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
        <EmptyState title="No tokens" body="A token authenticates the management API from a script." />
      ) : (
        <ul className="divide-y divide-border">
          {tokens.data?.tokens?.map((token) => (
            <li key={token.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{token.name ?? "unnamed"}</p>
                <p className="text-[11px] text-faint">
                  {token.environmentIds === null
                    ? "every environment"
                    : `${token.environmentIds.length} environment(s)`}{" "}
                  · used {relativeTime(token.lastUsedAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Revoke token"
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
        title="New access token"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.busy} onClick={() => void create.run()}>
              Create
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="ci" />
        </Field>
        <Field
          label="Scope"
          hint="An unscoped token can touch every environment, production included."
        >
          <Select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="">every environment</option>
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
        title="Copy this token now"
        description="It is stored hashed. This is the only time it will be shown."
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
    toast.push("ok", `${created.key} created`);
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
      description="Projects and workspaces in this deployment"
      actions={
        can("admin") ? (
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New
          </Button>
        ) : undefined
      }
    >
      {projects.length === 0 ? (
        <EmptyState title="No projects" body="Create a project to start managing flags." />
      ) : (
        <ul className="divide-y divide-border">
          {projects.map((p) => {
            const isActive = p.key === activeProject;
            return (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    <span className="font-mono text-[11px] text-faint">({p.key})</span>
                    {isActive ? <Badge tone="neutral">active</Badge> : null}
                  </div>
                  <p className="text-[11px] text-faint">
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
        title="New project"
        description="A project groups environments, flags, and segments together."
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
              Create
            </Button>
          </>
        }
      >
        <Field label="Key" hint="Unique slug, e.g. web-app or billing">
          <Input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="web-app"
          />
        </Field>
        <Field label="Name" hint="Human-readable project name">
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
            This will permanently delete this project and all its flags, environments, targeting
            rules, segments, and SDK keys. This action cannot be undone.
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
    toast.push("ok", `${created.key} created — reload to switch to it`);
    setKey("");
    setName("");
    setCreating(false);
    return created;
  });

  return (
    <Card
      title="Environments"
      description={`In ${project}`}
      actions={
        can("admin") ? (
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New
          </Button>
        ) : undefined
      }
    >
      <ul className="divide-y divide-border">
        {environments.map((environment) => (
          <li key={environment.id} className="flex items-center justify-between gap-3 py-2">
            <span className="flex items-center gap-2 text-sm">
              <span
                className="size-2 rounded-full"
                style={{ background: environmentTint(environment.key, environment.color) }}
              />
              {environment.name}
              {environment.isProduction ? <Badge tone="danger">production</Badge> : null}
            </span>
            <span className="font-mono text-[11px] text-faint">
              snapshot v{environment.snapshotVersion}
            </span>
          </li>
        ))}
      </ul>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New environment"
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
              Create
            </Button>
          </>
        }
      >
        <Field label="Key">
          <Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="staging" />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Staging" />
        </Field>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={isProduction}
            onChange={(event) => setIsProduction(event.target.checked)}
          />
          Production — the client tier will require signed contexts here
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
    toast.push("ok", "Password changed — sign in again");
    setCurrent("");
    setNext("");
    // Every session ended, including this one. Reflecting that immediately is
    // more honest than waiting for the next request to 401.
    await session.signOut();
    return null;
  });

  return (
    <Card title="Your password" description="Changing it ends every session you have, including this one.">
      <div className="space-y-3">
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>
        <Field label="New password" hint="At least 12 characters.">
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </Field>
        {change.error !== null ? <ErrorNote>{change.error.message}</ErrorNote> : null}
        {session.principal?.kind === "token" ? (
          <InfoNote>You are authenticated with an access token, not a password.</InfoNote>
        ) : null}
        <Button
          variant="secondary"
          loading={change.busy}
          disabled={current === "" || next === ""}
          onClick={() => void change.run()}
        >
          Change password
        </Button>
      </div>
    </Card>
  );
}
