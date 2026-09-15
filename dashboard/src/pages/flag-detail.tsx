/**
 * One flag, in one environment.
 *
 * The page is built around one rule: **every write carries the version this
 * page read.** A 409 is not an error to retry, it is another person's edit, and
 * it is rendered as such — with what changed and a reload — rather than
 * overwritten by whoever clicked last.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CalendarClock,
  FlaskConical,
  History,
  Power,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { A, ApiError, type DryRunResult, type FlagConfig, type Rule } from "../lib/api";
import { useResource, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { absoluteTime, relativeTime, variationLabel, valueLabel } from "../lib/utils";
import { Page } from "../components/page";
import { TargetingEditor, type TargetingValue } from "../components/targeting";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  InfoNote,
  Spinner,
  Switch,
  Tabs,
  Textarea,
  useToast,
} from "../components/ui";

const TABS = [
  { id: "targeting", label: "Targeting" },
  { id: "schedule", label: "Scheduled" },
  { id: "requests", label: "Requests" },
  { id: "history", label: "History" },
  { id: "metrics", label: "Metrics" },
];

export function FlagDetailPage() {
  const { flagKey = "" } = useParams();
  const { project, environment, can, currentEnvironment } = useSession();
  const toast = useToast();
  const writable = can("writer");

  const [tab, setTab] = useState("targeting");
  const [draft, setDraft] = useState<TargetingValue | null>(null);
  const [conflict, setConflict] = useState<FlagConfig | null>(null);
  const [killing, setKilling] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const definition = useResource(() => A.flag(project, flagKey), [project, flagKey], {
    enabled: project !== "",
  });
  const config = useResource(
    () => A.config(project, environment, flagKey),
    [project, environment, flagKey],
    { enabled: project !== "" && environment !== "" },
  );
  const segments = useResource(
    () => A.segments(project, environment),
    [project, environment],
    { enabled: project !== "" && environment !== "" },
  );
  const others = useResource(
    () => A.flags(project, environment),
    [project, environment],
    { enabled: project !== "" && environment !== "" },
  );

  /* The draft starts as what the server has, and diverges until saved. */
  useEffect(() => {
    if (config.data === null) return;
    setDraft(toDraft(config.data));
  }, [config.data]);

  const dirty = useMemo(
    () => config.data !== null && draft !== null && !same(toDraft(config.data), draft),
    [config.data, draft],
  );

  const save = useAction(async () => {
    if (config.data === null || draft === null) return null;
    try {
      const result = await A.writeConfig(project, environment, flagKey, {
        expectedVersion: config.data.version,
        enabled: config.data.enabled,
        offVariation: draft.offVariation ?? 0,
        ...(draft.fallthroughRollout !== undefined
          ? { fallthroughRollout: toRolloutBody(draft.fallthroughRollout) }
          : { fallthroughVariation: draft.fallthroughVariation ?? 0 }),
        rules: draft.rules.map(toRuleBody),
        targets: draft.targets,
        prerequisites: draft.prerequisites,
      });
      toast.push("ok", `Saved — version ${result.version}`);
      await config.reload();
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The 409 carries the current configuration, so the page can show what
        // it is now instead of asking somebody to guess.
        const details = error.details as { current?: FlagConfig } | undefined;
        setConflict(details?.current ?? null);
        return null;
      }
      throw error;
    }
  });

  const toggle = useAction(async (enabled: boolean) => {
    if (config.data === null) return null;
    const result = await A.writeConfig(project, environment, flagKey, {
      expectedVersion: config.data.version,
      enabled,
    });
    toast.push("ok", `${flagKey} is now ${enabled ? "on" : "off"}`);
    await config.reload();
    return result;
  });

  if (definition.loading || config.loading) return <Spinner className="m-6" />;
  if (definition.error !== null) {
    return (
      <Page title={flagKey}>
        <ErrorNote>{definition.error.message}</ErrorNote>
      </Page>
    );
  }
  if (definition.data === null || config.data === null || draft === null) {
    return (
      <Page title={flagKey}>
        <EmptyState title="This flag has no configuration in this environment" />
      </Page>
    );
  }

  const flag = definition.data;
  const live = config.data;
  const otherFlags = (others.data?.flags ?? [])
    .filter((entry) => entry.key !== flagKey)
    .map((entry) => ({ key: entry.key, variations: entry.variations }));

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <Link to="/flags" className="text-muted hover:text-ink" aria-label="Back to flags">
            <ArrowLeft className="size-4" />
          </Link>
          {flag.name}
          <Badge tone="neutral">{flag.kind}</Badge>
          {flag.clientAvailable ? <Badge tone="accent">client</Badge> : null}
          {flag.archived ? <Badge tone="warn">archived</Badge> : null}
        </span>
      }
      description={
        <span className="font-mono">
          {flag.key} · {environment} · v{live.version}
        </span>
      }
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={!writable || !live.enabled}
            onClick={() => setKilling(true)}
            className="hover:text-danger"
          >
            <Power className="size-3.5" />
            Kill switch
          </Button>
          <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1">
            <Switch
              checked={live.enabled}
              disabled={!writable || toggle.busy}
              tone="on"
              label={`Toggle ${flag.key}`}
              onChange={(next) => void toggle.run(next)}
            />
            <span className="text-xs text-muted">{live.enabled ? "on" : "off"}</span>
          </div>
        </>
      }
    >
      {currentEnvironment?.isProduction === true ? (
        <InfoNote>
          <strong className="text-ink">Production.</strong> A save here reaches every connected SDK
          in under a second.
        </InfoNote>
      ) : null}

      {flag.description !== null && flag.description !== "" ? (
        <p className="text-sm text-muted">{flag.description}</p>
      ) : null}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "targeting" ? (
        <div className="space-y-4">
          <VariationsCard flag={flag} />
          <TargetingEditor
            flag={flag}
            value={draft}
            onChange={setDraft}
            segments={segments.data?.segments ?? []}
            otherFlags={otherFlags}
            disabled={!writable}
          />

          {save.error !== null ? <ErrorNote>{save.error.message}</ErrorNote> : null}

          <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-card border border-border bg-surface/95 px-4 py-3 backdrop-blur">
            <span className="text-xs text-muted">
              {dirty ? (
                <>
                  Unsaved changes. Saving writes version{" "}
                  <span className="font-mono text-ink">{live.version + 1}</span>.
                </>
              ) : (
                <>
                  Saved. Version <span className="font-mono">{live.version}</span>, changed{" "}
                  {relativeTime(live.version === 1 ? null : undefined)}
                </>
              )}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!dirty}
                onClick={() => setDraft(toDraft(live))}
              >
                <RotateCcw className="size-3.5" />
                Discard
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!dirty}
                onClick={() => setPreviewing(true)}
              >
                <FlaskConical className="size-3.5" />
                Preview
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!writable || !dirty}
                onClick={() => setScheduling(true)}
              >
                <CalendarClock className="size-3.5" />
                Schedule
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={save.busy}
                disabled={!writable || !dirty}
                onClick={() => void save.run()}
              >
                <Save className="size-3.5" />
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "schedule" ? <ScheduleTab flagKey={flagKey} /> : null}
      {tab === "requests" ? <RequestsTab flagKey={flagKey} /> : null}
      {tab === "history" ? <HistoryTab flagKey={flagKey} onReverted={() => void config.reload()} /> : null}
      {tab === "metrics" ? <MetricsTab flagKey={flagKey} flag={flag} /> : null}

      <ConfirmDialog
        open={killing}
        onClose={() => setKilling(false)}
        title={`Turn off ${flag.key}?`}
        confirmLabel="Turn it off"
        body={
          <>
            <p>
              Everyone in <strong className="text-ink">{environment}</strong> serves{" "}
              <strong className="text-ink">
                {variationLabel(flag.variations[live.offVariation ?? 0], flag.kind)}
              </strong>{" "}
              immediately. Targeting is kept.
            </p>
          </>
        }
        onConfirm={async () => {
          try {
            await A.killSwitch(project, environment, flag.key);
            toast.push("ok", `${flag.key} is off`);
          } catch (error) {
            toast.push("error", error instanceof Error ? error.message : String(error));
          }
          await config.reload();
        }}
      />

      <ConflictDialog
        current={conflict}
        onClose={() => setConflict(null)}
        onReload={() => {
          setConflict(null);
          void config.reload();
        }}
      />

      <PreviewDialog
        open={previewing}
        onClose={() => setPreviewing(false)}
        flagKey={flagKey}
        flag={flag}
        draft={draft}
      />

      <ScheduleDialog
        open={scheduling}
        onClose={() => setScheduling(false)}
        flagKey={flagKey}
        draft={draft}
      />
    </Page>
  );
}

