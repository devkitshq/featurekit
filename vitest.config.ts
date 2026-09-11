import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Benchmarks are a standalone Node harness (tools/bench.mjs), not a vitest
    // suite: they measure the built output in dist/sdk and report
    // ns/op directly. See docs/evaluation/benchmarks.md.
    testTimeout: 30_000,
  },
});
