/** What serving files from a directory needs: content types and a root that cannot be escaped. */

import { normalize, resolve, sep } from "node:path";

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
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
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * `requested` inside `root`, or null. Resolved and prefix-checked rather than
 * cleaned of dots by hand, which is how every traversal bug was written.
 */
export function safeJoin(root: string, requested: string): string | null {
  if (requested.length === 0 || requested.includes("\0")) return null;
  const candidate = resolve(root, normalize(requested));
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}
