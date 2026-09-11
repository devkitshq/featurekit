/**
 * Idempotency keys for mutating requests (§15, review PR-E1).
 *
 * **The failure this prevents.** A CI job PATCHes a flag, the response is lost
 * to a timeout or a load-balancer hiccup, the job retries. The second request
 * carries a stale `expectedVersion` and gets a 409 — which is the *good* case,
 * and it still means a red pipeline for a change that actually landed. For the
 * endpoints without a version check, notably the kill switch and segment
 * imports, a retry simply applies twice.
 *
 * An `Idempotency-Key` header makes the retry safe: the first request's result
 * is remembered and replayed, so the caller sees what it would have seen.
 *
 * **Scope, stated honestly.** This cache is per node and in memory. It covers
 * the retry that actually happens — the same client retrying within seconds,
 * usually against the same node behind a keep-alive connection — and not the
 * general distributed case. Making it cluster-wide means a shared store on the
 * write path, and the write path already has Postgres and its own version
 * check. A retry that lands on another node falls back to the version check,
 * which is exactly the behaviour that exists today.
 */

import { createHash } from "node:crypto";
import type { HttpResponse, RequestContext } from "./router.js";
import { HttpError } from "./router.js";

interface Entry {
  /** Hash of the request body, so the same key with a different body is caught. */
  fingerprint: string;
  response?: HttpResponse;
  /** Set while the first request is still running. */
  inFlight: boolean;
  expiresAt: number;
}

export interface IdempotencyOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class IdempotencyCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: IdempotencyOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    const ceiling = this.options.maxEntries ?? 10_000;
    if (this.entries.size < ceiling) return;
    let dropped = 0;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      if (++dropped >= Math.floor(ceiling / 2)) break;
    }
  }

  /**
   * Run `work` once per key.
   *
   * A repeat with the same body replays the first response. A repeat with a
   * *different* body is a caller bug — the same key meaning two different
   * changes — and is refused rather than silently applying the second.
   */
  async run(
    key: string,
    body: unknown,
    work: () => Promise<HttpResponse>,
  ): Promise<HttpResponse> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(body ?? null), "utf8")
      .digest("hex");
    const now = this.now();
    const existing = this.entries.get(key);

    if (existing !== undefined && existing.expiresAt > now) {
      if (existing.fingerprint !== fingerprint) {
        throw new HttpError(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "this Idempotency-Key was already used for a different request body",
        );
      }
      if (existing.response !== undefined) return existing.response;
      // Still running. Two concurrent retries of the same request is a real
      // pattern (a client that retries on timeout while the first is alive),
      // and running the mutation twice is exactly what this exists to stop.
      throw new HttpError(
        409,
        "IDEMPOTENCY_IN_FLIGHT",
        "a request with this Idempotency-Key is still being processed",
      );
    }

    this.prune();
    const entry: Entry = {
      fingerprint,
      inFlight: true,
      expiresAt: now + (this.options.ttlMs ?? 10 * 60_000),
    };
    this.entries.set(key, entry);

    try {
      const response = await work();
      entry.response = response;
      entry.inFlight = false;
      return response;
    } catch (error) {
      // A failed request is not remembered: the caller should be able to fix
      // whatever was wrong and retry with the same key.
      this.entries.delete(key);
      throw error;
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The key a request presented, validated.
 *
 * Bounded and character-restricted because it becomes a cache key and appears
 * in logs. Absent is fine — idempotency is opt-in, and most callers are humans
 * in a dashboard who will not retry blindly.
 */
export function idempotencyKeyOf(ctx: RequestContext): string | null {
  const raw = ctx.header("idempotency-key");
  if (raw === undefined) return null;
  const key = raw.trim();
  if (key.length === 0) return null;
  if (key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new HttpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be at most 200 characters of [A-Za-z0-9._:-]",
    );
  }
  // Scoped per route and method: the same key on two different endpoints is two
  // different operations, and collapsing them would replay the wrong response.
  return `${ctx.method} ${ctx.routePattern} ${key}`;
}
