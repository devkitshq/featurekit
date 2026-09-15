/**
 * The audit log.
 *
 * Who changed what, when, and what it looked like before. The verify button is
 * owner-only because the answer — "somebody edited the audit log" — is itself
 * sensitive, and because checking walks the project's whole history.
 */

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { A } from "../lib/api";
import { useAction, useResource } from "../lib/hooks";
import { useSession } from "../lib/session";
import { absoluteTime, relativeTime } from "../lib/utils";
import { Page } from "../components/page";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  InfoNote,
  Spinner,
} from "../components/ui";

export function AuditPage() {
  const { project, can } = useSession();
  const [flag, setFlag] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const audit = useResource(
    () => A.audit(project, { limit: 100, ...(flag === "" ? {} : { flag }) }),
    [project, flag],
    { enabled: project !== "" },
  );

  const verify = useAction(async () => A.verifyAudit(project));
  const entries = audit.data?.entries ?? [];

  return (
    <Page
      title="Audit log"
      description={`Complete history of configuration changes in ${project}`}
      actions={
        can("admin") ? (
          <Button variant="secondary" size="sm" loading={verify.busy} onClick={() => void verify.run()}>
            <ShieldCheck className="size-3.5" />
            Verify audit chain
          </Button>
        ) : undefined
      }
    >
      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter by flag key…"
          value={flag}
          onChange={(event) => setFlag(event.target.value)}
          className="max-w-64"
        />
      </div>

      {verify.error !== null ? <ErrorNote>{verify.error.message}</ErrorNote> : null}

      {audit.loading ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No audit entries recorded yet"
          body="All flag updates, schedule triggers, and administrative actions will be logged here with cryptographic verification."
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <li key={entry.id} className="py-2.5">
                <button
                  className="flex w-full items-start justify-between gap-3 text-left cursor-pointer"
                  onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone={toneFor(entry.action)}>{entry.action}</Badge>
                      <span className="font-mono text-xs text-foreground">{entry.entityKey ?? "—"}</span>
                      {entry.comment !== null ? (
                        <span className="truncate text-muted-foreground"> — {entry.comment}</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground">
                      <span>{relativeTime(entry.createdAt)} ·</span>
                      <span className="text-foreground font-medium">
                        {entry.actorName ?? entry.actorEmail ?? entry.actorKind}
                      </span>
                      {entry.actorId !== null ? (
                        <span className="font-mono" title="Member ID">
                          ({entry.actorId})
                        </span>
                      ) : null}
                      {entry.actorKind === "token" ? <span>via API token</span> : null}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {absoluteTime(entry.createdAt)}
                  </span>
                </button>
                {expanded === entry.id ? (
                  <div className="mt-2 grid gap-2 lg:grid-cols-2">
                    <Diff title="Previous State" value={entry.before} />
                    <Diff title="New State" value={entry.after} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

function toneFor(action: string): "on" | "danger" | "warn" | "neutral" {
  if (action.includes("killed") || action.includes("off")) return "danger";
  if (action.includes("reverted")) return "warn";
  if (action.includes("created")) return "on";
  return "neutral";
}

function Diff({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] text-muted-foreground">
        {value === undefined || value === null ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** Rendered by the verify action, above the list, when it has run. */
export function VerifyResult({ ok, checked }: { ok: boolean; checked: number }) {
  return ok ? (
    <InfoNote>Audit chain verified: cryptographic signatures intact across {checked} entries.</InfoNote>
  ) : (
    <ErrorNote>Audit chain verification failed: log inconsistency or tampering detected.</ErrorNote>
  );
}
