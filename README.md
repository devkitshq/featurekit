# featurekit

Feature flags with a control plane you run.

```ts
if (flags.get("new-checkout", false)) {
  // …
}
```

Two packages. `featurekit-server` is the server side — the control plane, and an
evaluator that holds the ruleset in memory. `featurekit-client` is one client
for everything else, with no framework bindings and no per-runtime build.

```bash
npm i featurekit-server  # runs the control plane; evaluates server-side
npm i featurekit-client  # browsers, React Native, Node, Deno, Bun, edge
```

Not writing JavaScript? Skip both and implement
[two HTTP endpoints](docs/client-tier/http.md).

---

## The one idea worth knowing first

There are two tiers, and the split is a security boundary rather than a
deployment detail.

**The server tier** gets the compiled ruleset. It evaluates any context
synchronously, in memory, with no network call per check, and keeps working when
the control plane is down.

**The client tier** gets *evaluated values for one context* and never the rules.
A rule reading `plan in [pro, enterprise]` tells anyone with devtools that a paid
tier exists and what it is called. Rollout percentages disclose release plans.
Segment definitions name your churn-risk cohort. None of that is fixed by
minification, so it is not sent — and a flag marked `clientAvailable: false` is
not filtered out on the client, it never leaves the server.

That is why the client SDK's reads take no context argument: the connection *is*
the context.

---

## Running the control plane

It is a class you construct, not a binary you configure. One file, and you own
the process — which is the point of a control plane you run rather than a
service you rent.

```bash
mkdir acme-flags && cd acme-flags
npm init -y && npm pkg set type=module
npm i featurekit-server
npm i -D @testcontainers/postgresql @testcontainers/redis  # dev only, see below
```

```js
// server.js
import { FeaturekitServer } from "featurekit-server";

const server = new FeaturekitServer({
  services: ["all"],
  port: 3000,
});

await server.start();
```

```bash
node server.js
```

That is a working control plane: the management API, the client tier, the
streams, event ingest, the rollup worker, the scheduler, and a dashboard on
`http://127.0.0.1:3000/admin`.

**It needs no database setup to start.** Outside production, featurekit brings
up Postgres and Redis in Docker when you have not given it their addresses, and
runs the migrations. This needs Docker running and the two `@testcontainers`
packages above. They are dev dependencies on purpose, so production installs
never carry them; without them, `start()` tells you to install them or pass
`databaseUrl` and `redisUrl`. Only addresses you did *not* specify are started —
an explicit `databaseUrl` that does not answer is an error, never a silent
redirect to a fresh empty container.

### Flags as data in your repository

Definitions belong in version control; on/off and targeting belong to whoever is
on call. Passing `flags` gets you both:

```js
// flags.js
export default {
  project: { key: "acme", name: "Acme Cloud" },
  environment: { key: "development", name: "Development", isProduction: false },
  flags: [
    {
      key: "new-checkout",
      name: "New checkout flow",
      kind: "boolean",
      clientAvailable: true,
      variations: [
        { name: "off", value: false },
        { name: "on", value: true },
      ],
      config: {
        enabled: true,
        offVariation: "off",
        fallthroughVariation: "off",
        rules: [
          {
            description: "Paid plans get the new checkout",
            clauses: [{ contextKind: "user", attribute: "plan", op: "in", values: ["pro", "enterprise"] }],
            variation: "on",
          },
        ],
      },
    },
  ],
};
```

```js
import flags from "./flags.js";

const server = new FeaturekitServer({ services: ["all"], port: 3000, flags });
await server.start();
```

On restart, new flags are created and definitions kept current. **Existing
flags keep whatever the dashboard says** — a toggle somebody flipped at 3am is
not reverted by the next deploy. `flagsReset: true` overrides that, deliberately.

[`examples/basic-example/server`](examples/basic-example/server) is a working
version of this setup, with a website and an Expo app reading the same flags.

### Going to production

