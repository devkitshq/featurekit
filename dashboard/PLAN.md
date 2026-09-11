# The featurekit dashboard

The control plane already has a complete management API. What it has never had
is a face — which means every §18 scenario in `plan.md` ("an engineer at 3am
needs to turn this off", "two people save the same flag", "who changed this and
can we put it back") is currently answered with `curl`. This document is the
scope of the dashboard that answers them, and what has to be built underneath it
to make that possible.

Served by the control plane itself at **`/admin`**. Not a separate deployment,
not a separate thing to run: if featurekit is up, its dashboard is up.

---

## 1. Shape

```
dashboard/                      Vite + React + TypeScript + Tailwind v4
  src/
    api/                        typed client over /v1/admin/*
    components/ui/              shadcn-style primitives (button, dialog, …)
    components/                 flag table, rule editor, rollout editor, …
    pages/                      one file per route
    main.tsx  router.tsx  app.tsx
  dist/                         the build output the server serves
  vite.config.ts                base: "/admin/"
```

A static single-page bundle. No server rendering, no Next runtime, no second
process: `npm run build` produces `dashboard/dist` and the Node server serves it
from disk at `/admin`, falling through to `index.html` so client-side routes
survive a refresh.

**Why static.** The dashboard's data all comes from the management API, which is
already authenticated, already audited and already the contract other tools use.
A server-rendered dashboard would need a second privileged path to the database
and a second set of authorization decisions to get wrong.

---

## 2. Authentication

The management API authenticates a personal access token today. The dashboard
needs a human login, and the two must resolve to the **same** `Principal`, or
authorization becomes two implementations that drift.

### 2.1 What is added

| Change | Detail |
| :-- | :-- |
| `members.password_hash` | scrypt (`N=16384, r=8, p=1`), 16-byte salt, stored as `scrypt$N$r$p$salt$hash`. Nullable: a member who only ever uses a PAT has no password. |
| `dashboard_sessions` | `id`, `member_id`, `token_hash` (sha256, unique), `created_at`, `expires_at`, `last_seen_at`, `user_agent`. The plaintext lives only in the cookie. |
| `POST /v1/admin/auth/login` | `{ email, password }` → `Set-Cookie: fk_session=…; HttpOnly; SameSite=Strict; Path=/`, `Secure` in production. Returns the member. |
| `POST /v1/admin/auth/logout` | Deletes the row. A logout that only clears the cookie is not a logout. |
| `GET /v1/admin/auth/me` | Who am I, and what may I do. The dashboard's boot request. |
| `POST /v1/admin/auth/password` | Change own password; invalidates every other session for that member. |

### 2.2 Rules

- **One principal type.** `principalFromSession` produces the same `Principal`
  shape as `principalFromToken`, so every existing role and environment-scope
  check applies unchanged and the audit log records a real person.
- **Cookie or Bearer, never both interpreted at once.** `Authorization` wins if
  present; otherwise the cookie is tried.
- **CSRF.** A cookie-authenticated *mutation* must carry `x-featurekit-csrf: 1`.
  A cross-site form cannot set a custom header without a preflight, and the
  admin routes deliberately carry no CORS headers, so the preflight fails. Plus
  `SameSite=Strict`, which handles the rest. GETs need neither.
- **Timing.** Unknown email and wrong password take the same path and return the
  same `401 CREDENTIALS_REJECTED`; a login form that distinguishes them is an
  account enumeration oracle.
- **Rate limiting.** `/v1/admin/auth/login` gets its own low ceiling, keyed by
  IP, on the existing limiter.
- **Sessions expire** after 12 hours and slide on use (at most one write per
  10 minutes, so a click does not become a database write).

### 2.3 The first user

Three ways in, in this order:

1. `FEATUREKIT_ADMIN_EMAIL` + `FEATUREKIT_ADMIN_PASSWORD` — seeded on start if
   no member with that email exists. How the demo and Docker get a login.
2. `npm run admin:user -- create <email>` — prompts for a password, prints
   nothing secret to stdout.
3. `npm run admin:user -- password <email>` — reset.

A deployment with no members and no seed variables serves a "no accounts yet"
page at `/admin` that tells you which command to run, rather than a login form
nobody can pass.

---

## 3. API gaps to close

The dashboard needs facts the current API cannot express. Each of these is a
real gap, not a convenience for one screen:

| Endpoint | Why it does not exist yet |
| :-- | :-- |
| `GET /projects/:project/environments` | `listProjects` returns environment *keys* only. The switcher needs ids, colours and `isProduction`. |
| `GET /projects/:project/flags?environment=` | The flag table needs on/off and the served default per flag. Without it the list is N+1 requests. |
| `GET /projects/:project/flags/:flag` | Variation **values** are nowhere in the API. `readFlagConfig` speaks indices, which is right for writes and useless for a table that has to render "25%" or "one-click". |
| `POST /flags/:flag/restore` | Archive exists; unarchive does not, so an accidental archive is permanent. |
| `DELETE /segments/:segment` | Segments can be created but not removed. |
| `GET /segments/:segment` | Member count and rules for the segment detail page. |
| `GET /members`, `POST /members`, `PATCH /members/:id`, `DELETE /members/:id` | Now that people log in, somebody has to be able to add and remove them. Owner only. |
| `GET/POST/DELETE /tokens` | PATs for CI, minted from the UI, scoped and revocable. |
| `GET /flags/:flag/metrics` | `evaluation_summaries` is written by the rollup worker and read by nothing. The flag page's "is anyone actually evaluating this" panel. |

All of them are ordinary routes on the existing `registerAdminRoutes`, with the
same `requireRole` / `requireEnvironmentAccess` discipline.

Two supporting changes elsewhere:

- **Router wildcards.** `Router` matches a fixed segment count. `/admin/*` needs
  a trailing-wildcard pattern, added once, used by the static handler.
- **Static file serving.** A tiny handler with an ETag, an immutable cache
  header for `assets/*` (they are content-hashed) and `no-store` for
  `index.html`. Path traversal is refused by resolving and prefix-checking, not
  by string cleaning.

---

## 4. Screens

### 4.1 Flags (the list)

The page people keep open. One row per flag, filtered by project and
environment.

- Search by key/name, filter by tag, kind, status (on/off), archived.
- Per-row: kind badge, the enabled toggle, the served default, rule count, last
  changed, and the flag's key with a copy button.
- **Toggle inline**, with the kill switch as a separate right-click-free action
  (a distinct red control, not the same switch): off is not a merge and does not
  need a version.
- Create flag: key, name, kind, variations (typed per kind), tags, temporary,
  `clientAvailable`. Boolean flags get `[false, true]` without asking.
- Archive with a confirmation naming the flag; restore from the archived filter.

### 4.2 Flag detail

Tabs, one concern each:

1. **Targeting** — the editor described in §4.3.
2. **Variations** — values and names, and which is the off variation.
3. **Rollout** — percentage split with weights that must total 100%.
4. **Scheduled** — pending changes with their execute time; cancel.
5. **Requests** — change requests awaiting review; approve or reject.
6. **History** — this flag's audit entries, each with a revert button.
7. **Metrics** — evaluations by variation over time, from the rollup.

Every write sends the `expectedVersion` the page read, and a `409` renders a
"somebody else changed this" panel with the current state and a reload — never a
silent overwrite.

Above the tabs: an environment switcher, because "on in staging, off in
production" is the normal state of a flag and switching should not be a
navigation.

### 4.3 The targeting editor

Ordered rules, each a list of clauses and one outcome:

- Clause: context kind, attribute, operator (the SDK's fifteen), values,
  negate. Value input adapts — a date picker for `before`/`after`, a number for
  the numeric comparisons, a segment picker for `segmentMatch`.
- Outcome: a single variation **or** a percentage rollout (never both — the
  database has a constraint saying so, and the UI enforces it as a radio).
- Rules reorder by drag; order is the evaluation order and the UI says so.
- Individual targets sit above the rules, visually, because they win.
- Prerequisites sit above those, because they gate everything.
- **Preview before saving.** The dry-run endpoint takes a set of contexts and
  reports who moves, including churn — "the same 5%, different users" is the
  failure no chart shows afterwards. The editor sends the contexts you have
  typed plus a sample.

### 4.4 Segments

List, create, delete. Member import by paste or CSV, paged at 50,000 per
request through the existing endpoint, with progress. Rule-based segments use
the same clause editor as §4.3.

### 4.5 Audit

Project-wide log: actor, action, entity, time, and a diff. Filter by flag and by
actor. Revert from any entry, which replays through the ordinary write path and
is itself audited. "Verify chain" for owners, which reports the first broken
link if there is one.

### 4.6 SDK keys

Per environment: list with kind, name, last used, created. Create — the
plaintext of a server key is shown **once**, with a warning that says so, and
the client key is displayed permanently because it is public by construction.
Revoke with a confirmation that names what will break.

### 4.7 Settings

- **Members** — email, role, last login; invite by creating with a password;
  change role; remove. Owner only.
- **Tokens** — personal access tokens, with an environment scope picker and an
  expiry. Shown once.
- **Environments** — create, with the production flag and a colour that then
  tints every environment badge in the app.
- **Status** — what `/health` says: database, Redis, snapshot ages, partition
  runway, version. The page an operator opens before opening a terminal.

### 4.8 App demo (`examples/app`)

The other half of the ask: a small product UI that uses `featurekit-client`
against the client tier, with a user switcher, live SSE updates and a panel
showing each flag's value and reason. It exists to make the dashboard's effect
visible — change a rollout in one window, watch the app move in the other — and
to demonstrate that `clientAvailable: false` flags never reach a browser.

---

## 5. Design

Dark-first, dense, keyboard-reachable. The reference is Unleash and Linear, not
a marketing site: this is a tool people keep open next to their editor.

- Tailwind v4 with a small token layer (`--color-surface`, `--color-border`, …)
  so light and dark are one definition, not two stylesheets.
- shadcn-style primitives written into the repo rather than pulled from a
  component library, so there is no runtime dependency to audit and every
  component is editable in place.
- lucide icons, sonner toasts.
- Every destructive action names its target in the confirmation. "Are you sure?"
  is not a confirmation.
- Production environments are visually distinct everywhere they appear. The
  single most expensive dashboard mistake is editing the wrong environment.

---

## 6. Order of work

| Phase | Contents | |
| :-- | :-- | :-- |
| **1** | Migration, password + session auth, `auth/*` routes, cookie principal, first-user seeding, `admin:user` script | done |
| **2** | Router wildcard, static serving at `/admin`, dashboard scaffold, login page, shell (sidebar, project/environment switcher), health panel | done |
| **3** | Flags list, create, archive/restore, toggle, kill switch | done |
| **4** | Flag detail: targeting editor, variations, rollout, dry-run preview, conflict handling | done |
| **5** | Audit + revert, SDK keys, scheduled changes, change requests | done |
| **6** | Segments, members, tokens, environments, metrics | done |
| **7** | `examples/app` browser UI, served by `examples/server` | done |

Not yet built, and deliberately listed rather than quietly dropped: drag-to-
reorder for rules (they move with buttons), CSV upload for segment members
(paste works), rule-based segment editing (the clause editor is wired for flags
only), and a chart over time on the metrics tab (it totals by variation).

Each phase ends with the thing working end to end against a real control plane,
not with a component that renders in isolation.

---

## 7. What this is deliberately not

- **Not a second source of truth.** Every write goes through the management API.
  There is no dashboard-only endpoint that touches the database directly.
- **Not a replacement for config-as-code.** `npx featurekit sync` (§11.3) stays
  the way flag *definitions* arrive from a repository. The dashboard owns
  operational state: on/off, targeting, rollout — the things owned by whoever is
  on call, not by the last person to merge.
- **Not multi-tenant.** One deployment, one organisation, projects inside it.
  Row-level tenancy is a different product.
