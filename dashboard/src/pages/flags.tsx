/**
 * The flags table.
 *
 * One row per flag, one request for the whole page. The toggle writes through
 * the ordinary versioned endpoint, so a row that somebody else changed while
 * this page was open fails with a conflict rather than quietly reverting their
 * edit — and the failure reloads the row instead of leaving the switch lying.
 *
 * The kill switch is a **separate control** from the toggle, not the same one
 * in a different state: "turn this off for everyone now" and "change the
 * default" are different intentions, and merging them is how an incident
 * response becomes a merge conflict.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, ArchiveRestore, Plus, Power, Search, X } from "lucide-react";
import { A, type FlagKind, type FlagRow } from "../lib/api";
import { useResource, useHotkey } from "../lib/hooks";
import { useSession } from "../lib/session";
import { toPercent } from "../lib/api";
import { cn, parseValue, relativeTime, absoluteTime, variationLabel } from "../lib/utils";
import { Page } from "../components/page";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  InfoNote,
  Select,
  Spinner,
  Switch,
  Textarea,
  useToast,
} from "../components/ui";

export function FlagsPage() {
  const { project, environment, can, currentEnvironment } = useSession();
  const toast = useToast();
  const scoped = project !== "" && environment !== "";

  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [killing, setKilling] = useState<FlagRow | null>(null);
  const [archiving, setArchiving] = useState<FlagRow | null>(null);

  const flags = useResource(
    () => A.flags(project, environment, showArchived),
    [project, environment, showArchived],
    { enabled: scoped },
  );

  useHotkey("/", () => document.getElementById("flag-search")?.focus());

  const rows = flags.data?.flags ?? [];
  const tags = useMemo(
    () => [...new Set(rows.flatMap((flag) => flag.tags))].sort(),
    [rows],
  );

  const filtered = rows.filter((flag) => {
    if (tag !== "" && !flag.tags.includes(tag)) return false;
    if (query === "") return true;
    const needle = query.toLowerCase();
    return (
      flag.key.toLowerCase().includes(needle) ||
      flag.name.toLowerCase().includes(needle) ||
      (flag.description ?? "").toLowerCase().includes(needle)
    );
  });

  const writable = can("writer");

  const setEnabled = async (flag: FlagRow, enabled: boolean) => {
    if (flag.environment === null) return;
    try {
      await A.writeConfig(project, environment, flag.key, {
        expectedVersion: flag.environment.version,
        enabled,
      });
      toast.push("ok", `${flag.key} is now ${enabled ? "on" : "off"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.push(
        "error",
        message.includes("modified concurrently")
          ? `${flag.key} was changed by somebody else — reloaded`
          : message,
      );
    } finally {
      await flags.reload();
    }
  };

  return (
    <Page
      title="Flags"
      description={
        scoped
          ? `${rows.length} in ${project} · ${environment}`
          : "Pick a project and environment"
      }
      actions={
        <>
          <Button
            variant={showArchived ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowArchived((value) => !value)}
          >
            <Archive className="size-3.5" />
            {showArchived ? "Hiding nothing" : "Archived"}
          </Button>
          <Button variant="primary" size="sm" disabled={!writable} onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New flag
          </Button>
        </>
      }
    >
      {currentEnvironment?.isProduction === true ? (
        <InfoNote>
          This is a <strong className="text-ink">production</strong> environment. Changes here reach
          real traffic within a few hundred milliseconds.
        </InfoNote>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-faint" />
          <Input
            id="flag-search"
            placeholder="Search flags…  (press /)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
          {query !== "" ? (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-2 text-faint hover:text-ink"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        {tags.length > 0 ? (
          <Select
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            className="w-40"
            aria-label="Filter by tag"
          >
            <option value="">All tags</option>
            {tags.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      {flags.loading && rows.length === 0 ? (
        <Spinner />
      ) : flags.error !== null ? (
        <ErrorNote>{flags.error.message}</ErrorNote>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "No flags yet" : "Nothing matches"}
          body={
            rows.length === 0
              ? "A flag starts off, with a default everyone gets until a rule says otherwise."
              : "Try a different search."
          }
          action={
            rows.length === 0 && writable ? (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
                New flag
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="w-14 px-3 py-2 font-medium">On</th>
                <th className="px-3 py-2 font-medium">Flag</th>
                <th className="w-40 px-3 py-2 font-medium">Serves</th>
                <th className="w-32 px-3 py-2 font-medium">Targeting</th>
                <th className="w-28 px-3 py-2 font-medium">Changed</th>
                <th className="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((flag) => (
                <FlagRowView
                  key={flag.key}
                  flag={flag}
                  writable={writable}
                  onToggle={(enabled) => void setEnabled(flag, enabled)}
                  onKill={() => setKilling(flag)}
                  onArchive={() => setArchiving(flag)}
                  onRestore={() => {
                    void A.restoreFlag(project, flag.key)
                      .then(() => toast.push("ok", `${flag.key} restored`))
                      .catch((error: Error) => toast.push("error", error.message))
                      .finally(() => void flags.reload());
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateFlagDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => void flags.reload()}
      />

      <ConfirmDialog
        open={killing !== null}
        onClose={() => setKilling(null)}
        title={`Turn off ${killing?.key ?? ""}?`}
        confirmLabel="Turn it off"
        body={
          <>
            <p>
              Every context will serve the off variation
              {killing !== null ? (
                <>
                  {" "}
                  (
                  <strong className="text-ink">
                    {variationLabel(
                      killing.variations[killing.environment?.offVariation ?? 0],
                      killing.kind,
                    )}
                  </strong>
                  )
                </>
              ) : null}{" "}
              in <strong className="text-ink">{environment}</strong>, within a few hundred
              milliseconds.
            </p>
            <p className="mt-2">
              Targeting rules are kept. Turning it back on restores exactly this configuration.
            </p>
          </>
        }
        onConfirm={async () => {
          if (killing === null) return;
          try {
            const result = await A.killSwitch(project, environment, killing.key);
            toast.push(
              "ok",
              result.alreadyOff ? `${killing.key} was already off` : `${killing.key} is off`,
            );
          } catch (error) {
            toast.push("error", error instanceof Error ? error.message : String(error));
          }
          await flags.reload();
        }}
      />

      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={`Archive ${archiving?.key ?? ""}?`}
        confirmLabel="Archive"
        body={
          <>
            <p>
              It disappears from every environment's next snapshot, so any SDK still calling{" "}
              <code className="font-mono text-ink">{archiving?.key}</code> starts getting the default
              its code passes.
            </p>
            <p className="mt-2">Archiving is reversible — the flag can be restored.</p>
          </>
        }
        onConfirm={async () => {
          if (archiving === null) return;
          try {
            await A.archiveFlag(project, archiving.key);
            toast.push("ok", `${archiving.key} archived`);
          } catch (error) {
            toast.push("error", error instanceof Error ? error.message : String(error));
          }
          await flags.reload();
        }}
      />
    </Page>
  );
}

function FlagRowView({
  flag,
  writable,
  onToggle,
  onKill,
  onArchive,
  onRestore,
}: {
  flag: FlagRow;
  writable: boolean;
  onToggle: (enabled: boolean) => void;
  onKill: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const state = flag.environment;
  return (
    <tr className={cn("border-b border-border last:border-0 hover:bg-surface", flag.archived && "opacity-60")}>
      <td className="px-3 py-2.5">
        <Switch
          checked={state?.enabled === true}
          disabled={!writable || state === null || flag.archived}
          tone="on"
          label={`Toggle ${flag.key}`}
          onChange={onToggle}
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            to={`/flags/${encodeURIComponent(flag.key)}`}
            className="font-medium hover:text-accent"
          >
            {flag.name}
          </Link>
          <Badge tone="neutral">{flag.kind}</Badge>
          {flag.clientAvailable ? (
            <Badge tone="accent" title="Evaluated for browsers by the client tier">
              client
            </Badge>
          ) : null}
          {flag.archived ? <Badge tone="warn">archived</Badge> : null}
          {flag.tags.map((entry) => (
            <Badge key={entry} tone="off">
              {entry}
            </Badge>
          ))}
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-faint">{flag.key}</p>
      </td>
      <td className="px-3 py-2.5 text-xs">
        {state === null ? (
          <span className="text-faint">not in this environment</span>
        ) : state.fallthroughRollout !== null ? (
          <span className="flex flex-wrap gap-1">
            {state.fallthroughRollout.map((slice) => (
              <Badge key={slice.variation} tone="accent">
                {toPercent(slice.weight)}% {variationLabel(flag.variations[slice.variation], flag.kind)}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-muted">
            {variationLabel(flag.variations[state.fallthroughVariation ?? 0], flag.kind)}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-muted">
        {state === null ? null : (
          <span className="flex gap-2">
            {state.ruleCount > 0 ? <span>{state.ruleCount} rules</span> : null}
            {state.targetCount > 0 ? <span>{state.targetCount} targets</span> : null}
            {state.prerequisiteCount > 0 ? <span>{state.prerequisiteCount} prereq</span> : null}
            {state.ruleCount + state.targetCount + state.prerequisiteCount === 0 ? (
              <span className="text-faint">—</span>
            ) : null}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-faint" title={absoluteTime(state?.updatedAt)}>
        {state === null ? "—" : relativeTime(state.updatedAt)}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex justify-end gap-1">
          {flag.archived ? (
            <Button variant="ghost" size="sm" disabled={!writable} onClick={onRestore}>
              <ArchiveRestore className="size-3.5" />
              Restore
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                title="Kill switch: serve the off variation to everyone"
                aria-label={`Kill switch for ${flag.key}`}
                disabled={!writable || state === null || !state.enabled}
                onClick={onKill}
                className="hover:text-danger"
              >
                <Power className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Archive"
                aria-label={`Archive ${flag.key}`}
                disabled={!writable}
                onClick={onArchive}
              >
                <Archive className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ─────────────────────────── create a flag ──────────────────────────── */

