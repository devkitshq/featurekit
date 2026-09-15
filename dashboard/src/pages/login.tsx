/**
 * Sign in.
 *
 * One form, one error message. The server answers the same way for an unknown
 * address and a wrong password, and so does this page: telling someone which
 * half they got right turns a login form into an account directory.
 */

import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { useSession } from "../lib/session";
import { Button, ErrorNote, Field, Input, InfoNote } from "../components/ui";

export function LoginPage() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.signIn(email, password);
    } catch {
      setError("Email or password is wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            f
          </span>
          <div>
            <h1 className="text-sm font-semibold text-foreground">featurekit</h1>
            <p className="text-xs text-muted-foreground">Feature flags and their consequences</p>
          </div>
        </div>

        {session.needsSetup ? (
          <div className="space-y-3">
            <InfoNote>
              <p className="font-semibold text-foreground">There are no accounts yet.</p>
              <p className="mt-1">
                Create the first one from the machine running the control plane:
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-[11px] text-muted-foreground">
                npm run admin:user -- create you@example.com --role owner
              </pre>
              <p className="mt-2">
                Or set <code className="font-mono">FEATUREKIT_ADMIN_EMAIL</code> and{" "}
                <code className="font-mono">FEATUREKIT_ADMIN_PASSWORD</code> and restart it.
              </p>
            </InfoNote>
            <Button variant="secondary" className="w-full" onClick={() => void session.refresh()}>
              I have created one
            </Button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-xs"
          >
            <Field label="Email">
              <Input
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
            <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
              <KeyRound className="size-3.5" />
              Sign in
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
