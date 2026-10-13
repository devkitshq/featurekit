/**
 * A static host for a browser app, in development.
 *
 * Trying the browser SDK otherwise means standing up a second process before
 * you can see anything: something to serve two files, something to hand the
 * page a client key, and a bundler to resolve the SDK import. None of that is
 * your application; all of it is in the way.
 *
 * So `FeaturekitServer` can serve a directory on its own port, with two
 * additions the page needs and cannot get from a plain file server:
 *
 * - `/api/config` — the **client** key for this environment, and the control
 *   plane's URL. In your real app this endpoint is yours, and it is also where
 *   you would mint the secure-mode signature for the user you just
 *   authenticated.
 * - `/sdk.js` — the built `featurekit-client` bundle, so `index.html` can
 *   `import` it with no build step.
 *
 * **Development only.** In production your app is served by your app's
 * infrastructure, which knows about your sessions, your CDN and your CSP.
 * `FeaturekitServer` refuses this option outside development rather than
 * quietly becoming a web server nobody meant to deploy.
 */

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppHostOptions {
  /**
   * Directory to serve.
   *
   * A `URL` or a `file:` string is resolved properly, which is what
   * `new URL("../app", import.meta.url)` produces — the obvious way to name a
   * directory next to the file doing the naming. Taking its `.pathname` instead
   * yields `/D:/Program%20Files/...` on Windows, which is not a path any
   * filesystem call will find.
   */
  dir: string | URL;
  port?: number;
  host?: string;
  /** Handed to the page by `/api/config`. Public by construction. */
  clientKey: string;
  /** Where the client tier is. Also handed to the page. */
  baseUrl: string;
  onError?: (error: unknown) => void;
}

export interface AppHost {
  url: string;
  port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * The built browser SDK, wherever it is installed.
 *
 * Resolved rather than guessed at a relative path, so this works both inside
 * this repository (a workspace symlink) and in a project that installed
 * `featurekit-client` from npm.
 */
function resolveBrowserSdk(): string | null {
  try {
    return createRequire(import.meta.url).resolve("featurekit-client");
  } catch {
    return null;
  }
}

export async function startAppHost(options: AppHostOptions): Promise<AppHost> {
  const root = resolve(toPath(options.dir));
  const host = options.host ?? "127.0.0.1";
  const sdkPath = resolveBrowserSdk();

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";

    if (path === "/api/config") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ clientKey: options.clientKey, baseUrl: options.baseUrl }));
      return;
    }

    if (path === "/sdk.js") {
      if (sdkPath === null) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("featurekit-client is not built — run `npm run build`");
        return;
      }
      void send(response, sdkPath, ".js", options.onError);
      return;
    }

    // A directory request is `index.html`; everything else is a file, and only
    // one inside the root — resolved and prefix-checked rather than cleaned of
    // dots by hand, which is how every traversal bug was written.
    const relative = path === "/" || path.endsWith("/") ? `${path}index.html` : path;
    const file = safeJoin(root, relative.slice(1));
    if (file === null) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("forbidden");
      return;
    }
    void send(response, file, extname(file).toLowerCase(), options.onError);
  });

  server.on("error", (error) => options.onError?.(error));

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4000, host, () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  // A wildcard binding is not an address anyone can type. Report the loopback
  // one, which is where the person reading the log is sitting.
  const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  return {
    port,
    url: `http://${reachable}:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

async function send(
  response: import("node:http").ServerResponse,
  file: string,
  extension: string,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    const content = await readFile(file);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      // Nothing is cached: this is a directory you are editing while it runs.
      "cache-control": "no-store",
    });
    response.end(content);
  } catch (error) {
    onError?.(error);
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }
}

/** A path, whether we were handed a path, a `file:` URL, or a `URL`. */
export function toPath(dir: string | URL): string {
  if (dir instanceof URL) return fileURLToPath(dir);
  return dir.startsWith("file:") ? fileURLToPath(new URL(dir)) : dir;
}

function safeJoin(root: string, requested: string): string | null {
  if (requested.includes("\0")) return null;
  const candidate = resolve(root, normalize(requested));
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

/** Where the SDK bundle would be, for an error message worth reading. */
export const BROWSER_SDK_HINT = join("packages", "client", "dist", "index.js");
