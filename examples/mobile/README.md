# The mobile app

A React Native app — Expo, TypeScript — reading the same flags as
[`../app`](../app), from the same control plane, over the same SDK.

```bash
npm i togglekit-client
```

```
src/config.ts       where the server is, and how the app gets a client key
src/togglekit.ts      the streaming fetch (the one React Native-specific file)
src/App.tsx         provider, personas, the screen
src/components/     checkout, values panel, event log, persona switcher
```

## There is no React Native SDK — and no React SDK

`togglekit-client` is one client with no framework bindings, and it is the same
package a web app installs. Two things this app supplies that a browser supplies
for itself, plus one small file:

**A `fetch` that streams.** The SDK keeps values current over a Server-Sent
Events response, read with `response.body.getReader()`. React Native's built-in
`fetch` buffers the whole body and exposes no `ReadableStream`, so that stream
can never open — the SDK notices and falls back to re-fetching on a timer, which
is correct but not live.
[`expo/fetch`](https://docs.expo.dev/versions/latest/sdk/expo/#fetch-api) is a
WinterCG fetch with real streaming, so it is passed straight through:

```ts
new TogglekitClient({ ...options, fetchImpl: expoFetch as unknown as typeof fetch });
```

That is the entire React Native adaptation.

**An address.** `127.0.0.1` on a phone is the phone. `src/config.ts` reads the
host Expo's own bundler was reached on, which is your machine's address on the
network, and points the SDK at `:3000` there.

**A React adapter, twenty lines.** [`src/togglekit.ts`](./src/togglekit.ts) is
`useFlag`, `useAllValues` and `useTogglekitState`, all `useSyncExternalStore`
over `detail()` and `on("change")`. It is copied verbatim from
[`docs/client-tier/adapters.md`](../../docs/client-tier/adapters.md) — read it
once and you have seen the whole binding, which is the argument for not shipping
it as a package.

## Run it

From the repository root, with the SDKs built:

```bash
npm install
npm run build
npm run demo:lan       # like `npm run demo`, but bound to 0.0.0.0
```

`demo:lan` rather than `demo` because a phone cannot reach loopback on your
laptop, and because putting a database and an admin dashboard on whatever
network you happen to be on should be something you typed on purpose.

Then, in this directory:

```bash
npm install
npm start              # scan the QR code with Expo Go, or press i / a / w
```

The device and the machine running the server have to be on the same network.
If they are not — a simulator behind a different interface, a VPN, a device on
cellular — name the host yourself in `examples/mobile/.env`:

```
EXPO_PUBLIC_TOGGLEKIT_URL=http://192.168.1.24:3000
EXPO_PUBLIC_TOGGLEKIT_CONFIG_URL=http://192.168.1.24:4000/api/config
```

Open the dashboard on your laptop at **http://127.0.0.1:3000/admin**
(`you@example.com` / `password12345`) and toggle `new-checkout`. The phone moves
within a second, on the connection it already holds. Run `examples/app` in a
browser at the same time and the two agree, because the answer was computed once
and pushed to both.

## What it demonstrates

**The phone never receives the ruleset.** The "what this device was told" panel
is the whole payload — `{ value, variationIndex, reason }` per flag. Not the
clause `plan in [pro, enterprise]`, which would tell anyone who unzipped the IPA
that a paid tier exists and what it is called; not the rollout percentages,
which disclose the release plan; not the segment definitions, which name the
churn-risk cohort. A mobile binary is a file on a stranger's device that can be
read at leisure, so this matters more here than it does in a browser, not less.

**`internal-pricing-model` is absent from that panel.** It is marked
`clientAvailable: false` in [`../server/flags.js`](../server/flags.js), so it is
not filtered out on the device — it never left the server. The *existence* of an
unreleased feature stays server-side.

**Switching persona drops the previous user's values first.** Tap a different
name: `identify()` empties the local map synchronously, before the network is
asked, so between the tap and the response every read returns its default rather
than the person you just switched away from. Responses also apply in call order
rather than arrival order, so a slow reply for a persona you have since left is
discarded instead of overwriting the newer one — which on a phone, where the
network is a suggestion, is not a hypothetical.

**Reads are synchronous.** `useFlag(key, default)` never suspends, never returns
`undefined`, and takes no context argument, because the connection *is* the
context. The default is required for the same reason as on the server: an
optional one produces `undefined` during an outage, and `if (undefined)` is a
wrong answer that reads like a right one.

## The key it ships with

A **client** key (`tk_clt_…`), fetched here from the demo server's
`/api/config`. In your app that endpoint is yours — the call right after login —
and it is where you would mint the secure-mode HMAC signature for the user you
just authenticated:

```ts
new TogglekitClient({
  clientKey: key,
  contextSignature: signature,
  contextSignatureExpiresAt: expiresAt,
  onSignatureExpiring: () => fetch("/api/togglekit-signature").then((r) => r.json()),
  …
});
```

On your backend, `togglekit/secure-mode` exports `signContext` and
`contextHash` so the signature is three lines rather than a reimplementation.

A production environment requires that signature, because the server evaluates
*as* the identity it is given and a key baked into a binary is not proof of
identity. This demo's environment is marked non-production, which is the only
reason unsigned contexts work here.

## The monorepo bits you will not need

[`metro.config.js`](./metro.config.js) teaches Metro to watch and resolve out of
the repository root, because this example depends on `../../packages/client`
through a `file:` link. In your own app you `npm i togglekit-client` and the
default Expo config resolves it like anything else.
