import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./dashboard/src"),
      cn: path.resolve(__dirname, "./dashboard/src/lib/utils.ts"),
      "togglekit-client": path.resolve(__dirname, "./packages/client/src/index.ts"),
      "togglekit-client": path.resolve(__dirname, "./packages/client/src/index.ts"),
      "togglekit-client": path.resolve(__dirname, "./packages/client/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Benchmarks are a standalone Node harness (tools/bench.mjs), not a vitest
    // suite: they measure the built output in dist/sdk and report
    // ns/op directly. See docs/evaluation/benchmarks.md.
    testTimeout: 30_000,
  },
});
