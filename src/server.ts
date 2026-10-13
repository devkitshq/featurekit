
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * `FeaturekitServer` — the control plane as an object you construct (§11.1).
 *
 * ```ts
 * import { FeaturekitServer } from "featurekit-server";
 *
 * const server = new FeaturekitServer({ services: ["all"], port: 3000 });
 * await server.start();   // dev: Postgres + Redis start automatically
 * ```
 *
 * `main.ts` is this class plus signal handling; a test is this class plus
 * `port: 0`. There is deliberately no second way to assemble the system.
 *
 * Three things happen inside `start()` that a bare `createApp` does not do, and
 * all three are development conveniences that **turn themselves off** in
 * production, because each of them is wrong there for a specific reason:
 *
 * - **Dependencies are started if missing.** In production, a control plane
 *   that reacts to an unreachable database by starting its own is a control
 *   plane that serves an empty flag set during a failover.
 * - **Migrations run on start.** In production this is a deploy step: every
 *   booting node running it is a lock convoy during a rolling deploy (§16).
 * - **Ports and URLs are chosen for you.** In production, an address nobody
 *   configured is an address nobody can find.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createApp, type App, type FeaturekitService } from "./app.js";
import { ConfigError, loadConfig, type FeaturekitConfig } from "./config/index.js";
import { type Database } from "./db/client.js";
import { createMember, findMemberByEmail, updateMember } from "./repositories/members.js";
import { PasswordError } from "./auth/passwords.js";
import { startAppHost, toPath, type AppHost } from "./http/app-host.js";
import { migrate } from "./migrate.js";
import { applyFlagFile, environmentOf, type FlagFile } from "./provisioning.js";
import { createSdkKey, listSdkKeys } from "./repositories/catalog.js";

export type { FeaturekitService } from "./app.js";

export interface FeaturekitServerOptions {
  /** Which parts of the system this process runs. Defaults to `["all"]`. */
  services?: readonly FeaturekitService[];
  port?: number;
  host?: string;
  databaseUrl?: string;
  redisUrl?: string;
  nodeEnv?: "development" | "test" | "production";
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

  /** Required in production; generated for you in development. */
  adminToken?: string;
  /** Signs client-tier contexts. Comma-separate to rotate (§16). */
  secureModeSecret?: string;
  /** Origins allowed to call the client tier. Never `*`. */
  corsAllowedOrigins?: readonly string[];

  /**
   * Run migrations during `start()`.
   *
   * Defaults to true outside production and false inside it. Setting it true in
   * production is supported and is a decision, not a default.
   */
  autoMigrate?: boolean;
  /**
   * Start Postgres and Redis in Docker when they are not reachable.
   *
   * Development only, and only for addresses you did not specify: an explicit
   * `databaseUrl` that does not answer is an error, never a redirect to a fresh
   * empty container.
   */
  devServices?: boolean;
  /** Container name prefix, so two checkouts can run side by side. */
  label?: string;
  /**
   * Where a development server records the addresses it resolved.
   *
   * Because dev services pick their own ports, a second process — a seeding
   * script, `npm run migrate`, an example — otherwise has no way to learn which
   * Postgres this server is using. Written on start, never in production, and
   * `false` turns it off.
   */
  devStateFile?: string | false;

  /**
   * Flag definitions to apply on start (§11.3).
   *
   * `{ project, environment, flags }` — usually imported from a file in your
   * repository. New flags are created and configured; **existing ones are left
   * alone**, because on/off and targeting belong to whoever is on call, not to
   * the last person who edited the file. `flagsReset` overrides that.
   *
   * Development only: applying definitions in production is a deploy step, not
   * something a booting node does.
   */
  flags?: FlagFile;
  /**
   * Re-apply configuration over flags that already exist.
   *
   * Defaults to `FEATUREKIT_FLAGS_RESET=1`. This is the switch that overwrites
   * what somebody changed in the dashboard, so it is never the default.
   */
  flagsReset?: boolean;

