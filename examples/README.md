# Examples

One control plane, and two clients reading from it — over two packages,
`featkit` and `featkit-client`.

| | What it is | Files |
| :-- | :-- | :-- |
| [`server/`](./server) | The control plane, and the flags it serves | `server.js`, `flags.js` |
| [`app/`](./app) | A browser app reading those flags live | `index.html`, `app.js`, `style.css` |
| [`mobile/`](./mobile) | A React Native app reading the same ones | `src/App.tsx`, `src/config.ts` |

Nothing here is stubbed. `server.js` starts the real control plane and pushes
`flags.js` through the real management API; `app.js` uses the published
`featkit-client` against the real client tier; `mobile/` uses that same
package with a twenty-line React adapter of its own, because there is no React
SDK and no React Native SDK — one client runs anywhere there is `fetch`.

## Run it

```bash
npm install
npm run build        # the server, the client SDK, and the dashboard bundle
npm run demo         # starts everything
```

Then open both:

- **http://127.0.0.1:3000/admin** — the dashboard, `you@example.com` / `password12345`
- **http://127.0.0.1:4000** — the app

Toggle `new-checkout` in the dashboard. The app moves within a second, on the
connection it already holds — no reload, no deploy. Switch personas in the app's
header and watch targeting decide different answers for the same flag.

## Run it on a phone

```bash
npm run demo:lan             # the same demo, bound to 0.0.0.0
cd examples/mobile && npm install && npm start
```

Loopback is the default because `npm run demo` should not put a database and an
admin dashboard on whatever network you happen to be on. A device cannot reach
it, so the mobile example gets its own command. Details, including what to do
when the device is not on your network, are in
[`mobile/README.md`](./mobile/README.md).

Run the browser app and the phone at once and toggle a flag: both move, because
the answer is computed in one place and pushed to whoever is connected.

Docker is needed on the first run: the server starts Postgres and Redis if it
cannot reach them, and runs the migrations. Later runs reuse those containers.

```bash
npm run demo:reset   # also re-apply flags.js over anything changed in the UI
APP_PORT=4001 npm run demo
```

## Why two ports

The app is on `:4000` and the control plane on `:3000`, which makes every flag
fetch a **cross-origin** request — exactly as it is in production, where your
app and your flags do not share an origin. That means the client tier's CORS
allowlist is exercised here rather than assumed:

```js
corsAllowedOrigins: ["http://127.0.0.1:4000", "http://localhost:4000"]
```

Exact origins, never `*`. The client tier answers with a browser's evaluated
flag values, so an origin that is not on the list gets no CORS headers and the
browser refuses the response — which is the correct outcome and needs no error
of ours.

## What each side proves

**The server** ([`server/README.md`](./server/README.md)) — one process runs the
API, the streams, event ingest, the rollup worker and the scheduler; flags
arrive from a file in your repository over the same HTTP API a CI job would use;
operational state (on/off, targeting) stays owned by whoever is on call, not by
the last person who edited that file.

**The mobile app** ([`mobile/README.md`](./mobile/README.md)) — the browser
SDK, unchanged, on React Native; the only adaptation is handing it
`expo/fetch` so the SSE stream can actually open, since React Native's built-in
`fetch` has no streaming body. A binary a stranger can unzip is the strongest
case for the client tier sending values and never rules.

**The app** ([`app/README.md`](./app/README.md)) — the browser is sent evaluated
values and never the rules; a flag marked `clientAvailable: false` never reaches
it at all; switching users drops the previous user's values synchronously, so
nobody ever sees somebody else's flags.
