/**
 * Cookies, to the extent the dashboard needs them.
 *
 * One session cookie, read and written in one place. A cookie library would be
 * a seventh runtime dependency for forty lines, and the forty lines are the
 * part worth reading anyway: the attributes below are the security boundary.
 */

export interface CookieOptions {
  path?: string;
  maxAgeSeconds?: number;
  expires?: Date;
  /** Never reachable from JavaScript. The default, and never overridden. */
  httpOnly?: boolean;
  /** HTTPS only. On in production; off on `http://localhost`, which has no TLS. */
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined || header.length === 0) return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name.length === 0 || Object.hasOwn(out, name)) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is a cookie we simply do not have.
      out[name] = raw;
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  if (options.expires !== undefined) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure === true) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Strict"}`);
  return parts.join("; ");
}

/** The header that deletes a cookie: same name, empty value, expired. */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, "", { ...options, maxAgeSeconds: 0, expires: new Date(0) });
}