  /**
   * Serve a browser app from a directory, in development (§2).
   *
   * Adds `/api/config` (the environment's client key and this server's URL) and
   * `/sdk.js` (the built `featurekit-client` bundle) so a prototype needs no
   * bundler and no second process. `environmentKey` defaults to the one `flags`
   * names. Refused outside development — in production your app is served by
   * your app's infrastructure.
   */
  app?: {
    dir: string | URL;
    port?: number;
    environmentKey?: string;
    /**
     * Interface to bind the app host to. Defaults to this server's `host`,
     * which is loopback — so a phone on the same Wi-Fi cannot reach it until
     * you say `0.0.0.0` and mean it. See `examples/mobile`.
     */
    host?: string;
  };

  /**
   * Whether this deployment already has a client or mobile SDK key.
   *
   * Secure mode becomes mandatory in production once one exists (§16), and that
   * is a database question the configuration loader cannot answer before the
   * database is open. The route layer enforces the real rule from the
   * environment row; this is the startup-time backstop for a deployment that
   * has already declared it.
   */
  clientKeysExist?: boolean;

  /**
   * Anything else from the configuration schema, by its environment-variable
   * name — `RATE_LIMIT_ADMIN_PER_MIN`, `SNAPSHOT_DEBOUNCE_MS`, and so on. The
   * schema is the documentation; this is the escape hatch that means the
   * constructor does not have to mirror all sixty of them.
   */
  env?: Record<string, string | undefined>;
}



export interface FeaturekitAddress {
  host: string;
  port: number;
  url: string;
}



export class FeaturekitServer {
  #app: App | null = null;
  #address: FeaturekitAddress | null = null;
  #config: FeaturekitConfig | null = null;
  #starting: Promise<FeaturekitAddress> | null = null;
  #appHost: AppHost | null = null;
  #pgContainer: any = null;
  #redisContainer: any = null;

  constructor(private readonly options: FeaturekitServerOptions = {}) {}

