/**
 * Postgres and Redis, started for you in development (§11.1, §17).
 *
 * `new FeaturekitServer({ services: ["all"] }).start()` is supposed to be the
 * whole setup step. That promise only holds if the two dependencies appear
 * without a compose file, so this module does the one thing that makes it true:
 * probe what the configuration points at, and if nothing answers, start a
 * container and point at that instead.
 *
 * Three rules keep this from becoming the kind of magic that eats an afternoon:
 *
 * 1. **Never in production.** The caller decides; this module refuses to be
 *    reached from a production start (see `server.ts`).
 * 2. **Never override an explicit URL.** If you passed `databaseUrl` or set
 *    `DATABASE_URL`, a failure to reach it is an error with the address in it,
 *    not a silent redirect to a container you did not ask for. Being pointed at
 *    a staging database and quietly served an empty local one is worse than not
 *    starting at all.
 * 3. **Say what it did.** Every container start and every chosen port is
 *    logged, because "why is my data gone" is answered by knowing which
 *    Postgres you were talking to.
 *
 * Containers are named and reused, not thrown away: a restart should be fast,
 * and yesterday's flags should still be there.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import postgres from "postgres";
import { Redis } from "ioredis";

const run = promisify(execFile);

export interface DevServiceOptions {
  /** Container name prefix, so two checkouts can run side by side. */
  label?: string;
  log?: (message: string) => void;
}

export interface DevServiceRequest extends DevServiceOptions {
  url: string;
  /** The caller asked for this address by name; never silently replace it. */
  explicit: boolean;
}

export interface DevServiceResolution {
  url: string;
  /** True when this call started a container. */
  started: boolean;
}

const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";
const CREDENTIALS = { user: "featurekit", password: "featurekit", database: "featurekit" };

class DevServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevServiceError";
  }
}

/* ─────────────────────────────── probes ─────────────────────────────── */

/**
 * Can we actually use this Postgres?
 *
 * A TCP connect is not the question — a laptop with a system Postgres on 5432
 * answers the socket and then rejects the role. The probe is a query, so
 * "something is listening" and "featurekit can use it" cannot be confused.
 */
async function postgresReachable(url: string): Promise<boolean> {
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(url, {
      max: 1,
      connect_timeout: 3,
      idle_timeout: 1,
      prepare: false,
      onnotice: () => {},
    });
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql?.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function redisReachable(url: string): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  // A probe that cannot connect is the expected case here, and an unhandled
  // `error` event would print an ECONNREFUSED stack over the startup log.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

/* ────────────────────────────── docker ──────────────────────────────── */

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { encoding: "utf8" });
  return stdout.trim();
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
}

/** The host port a running container publishes for `containerPort`, if any. */
async function publishedPort(name: string, containerPort: number): Promise<number | null> {
  try {
    const mapping = await docker(["port", name, `${containerPort}/tcp`]);
    // "0.0.0.0:55432\n[::]:55432" — every line is the same port.
    const match = /:(\d+)\s*$/m.exec(mapping);
    return match?.[1] === undefined ? null : Number(match[1]);
  } catch {
    return null;
  }
}

async function containerState(name: string): Promise<"running" | "stopped" | "absent"> {
  try {
    const state = await docker(["inspect", "-f", "{{.State.Running}}", name]);
    return state === "true" ? "running" : "stopped";
  } catch {
    return "absent";
  }
}

