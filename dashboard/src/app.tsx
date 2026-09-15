/**
 * The shell: sidebar, switchers, routes.
 *
 * Two rules the layout enforces rather than suggests:
 *
 * 1. **The environment you are editing is visible at all times**, and a
 *    production one is coloured differently everywhere it appears. The most
 *    expensive mistake a flag dashboard permits is editing the right flag in
 *    the wrong environment.
 * 2. **Nothing renders until we know who you are.** A screen that paints and
 *    then bounces you to a login has already leaked its shape and made two
 *    requests that were never going to work.
 */

import { useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  Activity,
  ChevronDown,
  Flag,
  History,
  KeyRound,
  LogOut,
  Plus,
  Settings,
  Users,
} from "lucide-react";
import { useSession } from "./lib/session";
import { useAction } from "./lib/hooks";
import { A } from "./lib/api";
import { cn, environmentTint } from "./lib/utils";
import {
  Badge,
  Button,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  useToast,
} from "./components/ui";
import { LoginPage } from "./pages/login";
import { OverviewPage } from "./pages/overview";
import { FlagsPage } from "./pages/flags";
import { FlagDetailPage } from "./pages/flag-detail";
import { SegmentsPage } from "./pages/segments";
import { AuditPage } from "./pages/audit";
import { KeysPage } from "./pages/keys";
import { SettingsPage } from "./pages/settings";

const NAV = [
  { to: "/", label: "Overview", icon: Activity, end: true },
  { to: "/flags", label: "Flags", icon: Flag, end: false },
  { to: "/segments", label: "Segments", icon: Users, end: false },
  { to: "/audit", label: "Audit", icon: History, end: false },
  { to: "/keys", label: "SDK keys", icon: KeyRound, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];

export function App() {
  const session = useSession();

  if (session.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (session.status === "anonymous") return <LoginPage />;

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/flags" element={<FlagsPage />} />
          <Route path="/flags/:flagKey" element={<FlagDetailPage />} />
          <Route path="/segments" element={<SegmentsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/keys" element={<KeysPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Sidebar() {
  const session = useSession();
  const location = useLocation();
  const toast = useToast();
  const environment = session.currentEnvironment;
  const tint = environment === null ? null : environmentTint(environment.key, environment.color);

  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectKey, setNewProjectKey] = useState("");
  const [newProjectName, setNewProjectName] = useState("");

  const createProject = useAction(async () => {
    const created = await A.createProject(
      newProjectKey.trim(),
      newProjectName.trim() === "" ? newProjectKey.trim() : newProjectName.trim(),
    );
    toast.push("ok", `${created.key} created`);
    setNewProjectKey("");
    setNewProjectName("");
    setCreatingProject(false);
    await session.refreshProjects();
    session.setProject(created.key);
    return created;
  });

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="grid size-6 place-items-center rounded bg-accent text-[13px] font-bold text-accent-ink">
          f
        </span>
        <span className="text-sm font-semibold tracking-tight">featurekit</span>
      </div>

      <div className="space-y-2 px-3 pb-3">
        <Switcher
          label="Project"
          value={session.project}
          onChange={session.setProject}
          options={session.projects.map((project) => ({
            value: project.key,
            label: project.name,
          }))}
          action={
            session.can("admin") ? (
              <button
                type="button"
                aria-label="New project"
                className="flex items-center gap-0.5 text-[10px] text-faint hover:text-ink transition"
                onClick={() => setCreatingProject(true)}
              >
                <Plus className="size-3" />
                <span>New</span>
              </button>
            ) : undefined
          }
        />
        <div className="relative">
          <Switcher
            label="Environment"
            value={session.environment}
            onChange={session.setEnvironment}
            options={session.environments.map((item) => ({
              value: item.key,
              label: item.isProduction ? `${item.name} · production` : item.name,
            }))}
          />
          {/* The tint is the whole point: production must not look like staging. */}
          {tint !== null ? (
            <span
              className="pointer-events-none absolute left-2 top-[30px] size-2 rounded-full"
              style={{ background: tint }}
              aria-hidden
            />
          ) : null}
        </div>
        {environment?.isProduction === true ? (
          <Badge tone="danger" className="w-full justify-center">
            editing production
          </Badge>
        ) : null}
      </div>

      <nav className="flex-1 space-y-0.5 px-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = item.end
            ? location.pathname === item.to
            : location.pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition",
                active ? "bg-raised text-ink" : "text-muted hover:bg-raised hover:text-ink",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <div className="mb-2 min-w-0">
          <p className="truncate text-xs font-medium">{session.member?.email ?? "—"}</p>
          <p className="text-[11px] text-faint">{session.principal?.role ?? ""}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => void session.signOut()}
        >
          <LogOut className="size-3.5" />
          Sign out
        </Button>
      </div>

      <Dialog
        open={creatingProject}
        onClose={() => setCreatingProject(false)}
        title="New project"
        description="A project groups environments, flags, and segments together."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreatingProject(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createProject.busy}
              disabled={newProjectKey.trim() === ""}
              onClick={() => void createProject.run()}
            >
              Create project
            </Button>
          </>
        }
      >
        <Field label="Key" hint="Unique slug, e.g. web-app or billing">
          <Input
            value={newProjectKey}
            onChange={(event) => setNewProjectKey(event.target.value)}
            placeholder="web-app"
          />
        </Field>
        <Field label="Name" hint="Human-readable project name">
          <Input
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            placeholder="Web App"
          />
        </Field>
        {createProject.error !== null ? <ErrorNote>{createProject.error.message}</ErrorNote> : null}
      </Dialog>
    </aside>
  );
}

function Switcher({
  label,
  value,
  onChange,
  options,
  action,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  action?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
        {action}
      </div>
      <div className="relative">
        <Select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 appearance-none pl-6 text-[13px]"
        >
          {options.length === 0 ? <option value="">none</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <ChevronDown className="pointer-events-none absolute right-2 top-2 size-4 text-faint" />
      </div>
    </div>
  );
}
