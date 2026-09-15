# The server

```bash
node examples/server/server.js            # or: npm run demo
node examples/server/server.js --reset    # re-apply flags.js over UI changes
```

Two files:

- **`server.js`** — starts the control plane, ensures a dashboard account, syncs
  `flags.js`, and serves `../app` on :4000.
- **`flags.js`** — the project, the environment and the flags, as data.

## The control plane, in four lines

```js
import { FeatkitServer } from "featkit";

const server = new FeatkitServer({ services: ["all"], port: 3000 });
await server.start();
```

`services: ["all"]` is one process running the API, the SSE streams, event
ingest, the rollup worker and the scheduler. That shape is right until a few
thousand connected SDKs; past that, run the same class twice with
`services: ["api", "stream"]` and `["rollup", "scheduler"]`. Routes a process
does not serve are **not registered**, so a health check against them 404s
rather than a node staying in rotation while failing requests.

In development `start()` does three things it will not do in production:

| | development | production |
| :-- | :-- | :-- |
| Postgres and Redis | started in Docker if unreachable | never — an unreachable database is an error |
| migrations | applied on start | a deploy step (`npm run migrate`) |
| ports | picks a free one if 5432 is taken, and says so | exactly what you configured |

An **explicit** `databaseUrl` or `DATABASE_URL` is never substituted, even in
development: being quietly served an empty local database when you meant to
point at staging is worse than failing to start.

For a real deployment:

```bash
npm run migrate
DATABASE_URL=… REDIS_URL=… ADMIN_TOKEN=… NODE_ENV=production npm start
```

## `flags.js`

Flag **definitions** — key, kind, variations, tags — plus the configuration each
one should start with. Every start pushes it through the management API with a
real access token: the same HTTP calls a CI job makes, not a back door into the
database.

Two rules worth knowing before you edit it:

- **Variations are referenced by index.** The order of the array is load
  bearing. Appending is safe; reordering silently re-points every rule.
- **A restart does not overwrite your dashboard changes.** New flags are created
  and configured; existing ones are left alone. Operational state belongs to
  whoever is on call, not to the last person who edited a file. `--reset` is the
  explicit override.

## The account, and the token

The dashboard login comes from configuration:

```bash
FEATKIT_ADMIN_EMAIL=you@example.com FEATKIT_ADMIN_PASSWORD=… npm run demo
```

Seeded on start if that member does not exist, never overwritten if it does — a
restart must not silently reset a password somebody has since changed. Add more
accounts in the dashboard, or:

```bash
npm run admin:user -- create someone@example.com --role writer
npm run admin:user -- list
```

The management token `server.js` uses for the sync is minted **directly into the
database**, and that is the only step here that does not go through the API. A
control plane with an unauthenticated "give me an admin token" endpoint would
need only to be reachable to be owned.

## Using the flags from a Node service

The browser app next door is one consumer. A server-side one looks like this —
the SDK holds a snapshot in memory, so evaluation is synchronous and survives
the control plane being unreachable:

```js
import { FeatkitSDK } from "featkit";

const fk = new FeatkitSDK({
  sdkKey: process.env.FEATKIT_SDK_KEY,   // an fk_srv_… key, from the dashboard
  baseUrl: "http://127.0.0.1:3000",
  persist: { kind: "file", path: ".featkit/snapshot.json" },
});

await fk.ready({ timeoutMs: 5_000 });        // never rejects; times out into defaults

if (fk.get("new-checkout", { key: user.id, plan: user.plan }, false)) {
  renderNewCheckout();
}
```

The default is a required argument. `false` there is what that line does when
featkit is unavailable — the one decision a flag SDK must not make for you.