/** A port nothing else on this machine is holding, starting at `preferred`. */
async function freePort(preferred: number): Promise<number> {
  for (let port = preferred; port < Math.min(65535, preferred + 2000); port++) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.once("listening", () => {
      const addr = probe.address();
      const assignedPort = typeof addr === "object" && addr ? addr.port : null;
      probe.close(() => {
        if (assignedPort) resolve(assignedPort);
        else reject(new DevServiceError(`no free port near ${preferred}`));
      });
    });
    probe.listen(0, "127.0.0.1");
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  { timeoutMs, name }: { timeoutMs: number; name: string },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new DevServiceError(
        `${name} did not become ready within ${Math.round(timeoutMs / 1000)}s — ` +
          `try \`docker logs ${name}\``,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/**
 * Start (or adopt) one container and return the host port it serves on.
 *
 * An existing container is reused whatever port it was created with, because
 * its volume is where the previous session's data is. A stopped one is started
 * rather than recreated for the same reason.
 */
async function ensureContainer(options: {
  name: string;
  image: string;
  containerPort: number;
  preferredPort: number;
  env: Record<string, string>;
  log: (message: string) => void;
}): Promise<{ port: number; started: boolean }> {
  const state = await containerState(options.name);

  if (state === "running") {
    const port = await publishedPort(options.name, options.containerPort);
    if (port !== null) return { port, started: false };
    // Running but publishing nothing useful: it was created by hand with a
    // different port mapping. Say so rather than guessing.
    throw new DevServiceError(
      `container ${options.name} is running but does not publish port ${options.containerPort}`,
    );
  }

  if (state === "stopped") {
    await docker(["start", options.name]);
    const port = await publishedPort(options.name, options.containerPort);
    if (port === null) {
      throw new DevServiceError(`container ${options.name} published no host port after start`);
    }
    options.log(`started existing container ${options.name} on port ${port}`);
    return { port, started: true };
  }

  const port = await freePort(options.preferredPort);
  const args = [
    "run",
    "-d",
    "--name",
    options.name,
    "-p",
    `127.0.0.1:${port}:${options.containerPort}`,
    // A named volume, so `docker rm` does not silently destroy the data and a
    // recreate finds it again.
    "-v",
    `${options.name}-data:${options.image.startsWith("postgres") ? "/var/lib/postgresql/data" : "/data"}`,
    "--restart",
    "unless-stopped",
  ];
  for (const [key, value] of Object.entries(options.env)) args.push("-e", `${key}=${value}`);
  args.push(options.image);

  options.log(`starting ${options.image} as ${options.name} on port ${port}`);
  await docker(args);
  return { port, started: true };
}

/* ────────────────────────────── the API ─────────────────────────────── */

function unreachable(kind: string, url: string, explicit: boolean): DevServiceError {
  return new DevServiceError(
    explicit
      ? `featurekit: cannot reach the ${kind} you configured (${redact(url)}).\n` +
        `  It was given explicitly, so featurekit will not substitute a local container for it.`
      : `featurekit: no ${kind} at ${redact(url)} and Docker is not available to start one.\n` +
        `  Start one yourself (\`docker compose up -d\`) or pass ${kind === "Postgres" ? "databaseUrl" : "redisUrl"}.`,
  );
}

/** Passwords do not belong in a startup log. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function ensureDevPostgres(request: DevServiceRequest): Promise<DevServiceResolution> {
  const log = request.log ?? (() => {});
  if (await postgresReachable(request.url)) return { url: request.url, started: false };
  if (request.explicit || !(await dockerAvailable())) {
    throw unreachable("Postgres", request.url, request.explicit);
  }

  const name = `${request.label ?? "featurekit-dev"}-postgres`;
  const { port } = await ensureContainer({
    name,
    image: POSTGRES_IMAGE,
    containerPort: 5432,
    preferredPort: portOf(request.url, 5432),
    env: {
      POSTGRES_USER: CREDENTIALS.user,
      POSTGRES_PASSWORD: CREDENTIALS.password,
      POSTGRES_DB: CREDENTIALS.database,
    },
    log,
  });

  const url =
    `postgres://${CREDENTIALS.user}:${CREDENTIALS.password}` +
    `@127.0.0.1:${port}/${CREDENTIALS.database}`;
  await waitFor(() => postgresReachable(url), { timeoutMs: 60_000, name });
  log(`postgres ready on 127.0.0.1:${port} (container ${name})`);
  return { url, started: true };
}

export async function ensureDevRedis(request: DevServiceRequest): Promise<DevServiceResolution> {
  const log = request.log ?? (() => {});
  if (await redisReachable(request.url)) return { url: request.url, started: false };
  if (request.explicit || !(await dockerAvailable())) {
    throw unreachable("Redis", request.url, request.explicit);
  }

  const name = `${request.label ?? "featurekit-dev"}-redis`;
  const { port } = await ensureContainer({
    name,
    image: REDIS_IMAGE,
    containerPort: 6379,
    preferredPort: portOf(request.url, 6379),
    env: {},
    log,
  });

  const url = `redis://127.0.0.1:${port}`;
  await waitFor(() => redisReachable(url), { timeoutMs: 30_000, name });
  log(`redis ready on 127.0.0.1:${port} (container ${name})`);
  return { url, started: true };
}

function portOf(url: string, fallback: number): number {
  try {
    const port = new URL(url).port;
    return port === "" ? fallback : Number(port);
  } catch {
    return fallback;
  }
}