```js
const server = new FeaturekitServer({
  services: ["all"],
  port: 3000,
  host: "0.0.0.0",
  nodeEnv: "production",

  databaseUrl: process.env.DATABASE_URL,
  // Optional. Everything featurekit stores goes in this one schema; `public`
  // if unset. Migrations create it.
  databaseSchema: "featurekit",
  redisUrl: process.env.REDIS_URL,

  // Required in production. Generated for you in development.
  adminToken: process.env.ADMIN_TOKEN,
  // Signs client-tier contexts. Comma-separate to rotate: sign with the first,
  // verify against all.
  secureModeSecret: process.env.SECURE_MODE_SECRET,

  // Exact origins, never `*` — these endpoints answer with a user's flag
  // values. Native apps send no Origin and are unaffected.
  corsAllowedOrigins: ["https://app.acme.com"],

  // Leave this off for a fleet and run `featurekit-server/migrate` as a deploy step
  // instead — see below. It defaults to off in production for that reason.
  autoMigrate: false,
});

await server.start();
```

Four things that are wrong by default elsewhere and are not here:

**`host: "0.0.0.0"`.** The default is loopback. Behind a load balancer that
means nothing reaches you, and the symptom is a healthy process serving nobody.

**Configuration fails on every missing variable at once**, before the port is
bound. Three restarts to discover three mistakes is three outages.

**Draining is ordered.** `SIGTERM` makes `/ready` answer 503 *before* the socket
stops accepting, so the load balancer stops sending work first; then every open
stream gets an individually jittered reconnect delay, which is what stops a
synchronised reconnect storm on every release. Point liveness at `/live`,
readiness at `/ready`, and set your orchestrator's termination grace period
above `SHUTDOWN_GRACE_MS` (10s default). `/health` and `/metrics` are also
there.

**Migrations are additive and forward-only.** Old code runs against the new
schema for the length of a rollout, so the order is migrate → deploy new →
drain old.

### Migrations

The right shape is a separate step before the new nodes start, because every
node migrating on boot is a lock convoy: N nodes take the same locks at the same
moment, one holding an `ACCESS EXCLUSIVE` lock on a large table while the rest
queue behind it, during a deploy, while traffic is shifting.

```js
// migrate.js — a deploy job, run once
import { migrate } from "featurekit-server/migrate";
await migrate();
```

```bash
node migrate.js && kubectl rollout restart deploy/acme-flags
```

Or without a file at all:

```bash
node -e 'import("featurekit-server/migrate").then(m => m.migrate())'
```

`migrate()` reads `DATABASE_URL` and `DATABASE_SCHEMA`, or takes
`{ databaseUrl, schema }`. It refuses to guess the database: a deploy job with a missing variable quietly migrating the wrong database
is worse than a failed deploy by a wide margin.

Safe to run concurrently — a retried pipeline or two CI jobs racing produce one
migration and one no-op, because it takes a Postgres advisory lock first. Safe
to run repeatedly, because it is idempotent. And it creates partition runway as
part of the same step, since a deploy that leaves the analytics table without
partitions has not finished, it has just not failed yet.

```js
import { migrationStatus } from "featurekit-server/migrate";

const { applied, partitionRunwayDays } = await migrationStatus();
```

Worth running on a schedule rather than only at deploy time: runway shrinks on
its own, and the failure arrives without a deploy to blame.

`autoMigrate: true` remains available and takes the same lock — it calls the
same function. It is the right choice for a single-node deployment and the wrong
one for a fleet.

### In a container

