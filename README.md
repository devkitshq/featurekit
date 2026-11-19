<div align="center">

# featurekit

**Feature flags with a control plane you run.**

Self-hosted feature flags for Node and everything that talks HTTP. Targeting rules, percentage rollouts, segments, a kill switch, scheduled changes, change requests, an audit log and an admin dashboard, all on the Postgres you already have.

[![npm version](https://img.shields.io/npm/v/featurekit-server.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/featurekit-server) [![npm client](https://img.shields.io/npm/v/featurekit-client.svg?style=flat-square&color=6366f1&label=client)](https://www.npmjs.com/package/featurekit-client) [![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178c6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-339933.svg?style=flat-square)](https://nodejs.org) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)

[Documentation](docs/README.md) · [Quickstart](#quickstart) · [Examples](examples/basic-example) · [MCP server](packages/mcp/README.md)

</div>

Like LaunchDarkly, except it runs on the Postgres you already have, the server is a class inside your own Node process, and nothing bills per seat or per user.

```ts
if (flags.get("new-checkout", { key: user.id, plan: user.plan }, false)) {
  // …
}
```

That check is synchronous and in memory, with no network call. Behind it: rules streamed to every server within seconds, sticky percentage rollouts, a kill switch, and a fallback to the last good ruleset when the control plane is down.

## Why featurekit

- **Checks cost nothing.** The server SDK holds the compiled ruleset. A plain check is ~60ns, a hashed percentage rollout ~0.5µs. [Benchmarks →](docs/evaluation/benchmarks.md)
- **Browsers never see your rules.** Clients get evaluated values for one context, never the rules, segments or rollout percentages. Signed contexts in production, so nobody reads flags for an identity they can't prove.
- **Survives outages.** The SDK serves its persisted snapshot, then its last good one, then your default. The kill switch needs no version and propagates immediately.
- **Changes are governed.** Scheduled changes, change requests with approval, dry runs against real contexts, revert to any audited state, and a hash-chained audit log you can verify.
- **Flags live in git.** Definitions come from a file in your repo. On/off and targeting stay with whoever is on call, so a deploy never reverts a 3am toggle.

## Quickstart

You need Node 22+ and Docker running. In development featurekit starts a throwaway Postgres container for you.

```bash
npm i featurekit-server
npm i -D @testcontainers/postgresql   # dev only: the throwaway Postgres
```

```js
// server.js
import { FeaturekitServer } from "featurekit-server";

const server = new FeaturekitServer({
  port: 3000,
  flags: {
    project: { key: "acme", name: "Acme" },
    environment: { key: "development", name: "Development", isProduction: false },
    flags: [
      {
        key: "new-checkout",
        name: "New checkout flow",
        kind: "boolean",
        variations: [{ name: "off", value: false }, { name: "on", value: true }],
        config: { enabled: true, offVariation: "off", fallthroughVariation: "on" },
      },
    ],
  },
  env: { FEATUREKIT_ADMIN_EMAIL: "you@acme.com", FEATUREKIT_ADMIN_PASSWORD: process.env.FEATUREKIT_ADMIN_PASSWORD },
});

await server.start();
```

```bash
FEATUREKIT_ADMIN_PASSWORD=choose-a-long-one node server.js
```

Open `http://127.0.0.1:3000/admin`, sign in, and create a `server` key under **Keys → New key**. Then read the flag:

```js
// app.js
import { FeaturekitSDK } from "featurekit-server/sdk";

const flags = new FeaturekitSDK({ sdkKey: process.env.FEATUREKIT_SDK_KEY, baseUrl: "http://127.0.0.1:3000" });
await flags.ready({ timeoutMs: 5_000 });

setInterval(() => console.log(flags.get("new-checkout", { key: "user-1" }, false)), 1_000);
```

Leave it running and turn `new-checkout` off in `/admin`. The output flips from `true` to `false` with no restart and no redeploy.

For production (`databaseUrl`, secure mode, CORS, migrations as a deploy step, draining), see [Deployment](docs/ops/deployment.md).

## How it compares

|                       | featurekit                     | Unleash                         | Flagsmith                       |
| :-------------------- | :----------------------------- | :------------------------------ | :------------------------------ |
| Self-hosted           | Yes                            | Yes                             | Yes                             |
| Storage               | Postgres                       | Postgres                        | Postgres                        |
| Control plane         | A class in your Node process   | Separate service                | Separate service (Python)       |
| Change requests       | Included                       | Enterprise edition              | Paid plans                      |
| Tamper-evident audit  | Hash chain you can verify      | Event log                       | Audit log on paid plans         |
| Framework SDKs        | One client, 20-line adapters   | Per-framework packages          | Per-framework packages          |
| License               | MIT, no paid edition           | Apache 2.0 core, commercial enterprise | BSD-3 core, commercial enterprise |

**LaunchDarkly** is hosted SaaS and the most complete option, with experimentation and a long list of SDKs, billed by seats and usage. featurekit costs whatever your Postgres costs.

If you need experimentation, A/B analytics or SDKs for a dozen languages today, Unleash or LaunchDarkly is the more complete choice. Choose featurekit if you want governance features without a commercial license, a control plane you embed instead of operate, and a small codebase you can read.

## Two tiers, one security boundary

The **server tier** (`featurekit-server/sdk`) gets the compiled ruleset and evaluates any context in memory. One instance answers for every user your process serves.

The **client tier** (`featurekit-client`) gets evaluated values for one context and never the rules. It runs in browsers, React Native, Deno, Bun and edge runtimes, and updates over SSE:

```ts
import { FeaturekitClient } from "featurekit-client";

const flags = new FeaturekitClient({ clientKey, baseUrl, context: { key: user.id }, stream: true });
await flags.ready();

flags.get("new-checkout", false);    // typed by the default
flags.on("change", () => render());  // pushed, no polling
```

Not writing JavaScript? Implement [two HTTP endpoints](docs/client-tier/http.md). React, Vue and Svelte bindings are [twenty lines you copy](docs/client-tier/adapters.md).

## Run it from your AI agent

Connect [`featurekit-mcp`](packages/mcp/README.md) to Claude Code, Cursor or any MCP client:

```bash
claude mcp add featurekit \
  --env FEATUREKIT_URL=http://127.0.0.1:3000 \
  --env FEATUREKIT_TOKEN=fk_pat_... \
  --env FEATUREKIT_MCP_WRITE=1 \
  -- npx -y featurekit-mcp
```

Then ask "roll out cart-v2 to 20% in production" or "kill cart-v2, checkout is erroring". It acts through a personal access token, so it can do what that token can and nothing more, and every change lands in the audit log marked `via featurekit-mcp`.

## Examples

[`examples/basic-example`](examples/basic-example) runs the control plane, a website and an Expo app on the same live stream, across all four flag types.

```bash
npm install && npm run build
node examples/basic-example/server/server.js
node examples/basic-example/server/swap.js   # in another terminal: flip flags live
```

The website is at `http://127.0.0.1:4000` and the dashboard at `http://127.0.0.1:3000/admin` (`admin@featurekit.dev` / `password12345`).

## Documentation

[Client SDK](docs/client-tier/client-sdk.md) · [Server SDK](docs/sdk/server-sdk.md) · [Plain HTTP](docs/client-tier/http.md) · [Framework adapters](docs/client-tier/adapters.md) · [Deployment](docs/ops/deployment.md) · [Runbooks](docs/ops/runbooks.md) · [Alerts](docs/ops/alerts.md) · [Evaluation](docs/evaluation/evaluator.md) · [Decisions](docs/decisions.md)

## Contributing

Issues and pull requests are welcome.

```bash
npm install
npm run build
npm test
```

The integration tests start their own Postgres container, so Docker is the only thing you need running.

## License

MIT. Use it for anything, including commercially. Every feature is in this repository: there is no paid edition and no hosted tier.
