import { TogglekitServer } from "togglekit";
import flags from "./flags.js";

/**
 * Loopback by default, because a demo should not put a database on your Wi-Fi
 * because you ran a command. `npm run demo:lan` sets `HOST=0.0.0.0`, which is
 * what a phone running `examples/mobile` needs to reach any of this.
 */
const host = process.env.HOST ?? "127.0.0.1";

const server = new TogglekitServer({
  services: ["all"],
  port: 3000,
  host,

  // Flag definitions live in the repository and are applied on start. Existing
  // flags keep whatever the dashboard says: TOGGLEKIT_FLAGS_RESET=1 overrides.
  flags,

  // The browser app next door, served on its own port with a client key.
  // Development only — in production your app is served by your own stack.
  // The app host follows `host`, so `/api/config` is reachable from a device
  // when the control plane is.
  app: { dir: new URL("../app", import.meta.url), port: 4000 },

  // The client tier is the only tier CORS applies to, and never with `*`:
  // these endpoints answer with a browser's evaluated flag values.
  // Native apps send no `Origin` header and are not subject to any of this;
  // the last two entries are Expo's web bundler, for `npm run web` in
  // `examples/mobile`.
  corsAllowedOrigins: [
    "http://127.0.0.1:4000",
    "http://localhost:4000",
    "http://127.0.0.1:8081",
    "http://localhost:8081",
  ],

  // The first dashboard account, created if it does not exist and never
  // overwritten if it does.
  env: {
    TOGGLEKIT_ADMIN_EMAIL: "you@example.com",
    TOGGLEKIT_ADMIN_PASSWORD: "password12345",
  },
});

try {
  await server.start();
} catch (error) {
  // The two ordinary failures are "this port is taken" and "Docker is not
  // running". Both deserve a sentence rather than a stack trace.
  process.stderr.write(`\ntogglekit: ${String(error.message ?? error)}\n\n`);
  process.exit(1);
}