  /** The bound address. Throws before `start()` resolves — there isn't one yet. */
  get address(): FeaturekitAddress {
    if (this.#address === null) throw new Error("featurekit: server has not started");
    return this.#address;
  }

  get url(): string {
    return this.address.url;
  }

  /** The assembled system: router, database handle, snapshot service, metrics. */
  get app(): App {
    if (this.#app === null) throw new Error("featurekit: server has not started");
    return this.#app;
  }

  /** Where the development app host is serving, if one was asked for. */
  get appUrl(): string | null {
    return this.#appHost?.url ?? null;
  }

  /** The resolved configuration, after defaults and any dev substitutions. */
  get config(): FeaturekitConfig {
    if (this.#config === null) throw new Error("featurekit: server has not started");
    return this.#config;
  }

  /**
   * Start listening.
   *
   * Idempotent: calling it twice returns the same address rather than binding a
   * second socket, because "start it if it isn't started" is a thing test
   * helpers do and a race is a poor reward for it.
   */
  async start(): Promise<FeaturekitAddress> {
    if (this.#address !== null) return this.#address;
    this.#starting ??= this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  async #start(): Promise<FeaturekitAddress> {
    const nodeEnv =
      this.options.nodeEnv ??
      (process.env["NODE_ENV"] as FeaturekitServerOptions["nodeEnv"]) ??
      "development";
    const isProduction = nodeEnv === "production";
    const log = this.#logger();

    /* dependencies */

    const databaseExplicit =
      this.options.databaseUrl !== undefined || process.env["DATABASE_URL"] !== undefined;
    const redisExplicit =
      this.options.redisUrl !== undefined || process.env["REDIS_URL"] !== undefined;

    let databaseUrl = this.options.databaseUrl ?? process.env["DATABASE_URL"];
    let redisUrl = this.options.redisUrl ?? process.env["REDIS_URL"];

    const wantsDevServices = this.options.devServices ?? !isProduction;

    if (!redisUrl && wantsDevServices && !isProduction) {
      log("No redisUrl provided, spinning up Redis container for development/testing...");
      const { RedisContainer } = await import("@testcontainers/redis");
      this.#redisContainer = await new RedisContainer("redis:alpine").start();
      redisUrl = this.#redisContainer.getConnectionUrl();
    }

    if (!databaseUrl && wantsDevServices && !isProduction) {
      log("No databaseUrl provided, spinning up PostgreSQL container for development/testing...");
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      this.#pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
      databaseUrl = this.#pgContainer.getConnectionUri();
    }

    /* configuration */

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.options.env,
      NODE_ENV: nodeEnv,

      // Written only when somebody actually supplied them, or when we are in
      // development and the value above is real (a dev container's address, or
      // the loopback default).
      //
      // Unconditionally writing the resolved value made
      // `REQUIRED_IN_PRODUCTION` unreachable for these two: `loadConfig` tests
      // `env[key] === undefined`, and by this line the key is always defined —
      // holding the laptop default we just invented. A production deployment
      // that forgot `DATABASE_URL` therefore passed configuration validation
      // and went on to dial 127.0.0.1:5432 forever, printing nothing, because
      // the stall happens before the logger emits anything. The check exists
      // precisely so "the development defaults must never silently apply", and
      // it was silently not applying.
      ...(isProduction && !databaseExplicit ? {} : { DATABASE_URL: databaseUrl }),
      ...(isProduction && !redisExplicit ? {} : { REDIS_URL: redisUrl }),
      ...(this.options.port !== undefined ? { PORT: String(this.options.port) } : {}),
      ...(this.options.host !== undefined ? { HOST: this.options.host } : {}),
      ...(this.options.logLevel !== undefined ? { LOG_LEVEL: this.options.logLevel } : {}),
      ...(this.options.adminToken !== undefined ? { ADMIN_TOKEN: this.options.adminToken } : {}),
      ...(this.options.secureModeSecret !== undefined
        ? { SECURE_MODE_SECRET: this.options.secureModeSecret }
        : {}),
      ...(this.options.corsAllowedOrigins !== undefined
        ? { CORS_ALLOWED_ORIGINS: this.options.corsAllowedOrigins.join(",") }
        : {}),
    };

    // A ConfigError lists every missing variable at once and is meant to be
    // read by a human at a terminal; it travels up untouched.
    const config = loadConfig(env, {
      clientKeysExist:
        this.options.clientKeysExist ??
        process.env["FEATUREKIT_CLIENT_KEYS_EXIST"] === "1",
    });
    this.#config = config;

    /* migrations */

    if (this.options.autoMigrate ?? !isProduction) {
      await this.#migrate(config.DATABASE_URL, log);
    }

    /* the system itself */

    const app = createApp(config, {
      ...(this.options.services !== undefined ? { services: this.options.services } : {}),
    });
    this.#app = app;

    // Before the socket opens, so a deployment cannot be reachable in the
    // window where it has a dashboard and no way to log into it.
    await this.#seedFirstAccount(app.db, config, log);

    const bound = await app.listen();
    const host = bound.host === "0.0.0.0" || bound.host === "::" ? "127.0.0.1" : bound.host;
    this.#address = { ...bound, url: `http://${host}:${bound.port}` };

    if (!isProduction && this.options.devStateFile !== false) {
      await this.#writeDevState({ databaseUrl: databaseUrl ?? config.DATABASE_URL, redisUrl: redisUrl ?? config.REDIS_URL }).catch(() => {
        // A demo that cannot write a scratch file should still serve flags.
        log("could not write the dev state file; scripts will need explicit URLs");
      });
    }

    // Both of these are development conveniences, and both refuse to run
    // outside it. They come after the socket so that the sync can be observed
    // in the log of a server that is already answering health checks.
    await this.#applyFlags(app.db, isProduction, log);
    await this.#startAppHost(app.db, isProduction, log);
    this.#summarise(config, isProduction, log);

    return this.#address;
  }

  /**
   * The first account, from configuration.
   *
   * A deployment with a dashboard and no accounts is a login form nobody can
   * pass. This is how Docker, the demo and a fresh clone get one without a
   * shell — and it is idempotent: an existing member is left alone, including
   * their password, because a restart must not silently reset a password
   * somebody has since changed.
   */
  async #seedFirstAccount(
    db: Database,
    config: FeaturekitConfig,
    log: (message: string) => void,
  ): Promise<void> {
    const email = config.FEATUREKIT_ADMIN_EMAIL;
    const password = config.FEATUREKIT_ADMIN_PASSWORD;
    if (email === undefined || password === undefined) return;

    try {
      const existing = await findMemberByEmail(db, email);
      if (existing !== null) {
        // One exception to "leave it alone": an account that exists without a
        // password cannot be logged into, and silently doing nothing there is
        // the same dead end this feature exists to prevent.
        if (!existing.hasPassword) {
          await updateMember(db, existing.id, { password });
          log(`set the password for ${email}`);
        }
        return;
      }
      await createMember(db, { email, role: "owner", password, name: "Owner" });
      log(`created the first account: ${email} (owner)`);
    } catch (error) {
      if (error instanceof PasswordError) {
        // Loud, and not fatal: a control plane that refuses to serve flags
        // because a seed password was too short is a worse outage than a
        // dashboard nobody can log into yet.
        log(`FEATUREKIT_ADMIN_PASSWORD rejected: ${error.message}`);
        return;
      }
      throw error;
    }
  }

