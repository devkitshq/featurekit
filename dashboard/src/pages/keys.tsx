/**
 * SDK keys.
 *
 * The asymmetry on this page is the product's security model, made visible: a
 * client key is displayed forever because it ships in a JS bundle and is public
 * by construction; a server key is shown once, at creation, because it buys the
 * whole ruleset and is stored hashed.
 */

import { useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { A, type SdkKey } from "../lib/api";
import { useAction, useResource } from "../lib/hooks";
import { useSession } from "../lib/session";
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

export function KeysPage() {
  const { project, environment, can, currentEnvironment } = useSession();
  const toast = useToast();
  const scoped = project !== "" && environment !== "";
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<SdkKey | null>(null);
  const [minted, setMinted] = useState<{ kind: string; key: string } | null>(null);

  const keys = useResource(() => A.keys(project, environment), [project, environment], {
    enabled: scoped && can("admin"),
  });

  if (!can("admin")) {
    return (
      <Page title="SDK keys">
        <EmptyState title="Admins only" body="SDK keys are managed by admins and owners." />
      </Page>
    );
  }

  const rows = keys.data?.keys ?? [];

  return (
    <Page
      title="SDK keys"
      description={scoped ? `${project} · ${environment}` : "Pick a project and environment"}
      actions={
        <Button
          variant="primary"
          size="sm"
          // Unscoped, this built `/projects//environments//keys` and 404ed. A
          // key belongs to an environment; there is nothing to mint without one.
          disabled={!scoped}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
          New key
        </Button>
      }
    >
      {currentEnvironment?.isProduction === true ? (
        <InfoNote>
          These keys read <strong className="text-ink">production</strong>. A server key here grants
          the full ruleset for it.
        </InfoNote>
      ) : null}

      {!scoped ? (
        <EmptyState
          title="No environment selected"
          body="SDK keys belong to one environment. Choose a project and environment above, or create one in Settings."
        />
      ) : keys.loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No keys yet"
          body="A server key streams the whole ruleset to your services. A client key buys a browser evaluated values for one context and nothing else."
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm">
                    <KeyRound className="size-3.5 text-faint" />
                    {key.name ?? "unnamed"}
                    <Badge tone={key.kind === "server" ? "danger" : "accent"}>{key.kind}</Badge>
                    {key.revokedAt !== null ? <Badge tone="warn">revoked</Badge> : null}
                  </p>
                  <div className="mt-1">
                    {key.publicKey !== null ? (
                      <CopyableKey value={key.publicKey} />
                    ) : (
                      <span className="text-[11px] text-faint">
                        stored hashed — shown only when created
                      </span>
                    )}
                  </div>
                </div>
                {key.revokedAt === null ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke ${key.name ?? key.id}`}
                    className="hover:text-danger"
                    onClick={() => setRevoking(key)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <CreateKeyDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setMinted(created);
          void keys.reload();
        }}
      />

      <Dialog
        open={minted !== null}
        onClose={() => setMinted(null)}
        title="Copy this key now"
        description={
          minted?.kind === "server"
            ? "A server key is stored hashed. This is the only time it will ever be shown."
            : "A client key is public by construction and can be read here again later."
        }
        footer={
          <Button variant="primary" onClick={() => setMinted(null)}>
            Done
          </Button>
        }
      >
        <CopyableKey value={minted?.key ?? ""} className="w-full" />
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "this key"}?`}
        confirmLabel="Revoke"
        body={
          <p>
            Every SDK using it stops receiving updates within seconds and falls back to the last
            snapshot it holds, then to your code's defaults. This cannot be undone.
          </p>
        }
        onConfirm={async () => {
          if (revoking === null) return;
          try {
            await A.revokeKey(project, environment, revoking.id);
            toast.push("ok", "Key revoked");
          } catch (error) {
            toast.push("error", error instanceof Error ? error.message : String(error));
          }
          await keys.reload();
        }}
      />
    </Page>
  );
}

function CreateKeyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (created: { kind: string; key: string }) => void;
}) {
  const { project, environment } = useSession();
  const [kind, setKind] = useState<SdkKey["kind"]>("server");
  const [name, setName] = useState("");

  const create = useAction(async () => {
    const created = await A.createKey(project, environment, kind, name.trim() === "" ? undefined : name.trim());
    onCreated({ kind: created.kind, key: created.key });
    setName("");
    onClose();
    return created;
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New SDK key"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.busy} onClick={() => void create.run()}>
            Create key
          </Button>
        </>
      }
    >
      <Field
        label="Kind"
        hint={
          kind === "server"
            ? "Streams the entire ruleset. Never put one in a browser or a mobile binary."
            : "Buys evaluated values for one context. Safe to ship publicly."
        }
      >
        <Select value={kind} onChange={(event) => setKind(event.target.value as SdkKey["kind"])}>
          <option value="server">server</option>
          <option value="client">client</option>
          <option value="mobile">mobile</option>
        </Select>
      </Field>
      <Field label="Name" hint="Where this key lives, so it can be revoked with confidence.">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="checkout-service"
        />
      </Field>
      {create.error !== null ? <ErrorNote>{create.error.message}</ErrorNote> : null}
    </Dialog>
  );
}
