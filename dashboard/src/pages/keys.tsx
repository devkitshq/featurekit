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
        <EmptyState
          title="Administrator access required"
          body="SDK keys can only be viewed and managed by organization admins and owners."
        />
      </Page>
    );
  }

  const rows = keys.data?.keys ?? [];

  return (
    <Page
      title="SDK keys"
      description={scoped ? `${project} · ${environment}` : "Select a project and environment to view SDK keys"}
      actions={
        <Button
          variant="primary"
          size="sm"
          disabled={!scoped}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
          New SDK key
        </Button>
      }
    >
      {currentEnvironment?.isProduction === true ? (
        <InfoNote>
          These keys access the <strong className="text-foreground font-semibold">production</strong> environment. Keep server keys secure.
        </InfoNote>
      ) : null}

      {!scoped ? (
        <EmptyState
          title="No environment selected"
          body="SDK keys belong to a specific environment. Choose a project and environment above to view or create keys."
        />
      ) : keys.loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No SDK keys created yet"
          body="Create a Server key for backend applications or a Client key for browser and mobile apps."
          action={
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New SDK key
            </Button>
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm">
                    <KeyRound className="size-3.5 text-muted-foreground" />
                    {key.name ?? "unnamed key"}
                    <Badge tone={key.kind === "server" ? "danger" : "accent"}>{key.kind}</Badge>
                    {key.revokedAt !== null ? <Badge tone="warn">revoked</Badge> : null}
                  </p>
                  <div className="mt-1">
                    {key.publicKey !== null ? (
                      <CopyableKey value={key.publicKey} />
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Stored hashed — secret key only displayed once upon creation
                      </span>
                    )}
                  </div>
                </div>
                {key.revokedAt === null ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke ${key.name ?? key.id}`}
                    title={`Revoke ${key.name ?? key.id}`}
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
        title="Copy your SDK key"
        description={
          minted?.kind === "server"
            ? "Server keys are stored hashed in the database. This is the only time this secret key will be shown."
            : "Client keys are public identifiers and can be viewed here anytime."
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
        title={`Revoke SDK key "${revoking?.name ?? "this key"}"?`}
        confirmLabel="Revoke key"
        body={
          <p>
            Connected SDKs using this key will immediately lose access and fall back to local cached snapshots and in-code defaults. This action cannot be undone.
          </p>
        }
        onConfirm={async () => {
          if (revoking === null) return;
          try {
            await A.revokeKey(project, environment, revoking.id);
            toast.push("ok", "SDK key revoked");
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
      title="Create SDK key"
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
        label="Key type"
        hint={
          kind === "server"
            ? "For backend applications. Has access to all targeting rules. Keep confidential."
            : kind === "mobile"
            ? "For native iOS and Android apps. Safe to include in client builds."
            : "For frontend web applications. Safe to expose publicly in client-side code."
        }
      >
        <Select value={kind} onChange={(event) => setKind(event.target.value as SdkKey["kind"])}>
          <option value="server">Server (Backend applications)</option>
          <option value="client">Client (Web applications)</option>
          <option value="mobile">Mobile (Native iOS/Android)</option>
        </Select>
      </Field>
      <Field label="Key name" hint="Descriptive name (e.g. billing-service or marketing-web)">
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
