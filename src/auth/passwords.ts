/**
 * Password hashing for dashboard logins.
 *
 * scrypt from `node:crypto`, because it is memory-hard, it is in the standard
 * library, and adding argon2 would put a native build step in the dependency
 * list of a package whose whole pitch is that it has six runtime dependencies.
 *
 * The parameters are stored **in** the hash string, so raising them later does
 * not invalidate existing passwords: an old hash still verifies with its own
 * parameters, and `needsRehash` says when to upgrade one on next login.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** ~16 MB and ~100ms on a laptop. A login is not a hot path. */
export const DEFAULT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * Password rules, such as they are.
 *
 * A minimum length and nothing else. Composition rules ("one symbol, one
 * digit") measurably push people towards `Password1!` and buy nothing; length
 * is the property that matters.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 512;

export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordError";
  }
}

export function checkPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  // Not a policy, a denial-of-service bound: scrypt on a 10 MB "password" is a
  // CPU burn anyone can trigger from a login form.
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

/** `scrypt$N$r$p$salt$hash`, both halves base64url. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> {
  checkPasswordPolicy(password);
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, KEY_LENGTH, { ...params, maxmem: maxmemFor(params) });
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored value: a corrupt row
 * must fail closed as "wrong password", never as a 500 that tells the caller
 * their guess was interesting.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = parse(stored);
  if (parsed === null) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    const candidate = await derive(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmemFor(parsed),
    });
    return timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

/** Whether a stored hash uses weaker parameters than we now use. */
export function needsRehash(stored: string | null, params: ScryptParams = DEFAULT_PARAMS): boolean {
  const parsed = parse(stored);
  if (parsed === null) return true;
  return parsed.N < params.N || parsed.r < params.r || parsed.p < params.p;
}

interface ParsedHash extends ScryptParams {
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string | null): ParsedHash | null {
  if (stored === null || stored.length === 0) return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, rawN, rawR, rawP, salt, hash] = parts as [string, string, string, string, string, string];
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  // A stored value naming absurd parameters would let a poisoned row turn one
  // login attempt into a gigabyte allocation.
  if (N < 1_024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  return {
    N,
    r,
    p,
    salt: Buffer.from(salt, "base64url"),
    hash: Buffer.from(hash, "base64url"),
  };
}

/** Node's default `maxmem` (32 MB) is below what N=16384,r=8 wants. */
function maxmemFor(params: ScryptParams): number {
  return 256 * params.N * params.r * 2;
}
