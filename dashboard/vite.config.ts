/**
 * The dashboard build.
 *
 * `base: "/admin/"` is the one setting that matters: the bundle is served from
 * a sub-path by the control plane, so every asset URL it emits has to carry
 * that prefix. Getting it wrong produces a blank page and a 404 for a script
 * nobody thinks to look for.
 *
 * In development, `vite dev` proxies the API to a control plane on 3000, which
 * keeps the session cookie same-origin — a cookie set by :3000 is not sent to
 * :5173, so without the proxy every dev request would be unauthenticated.
 */

import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const CONTROL_PLANE =
  process.env["FEATKIT_URL"] ?? process.env["FEATUREKIT_URL"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  root: import.meta.dirname,
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      cn: path.resolve(import.meta.dirname, "./src/lib/utils"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The server sets `immutable` on everything under `assets/`, which is only
    // safe because these names are content-hashed.
    assetsDir: "assets",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: CONTROL_PLANE, changeOrigin: false },
      "/health": { target: CONTROL_PLANE, changeOrigin: false },
    },
  },
});
