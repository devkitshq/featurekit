/**
 * featurekit-mcp: feature flags from Claude and any other MCP client.
 *
 * A thin layer over the admin API. It holds an access token and nothing else,
 * so it can do exactly what that token can and no more.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FeaturekitApi, type ApiOptions } from "./api.js";
import { registerTools, type ToolOptions } from "./tools.js";

export { ApiError, FeaturekitApi, WEIGHT_SCALE } from "./api.js";
export type * from "./api.js";
export { buildRollout, describeConfig, matchScore, percentToWeight, resolveVariation } from "./describe.js";
export type { ToolOptions } from "./tools.js";

export const VERSION = "0.1.0";

export interface ServerOptions extends ApiOptions, Partial<ToolOptions> {}

export function createServer(options: ServerOptions): McpServer {
  const write = options.write === true;
  const server = new McpServer(
    { name: "featurekit", version: VERSION },
    {
      instructions:
        "Manage featurekit feature flags. Find a flag with find_flags (people name flags loosely: " +
        '"cart v2 page" is usually cart-v2-page). Changes are per environment; ask which one when it is ' +
        "not clear, and say so when it is production. A percentage rollout is set_rollout; one value for " +
        "everyone is serve_variation; an emergency off is turn_flag_off. After a change, tell the user what " +
        "the flag now serves." +
        (write
          ? ""
          : " This server is READ-ONLY: it cannot change flags. To allow changes, set FEATUREKIT_MCP_WRITE=1."),
    },
  );
  registerTools(server, new FeaturekitApi(options), {
    write,
    ...(options.defaultProject !== undefined ? { defaultProject: options.defaultProject } : {}),
    ...(options.defaultEnvironment !== undefined ? { defaultEnvironment: options.defaultEnvironment } : {}),
  });
  return server;
}