const KIND_DEFAULTS: Record<FlagKind, string[]> = {
  boolean: ["false", "true"],
  string: ["control", "treatment"],
  number: ["0", "1"],
  json: ['{ "enabled": false }', '{ "enabled": true }'],
};

function CreateFlagDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { project } = useSession();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<FlagKind>("boolean");
  const [variations, setVariations] = useState<string[]>(KIND_DEFAULTS.boolean);
  const [tags, setTags] = useState("");
  const [temporary, setTemporary] = useState(true);
  const [clientAvailable, setClientAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setKey("");
    setName("");
    setDescription("");
    setKind("boolean");
    setVariations(KIND_DEFAULTS.boolean);
    setTags("");
    setTemporary(true);
    setClientAvailable(false);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsed = variations.map((raw, index) => {
        try {
          return { value: parseValue(raw, kind) };
        } catch (caught) {
          throw new Error(`variation ${index + 1}: ${(caught as Error).message}`);
        }
      });
      await A.createFlag(project, {
        key: key.trim(),
        name: name.trim() === "" ? key.trim() : name.trim(),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        kind,
        temporary,
        clientAvailable,
        tags: tags
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        variations: parsed,
      });
      toast.push("ok", `${key} created — it starts off`);
      onCreated();
      reset();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New flag"
      description="It is created off in every environment. Turning it on is a separate, audited act."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={key.trim() === ""} onClick={() => void submit()}>
            Create flag
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Key" hint="Letters, digits, dot, dash, underscore. It appears in your code.">
          <Input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="new-checkout"
            autoFocus
          />
        </Field>
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New checkout flow"
          />
        </Field>
      </div>

      <Field label="Description">
        <Input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this gates, and who to ask about it"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <Select
            value={kind}
            onChange={(event) => {
              const next = event.target.value as FlagKind;
              setKind(next);
              setVariations(KIND_DEFAULTS[next]);
            }}
          >
            <option value="boolean">boolean</option>
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="json">json</option>
          </Select>
        </Field>
        <Field label="Tags" hint="Comma separated">
          <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="checkout, q3" />
        </Field>
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium text-muted">Variations</span>
        {variations.map((value, index) => (
          <div key={index} className="flex items-center gap-2">
            <span className="w-6 text-center font-mono text-[11px] text-faint">{index}</span>
            {kind === "json" ? (
              <Textarea
                rows={2}
                value={value}
                onChange={(event) =>
                  setVariations((current) =>
                    current.map((entry, at) => (at === index ? event.target.value : entry)),
                  )
                }
              />
            ) : (
              <Input
                value={value}
                onChange={(event) =>
                  setVariations((current) =>
                    current.map((entry, at) => (at === index ? event.target.value : entry)),
                  )
                }
              />
            )}
            {variations.length > 2 && kind !== "boolean" ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove variation"
                onClick={() => setVariations((current) => current.filter((_, at) => at !== index))}
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ))}
        {kind !== "boolean" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVariations((current) => [...current, ""])}
          >
            <Plus className="size-3.5" />
            Add variation
          </Button>
        ) : (
          <p className="text-[11px] text-faint">A boolean flag is always [false, true].</p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-xs text-muted">
          <Switch checked={temporary} onChange={setTemporary} label="Temporary" />
          Temporary — a release toggle meant to be deleted after rollout
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          <Switch checked={clientAvailable} onChange={setClientAvailable} label="Client available" />
          Available to browsers — otherwise its existence never leaves the server
        </label>
      </div>

      {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
    </Dialog>
  );
}
