/**
 * Where the control plane is, and how this app gets a client key.
 *
 * Two things a browser gets for free and a phone does not:
 *
 * **The host.** `127.0.0.1` on a device is the device. The demo server runs on
 * your laptop, so the app has to be told your laptop's address on the network.
 * Expo already knows it — it is the host the bundler itself was reached on —
 * so it is read from `hostUri` rather than pasted into a constant that goes
 * stale the next time you join a different Wi-Fi.
 *
 * **The key.** In the browser demo the page is served by featurekit's dev app
 * host, which hands it `/api/config`. Nothing serves this app, so it asks that
 * same endpoint over the network. In a real mobile app this is *your* backend:
 * the call that happens right after login, returning the client key and — in a
 * production environment — the HMAC signature for the user who just
 * authenticated (§16).
 */

import Constants from "expo-constants";

/** The machine running `npm run demo`, as seen from this device. */
function developmentHost(): string {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Expo Go on older runtimes reports it here instead.
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost ??
    "";
  const host = hostUri.split(":")[0];
  return host.length > 0 ? host : "127.0.0.1";
}

const host = developmentHost();

/**
 * Overridable, because the one case `hostUri` cannot answer for you is a
 * device on a different network from the server. Put either in `.env`:
 *
 *   EXPO_PUBLIC_FEATKIT_URL=http://192.168.1.24:3000
 *   EXPO_PUBLIC_FEATKIT_CONFIG_URL=http://192.168.1.24:4000/api/config
 */
export const CONTROL_PLANE_URL =
  process.env.EXPO_PUBLIC_FEATKIT_URL ??
  process.env.EXPO_PUBLIC_FEATUREKIT_URL ??
  `http://${host}:3000`;

export const CONFIG_URL =
  process.env.EXPO_PUBLIC_FEATKIT_CONFIG_URL ??
  process.env.EXPO_PUBLIC_FEATUREKIT_CONFIG_URL ??
  `http://${host}:4000/api/config`;

export const DASHBOARD_URL = `${CONTROL_PLANE_URL}/admin`;

export interface AppConfig {
  clientKey: string;
  baseUrl: string;
}

/**
 * A **client** key (`fk_clt_…`), public by construction — it ships inside the
 * binary and anyone who unzips the IPA can read it. That is safe: it buys
 * evaluated values for one context, never the ruleset. A server key in a mobile
 * app would hand every installer the whole configuration, which is why the
 * client tier refuses one outright.
 */
export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch(CONFIG_URL);
  if (!response.ok) throw new Error(`${CONFIG_URL} answered ${response.status}`);
  const body = (await response.json()) as Partial<AppConfig>;
  if (typeof body.clientKey !== "string" || body.clientKey.length === 0) {
    throw new Error(`${CONFIG_URL} returned no client key`);
  }
  // `baseUrl` from the demo server is its own `127.0.0.1` address, which is not
  // reachable from a device. The host we already resolved is.
  return { clientKey: body.clientKey, baseUrl: CONTROL_PLANE_URL };
}