  /**
   * Apply the flag file, if one was given.
   *
   * Refused in production: a node that rewrites flag configuration while it
   * boots is a node that can undo an incident response by being restarted.
   */
  async #applyFlags(
    db: Database,
    isProduction: boolean,
    log: (message: string) => void,
  ): Promise<void> {
    const file = this.options.flags;
    if (file === undefined) return;
    if (isProduction) {
      throw new ConfigError(
        "featurekit: `flags` applies definitions on start, which is a development " +
          "convenience. In production this is a deploy step — run the sync from CI " +
          "against a scoped token instead.",
      );
    }

    const reset =
      this.options.flagsReset ??
      process.env["FEATUREKIT_FLAGS_RESET"] === "1";
    const changes = await applyFlagFile(db, file, { reset });
    // Only what changed, so a restart that reconciles to nothing says nothing.
    const notable = changes.filter((change) => change.action !== "unchanged");
    for (const change of notable) log(`${change.action} ${change.entity}`);
    log(
      `flags reconciled: ${notable.length} change${notable.length === 1 ? "" : "s"}` +
        (reset ? " (reset)" : ""),
    );
    if (notable.length > 0 && this.#app !== null) {
      const env = await environmentOf(db, file);
      if (env !== null) {
        await this.#app.snapshots.notifyChangeImmediate(env.id);
      }
    }
  }

  /**
   * Serve a browser app, if one was asked for.
   *
   * The client key is minted here rather than configured, because a demo that
   * makes you paste a key before it renders is a demo nobody finishes. It is a
   * *client* key: public by construction, and worth only evaluated values for a
   * context, never the ruleset.
   */
  async #startAppHost(
    db: Database,
    isProduction: boolean,
    log: (message: string) => void,
  ): Promise<void> {
    const app = this.options.app;
    if (app === undefined) return;
    if (isProduction) {
      throw new ConfigError(
        "featurekit: `app` serves a directory for development. In production your " +
          "application is served by your application's infrastructure.",
      );
    }

    const environmentKey = app.environmentKey ?? this.options.flags?.environment.key;
    if (environmentKey === undefined) {
      throw new ConfigError(
        "featurekit: `app` needs `environmentKey`, or a `flags` file that names one — " +
          "the page has to be given a key for some environment.",
      );
    }

    const environment =
      this.options.flags === undefined
        ? null
        : await environmentOf(db, {
            ...this.options.flags,
            environment: { ...this.options.flags.environment, key: environmentKey },
          });
    if (environment === null) {
      throw new ConfigError(`featurekit: no environment ${environmentKey} to serve an app for`);
    }

    const keys = await listSdkKeys(db, environment.id);
    const existing = keys.find((key) => key.kind === "client" && key.revokedAt === null);
    const clientKey =
      existing?.publicKey ??
      (await createSdkKey(db, { environmentId: environment.id, kind: "client", name: "dev app" }))
        .key;

    // The app host follows the server's own binding unless told otherwise: if
    // the control plane is reachable from the network, the endpoint handing out
    // its client key has to be too, or a device gets half a demo.
    const appHostBinding = app.host ?? this.options.host;

    this.#appHost = await startAppHost({
      dir: toPath(app.dir),
      ...(app.port === undefined ? {} : { port: app.port }),
      ...(appHostBinding === undefined ? {} : { host: appHostBinding }),
      clientKey,
      baseUrl: this.#address?.url ?? "",
      onError: () => {
        // A 404 for a file somebody is still writing is not an event.
      },
    });
    log(`app served from ${toPath(app.dir)} on ${this.#appHost.url}`);
  }

  /**
   * Where to point a browser, in development.
   *
   * The pino line above this is for a log aggregator; this is for the person
   * who just typed a command and is looking at a terminal. It never prints the
   * seeded password — a process that logs a credential has put it in every
   * scrollback, CI artefact and screenshot from then on.
   */
  #summarise(
    config: FeaturekitConfig,
    isProduction: boolean,
    log: (message: string) => void,
  ): void {
    if (isProduction) return;
    const url = this.#address?.url ?? "";
    if (config.DASHBOARD !== "off") {
      const account = config.FEATUREKIT_ADMIN_EMAIL;
      log(
        `dashboard ${url}${config.DASHBOARD_PATH}` +
          (account === undefined ? "" : ` — sign in as ${account}`),
      );
    }
    if (this.#appHost !== null) log(`app       ${this.#appHost.url}`);
  }

  /**
   * Record what a development server resolved, for the process after this one.
   *
   * Only the addresses — no token, no key. A file under the working directory
   * that contained a credential would be a file somebody commits.
   */
  async #writeDevState(addresses: { databaseUrl: string; redisUrl: string }): Promise<void> {
    const path =
      typeof this.options.devStateFile === "string"
        ? this.options.devStateFile
        : join(process.cwd(), ".featurekit", "dev.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          url: this.#address?.url,
          databaseUrl: addresses.databaseUrl,
          redisUrl: addresses.redisUrl,
          services: this.options.services ?? ["all"],
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}
`,
      "utf8",
    );
  }

  /**
   * Apply migrations behind an advisory lock.
   *
   * The lock is what makes two processes starting at once safe: the second
   * waits, then finds nothing to do. Its own connection, closed straight after,
   * because an advisory lock lives for the session and the pool's connections
   * outlive this step.
   */
  async #migrate(databaseUrl: string, log: (message: string) => void): Promise<void> {
    // The same function a deploy job calls, so `autoMigrate` and a separate
    // step cannot drift apart — and so both take the same advisory lock.
    await migrate({ databaseUrl, log });
  }

  /**
   * Stop serving and release everything.
   *
   * Streams drain, workers flush, then the database and Redis handles close —
   * the reverse of startup. Containers started for development are left
   * running: the next `start()` is faster for it, and the data is still there.
   */
  async stop(): Promise<void> {
    await this.#appHost?.close();
    this.#appHost = null;
    const app = this.#app;
    this.#app = null;
    this.#address = null;
    this.#config = null;
    await app?.close();

    if (this.#pgContainer) {
      this.#logger()("Stopping PostgreSQL container...");
      await this.#pgContainer.stop();
      this.#pgContainer = null;
    }
    if (this.#redisContainer) {
      this.#logger()("Stopping Redis container...");
      await this.#redisContainer.stop();
      this.#redisContainer = null;
    }
  }

  #logger(): (message: string) => void {
    if (this.options.logLevel === "silent") return () => {};
    return (message: string) => process.stdout.write(`featurekit: ${message}\n`);
  }
}

export { redact as redactUrl };
