import { FeaturekitServer } from "featurekit-server";
import { sql } from "drizzle-orm";
import flags, { project, environment } from "./flags.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const appPort = Number(process.env.APP_PORT ?? 4000);

const server = new FeaturekitServer({
  services: ["all"],
  port,
  host,

  // Flag definitions are provisioned automatically on start
  flags,

  // Built-in static host for the website demo
  app: { dir: new URL("../website", import.meta.url), port: appPort },

  // Allow browser & Expo web clients to connect
  corsAllowedOrigins: [
    `http://127.0.0.1:${appPort}`,
    `http://localhost:${appPort}`,
    "http://127.0.0.1:8081",
    "http://localhost:8081",
    "http://127.0.0.1:19006",
    "http://localhost:19006",
  ],

  env: {
    FEATUREKIT_ADMIN_EMAIL: "admin@featurekit.dev",
    FEATUREKIT_ADMIN_PASSWORD: "password12345",
  },
});

try {
  await server.start();

  // Helper to swap flag variations on demand
  let swapIndex = 0;
  async function swapFlags() {
    swapIndex++;
    const db = server.app.db;

    // Fetch environment and flags
    const envRows = await db.execute(
      sql`SELECT id FROM environments WHERE key = ${environment.key} LIMIT 1`
    );
    const envId = envRows[0]?.id;
    if (!envId) throw new Error("Environment not found");

    const flagKeys = ["feature-toggle", "headline-text", "discount-number", "theme-config"];
    const results = {};

    for (const flagKey of flagKeys) {
      // Get flag, its variations, and current environment binding
      const flagRows = await db.execute(
        sql`SELECT id FROM flags WHERE key = ${flagKey} LIMIT 1`
      );
      const flagId = flagRows[0]?.id;
      if (!flagId) continue;

      const varRows = await db.execute(
        sql`SELECT id, name, value FROM flag_variations WHERE flag_id = ${flagId} ORDER BY id ASC`
      );
      if (varRows.length === 0) continue;

      // Pick next variation in a round-robin cycle
      const nextVar = varRows[swapIndex % varRows.length];

      // Update flag environment with the new fallthrough variation and increment version
      await db.execute(
        sql`UPDATE flag_environments 
            SET fallthrough_variation_id = ${nextVar.id}, 
                enabled = true,
                version = version + 1,
                updated_at = NOW()
            WHERE flag_id = ${flagId} AND environment_id = ${envId}`
      );

      // Notify the snapshot service to immediately recompile and broadcast SSE patch!
      server.app.snapshots.notifyChange(envId, flagKey);
      results[flagKey] = { name: nextVar.name, value: nextVar.value };
    }

    return results;
  }

  // Register public swap endpoint on the server for easy testing
  const swapHandler = async (ctx) => {
    try {
      const swapped = await swapFlags();
      return {
        ok: true,
        message: "Flags swapped successfully! SSE updates broadcasted.",
        cycle: swapIndex,
        flags: swapped,
      };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    }
  };

  server.app.router.get("/api/swap", swapHandler);
  server.app.router.post("/api/swap", swapHandler);

  console.log("\n=======================================================");
  console.log("  🚀 Featurekit Demo Server is Running!");
  console.log("=======================================================");
  console.log(`  🌐 Control Plane & API:  ${server.url}`);
  console.log(`  📊 Admin Dashboard:      ${server.url}/admin (admin@featurekit.dev / password12345)`);
  console.log(`  💻 Website Demo:         http://127.0.0.1:${appPort}`);
  console.log(`  📱 Expo Mobile App:      examples/basic-example/expo-app`);
  console.log(`  ⚡ Swap Trigger API:     ${server.url}/api/swap`);
  console.log("=======================================================\n");

} catch (error) {
  process.stderr.write(`\nfeaturekit: ${String(error.message ?? error)}\n\n`);
  process.exit(1);
}
