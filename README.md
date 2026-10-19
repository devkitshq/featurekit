<div align="center">

# featurekit

**Feature flags with a control plane you run.**

Self-hosted feature flags for Node and everything that talks HTTP. Targeting rules, percentage rollouts, segments, a kill switch, scheduled changes, change requests, an audit log and an admin dashboard, all on the Postgres you already have.

[![npm version](https://img.shields.io/npm/v/featurekit-server.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/featurekit-server) [![npm client](https://img.shields.io/npm/v/featurekit-client.svg?style=flat-square&color=6366f1&label=client)](https://www.npmjs.com/package/featurekit-client) [![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178c6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-339933.svg?style=flat-square)](https://nodejs.org) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)

[Documentation](docs/README.md) · [Quickstart](#quickstart) · [Examples](#examples) · [MCP server](packages/mcp/README.md)

</div>

### Why feature flags exist

Deploying code and releasing a feature are two different decisions, and a flag lets you make them separately. You merge and deploy on Tuesday, then turn the feature on Thursday for your own team, then for 5% of users, then for everyone. If it breaks, you turn it off in seconds instead of reverting, rebuilding and redeploying in the middle of an incident.

### Why they are hard to build

Checking a flag is one line:

```ts
if (flags.get("new-checkout", false)) {
  // …
}
```

Everything behind that line is the hard part.

- Flags sit on hot paths and get checked many times per request, so a check can't be a network call. Every server needs the rules in memory, and needs to hear about a change within seconds.
- Browsers and mobile apps need answers too, but the rules name your customers, your segments and features you haven't announced. The browser must never see them, only the results.
- A rollout raised from 10% to 20% has to keep the first 10% in, and a user has to get the same answer from every server.
- The kill switch has to work during the incident it exists for, and an SDK has to keep answering from the last rules it saw when the control plane is down.
- A flag changes production without a deploy, so changes need review, scheduling and a record of who flipped what.

featurekit is that machinery, in two packages:

```bash
npm i featurekit-server  # runs the control plane; evaluates server-side
npm i featurekit-client  # browsers, React Native, Node, Deno, Bun, edge
```

`featurekit-server` is the control plane plus an evaluator that holds the ruleset in memory. `featurekit-client` is one client for everything else, with no framework bindings and no per-runtime build. Not writing JavaScript? Skip both and implement [two HTTP endpoints](docs/client-tier/http.md).

## Quickstart

You need Node 20+ and Docker running. In development featurekit starts a throwaway Postgres container for you.

**1. Install**

```bash
mkdir acme-flags && cd acme-flags
npm init -y && npm pkg set type=module
npm i featurekit-server
npm i -D @testcontainers/postgresql  # dev only, see below
```

**2. Start the control plane**

It is a class you construct, in one file, and you own the process.

```js
// server.js
import { FeaturekitServer } from "featurekit-server";

const server = new FeaturekitServer({
  services: ["all"],
  port: 3000,
  env: {
    FEATUREKIT_ADMIN_EMAIL: "you@acme.com",
    FEATUREKIT_ADMIN_PASSWORD: process.env.FEATUREKIT_ADMIN_PASSWORD,
  },
});

await server.start();
```

```bash
FEATUREKIT_ADMIN_PASSWORD=choose-a-long-one node server.js
```

That runs the management API, the client tier, the streams, event ingest, the rollup worker, the scheduler and a dashboard on `http://127.0.0.1:3000/admin`. The `env` block seeds your login. The account is created if it does not exist and never overwritten if it does.

**3. Create a key.** Open `/admin`, sign in, create a project and an environment, then go to **Keys → New key**. Use `server` for backend services, and `client` or `mobile` for anything a user can unzip. The plaintext is shown once.

**4. Read a flag**

```ts
import { FeaturekitSDK } from "featurekit-server";

const flags = new FeaturekitSDK({
  sdkKey: process.env.FEATUREKIT_SDK_KEY!,
  baseUrl: "http://127.0.0.1:3000",
});

await flags.ready({ timeoutMs: 5_000 });
flags.get("new-checkout", { key: user.id, plan: user.plan }, false);
```

[`examples/basic-example`](examples/basic-example) is the whole thing running, with a website and an Expo app reading the same flags.

### Development vs. production

Outside production, featurekit brings up Postgres in Docker when you have not given it an address, and runs the migrations. That needs Docker and the `@testcontainers/postgresql` package above. It is a dev dependency so production installs never carry it; without it, `start()` tells you to install it or pass `databaseUrl`. Postgres is the only thing featurekit needs.

Only addresses you did not specify are started. An explicit `databaseUrl` that does not answer is an error, never a silent redirect to a fresh empty container.

Production requires `databaseUrl`, and a secure-mode secret once a client key exists. Set exact CORS origins and run migrations as a deploy step. See [Going to production](#going-to-production).

## The one idea worth knowing first

There are two tiers, and the split is a security boundary.

The **server tier** gets the compiled ruleset. It evaluates any context synchronously, in memory, with no network call per check, and keeps working when the control plane is down.

The **client tier** gets evaluated values for one context and never the rules. A rule reading `plan in [pro, enterprise]` tells anyone with devtools that a paid tier exists and what it is called. Rollout percentages disclose release plans. Segment definitions name your churn-risk cohort. Minification fixes none of that, so the rules are never sent. A flag marked `clientAvailable: false` never leaves the server at all.

That is why the client SDK's reads take no context argument: the connection is the context.

## Run it from your AI agent

Connect [`featurekit-mcp`](packages/mcp/README.md) to Claude Code, Claude Desktop or any MCP client:

```bash
claude mcp add featurekit \
  --env FEATUREKIT_URL=http://127.0.0.1:3000 \
  --env FEATUREKIT_TOKEN=fk_pat_... \
  --env FEATUREKIT_MCP_WRITE=1 \
  -- npx -y featurekit-mcp
```

Then ask:

```text
You:   Roll out cart v2 page to 20% of users in production.

Agent: Done. cart-v2-page in production: 20% get true, the rest get
       false. The flag was off; it is now on.
```

```text
You:   Kill cart v2 page in production, checkout is erroring.

Agent: Done. cart-v2-page is off in production. Everyone gets false.
```

It works through the admin API with a personal access token, so it can do what that token can and nothing more. Every change lands in the audit log marked `via featurekit-mcp`.

## Built in

| Feature | What you get |
| :-- | :-- |
| Targeting | Rules on any context attribute, individual targets, prerequisites on other flags, and segments. Large segments ship as exact roaring bitmaps or cuckoo filters. |
| Rollouts | Percentage rollouts that keep the same people in as the percentage rises. |
| Kill switch | `POST …/off` needs no version and propagates immediately, without waiting on other edits. |
| No lost edits | Every configuration write carries the version it read. A concurrent edit is refused with the current state. |
| Governance | Scheduled changes, change requests with approval, dry runs against real contexts, and revert to any audited state. |
| Audit log | Who changed what, with the before and after of every change, in a hash chain you can verify. |
| Secure mode | Production rejects unsigned client contexts, so nobody can read the flags of an identity they cannot prove. |
| Survives outages | The server SDK serves its persisted snapshot, then its last good one, then your default. |

## Running the control plane

### Flags as data in your repository

Definitions belong in version control. On/off and targeting belong to whoever is on call. Passing `flags` gets you both:

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

On restart, new flags are created and definitions kept current. Existing flags keep whatever the dashboard says, so a toggle somebody flipped at 3am is not reverted by the next deploy. `flagsReset: true` overrides that, deliberately.

[`examples/basic-example/server`](examples/basic-example/server) is a working version of this setup.

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

Four defaults that other tools get wrong:

`host: "0.0.0.0"` is required behind a load balancer. The default is loopback, and the symptom of leaving it is a healthy process serving nobody.

Configuration reports every missing variable at once, before the port is bound. Three restarts to find three mistakes would be three outages.

Draining is ordered. `SIGTERM` makes `/ready` answer 503 before the socket stops accepting, so the load balancer stops sending work first. Then every open stream gets its own jittered reconnect delay, which stops a synchronised reconnect storm on every release. Point liveness at `/live` and readiness at `/ready`, and set your orchestrator's termination grace period above `SHUTDOWN_GRACE_MS` (10s by default). `/health` and `/metrics` are there too.

Migrations are additive and forward-only. Old code runs against the new schema for the length of a rollout, so the order is migrate, deploy new, drain old.

### Migrations

Run migrations as a separate step before the new nodes start. Every node migrating on boot is a lock convoy: N nodes take the same locks at the same moment, one holding an `ACCESS EXCLUSIVE` lock on a large table while the rest queue behind it, during a deploy, while traffic is shifting.

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

`migrate()` reads `DATABASE_URL` and `DATABASE_SCHEMA`, or takes `{ databaseUrl, schema }`. It refuses to guess the database, because a deploy job quietly migrating the wrong one is far worse than a failed deploy.

It is safe to run concurrently: it takes a Postgres advisory lock first, so a retried pipeline or two racing CI jobs produce one migration and one no-op. It is idempotent, so it is safe to run repeatedly. It also creates partition runway in the same step, since a deploy that leaves the analytics table without partitions has only postponed its failure.

```js
import { migrationStatus } from "featurekit-server/migrate";

const { applied, partitionRunwayDays } = await migrationStatus();
```

Run that on a schedule as well as at deploy time. Runway shrinks on its own, and the failure arrives without a deploy to blame.

`autoMigrate: true` is still available and takes the same lock, because it calls the same function. It suits a single-node deployment and is wrong for a fleet.

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

Set `devServices: false` explicitly if your image might ever run outside production without a reachable database. Otherwise it will try to start one in Docker, from inside Docker.

### Scaling

Split the process by service when one machine stops being enough:

```js
new FeaturekitServer({ services: ["api", "stream"] });      // scale horizontally
new FeaturekitServer({ services: ["rollup", "scheduler"] }); // keep it small
```

Or set `FEATUREKIT_SERVICES=api,stream` and run the packaged entrypoint, `node node_modules/featurekit-server/dist/main.js`, if you would rather configure by environment than by file.

[Every option, and the full environment schema](docs/ops/deployment.md)

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

Reads are synchronous, and they survive the control plane being gone: bootstrap, then the persisted snapshot, then the last good snapshot in memory, then your default. `ready()` never rejects. It times out into serving defaults, which is a legitimate state to run in.

The default is a required argument. An optional one produces `undefined` during an outage, and `if (undefined)` is a wrong answer that looks like a right one. Requiring it makes every call site say what happens when featurekit is unavailable, which is a decision a flag SDK must not make for you.

The difference from `featurekit-client` is the context per call. This SDK holds the ruleset, so a single instance answers for every identity your process serves, holds nothing per user and makes no round trip. The client takes no context, because the connection is the context, and holds one identity at a time.

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

One `get` covers every type. The default is required and does two jobs. It says what happens when featurekit is unavailable, and its type is the expected type: `get("new-checkout", false)` is a `boolean` with no annotation, and a value that somehow is not one falls back instead of handing `"false"` to an `if`.

It is synchronous because the values are already in memory, which lets you call it during a render, where a promise cannot run. `await flags.get(…)` is valid if you prefer the shape, but there is nothing behind it to await.

Build it once. Re-creating it resets the ordering guard that keeps a slow response for one user off another user's screen.

One instance holds one identity. That is right for a browser or a phone, with one user in front of the screen. A backend answering for many users at once needs one instance per identity, or the server SDK above, which takes a context per call and never goes to the network.

The client key is public by construction: it ships in a page, a binary or an APK anyone can unzip. That is safe, because the key only buys evaluated values for one context.

### Frameworks

There is no React package, no Vue package and no React Native package. A binding is twenty lines over two methods that already exist: `detail(flagKey)` reads synchronously, and `on("change", handler)` returns an unsubscribe function. A package per framework would turn those twenty lines into a version matrix owed on somebody else's release schedule.

[Framework adapters](docs/client-tier/adapters.md) has the twenty lines for React, Vue and Svelte. Copy the one you need, and it is yours.

### React Native

Same package, same adapter, one extra line. React Native's built-in `fetch` buffers whole bodies and exposes no `ReadableStream`, so the SSE stream cannot open and the SDK falls back to re-fetching on a timer. Pass a streaming fetch:

```ts
import { fetch as expoFetch } from "expo/fetch";

new FeaturekitClient({ …options, fetchImpl: expoFetch as unknown as typeof fetch });
```

[`examples/basic-example/expo-app`](examples/basic-example/expo-app) does exactly that in a working Expo app.

### Secure mode

Production rejects unsigned contexts, because the server evaluates as whatever identity it is handed. Your backend mints the signature where the session is already trusted:

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

Then hand the pair to the client, with `onSignatureExpiring` to refresh it before it lapses.

`featurekit-server/secure-mode` is a separate entry point so that a service whose only job is signing a string does not load the control plane. The main entry pulls in Drizzle, a Postgres driver and the logger; `featurekit-server/secure-mode` imports in 15ms where `featurekit-server` takes 3.5s.

Pass the `attributesHash`. A signature over the key alone proves who the context claims to be and nothing about its attributes, so a user with a valid signature for their own id could send `{ key: "u-ana", plan: "enterprise" }` and be evaluated as an enterprise customer. `contextHash(context)` closes that for the cost of one function call.

## Examples

[`examples/basic-example`](examples/basic-example) is a complete setup showing the four flag types (boolean, string, number and JSON) across server, web and mobile:

- `server/` runs the control plane and exposes `POST /api/swap` for live flag rotations.
- `website/` is a browser app listening to live SSE updates.
- `expo-app/` is a React Native (Expo) app on the same live stream.

```bash
# 1. Build the packages
npm install
npm run build

# 2. Start the Server & Web App
node examples/basic-example/server/server.js

# 3. Swap flags in real-time (in another terminal):
node examples/basic-example/server/swap.js
```

The website is at `http://127.0.0.1:4000` and the dashboard at `http://127.0.0.1:3000/admin` (`admin@featurekit.dev` / `password12345`). For the mobile app, run `cd examples/basic-example/expo-app && npm run web`.

## Documentation

| Guide | Description |
| :-- | :-- |
| [Client SDK](docs/client-tier/client-sdk.md) | Values not rules, `identify` ordering, secure mode |
| [Framework adapters](docs/client-tier/adapters.md) | The twenty lines, for React, Vue and Svelte |
| [Plain HTTP](docs/client-tier/http.md) | The contract non-JavaScript apps implement |
| [Server SDK](docs/sdk/server-sdk.md) | Snapshots, persistence, surviving an outage |
| [MCP server](packages/mcp/README.md) | Managing flags from Claude and other MCP clients |
| [Deployment](docs/ops/deployment.md) | Migrations, draining, backup and recovery |
| [Runbooks](docs/ops/runbooks.md) · [Alerts](docs/ops/alerts.md) | When it is on fire |
| [Evaluation](docs/evaluation/evaluator.md) | Bucketing, operators, segments, determinism |
| [Decisions](docs/decisions.md) | Where the implementation departs from the plan, and why |

## Contributing

Issues and pull requests are welcome.

```bash
npm run build                  # Build server, evaluator, client, and dashboard
npm run typecheck              # Typecheck entire workspace
npm test                       # Run Vitest test suite
npm run dev                    # Run server in watch mode
npm run migrate                # Run database migrations
node tools/check-package.mjs   # Validate package contents & boundaries
```

The integration tests start their own Postgres container, so Docker is the only thing you need running for the full suite.

The conformance corpus is generated by an independent transcription of the murmur3 spec that shares no code with the evaluator, and CI checks that it still regenerates byte for byte.

## License

MIT