Your `server.js` is the entrypoint, so the Dockerfile is the ordinary one:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js flags.js ./
USER node
EXPOSE 3000
# No shell wrapper: PID 1 must be node itself, or SIGTERM never reaches the
# graceful drain and every deploy severs its open streams.
CMD ["node", "server.js"]
```

Set `devServices: false` explicitly if your image might ever run outside
production without a database reachable — otherwise it will try to start one in
Docker, from inside Docker.

### Scaling

Split the process by service when one machine stops being enough:

```js
new FeaturekitServer({ services: ["api", "stream"] });      // scale horizontally
new FeaturekitServer({ services: ["rollup", "scheduler"] }); // keep it small
```

Or set `FEATUREKIT_SERVICES=api,stream` and run the packaged entrypoint,
`node node_modules/featurekit-server/dist/main.js`, if you would rather configure by
environment than by file.

### Your first key

Open `/admin`, log in, create a project and environment, then **Keys → New
key**. `server` for backend services, `client` or `mobile` for anything a user
can unzip. The plaintext is shown once.

To get a login without a shell, seed the first account — created if it does not
exist, never overwriting one that does:

```js
new FeaturekitServer({
  env: {
    FEATUREKIT_ADMIN_EMAIL: "you@acme.com",
    FEATUREKIT_ADMIN_PASSWORD: process.env.FEATUREKIT_ADMIN_PASSWORD,
  },
});
```

[Every option, and the full environment schema →](docs/ops/deployment.md)

## Using it: server side

```ts
import { FeaturekitSDK } from "featurekit-server";

const flags = new FeaturekitSDK({
  sdkKey: process.env.FEATUREKIT_SDK_KEY!,
  baseUrl: "https://flags.internal.acme.com",
  persist: { kind: "file", path: ".featurekit/snapshot.json" },
  mode: "streaming",
});

await flags.ready({ timeoutMs: 5_000 });

const context = { key: user.id, plan: user.plan };
flags.get("new-checkout", context, false);
flags.get("loyalty-discount", context, 0);
flags.get("checkout-flow", context, "classic");
```

Synchronous, and it survives the control plane being gone: bootstrap →
persisted snapshot → last-known-good in memory → your default. `ready()` never
rejects; it times out into "serving defaults", which is a legitimate state to
run in rather than a failed deploy.

**The default is a required argument.** An optional one produces `undefined`
during an outage, and `if (undefined)` is a wrong answer that looks like a right
one. Requiring it forces every call site to say what happens when featurekit is
unavailable — the one decision a flag SDK must not make for you.

The one difference from `featurekit-client` is the **context per call**. This
SDK holds the ruleset, so a single instance answers for every identity your
process serves; nothing is held per user, and there is no round trip. The client
takes no context because the connection is the context, and holds one identity
at a time.

## Using it: everywhere else

```ts
import { FeaturekitClient } from "featurekit-client";

export const flags = new FeaturekitClient({
  clientKey: PUBLIC_CLIENT_KEY,
  baseUrl: "https://flags.acme.com",
  context: { key: user.id, plan: user.plan },
  stream: true,
});

await flags.ready();

flags.get("new-checkout", false);       // boolean
flags.get("loyalty-discount", 0);       // number
flags.get("checkout-flow", "classic");  // string
flags.get("theme", { accent: "blue" }); // json

flags.on("change", () => render());     // pushed over SSE, no polling
await flags.identify(nextUser);         // the one async operation
```

One `get` for every type. The default is required and does two jobs: it states
what happens when featurekit is unavailable, and its type is the expected type —
`get("new-checkout", false)` is a `boolean` with no annotation, and a value that
somehow is not one falls back rather than handing `"false"` to an `if`.

It is synchronous, because the values are already in memory. That is what lets
it be called during a render, where a promise cannot. `await flags.get(…)` is
valid if you prefer the shape, but there is nothing behind it to await.

Build it **once**. Re-creating it resets the ordering guard that keeps a slow
response for one user off another user's screen.

**One instance, one identity.** Right for a browser or a phone, where there is
one user in front of the screen. A backend answering for many users
concurrently needs one instance per identity — or the server SDK above, which
takes a context per call and never goes to the network.

The client key is public by construction: it ships in a page, a binary, an APK
anyone can unzip. That is safe, because it buys evaluated values for one context
and never the ruleset.

### Frameworks

There is no React package, no Vue package, no React Native package. A binding is
twenty lines over two methods that already exist — `detail(flagKey)` reads
synchronously, `on("change", handler)` returns an unsubscribe function — and a
package per framework turns those twenty lines into a version matrix owed on
somebody else's release schedule.

[Framework adapters](docs/client-tier/adapters.md) has those twenty lines for
React, Vue and Svelte. Copy the one you need; it is then yours.

### React Native

Same package, same adapter, one extra line. React Native's built-in `fetch`
buffers whole bodies and exposes no `ReadableStream`, so the SSE stream cannot
open and the SDK falls back to re-fetching on a timer. Pass a streaming fetch:

```ts
import { fetch as expoFetch } from "expo/fetch";

