# @featkit/client

The client-tier SDK for **featkit** — evaluated feature flag values, never the ruleset.

```bash
npm i @featkit/client
```

One client, zero runtime dependencies, and any JavaScript runtime:
- **Browsers** (Vanilla JS, React, Vue, Svelte, Angular, Solid)
- **Mobile** (React Native, Expo)
- **Server / Edge runtimes** (Node.js, Deno, Bun, Cloudflare Workers, Vercel Edge)

---

## Why `@featkit/client`?

### The Security & Performance Split
Shipping targeting rules and segment definitions to a client application exposes business logic:
- An unreleased tier name (`plan in ["enterprise", "stealth-ai"]`) reveals unannounced product launches in DevTools.
- Rollout percentage logic discloses release plans.
- Segment definitions leak private user targeting rules.
- Mobile binaries can be unzipped and inspected.

**`@featkit/client` only ever receives evaluated values for a single identity.** Flags marked `clientAvailable: false` never leave the server. The connection *is* the context.

---

## Installation

```bash
npm install @featkit/client
# or
pnpm add @featkit/client
# or
yarn add @featkit/client
```

---

## Quick Start

```ts
import { FeatkitClient } from "@featkit/client";

const flags = new FeatkitClient({
  baseUrl: "https://flags.acme.com", // Your featkit server URL
  clientKey: "fk_clt_development_...",
  context: {
    key: "user-123",
    email: "user@example.com",
    plan: "pro",
  },
});

// Wait for initial flag evaluation
await flags.ready();

// Synchronous flag evaluation
if (flags.get("new-checkout", false)) {
  showNewCheckout();
}

// Subscribe to real-time flag changes (via Server-Sent Events)
const unsubscribe = flags.on("change", (changedKeys) => {
  console.log("Flags updated:", changedKeys);
  if (changedKeys.includes("new-checkout")) {
    updateCheckoutUI(flags.get("new-checkout", false));
  }
});

// Later, when switching user identities (e.g., login / logout):
await flags.identify({ key: "user-456", plan: "enterprise" });

// Clean up when shutting down or unmounting:
flags.close();
```

---

## API Reference

### `new FeatkitClient(options)`

```ts
interface FeatkitClientOptions {
  baseUrl: string;
  clientKey: string;
  context?: { key: string; [attribute: string]: unknown };
  streaming?: boolean;          // Default: true (real-time updates via SSE)
  bootstrap?: FlagStateResponse; // Preloaded server-side state for instant render
  offline?: boolean;            // Default: false
  signature?: SignaturePair;    // Optional HMAC signature for Secure Mode
  fetchImpl?: typeof fetch;
  eventSourceImpl?: typeof EventSource;
  onError?: (error: unknown) => void;
}
```

### Methods

- **`flags.ready(): Promise<void>`**
  Resolves when the initial flag state is fetched and available for evaluation.

- **`flags.get<T>(flagKey: string, defaultValue: T): T`**
  Synchronously returns the evaluated flag value for the current identity. If the flag does not exist or has not loaded, returns `defaultValue`.

- **`flags.identify(context: EvaluationContextLike, signature?: SignaturePair): Promise<void>`**
  Switches the evaluation context to a new identity, immediately fetching new flag values and reconnecting real-time streams.

- **`flags.on(event: "change", handler: (keys: string[]) => void): () => void`**
  Fires whenever flag evaluations change (via real-time stream push or `identify`). Returns an unsubscribe function.

- **`flags.on(event: "state", handler: (state: ClientState) => void): () => void`**
  Fires on client lifecycle state changes: `"initializing" | "ready" | "identifying" | "offline"`.

- **`flags.close(): void`**
  Closes active SSE streaming connections and aborts in-flight network requests.

---

## Secure Mode

For sensitive environments, enable **Secure Mode** to guarantee context integrity with HMAC signatures:

```ts
const flags = new FeatkitClient({
  baseUrl: "https://flags.acme.com",
  clientKey: "fk_clt_production_...",
  context: { key: "user-123", email: "alice@acme.com" },
  signature: {
    hash: "a3f89e2...", // Generated server-side with @featkit/server/secure-mode
    issuedAt: 1718000000,
  },
});
```

---

## Framework Integration

Because `@featkit/client` has zero dependencies and synchronous reads, integrating with any UI framework takes only a few lines:

### React Hook Example

```tsx
import { useState, useEffect } from "react";
import { FeatkitClient } from "@featkit/client";

export const client = new FeatkitClient({
  baseUrl: "https://flags.acme.com",
  clientKey: "fk_clt_...",
  context: { key: "anonymous" },
});

export function useFlag<T>(flagKey: string, defaultValue: T): T {
  const [value, setValue] = useState(() => client.get(flagKey, defaultValue));

  useEffect(() => {
    return client.on("change", (keys) => {
      if (keys.includes(flagKey)) {
        setValue(client.get(flagKey, defaultValue));
      }
    });
  }, [flagKey, defaultValue]);

  return value;
}
```

---

## License

MIT © [DevKits](https://github.com/devkitshq/featkit)
