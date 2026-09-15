/**
 * Segments: named cohorts a rule can point at.
 *
 * The import is paged by the API at 50,000 members a request, and this page
 * pages accordingly — a ten-million-member list is two hundred bounded
 * transactions, each of which can fail and be retried on its own, rather than
 * one that holds a lock for minutes.
 */

import { useState } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { A, type Segment } from "../lib/api";
import { useAction, useResource } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Page } from "../components/page";
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
  Textarea,
  useToast,
} from "../components/ui";

/** The API's per-request ceiling. Paging is the client's job. */
const PAGE_SIZE = 50_000;

export function SegmentsPage() {
  const { project, environment, can } = useSession();
  const scoped = project !== "" && environment !== "";
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<Segment | null>(null);
  const [deleting, setDeleting] = useState<Segment | null>(null);
  const toast = useToast();

  const segments = useResource(() => A.segments(project, environment), [project, environment], {
    enabled: scoped,
  });
  const rows = segments.data?.segments ?? [];
  const writable = can("writer");

  return (
    <Page
      title="Segments"
      description={`Manage reusable user segments in ${project} · ${environment}`}
      actions={
        <Button
          variant="primary"
          size="sm"
          disabled={!writable || !scoped}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
          New segment
        </Button>
      }
    >
      {!scoped ? (
        <EmptyState
          title="No environment selected"
          body="Segments are environment-specific. Please choose a project and environment above to get started."
        />
      ) : segments.loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No segments created yet"
          body="Segments let you define reusable lists of users or rule sets to target across multiple feature flags."
          action={
            writable ? (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
                New segment
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((segment) => (
            <Card
              key={segment.key}
              title={
                <span className="flex items-center gap-2">
                  {segment.name}
                  {segment.external ? (
                    <Badge tone="accent" title="Membership is evaluated by your external service">
                      external
                    </Badge>
                  ) : null}
                </span>
              }
              description={<span className="font-mono">{segment.key}</span>}
              actions={
                writable ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setImporting(segment)}>
                      <Upload className="size-3.5" />
                      Manage members
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete segment ${segment.key}`}
                      className="hover:text-danger"
                      onClick={() => setDeleting(segment)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                ) : undefined
              }
            >
              <p className="text-sm text-muted-foreground">
                {segment.memberCount === null
                  ? "Externally managed"
                  : `${segment.memberCount.toLocaleString()} ${segment.memberCount === 1 ? "member" : "members"}`}
              </p>
            </Card>
          ))}
        </div>
      )}

      <CreateSegmentDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => void segments.reload()}
      />

      <ImportDialog
        segment={importing}
        onClose={() => setImporting(null)}
        onDone={() => void segments.reload()}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete segment "${deleting?.key ?? ""}"?`}
        confirmLabel="Delete segment"
        body={
          <p>
            This segment cannot be deleted if it is currently referenced by any active flag targeting rules.
          </p>
        }
        onConfirm={async () => {
          if (deleting === null) return;
          try {
            await A.deleteSegment(project, environment, deleting.key);
            toast.push("ok", `Segment ${deleting.key} deleted`);
          } catch (error) {
            toast.push("error", error instanceof Error ? error.message : String(error));
          }
          await segments.reload();
        }}
      />
    </Page>
  );
}

function CreateSegmentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { project, environment } = useSession();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [external, setExternal] = useState(false);

  const create = useAction(async () => {
    const result = await A.createSegment(project, environment, {
      key: key.trim(),
      name: name.trim() === "" ? key.trim() : name.trim(),
      external,
    });
    toast.push("ok", `Segment ${key} created`);
    onCreated();
    setKey("");
    setName("");
    onClose();
    return result;
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create segment"
      description="Create a named cohort to target in flag rules."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.busy}
            disabled={key.trim() === ""}
            onClick={() => void create.run()}
          >
            Create segment
          </Button>
        </>
      }
    >
      <Field label="Key" hint="Unique identifier (e.g. beta-testers)">
        <Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="beta-testers" />
      </Field>
      <Field label="Name" hint="Human-readable segment name">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Beta testers" />
      </Field>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={external}
          onChange={(event) => setExternal(event.target.checked)}
        />
        <span>External segment — membership is evaluated dynamically via your own service</span>
      </label>
      {create.error !== null ? <ErrorNote>{create.error.message}</ErrorNote> : null}
    </Dialog>
  );
}

function ImportDialog({
  segment,
  onClose,
  onDone,
}: {
  segment: Segment | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { project, environment } = useSession();
  const toast = useToast();
  const [raw, setRaw] = useState("");
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [progress, setProgress] = useState<string | null>(null);

  const submit = useAction(async () => {
    if (segment === null) return null;
    const keys = raw
      .split(/[\n,]/)
      .map((key) => key.trim())
      .filter((key) => key.length > 0);

    let done = 0;
    let memberCount = 0;
    for (let at = 0; at < keys.length; at += PAGE_SIZE) {
      const page = keys.slice(at, at + PAGE_SIZE).map((contextKey) => ({ contextKey }));
      const result = await A.segmentMembers(project, environment, segment.key, {
        [mode]: page,
      } as { add?: Array<{ contextKey: string }>; remove?: Array<{ contextKey: string }> });
      done += page.length;
      memberCount = result.memberCount;
      setProgress(`${done.toLocaleString()} of ${keys.length.toLocaleString()}`);
    }
    toast.push("ok", `${segment.key} updated: now has ${memberCount.toLocaleString()} members`);
    setProgress(null);
    setRaw("");
    onDone();
    onClose();
    return null;
  });

  return (
    <Dialog
      open={segment !== null}
      onClose={onClose}
      width="lg"
      title={`Manage members: ${segment?.name ?? segment?.key ?? ""}`}
      description="Enter context keys (one per line or comma-separated) to add or remove from this segment."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant={mode === "remove" ? "danger" : "primary"}
            loading={submit.busy}
            disabled={raw.trim() === ""}
            onClick={() => void submit.run()}
          >
            {mode === "add" ? "Add members" : "Remove members"}
          </Button>
        </>
      }
    >
      <div className="flex gap-2">
        <Button
          variant={mode === "add" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setMode("add")}
        >
          Add members
        </Button>
        <Button
          variant={mode === "remove" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setMode("remove")}
        >
          Remove members
        </Button>
      </div>
      <Textarea rows={10} value={raw} onChange={(event) => setRaw(event.target.value)} placeholder="user-123&#10;user-456&#10;user-789" />
      {progress !== null ? <InfoNote>Updating members… {progress}</InfoNote> : null}
      {submit.error !== null ? <ErrorNote>{submit.error.message}</ErrorNote> : null}
    </Dialog>
  );
}