new FeaturekitClient({ …options, fetchImpl: expoFetch as unknown as typeof fetch });
```

[`examples/mobile`](examples/mobile) is that, in a working app.

### Secure mode

Production rejects unsigned contexts, because the server evaluates *as* the
identity it is handed. Your backend mints the signature where the session is
already trusted:

```ts
import { signContext, contextHash } from "featurekit-server/secure-mode";

app.get("/api/featurekit-signature", requireSession, (req, res) => {
  const context = { key: req.user.id, plan: req.user.plan };
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  res.json({
    signature: signContext(context.key, expiresAt, SECRETS, contextHash(context)),
    expiresAt,
  });
});
```

Then hand the pair to the client, with `onSignatureExpiring` to refresh before
it lapses.

A separate entry point from `featurekit` because of what it does not load: the
main entry is the control plane, so importing it pulls Drizzle, a Postgres
driver and ioredis into a service whose only job is signing a string —
`featurekit-server/secure-mode` imports in 15ms where `featurekit-server` takes 3.5s.

**Pass the `attributesHash`.** A signature over the key alone authenticates
*who* the context claims to be and nothing about what it claims to be true — a
user holding a valid signature for their own id can send
`{ key: "u-ana", plan: "enterprise" }` and be evaluated as an enterprise
customer. `contextHash(context)` closes that, and costs one function call.

---

## Examples

The **[`examples/basic-example`](examples/basic-example)** folder contains a complete end-to-end setup demonstrating the 4 core flag types (Toggle/Boolean, Text/String, Number, and JSON/Object) across server, web, and mobile:

- **`server/`**: Runs the Featurekit Control Plane and exposes `POST /api/swap` for live flag rotations.
- **`website/`**: Interactive browser app listening to live SSE stream updates.
- **`expo-app/`**: React Native (Expo) mobile app connecting to the same live stream.

### Running the Example

```bash
# 1. Build the packages
npm install
npm run build

# 2. Start the Server & Web App
node examples/basic-example/server/server.js

# 3. Swap flags in real-time (in another terminal):
node examples/basic-example/server/swap.js
```

- **Website**: `http://127.0.0.1:4000`
- **Admin Dashboard**: `http://127.0.0.1:3000/admin` (`admin@featurekit.dev` / `password12345`)
- **Expo Mobile App**: `cd examples/basic-example/expo-app && npm run web`

---

## Documentation

| | |
| :-- | :-- |
| [Client SDK](docs/client-tier/client-sdk.md) | Values not rules, `identify` ordering, secure mode |
| [Framework adapters](docs/client-tier/adapters.md) | The twenty lines, for React, Vue and Svelte |
| [Plain HTTP](docs/client-tier/http.md) | The contract non-JavaScript apps implement |
| [Server SDK](docs/sdk/server-sdk.md) | Snapshots, persistence, surviving an outage |
| [Deployment](docs/ops/deployment.md) | Migrations, draining, backup and recovery |
| [Runbooks](docs/ops/runbooks.md) · [Alerts](docs/ops/alerts.md) | When it is on fire |
| [Evaluation](docs/evaluation/evaluator.md) | Bucketing, operators, segments, determinism |
| [Decisions](docs/decisions.md) | Where the implementation departs from the plan, and why |

## Developer Commands

```bash
npm run build                  # Build server, evaluator, client, and dashboard
npm run typecheck              # Typecheck entire workspace
npm test                       # Run Vitest test suite
npm run dev                    # Run server in watch mode
npm run migrate                # Run database migrations
node tools/check-package.mjs   # Validate package contents & boundaries
```

The conformance corpus is generated by an independent transcription of the
murmur3 spec that shares no code with the evaluator, and CI checks that it still
regenerates byte-for-byte.

## Licence

MIT
