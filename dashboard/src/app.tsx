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
  Layers,
} from "lucide-react";
import { useSession } from "@/lib/session";
import { useAction } from "@/lib/hooks";
import { A } from "@/lib/api";
import { cn, environmentTint } from "@/lib/utils";
import {
  Badge,
  Button,
  Dialog,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
  TooltipProvider,
  useToast,
} from "@/components/ui";
import { LoginPage } from "@/pages/login";
import { OverviewPage } from "@/pages/overview";
import { FlagsPage } from "@/pages/flags";
import { FlagDetailPage } from "@/pages/flag-detail";
import { SegmentsPage } from "@/pages/segments";
import { AuditPage } from "@/pages/audit";
import { KeysPage } from "@/pages/keys";
import { SettingsPage } from "@/pages/settings";

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
      <div className="flex h-full items-center justify-center bg-background">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (session.status === "anonymous") return <LoginPage />;

  return (
    <TooltipProvider>
      <div className="flex h-full bg-background text-foreground">
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
    </TooltipProvider>
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

  const memberInitial = (session.member?.email ?? "U").charAt(0).toUpperCase();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card/50 backdrop-blur-xs">
      {/* Brand Header */}
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border/50">
        <span className="grid size-7 place-items-center rounded-lg bg-primary text-xs font-bold text-primary-foreground shadow-xs">
          <Layers className="size-4" />
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-semibold tracking-tight text-foreground">togglekit</span>
          <span className="text-[10px] text-muted-foreground font-mono leading-none">control plane</span>
        </div>
      </div>

      {/* Switchers */}
      <div className="space-y-2.5 p-3.5 border-b border-border/50 bg-muted/15">
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
                className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition cursor-pointer font-medium"
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
              className="pointer-events-none absolute left-2 top-[28px] size-2 rounded-full"
              style={{ background: tint }}
              aria-hidden
            />
          ) : null}
        </div>
        {environment?.isProduction === true ? (
          <Badge tone="danger" className="w-full justify-center text-[10px] uppercase tracking-wider py-1 font-semibold">
            editing production
          </Badge>
        ) : null}
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 space-y-1 p-3">
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
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors cursor-pointer",
                active
                  ? "bg-secondary text-foreground font-semibold shadow-xs"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4", active ? "text-primary" : "text-muted-foreground")} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      {/* Footer User Info */}
      <div className="border-t border-border/70 p-3 bg-muted/10">
        <div className="mb-2.5 flex items-center gap-2.5 px-1">
          <div className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary font-mono text-xs font-semibold text-foreground border border-border/70">
            {memberInitial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">{session.member?.email ?? "—"}</p>
            <p className="text-[10px] text-muted-foreground capitalize font-medium">{session.principal?.role ?? ""}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-xs text-muted-foreground hover:text-destructive"
          onClick={() => void session.signOut()}
        >
          <LogOut className="size-3.5" />
          Sign out
        </Button>
      </div>

      <Dialog
        open={creatingProject}
        onClose={() => setCreatingProject(false)}
        title="Create project"
        description="Projects help you organize environments, feature flags, and segments for a specific service or team."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreatingProject(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              loading={createProject.busy}
              disabled={newProjectKey.trim() === ""}
              onClick={() => void createProject.run()}
            >
              Create project
            </Button>
          </>
        }
      >
        <Field label="Project key" hint="Unique identifier (e.g. web-app or billing)">
          <Input
            value={newProjectKey}
            onChange={(event) => setNewProjectKey(event.target.value)}
            placeholder="web-app"
          />
        </Field>
        <Field label="Project name" hint="Display name shown in the dashboard">
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
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        {action}
      </div>
      <div className="relative">
        <Select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 appearance-none pl-6 text-xs"
        >
          {options.length === 0 ? <option value="">none</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <ChevronDown className="pointer-events-none absolute right-2 top-2 size-4 text-muted-foreground" />
      </div>
    </div>
  );
}
