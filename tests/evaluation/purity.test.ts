import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `src/sdk/evaluation/` is the only directory the control plane and the server
 * SDK both compile. It imports nothing — not zod, not the logger — so the same
 * source compiles into an edge runtime and, eventually, a port to another
 * language.
 *
 * It now sits inside the `featurekit` package rather than in one of its own,
 * which makes this test load-bearing in a way it was not before: a package
 * boundary used to make `../../db/schema.js` inexpressible, and a directory
 * boundary does not.
 *
 * Enforced by a test, not good intentions.
 */
const DIR = join(process.cwd(), "src/sdk/evaluation");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

const IMPORT_RE = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm;
const BARE_IMPORT_RE = /^\s*import\s+["']([^"']+)["']/gm;

describe("the evaluation core is dependency-free", () => {
  it("finds the source files it is supposed to be guarding", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files)("%s imports only its own siblings", (file) => {
    const source = readFileSync(join(DIR, file), "utf8");
    const specifiers = [
      ...[...source.matchAll(IMPORT_RE)].map((m) => m[1]!),
      ...[...source.matchAll(BARE_IMPORT_RE)].map((m) => m[1]!),
    ];
    for (const spec of specifiers) {
      // Relative and inside this directory. No packages, no `node:` builtins,
      // no reaching up into the control plane.
      expect(spec, `${file} imports ${spec}`).toMatch(/^\.\/[A-Za-z0-9._-]+\.js$/);
    }
  });

  it.each(files)("%s uses no Node-only globals", (file) => {
    const source = readFileSync(join(DIR, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const global of ["process.", "require(", "__dirname", "Buffer.", "globalThis.process"]) {
      expect(code, `${file} references ${global}`).not.toContain(global);
    }
  });
});
