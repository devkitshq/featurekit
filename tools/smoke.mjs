/**
 * The packages as a user gets them.
 *
 * Every other test imports `src/`. This one packs both packages, installs the
 * tarballs into an empty project and drives them through public interfaces
 * only — the README quickstart, the management API, both SDKs — so a missing
 * dependency, a file left out of `files`, or a README that no longer works
 * fails here instead of for the first person who tries it.
 *
 *   npm run build
 *   DATABASE_URL=postgres://... node tools/smoke.mjs
 *
 * The database is migrated and written to; use a throwaway one.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DATABASE_URL = required("DATABASE_URL");
const PORT = 40_000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "smoke@featurekit.dev";
const PASSWORD = "smoke-password-123";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    process.stderr.write(`smoke: ${name} is required (a throwaway database; it is migrated and written to)\n`);
    process.exit(78);
  }
  return value;
}

function step(message) {
  process.stdout.write(`smoke: ${message}\n`);
}

function npm(args, cwd) {
  return execFileSync(NPM, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
}

const work = mkdtempSync(join(tmpdir(), "featurekit-smoke-"));
const app = join(work, "app");
let server;

try {
  /* ── pack and install, as from npm ─────────────────────────────────── */

  step("packing");
  npm(["pack", "--pack-destination", work], ROOT);
  npm(["pack", "--pack-destination", work], join(ROOT, "packages", "client"));
  const tarballs = readdirSync(work).filter((f) => f.endsWith(".tgz")).map((f) => join(work, f));
  if (tarballs.length !== 2) throw new Error(`expected 2 tarballs, found ${tarballs.join(", ")}`);

  step("installing into an empty project");
  execFileSync("node", ["-e", "require('fs').mkdirSync(process.argv[1])", app]);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke-app", private: true, type: "module" }));
  npm(["install", "--no-audit", "--no-fund", ...tarballs], app);

  /* ── the README quickstart, verbatim ───────────────────────────────── */

  // No addresses and no testcontainers installed: it must explain itself
  // rather than crash on a missing module.
  writeFileSync(
    join(app, "quickstart.js"),
    `import { FeaturekitServer } from "featurekit-server";

const server = new FeaturekitServer({
  services: ["all"],
  port: 3000,
});

await server.start();
`,
  );
  step("README quickstart without dev helpers explains what to install");
  const quickstart = await run(["quickstart.js"], { DATABASE_URL: undefined }, 60_000);
  expect(quickstart.code !== 0, `quickstart should fail without addresses, exited ${quickstart.code}`);
  expect(
    quickstart.output.includes("npm i -D @testcontainers/postgresql"),
    `quickstart error does not say what to install:\n${quickstart.output}`,
  );

  /* ── entry points load ─────────────────────────────────────────────── */

  step("subpath entry points load");
  writeFileSync(
    join(app, "entries.js"),
    `import { migrate, migrationStatus } from "featurekit-server/migrate";
import { signContext, contextHash } from "featurekit-server/secure-mode";
import { evaluate } from "featurekit-server/evaluation";
for (const fn of [migrate, migrationStatus, signContext, contextHash, evaluate]) {
  if (typeof fn !== "function") throw new Error("missing export");
}
await migrate();
const status = await migrationStatus();
if (!(status.applied > 0 && status.partitionRunwayDays > 0)) throw new Error(JSON.stringify(status));
`,
  );
  const entries = await run(["entries.js"], {}, 120_000);
  expect(entries.code === 0, `entry points failed:\n${entries.output}`);

  /* ── a running control plane ───────────────────────────────────────── */

  writeFileSync(
    join(app, "server.js"),
    `import { FeaturekitServer } from "featurekit-server";

const server = new FeaturekitServer({
  services: ["all"],
  port: ${PORT},
  databaseUrl: process.env.DATABASE_URL,
  devStateFile: false,
  env: { FEATUREKIT_ADMIN_EMAIL: "${EMAIL}", FEATUREKIT_ADMIN_PASSWORD: "${PASSWORD}" },
  flags: {
    project: { key: "smoke", name: "Smoke" },
    environment: { key: "development", name: "Development", isProduction: false },
    flags: [
      {
        key: "smoke-flag",
        name: "Smoke flag",
        kind: "boolean",
        clientAvailable: true,
        variations: [{ name: "off", value: false }, { name: "on", value: true }],
        config: { enabled: true, offVariation: "off", fallthroughVariation: "on" },
      },
    ],
  },
});

await server.start();
`,
  );
  step("starting the control plane");
  server = start(["server.js"]);
  await waitFor(async () => (await fetch(`${BASE}/ready`)).ok, 60_000, () => server.output());

  step("logging in with the seeded account and minting an access token");
  const login = await fetch(`${BASE}/v1/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(login.ok, `login failed: ${login.status} ${await login.text()}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const minted = await api("POST", "/v1/admin/tokens", { name: "smoke" }, { cookie, "x-featurekit-csrf": "1" });
  const auth = { authorization: `Bearer ${minted.token}` };

  step("creating client and server keys");
  const keys = "/v1/admin/projects/smoke/environments/development/keys";
  const clientKey = (await api("POST", keys, { kind: "client" }, auth)).key;
  const serverKey = (await api("POST", keys, { kind: "server" }, auth)).key;

  /* ── both SDKs, and a change pushed to each ────────────────────────── */

  writeFileSync(
    join(app, "sdks.js"),
    `import { FeaturekitClient } from "featurekit-client";
import { FeaturekitSDK } from "featurekit-server";

const timeout = (ms, what) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for " + what)), ms));
const tell = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

const client = new FeaturekitClient({
  clientKey: process.env.CLIENT_KEY,
  baseUrl: process.env.BASE,
  context: { kind: "user", key: "smoke-user" },
  stream: true,
});
const sdk = new FeaturekitSDK({ sdkKey: process.env.SERVER_KEY, baseUrl: process.env.BASE, mode: "streaming" });

await Promise.race([Promise.all([client.ready(), sdk.ready({ timeoutMs: 15000 })]), timeout(20000, "ready")]);
tell({ phase: "before", client: client.get("smoke-flag", false), server: sdk.get("smoke-flag", { key: "smoke-user" }, false) });

const clientChanged = new Promise((done) => client.on("change", () => client.get("smoke-flag", true) === false && done()));
const serverChanged = (async () => {
  while (sdk.get("smoke-flag", { key: "smoke-user" }, true) !== false) await new Promise((r) => setTimeout(r, 100));
})();
tell({ phase: "listening" });

await Promise.race([Promise.all([clientChanged, serverChanged]), timeout(20000, "the change to arrive")]);
tell({ phase: "after", client: client.get("smoke-flag", true), server: sdk.get("smoke-flag", { key: "smoke-user" }, true) });
client.close();
sdk.close?.();
process.exit(0);
`,
  );
  step("reading the flag through both SDKs, then flipping it");
  const sdks = start(["sdks.js"], { BASE, CLIENT_KEY: clientKey, SERVER_KEY: serverKey });
  await waitFor(() => sdks.lines().some((l) => l.phase === "listening"), 30_000, () => sdks.output());
  const before = sdks.lines().find((l) => l.phase === "before");
  expect(before?.client === true && before?.server === true, `expected the flag on first: ${JSON.stringify(before)}`);

  await api("POST", "/v1/admin/projects/smoke/environments/development/flags/smoke-flag/off", { comment: "smoke" }, auth);
  const exit = await sdks.exited;
  const after = sdks.lines().find((l) => l.phase === "after");
  expect(exit === 0 && after?.client === false && after?.server === false, `change not delivered:\n${sdks.output()}`);

  step("all checks passed");
} catch (error) {
  process.stderr.write(`smoke: FAILED — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  server?.kill();
  await server?.exited;
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows can hold the directory briefly after the child exits.
  }
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(method, path, body, headers) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return JSON.parse(text);
}

function childEnv(extra) {
  const env = { ...process.env, DATABASE_URL, NODE_ENV: "development", ...extra };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

function start(args, extra = {}) {
  const child = spawn("node", args, { cwd: app, env: childEnv(extra) });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((done) => child.on("exit", (code) => done(code)));
  return {
    exited,
    output: () => output,
    lines: () =>
      output
        .split("\n")
        .filter((line) => line.startsWith("{\"phase\""))
        .map((line) => JSON.parse(line)),
    kill: () => child.kill(),
  };
}

async function run(args, extra, timeoutMs) {
  const child = start(args, extra);
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const code = await child.exited;
  clearTimeout(timer);
  return { code, output: child.output() };
}

async function waitFor(check, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${timeoutMs}ms\n${describe()}`);
}
