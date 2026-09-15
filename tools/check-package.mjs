/**
 * What the published packages actually contain (§20).
 *
 * `npm pack` is the only honest answer to "what does a customer get". A `files`
 * field is a promise; this checks it. The failures it catches are the ones that
 * are invisible until they are embarrassing:
 *
 * - **Source maps.** A `.map` file next to shipped JS republishes the original
 *   source, comments included, to every customer's bundle analyser.
 * - **Test material and secret-shaped files**, shipped by a `files` field that
 *   was widened once and never narrowed again.
 * - **Runtime dependencies on the client.** `featkit-client` claims zero. A
 *   stray import puts something in every browser bundle and every mobile binary
 *   that ships it.
 * - **Control-plane code reachable from the evaluator.** `src/sdk/` is the
 *   server-tier SDK. It lives inside `featkit` alongside the control plane,
 *   so the boundary that used to be free — two separate packages — now has to
 *   be asserted. An evaluator that imports `src/db/` needs Postgres to answer
 *   a question it should answer from memory.
 *
 * Exits non-zero with a list. Run in CI; runnable by hand.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGES = [".", "packages/client"];

/** Zero runtime dependencies, asserted rather than intended. */
const ZERO_DEPENDENCY = new Set(["featkit-client", "featurekit-client"]);

const problems = [];

function packageContents(directory) {
  let raw;
  try {
    raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: directory,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // `npm pack` failing is itself a finding — a manifest npm refuses is a
    // manifest nobody can publish — and deserves the reason, not a stack.
    const reason = String(error.stdout ?? error.stderr ?? error.message).trim();
    const indented = reason.split("\n").join("\n      ");
    problems.push(`${directory}: npm pack failed\n      ${indented}`);
    return [];
  }
  const [result] = JSON.parse(raw);
  return result?.files?.map((file) => file.path) ?? [];
}

for (const directory of PACKAGES) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const files = packageContents(directory);

  if (files.length === 0) {
    continue;
  }

  for (const file of files) {
    if (file.endsWith(".map")) {
      problems.push(`${manifest.name}: ships a source map (${file})`);
    }
    if (/(^|\/)(test|tests|__tests__|fixtures)\//.test(file)) {
      problems.push(`${manifest.name}: ships test material (${file})`);
    }
    if (/\.env|\.pem$|\.key$/.test(file)) {
      problems.push(`${manifest.name}: ships something secret-shaped (${file})`);
    }
  }

  if (ZERO_DEPENDENCY.has(manifest.name)) {
    const dependencies = Object.keys(manifest.dependencies ?? {});
    if (dependencies.length > 0) {
      problems.push(
        `${manifest.name} must have zero runtime dependencies, found: ${dependencies.join(", ")}`,
      );
    }
  }

  if (manifest.version === "0.0.0") {
    problems.push(`${manifest.name}: version is still 0.0.0 and cannot be published`);
  }
  if (manifest.repository === undefined) {
    problems.push(`${manifest.name}: no "repository" field, so npm shows no provenance link`);
  }
}

/**
 * The import boundary, checked statically.
 *
 * When the evaluator was its own package this held for free: a relative path
 * out of `packages/sdk/src` was not expressible. Inside one package it is one
 * `../db/schema.js` away, and nothing but this check would notice — the build
 * would be green and the regression would surface as a customer's evaluator
 * demanding a database connection.
 *
 * So: nothing under `src/sdk/` may import from `src/` outside itself, and
 * nothing may import a runtime dependency. Both are what make the evaluator
 * portable to Deno, Bun and an edge runtime.
 */
const RUNTIME_DEPENDENCIES = Object.keys(
  JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {},
).filter((name) => name !== "featkit" && name !== "featurekit");

function sourcesUnder(directory) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) out.push([path, readFileSync(path, "utf8")]);
    }
  };
  walk(directory);
  return out;
}

/** `from "…"` and `import("…")`, which is the whole surface that pulls code in. */
const SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

for (const [path, source] of sourcesUnder(join("src", "sdk"))) {
  for (const [, specifier] of source.matchAll(SPECIFIER)) {
    // A relative path that climbs above `src/sdk/` — `../db/schema.js` from
    // `src/sdk/client/` is two levels up and out.
    const climbs = specifier.match(/^(\.\.\/)+/)?.[0].length / 3 || 0;
    const depth = path.split(/[/\\]/).length - 2; // segments below `src/sdk/`
    if (specifier.startsWith(".") && climbs >= depth) {
      problems.push(`${path}: reaches outside src/sdk (${specifier})`);
      continue;
    }
    if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
    if (RUNTIME_DEPENDENCIES.includes(specifier.split("/")[0])) {
      problems.push(`${path}: the evaluator must not import ${specifier}`);
    }
  }
}

/**
 * `featkit/secure-mode` must not drag the control plane in.
 *
 * Its entire reason to exist as a separate entry point is that a customer's
 * backend can mint a signed context without loading Drizzle, a Postgres driver,
 * ioredis and pino at import time. That promise is one careless import away from
 * being false, and nothing would fail — the signature would still be correct,
 * just preceded by a second of module loading in a cold Lambda. So the
 * transitive closure of its relative imports is walked, and any runtime
 * dependency in it is a build failure.
 */
function closureOf(entry) {
  const seen = new Set();
  const externals = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        externals.push([file, specifier]);
        continue;
      }
      // `./x.js` in the source is `./x.ts` on disk.
      const resolved = join(dirname(file), specifier).replace(/\.js$/, ".ts");
      walk(resolved);
    }
  };
  walk(entry);
  return { files: seen, externals };
}

/**
 * Each subpath entry, and the runtime dependencies it is allowed to reach.
 *
 * An empty list means none at all. The point of a subpath is what it does *not*
 * load, and that promise is one careless import away from being false with
 * nothing failing — the code would still work, just after loading a route layer
 * and a metrics registry that the deploy job or the signing endpoint never
 * calls. So the transitive closure of relative imports is walked and anything
 * outside the allowance is a build failure.
 */
const ENTRY_BUDGETS = [
  // Signing is an HMAC over a string. It needs nothing.
  { entry: join("src", "secure-mode.ts"), name: "featkit/secure-mode", allow: [] },
  // Migrating is talking to Postgres, so it may. Not Redis, not the logger,
  // not the metrics registry.
  { entry: join("src", "migrate.ts"), name: "featkit/migrate", allow: ["drizzle-orm", "postgres"] },
];

for (const { entry, name, allow } of ENTRY_BUDGETS) {
  for (const [file, specifier] of closureOf(entry).externals) {
    const packageName = specifier.split("/")[0];
    if (!RUNTIME_DEPENDENCIES.includes(packageName)) continue;
    if (allow.includes(packageName)) continue;
    problems.push(`${name} pulls in ${specifier} (via ${file})`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `featkit: package check failed\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write("featkit: package contents OK\n");
