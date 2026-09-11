/**
 * The landing page: what changed, and is anything on fire.
 *
 * Deliberately two panels and no charts. The questions someone opens a flag
 * dashboard with are "what did somebody just change" and "is the control plane
 * healthy"; a wall of graphs answers neither.
 */

import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { A } from "../lib/api";
import { useResource } from "../lib/hooks";
import { useSession } from "../lib/session";
import { relativeTime, absoluteTime } from "../lib/utils";
import { Page } from "../components/page";
import { Badge, Card, EmptyState, Spinner } from "../components/ui";

export function OverviewPage() {
  const { project, environment, currentEnvironment } = useSession();
  const scoped = project !== "" && environment !== "";

  const recent = useResource(() => A.recent(project, environment), [project, environment], {
    enabled: scoped,
  });
  const health = useResource(() => A.health(), []);
  const flags = useResource(() => A.flags(project, environment), [project, environment], {
    enabled: scoped,
  });

  const list = flags.data?.flags ?? [];
  const on = list.filter((flag) => flag.environment?.enabled === true).length;
  const targeted = list.filter((flag) => (flag.environment?.ruleCount ?? 0) > 0).length;

  return (
    <Page
      title="Overview"
      description={
        scoped
          ? `${project} · ${environment}${currentEnvironment?.isProduction === true ? " · production" : ""}`
          : "Pick a project to begin"
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Flags" value={list.length} loading={flags.loading} />
        <Stat label="On in this environment" value={on} loading={flags.loading} />
        <Stat label="With targeting rules" value={targeted} loading={flags.loading} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Recently changed"
          description="In this environment, newest first"
          actions={
            <Link
              to="/flags"
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              All flags <ArrowRight className="size-3" />
            </Link>
          }
        >
          {recent.loading ? (
            <Spinner />
          ) : (recent.data?.flags?.length ?? 0) === 0 ? (
            <EmptyState title="Nothing has changed here yet" />
          ) : (
            <ul className="divide-y divide-border">
              {recent.data?.flags?.map((flag) => (
                <li key={flag.key} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <Link
                      to={`/flags/${encodeURIComponent(flag.key)}`}
                      className="truncate text-sm hover:text-accent"
                    >
                      {flag.name}
                    </Link>
                    <p className="truncate font-mono text-[11px] text-faint">{flag.key}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={flag.enabled ? "on" : "off"}>{flag.enabled ? "on" : "off"}</Badge>
                    <span className="text-[11px] text-faint" title={absoluteTime(flag.updatedAt)}>
                      {relativeTime(flag.updatedAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Control plane" description="What /health reports right now">
          {health.loading ? (
            <Spinner />
          ) : health.data === null ? (
            <EmptyState title="Health is unreachable" />
          ) : (
            <div className="space-y-2">
              {Object.entries(health.data.checks ?? {}).map(([name, check]) => (
                <div key={name} className="flex items-center justify-between gap-3">
                  <span className="text-sm capitalize">{name}</span>
                  <span className="flex items-center gap-1.5 text-xs">
                    {check.state === "ok" ? (
                      <CheckCircle2 className="size-3.5 text-on" />
                    ) : (
                      <AlertTriangle className="size-3.5 text-warn" />
                    )}
                    <span className={check.state === "ok" ? "text-on" : "text-warn"}>
                      {check.state}
                      {check.detail === undefined ? "" : ` · ${check.detail}`}
                    </span>
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-xs text-muted">
                <span>version</span>
                <span className="font-mono">{health.data.version}</span>
              </div>
              {health.data.partitionRunwayDays !== undefined ? (
                <div className="flex items-center justify-between gap-3 text-xs text-muted">
                  <span>partition runway</span>
                  <span className="font-mono">{health.data.partitionRunwayDays} days</span>
                </div>
              ) : null}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}

function Stat({ label, value, loading }: { label: string; value: number; loading: boolean }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{loading ? "—" : value}</p>
    </div>
  );
}
