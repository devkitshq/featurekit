# The dashboard

Served by the control plane at **`/admin`**. If featurekit is up, the way to
turn a flag off is up.

```bash
npm run build            # tsc -b, then the dashboard bundle
npm run demo             # the control plane on :3000, the example app on :4000
open http://127.0.0.1:3000/admin      # you@example.com / password12345
```

`PLAN.md` in this directory is the scope and the reasoning; this is how to run
and change it.

## Signing in

The first account comes from one of three places, in this order:

```bash
# 1. configuration, applied on start (how Docker and the demo get one)
FEATUREKIT_ADMIN_EMAIL=you@example.com FEATUREKIT_ADMIN_PASSWORD='…' npm start

# 2. the CLI
npm run admin:user -- create you@example.com --role owner
npm run admin:user -- password you@example.com
npm run admin:user -- role you@example.com admin
npm run admin:user -- list

# 3. from inside the dashboard, once one owner exists: Settings → Members
```

A deployment with no accounts shows the command rather than a login form nobody
can pass.

**Passwords** are scrypt with the parameters stored in the hash, so raising them
later does not invalidate anyone. **Sessions** are rows, not signed tokens,
because "log this person out now" has to be answerable. The cookie is
`HttpOnly`, `SameSite=Strict`, and `Secure` outside development.

Roles are the ones the management API already had — `reader`, `writer`, `admin`,
`owner` — and a session resolves to the same `Principal` a personal access token
does, so there is one authorization path rather than two.

## Working on it

```bash
npm run dashboard:dev        # vite on :5173, proxying /v1 to :3000
npm run typecheck:dashboard
npm run build:dashboard      # writes dashboard/dist, which the server serves
```

The dev server proxies the API rather than pointing at `:3000` directly: the
session cookie is set by the control plane's origin, and a cross-origin request
would not carry it.

## Layout

```
src/
  lib/api.ts        every endpoint, typed. The only file that knows about
                    credentials, CSRF and error shapes.
  lib/session.tsx   who is signed in, and the project/environment everything
                    else is scoped to.
  lib/hooks.ts      useResource / useAction — a fetch and a counter, not a
                    cache library.
  components/ui/    the primitives, written here rather than installed.
  components/       targeting editor, page frame.
  pages/            one file per route.
```

## The rules it enforces

- **Every write carries the version it read.** A `409` renders as "somebody else
  changed this", with their configuration and a reload — never an overwrite.
- **The kill switch is its own control**, not the toggle in another state. It
  needs no version and propagates immediately.
- **Production looks different**, everywhere it appears. The most expensive
  mistake this UI permits is the right change in the wrong environment.
- **Destructive confirmations name their target** and say what breaks.
- **Server keys are shown once.** Client keys are shown forever, because they
  are public by construction.
- **Cookie-authenticated mutations carry `x-featurekit-csrf`.** A cross-site
  form can send cookies; it cannot set a header without a preflight, and the
  admin routes carry no CORS headers, so the preflight fails.

## What it does not do

Config-as-code stays the way flag *definitions* arrive from a repository
(`npx featurekit sync`). The dashboard owns operational state — on/off,
targeting, rollout — which belongs to whoever is on call, not to the last person
who merged.
