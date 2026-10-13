/**
 * Request body schemas for the SDK- and client-facing endpoints.
 *
 * Every public endpoint validates before it uses. The rule this file exists to
 * enforce is that **an unvalidated body must never reach code that allocates
 * proportionally to it** — `POST /v1/events` previously handed `unknown`
 * straight to the ingest sink, which is an unbounded array of unbounded strings
 * arriving from anyone holding a public client key.
 *
 * Body byte ceilings live here too, next to the schema they belong to, because
 * a schema that rejects a 4 MB body has already paid for reading 4 MB.
 */

import { z } from "zod";

/* ── byte ceilings, per endpoint ─────────────────────────────────────── */

export const BODY_LIMITS = {
  /** A context plus a signature. Generous; the honest case is under 1 KB. */
  clientState: 64 * 1024,
  /** A flush of pre-aggregated buckets. 100k buckets would be ~10 MB — no. */
  events: 512 * 1024,
  /** One flag's configuration, rules included. */
  adminWrite: 512 * 1024,
  /** A chunked segment import page. */
  segmentImport: 5 * 1024 * 1024,
} as const;

/* ── POST /v1/client/state ───────────────────────────────────────────── */

/**
 * The context itself is `unknown` here and checked by `checkContext` instead:
 * its shape is recursive and its limits are about *resource consumption*, which
 * a zod schema expresses badly and a depth-limited walk expresses exactly.
 */
export const clientStateSchema = z.object({
  context: z.unknown(),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  signature: z.string().max(256).optional(),
  expiresAt: z.number().int().optional(),
});

export type ClientStateBody = z.infer<typeof clientStateSchema>;

/* ── POST /v1/events ─────────────────────────────────────────────────── */

/**
 * Matches `SummaryBatch` in the SDK. The caps are the interesting part:
 *
 * - `summaries` is capped at 10,000 rows per batch. The SDK's own default
 *   ceiling is 100,000 buckets; a client is free to send more than one batch,
 *   and a server that accepts an unbounded array in one request has handed the
 *   caller a per-request allocation multiplier.
 * - `bucketAt` is bounded to a sane window. A batch claiming to be from 1970 or
 *   2170 would otherwise create a partition-shaped problem in `evaluation_
 *   summaries`, and inserting it is how a partitioned table
 *   acquires rows nothing will ever drop.
 *
 * Strict about size, tolerant about shape:
 *
 * The caps are hard because they bound allocation. The optional fields are
 * optional because analytics is explicitly lossy: rejecting a batch that
 * omits `variationIndex` buys nothing — the SDK cannot resend it usefully, and
 * a 400 on the events endpoint is a retry loop on the one path that is allowed
 * to drop data. An absent `variationIndex` already has a meaning ("the caller's
 * default was served"), and an absent reason is recorded as unknown rather than
 * discarded.
 */
export const evaluationSummarySchema = z.object({
  flagKey: z.string().min(1).max(255),
  variationIndex: z.number().int().min(0).max(10_000).nullable().default(null),
  reason: z.string().min(1).max(64).default("UNKNOWN"),
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  uniqueContexts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  /**
   * Base64 HLL sketch of the distinct context keys behind `count`, when the SDK
   * can produce one. Bounded at 8 KB — a 2^12 sketch is ~4 KB encoded, and an
   * unbounded blob here is an allocation multiplier per summary row.
   */
  uniqueSketch: z.string().max(8_192).optional(),
});

/**
 * `bucketAt` is optional, and its absence means "stamp it on arrival".
 *
 * Server arrival time is also what a badly skewed client clock gets: §17 asks
 * whether telemetry can lie, and a fleet with a clock an hour fast would
 * otherwise write rows into a future partition and make every dashboard wrong.
 * The window check below is what enforces that.
 */
export const summaryBatchSchema = z.object({
  bucketAt: z.number().int().min(0).optional(),
  summaries: z.array(evaluationSummarySchema).max(10_000),
  dropped: z.number().int().min(0).optional(),
});

export type SummaryBatchBody = z.infer<typeof summaryBatchSchema>;

/** How far out of the present a reported bucket may be, in milliseconds. */
export const EVENT_BUCKET_PAST_MS = 24 * 60 * 60 * 1000;
export const EVENT_BUCKET_FUTURE_MS = 5 * 60 * 1000;

export function bucketIsAcceptable(bucketAt: number | undefined, now = Date.now()): boolean {
  if (bucketAt === undefined) return true; // stamped on arrival
  return bucketAt > now - EVENT_BUCKET_PAST_MS && bucketAt < now + EVENT_BUCKET_FUTURE_MS;
}