/* ───────────────────────────── variations ───────────────────────────── */

function VariationsCard({ flag }: { flag: import("../lib/api").FlagDefinition }) {
  return (
    <Card
      title="Variations"
      description="The values this flag can serve. Rules and rollouts reference them by position."
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {flag.variations.map((variation) => (
          <div
            key={variation.idx}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
          >
            <span className="font-mono text-[11px] text-faint">{variation.idx}</span>
            <span className="text-sm">{variation.name ?? "—"}</span>
            <code className="ml-auto truncate rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {valueLabel(variation.value, flag.kind)}
            </code>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ────────────────────────────── conflict ────────────────────────────── */

function ConflictDialog({
  current,
  onClose,
  onReload,
}: {
  current: FlagConfig | null;
  onClose: () => void;
  onReload: () => void;
}) {
  return (
    <Dialog
      open={current !== null}
      onClose={onClose}
      title="Somebody else changed this flag"
      description="Your save was refused rather than overwriting their edit."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep my draft
          </Button>
          <Button variant="primary" onClick={onReload}>
            Load theirs
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        The flag is now at version{" "}
        <span className="font-mono text-ink">{current?.version ?? "?"}</span>. Loading theirs
        discards your unsaved changes; keeping yours lets you copy anything you need first — but
        saving will still be refused until you reload.
      </p>
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-canvas p-3 font-mono text-[11px] text-muted">
        {JSON.stringify(current, null, 2)}
      </pre>
    </Dialog>
  );
}

/* ─────────────────────────── dry-run preview ────────────────────────── */

function generateSampleContexts(flagKey: string, draft: TargetingValue): string {
  const contexts: Record<string, unknown>[] = [];
  const addedKeys = new Set<string>();

  // 1. Add targeted keys from draft.targets if any
  for (const target of draft.targets ?? []) {
    for (const key of target.keys ?? []) {
      if (!addedKeys.has(key)) {
        addedKeys.add(key);
        contexts.push({ key });
      }
    }
  }

  // 2. Generate contexts tailored to match and challenge each rule's clauses
  (draft.rules ?? []).forEach((rule, ruleIdx) => {
    const matchingCtx: Record<string, unknown> = {
      key: `user-${ruleIdx + 1}-match`,
    };
    const nonMatchingCtx: Record<string, unknown> = {
      key: `user-${ruleIdx + 1}-fallback`,
    };

    for (const clause of rule.clauses ?? []) {
      const attr = clause.attribute;
      if (!attr) continue;

      if (clause.op === "in" || clause.op === "startsWith" || clause.op === "contains" || clause.op === "endsWith") {
        const val = clause.values?.[0] ?? "test-value";
        matchingCtx[attr] = val;
        nonMatchingCtx[attr] = typeof val === "string" ? `other-${val}` : val === true ? false : 99999;
      } else if (clause.op === "lessThan" || clause.op === "lessThanOrEqual") {
        const num = Number(clause.values?.[0] ?? 100);
        matchingCtx[attr] = num - 1;
        nonMatchingCtx[attr] = num + 10;
      } else if (clause.op === "greaterThan" || clause.op === "greaterThanOrEqual") {
        const num = Number(clause.values?.[0] ?? 100);
        matchingCtx[attr] = num + 10;
        nonMatchingCtx[attr] = num - 1;
      } else if (clause.op === "segmentMatch") {
        matchingCtx[attr] = "segment-member";
        nonMatchingCtx[attr] = "non-member";
      } else {
        matchingCtx[attr] = clause.values?.[0] ?? "active";
        nonMatchingCtx[attr] = "inactive";
      }
    }

    contexts.push(matchingCtx);
    contexts.push(nonMatchingCtx);
  });

  // 3. Fallback generic contexts customized for this specific flag key if none or few
  if (contexts.length < 3) {
    const slug = flagKey.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    contexts.push({ key: `${slug}-usr-1`, tier: "free", country: "US" });
    contexts.push({ key: `${slug}-usr-2`, tier: "pro", country: "CA" });
    contexts.push({ key: `${slug}-usr-3`, tier: "enterprise", country: "EU" });
  }

  return contexts.map((c) => JSON.stringify(c)).join("\n");
}

function PreviewDialog({
  open,
  onClose,
  flagKey,
  flag,
  draft,
}: {
  open: boolean;
  onClose: () => void;
  flagKey: string;
  flag: import("../lib/api").FlagDefinition;
  draft: TargetingValue;
}) {
  const { project, environment } = useSession();
  const [raw, setRaw] = useState(() => generateSampleContexts(flagKey, draft));
  const [result, setResult] = useState<DryRunResult | null>(null);

  // Re-generate default sample contexts whenever opening a different flag or draft
  useEffect(() => {
    if (open) {
      setRaw(generateSampleContexts(flagKey, draft));
      setResult(null);
    }
  }, [open, flagKey, draft]);

  const run = useAction(async () => {
    const contexts = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
    const outcome = await A.dryRun(project, environment, flagKey, toPatch(draft), contexts);
    setResult(outcome);
    return outcome;
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title={`Preview change: ${flagKey}`}
      description="Compiles the proposed configuration in a transaction that is rolled back, then evaluates these contexts against both."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button variant="default" size="sm" loading={run.busy} onClick={() => void run.run()}>
            Run preview
          </Button>
        </>
      }
    >
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-muted-foreground">Test Contexts</span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground underline cursor-pointer"
            onClick={() => setRaw(generateSampleContexts(flagKey, draft))}
          >
            Reset to flag rules
          </button>
        </div>
        <Textarea rows={6} value={raw} onChange={(event) => setRaw(event.target.value)} />
        <span className="block mt-1 text-[11px] text-muted-foreground">
          One JSON object per line. Auto-populated with attributes and targets from this flag.
        </span>
      </div>
      {run.error !== null ? <ErrorNote>{run.error.message}</ErrorNote> : null}
      {run.busy ? <Spinner /> : null}

      {result !== null ? (
        <div className="space-y-3">
          {result.warning !== undefined ? <ErrorNote>{result.warning}</ErrorNote> : null}
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="evaluated" value={result.evaluated} />
            <Stat label="move" value={result.changed} />
            <Stat
              label="churn"
              value={result.churn === undefined ? "—" : `${Math.round(result.churn * 100)}%`}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Distribution title="Now" counts={result.before} flag={flag} />
            <Distribution title="Proposed" counts={result.after} flag={flag} />
          </div>
          {result.examples.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wide text-faint">Who moves</p>
              <ul className="divide-y divide-border rounded-md border border-border">
                {result.examples.map((example, index) => (
                  <li key={index} className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                    <code className="truncate font-mono text-[11px] text-muted">
                      {JSON.stringify(example.context)}
                    </code>
                    <span className="shrink-0">
                      <span className="text-faint">{valueLabel(example.before, flag.kind)}</span>
                      <span className="mx-1 text-faint">→</span>
                      <span className="text-ink">{valueLabel(example.after, flag.kind)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/* ───────────────────────────── scheduling ───────────────────────────── */

function ScheduleDialog({
  open,
  onClose,
  flagKey,
  draft,
}: {
  open: boolean;
  onClose: () => void;
  flagKey: string;
  draft: TargetingValue;
}) {
  const { project, environment } = useSession();
  const toast = useToast();
  const [when, setWhen] = useState("");
  const create = useAction(async () => {
    const result = await A.createSchedule(
      project,
      environment,
      flagKey,
      toPatch(draft),
      new Date(when).toISOString(),
    );
    toast.push("ok", "Scheduled");
    onClose();
    return result;
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Apply this change later"
      description="Validated now, applied then. A change that fails validation at 3am on a Saturday is a change nobody is awake for."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.busy}
            disabled={when === ""}
            onClick={() => void create.run()}
          >
            Schedule
          </Button>
        </>
      }
    >
      <Field label="When">
        <Input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
      </Field>
      {create.error !== null ? <ErrorNote>{create.error.message}</ErrorNote> : null}
    </Dialog>
  );
}

function ScheduleTab({ flagKey }: { flagKey: string }) {
  const { project, environment, can } = useSession();
  const toast = useToast();
  const scheduled = useResource(
    () => A.schedule(project, environment, flagKey),
    [project, environment, flagKey],
  );
  const rows = scheduled.data?.scheduled ?? [];

  return (
    <Card title="Scheduled changes" description="Pending changes for this flag in this environment">
      {scheduled.loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          body="Edit targeting, then use Schedule instead of Save to apply it at a chosen time."
        />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <p title={absoluteTime(row.executeAt)}>{relativeTime(row.executeAt)}</p>
                <p className="text-[11px] text-faint">{absoluteTime(row.executeAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                {row.executedAt !== null ? (
                  <Badge tone="on">applied</Badge>
                ) : row.failedReason !== null ? (
                  <Badge tone="danger" title={row.failedReason}>
                    failed
                  </Badge>
                ) : (
                  <Badge tone="accent">pending</Badge>
                )}
                {row.executedAt === null && can("writer") ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Cancel"
                    onClick={() => {
                      void A.cancelSchedule(project, environment, flagKey, row.id)
                        .then(() => toast.push("ok", "Cancelled"))
                        .catch((error: Error) => toast.push("error", error.message))
                        .finally(() => void scheduled.reload());
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ────────────────────────── change requests ─────────────────────────── */

function RequestsTab({ flagKey }: { flagKey: string }) {
  const { project, environment, can } = useSession();
  const toast = useToast();
  const requests = useResource(
    () => A.requests(project, environment, flagKey),
    [project, environment, flagKey],
  );
  const rows = requests.data?.requests ?? [];

  return (
    <Card
      title="Change requests"
      description="Proposed changes awaiting a second pair of eyes. Approving applies them through the ordinary write path."
    >
      {requests.loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No open requests" />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-md border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={row.status === "pending" ? "accent" : "neutral"}>{row.status}</Badge>
                  <span className="text-xs text-muted">{relativeTime(row.createdAt)}</span>
                </div>
                {row.status === "pending" && can("writer") ? (
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void A.rejectRequest(project, environment, flagKey, row.id)
                          .then(() => toast.push("ok", "Rejected"))
                          .catch((error: Error) => toast.push("error", error.message))
                          .finally(() => void requests.reload());
                      }}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        void A.approveRequest(project, environment, flagKey, row.id)
                          .then(() => toast.push("ok", "Approved and applied"))
                          .catch((error: Error) => toast.push("error", error.message))
                          .finally(() => void requests.reload());
                      }}
                    >
                      Approve
                    </Button>
                  </div>
                ) : null}
              </div>
              {row.comment !== null ? <p className="mb-2 text-sm">{row.comment}</p> : null}
              <pre className="max-h-40 overflow-auto rounded bg-canvas p-2 font-mono text-[11px] text-muted">
                {JSON.stringify(row.patch, null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ─────────────────────────────── history ────────────────────────────── */

function HistoryTab({ flagKey, onReverted }: { flagKey: string; onReverted: () => void }) {
  const { project, environment, can } = useSession();
  const toast = useToast();
  const [reverting, setReverting] = useState<string | null>(null);
  const audit = useResource(
    () => A.audit(project, { flag: flagKey, limit: 50 }),
    [project, flagKey],
  );
  const entries = audit.data?.entries ?? [];

  return (
    <Card
      title="History"
      description="Every change to this flag, with the configuration before and after."
    >
      {audit.loading ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <EmptyState title="No history yet" />
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="font-medium">{entry.action}</span>
                  {entry.comment !== null ? (
                    <span className="text-muted"> — {entry.comment}</span>
                  ) : null}
                </p>
                <p className="text-[11px] text-faint" title={absoluteTime(entry.createdAt)}>
                  {relativeTime(entry.createdAt)} · {entry.actorKind}
                </p>
              </div>
              {can("writer") ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setReverting(entry.id)}
                  title="Restore the configuration as it was before this change"
                >
                  <History className="size-3.5" />
                  Revert
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={reverting !== null}
        onClose={() => setReverting(null)}
        title="Revert to this configuration?"
        confirmLabel="Revert"
        destructive={false}
        body={
          <p>
            The configuration recorded <em>before</em> that change is written back through the
            ordinary path — validated, version-checked and audited like any other edit.
          </p>
        }
        onConfirm={async () => {
          if (reverting === null) return;
          try {
            await A.revert(project, environment, flagKey, reverting);
            toast.push("ok", "Reverted");
            onReverted();
          } catch (error) {
            toast.push("error", error instanceof Error ? error.message : String(error));
          }
          await audit.reload();
        }}
      />
    </Card>
  );
}

/* ─────────────────────────────── metrics ────────────────────────────── */

function MetricsTab({
  flagKey,
  flag,
}: {
  flagKey: string;
  flag: import("../lib/api").FlagDefinition;
}) {
  const { project, environment } = useSession();
  const metrics = useResource(
    () => A.metrics(project, environment, flagKey, 24),
    [project, environment, flagKey],
  );

  const totals = new Map<string, number>();
  for (const point of metrics.data?.points ?? []) {
    const label =
      point.variationIdx === null
        ? "default served"
        : variationLabel(flag.variations[point.variationIdx], flag.kind);
    totals.set(label, (totals.get(label) ?? 0) + point.count);
  }
  const grand = [...totals.values()].reduce((sum, value) => sum + value, 0);

  return (
    <Card
      title="Evaluations, last 24 hours"
      description="Summarised by the SDKs and rolled up here. The question it answers is whether anything still reads this flag."
    >
      {metrics.loading ? (
        <Spinner />
      ) : grand === 0 ? (
        <EmptyState
          title="No evaluations recorded"
          body="Either nothing is reading this flag, or the SDKs have not flushed a summary yet."
        />
      ) : (
        <div className="space-y-2">
          {[...totals.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([label, count]) => (
              <div key={label} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{label}</span>
                  <span className="font-mono tabular-nums text-muted">
                    {count.toLocaleString()} · {((count / grand) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${(count / grand) * 100}%` }}
                  />
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border bg-canvas px-2 py-1.5">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-faint">{label}</p>
    </div>
  );
}

/** How many contexts land on each variation, before and after. */
function Distribution({
  title,
  counts,
  flag,
}: {
  title: string;
  counts: Record<string, number>;
  flag: import("../lib/api").FlagDefinition;
}) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1;
  return (
    <div className="rounded-md border border-border p-2">
      <p className="mb-1 text-[11px] uppercase tracking-wide text-faint">{title}</p>
      <div className="space-y-1">
        {Object.entries(counts).map(([index, count]) => (
          <div key={index} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate">
              {variationLabel(flag.variations[Number(index)], flag.kind)}
            </span>
            <span className="font-mono tabular-nums text-muted">
              {count} · {Math.round((count / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────────── conversions ──────────────────────────── */

function toDraft(config: FlagConfig): TargetingValue {
  return {
    rules: config.rules,
    targets: config.targets,
    prerequisites: config.prerequisites,
    offVariation: config.offVariation,
    ...(config.fallthroughRollout !== undefined
      ? { fallthroughRollout: config.fallthroughRollout }
      : { fallthroughVariation: config.fallthroughVariation ?? 0 }),
  };
}

/** The API takes `{ variation, weight }`; a read hands back `{ variationIndex, weight }`. */
function toRolloutBody(rollout: NonNullable<Rule["rollout"]>) {
  return {
    ...(rollout.contextKind === undefined ? {} : { contextKind: rollout.contextKind }),
    ...(rollout.bucketBy === undefined ? {} : { bucketBy: rollout.bucketBy }),
    ...(rollout.seed === undefined ? {} : { seed: rollout.seed }),
    variations: rollout.variations.map((slice) => ({
      variation: slice.variationIndex,
      weight: slice.weight,
    })),
  };
}

function toRuleBody(rule: Rule) {
  return {
    ...(rule.description === undefined || rule.description === ""
      ? {}
      : { description: rule.description }),
    clauses: rule.clauses,
    ...(rule.rollout !== undefined
      ? { rollout: toRolloutBody(rule.rollout) }
      : { variation: rule.variation ?? 0 }),
  };
}

/** The body shape a dry run and a scheduled change take: a patch without a version. */
function toPatch(draft: TargetingValue) {
  return {
    offVariation: draft.offVariation ?? 0,
    ...(draft.fallthroughRollout !== undefined
      ? { fallthroughRollout: toRolloutBody(draft.fallthroughRollout) }
      : { fallthroughVariation: draft.fallthroughVariation ?? 0 }),
    rules: draft.rules.map(toRuleBody),
    targets: draft.targets,
    prerequisites: draft.prerequisites,
  };
}

const same = (a: TargetingValue, b: TargetingValue): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
