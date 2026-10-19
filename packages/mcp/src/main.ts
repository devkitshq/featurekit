#!/usr/bin/env node
/**
 * `npx featurekit-mcp`, over stdio.
 *
 * Configuration is environment variables, which is how MCP clients pass it:
 *
 * - `FEATUREKIT_URL`         the control plane, e.g. https://flags.example.com (required)
 * - `FEATUREKIT_TOKEN`       a personal access token (required)
 * - `FEATUREKIT_MCP_WRITE`   `1` to allow changing flags; read-only otherwise
 * - `FEATUREKIT_PROJECT`     default project key
 * - `FEATUREKIT_ENVIRONMENT` default environment key
 *
 * stdout is the protocol, so anything for a human goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./index.js";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

const baseUrl = env("FEATUREKIT_URL");
const token = env("FEATUREKIT_TOKEN");
if (baseUrl === undefined || token === undefined) {
  process.stderr.write("featurekit-mcp: set FEATUREKIT_URL and FEATUREKIT_TOKEN\n");
  process.exit(1);
}

const project = env("FEATUREKIT_PROJECT");
const environment = env("FEATUREKIT_ENVIRONMENT");
const server = createServer({
  baseUrl,
  token,
  write: /^(1|true|yes)$/i.test(env("FEATUREKIT_MCP_WRITE") ?? ""),
  ...(project !== undefined ? { defaultProject: project } : {}),
  ...(environment !== undefined ? { defaultEnvironment: environment } : {}),
});

await server.connect(new StdioServerTransport());
