# The app

A browser client using `togglekit-client`. Three files, no build step:

```
index.html    the page
app.js        the SDK, the personas, the rendering
style.css     the look
```

It is served by [`../server`](../server) on **http://127.0.0.1:4000**, which
also hands it a client key over `/api/config`. Start everything with
`npm run demo`.

## What it demonstrates

**The browser never receives the ruleset.** It sends a context and gets back
evaluated values — `{ value, variationIndex, reason }` per flag, and nothing
else. A rule reading `plan in [pro, enterprise]` would tell anyone with devtools
that a paid tier exists and what it is called; rollout percentages disclose
release plans; segment definitions name your churn-risk cohort. The "what this
browser was told" panel is the entire payload, and you can confirm it in the
network tab.

**`internal-pricing-model` is not in that payload.** It is marked
`clientAvailable: false` in `flags.js`, so it is not filtered out in the UI — it
is never sent. The *existence* of an unreleased feature stays server-side.

**Switching users drops the previous user's values synchronously**, before the
network answers. Change persona in the header: the page never shows Ana's flags
to Ben, not even for a frame. Responses also apply in call order rather than
arrival order, so a slow reply for a user you have since switched away from is
discarded rather than applied over the newer one.

**Reads are synchronous.** No context argument — the connection *is* the
context — and no promise, because the values are already in memory:

```js
const fk = new TogglekitClient({ clientKey, baseUrl, context: user, stream: true });
await fk.ready();

fk.get("new-checkout", false);          // boolean
fk.get("loyalty-discount", 0);          // number
fk.get("checkout-flow", "classic");     // string

fk.on("change", (keys) => rerender(keys));   // pushed over SSE, no polling
await fk.identify(nextUser);                 // the one async operation
```

## The key it uses

A **client** key (`tk_clt_…`), public by construction: it ships in the page and
the network tab shows it. That is safe because it buys evaluated values for a
context, not the ruleset. A server key here would hand every visitor the whole
configuration, which is why the client tier refuses one outright.

In production the client tier also requires the context to be **signed** — an
HMAC your own server mints once it knows who is logged in — because the server
evaluates *as* the identity it is given. This demo's environment is marked
non-production, which is the only reason unsigned contexts work here.

## Try it from devtools

```js
window.fk.allValues();
window.fk.get("new-checkout", false);
await window.fk.identify({ key: "u-cleo", plan: "enterprise", tenureMonths: 40 });
```
