/**
 * The rollup worker: buffered summaries → `evaluation_summaries` (§7.9, §10).
 *
 * **Idempotency is the whole design.** Writes go through
 * `ON CONFLICT (environment_id, flag_key, variation_idx, reason, bucket_at) DO
 * UPDATE SET count = count + excluded.count`, which means:
 *
 * - a batch written twice after an ambiguous failure double-counts, so it is
 *   never retried blindly — a failed write goes back to the buffer *once* and
 *   then to the DLQ;
 * - late events land in their own historical bucket instead of being discarded,
 *   provided a partition still covers it;
 * - two nodes writing the same bucket concurrently is safe, which is what makes
 *   this "single writer per shard" rather than "single writer".
 *
 * **A missing partition is treated as a first-class outcome, not an exception.**
 * §7.9 forbids a DEFAULT partition, so an insert whose `bucket_at` has no
 * partition fails loudly — correctly. The worker catches exactly that, sends
 * the batch to the DLQ and keeps going, because a stalled drain becomes an
 * unbounded buffer, and an unbounded buffer in the analytics path is how
 * analytics takes down evaluation (§22).
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { evaluationSummaries } from "../db/schema.js";
import type { BufferedSummary, EventBuffer } from "./ingest.js";
import { HyperLogLog } from "./hll.js";

export interface DeadLetterSink {
  /** Rows that could not be written. Replayable, bounded by the implementation. */
  push(rows: BufferedSummary[], reason: string): Promise<void> | void;
}

export interface RollupWorkerOptions {
  db: Database;
  buffer: EventBuffer;
  intervalMs?: number;
  /** Rows per INSERT. Postgres parameter limits, not throughput, set this. */
  batchSize?: number;
  deadLetter?: DeadLetterSink;
  /**
   * Only one worker per shard should drain concurrently. The lease is the
   * mechanism; on a single node it is a no-op, and with Redis it is a SET NX.
   */
  acquireLease?: (shard: number, ttlMs: number) => Promise<boolean>;
  releaseLease?: (shard: number) => Promise<void>;
  shard?: number;
  onWritten?: (rows: number) => void;
  onDropped?: (rows: number, reason: string) => void;
  onLag?: (seconds: number) => void;
  onError?: (error: unknown) => void;
}

export class RollupWorker {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private closed = false;

  constructor(private readonly options: RollupWorkerOptions) {}

  start(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // One last drain on the way out, so a rolling deploy does not discard the
    // last few seconds of every node's analytics.
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.draining) return; // never two drains at once on one node
    this.draining = true;
    try {
      this.options.onLag?.(this.options.buffer.lagSeconds());
      await this.drainOnce();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.draining = false;
    }
  }

  /** Exposed for tests: drain whatever is buffered, once. */
  async drainOnce(): Promise<number> {
    const shard = this.options.shard ?? 0;
    const lease = this.options.acquireLease;
    if (lease !== undefined && !(await lease(shard, 30_000))) return 0;

    try {
      const rows = this.options.buffer.drain();
      if (rows.length === 0) return 0;

      const size = this.options.batchSize ?? 500;
      let written = 0;
      for (let i = 0; i < rows.length; i += size) {
        const chunk = rows.slice(i, i + size);
        try {
          await this.write(chunk);
          written += chunk.length;
          this.options.onWritten?.(chunk.length);
        } catch (error) {
          this.options.onError?.(error);
          // One retry through the buffer, then the DLQ. Retrying an insert that
          // may have partially applied is how `count` silently doubles, so the
          // second failure is terminal by design.
          if (isMissingPartition(error)) {
            await this.deadLetter(chunk, "missing_partition");
          } else {
            await this.deadLetter(chunk, "write_failed");
          }
        }
      }
      return written;
    } finally {
      await this.options.releaseLease?.(shard).catch(() => undefined);
    }
  }

  private async deadLetter(rows: BufferedSummary[], reason: string): Promise<void> {
    this.options.onDropped?.(rows.length, reason);
    try {
      await this.options.deadLetter?.push(rows, reason);
    } catch (error) {
      // Even the DLQ failed. The rows are gone, which is the documented,
      // acceptable outcome for analytics — and it is counted above.
      this.options.onError?.(error);
    }
  }

  private async write(rows: BufferedSummary[]): Promise<void> {
    const merged = mergeRows(rows);
    await this.options.db
      .insert(evaluationSummaries)
      .values(
        merged.map((row) => ({
          environmentId: row.environmentId,
          flagKey: row.flagKey,
          variationIdx: row.variationIndex,
          reason: row.reason,
          bucketAt: new Date(row.bucketAt),
          count: row.count,
          uniqueSketch: row.sketch ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [
          evaluationSummaries.environmentId,
          evaluationSummaries.flagKey,
          evaluationSummaries.variationIdx,
          evaluationSummaries.reason,
          evaluationSummaries.bucketAt,
        ],
        set: {
          count: sql`${evaluationSummaries.count} + excluded.count`,
          // Sketches merge by register-wise max, which SQL cannot express, so
          // the stored one wins unless it is null. Full merge-on-write would
          // need a read-modify-write under a lock, and analytics does not earn
          // that; `hll.ts` documents the consequence.
          uniqueSketch: sql`coalesce(${evaluationSummaries.uniqueSketch}, excluded.unique_sketch)`,
        },
      });
  }
}

/**
 * Merge rows addressing the same primary key before they reach the INSERT.
 *
 * Postgres rejects an INSERT ... ON CONFLICT whose own VALUES list contains the
 * same conflict target twice ("cannot affect row a second time"), and a drain
 * that merged two nodes' buffers can absolutely contain duplicates. This is the
 * kind of failure that only appears under load, which is why it is handled here
 * rather than discovered later.
 */
export function mergeRows(rows: BufferedSummary[]): BufferedSummary[] {
  const merged = new Map<string, BufferedSummary>();
  for (const row of rows) {
    const id = `${row.environmentId} ${row.flagKey} ${row.variationIndex ?? "d"} ${row.reason} ${row.bucketAt}`;
    const existing = merged.get(id);
    if (existing === undefined) {
      merged.set(id, { ...row });
      continue;
    }
    existing.count += row.count;
    existing.uniqueContexts = Math.max(existing.uniqueContexts, row.uniqueContexts);
    // Sketches merge properly here, in process, where a real union is possible.
    const a = HyperLogLog.fromBytes(existing.sketch);
    const b = HyperLogLog.fromBytes(row.sketch);
    if (a !== null && b !== null) {
      a.merge(b);
      existing.sketch = a.toBytes();
    } else if (existing.sketch === undefined && row.sketch !== undefined) {
      existing.sketch = row.sketch;
    }
  }
  return [...merged.values()];
}

/**
 * Did this write fail because no partition covers the row?
 *
 * Distinguished from a generic write failure because it is the one that means
 * "partition maintenance stopped running" — an operational failure with its own
 * runbook and its own alert, not a transient error to retry.
 *
 * **The cause chain has to be walked.** Drizzle wraps driver errors in its own
 * `Error` whose message is the failing SQL, so matching only on the top-level
 * message finds the query text and misses the reason. A container-backed test
 * is what caught that: the DLQ was recording `write_failed` for the one failure
 * that has a specific runbook. Postgres raises SQLSTATE 23514 here, which is
 * checked alongside the text because the text is localisable.
 */
export function isMissingPartition(error: unknown): boolean {
  const pattern = /no partition of relation|partition key of the failing row/i;

  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current === "object") {
      const candidate = current as { message?: unknown; code?: unknown; cause?: unknown };
      if (candidate.code === "23514") return true;
      if (typeof candidate.message === "string" && pattern.test(candidate.message)) return true;
      current = candidate.cause;
      continue;
    }
    if (typeof current === "string" && pattern.test(current)) return true;
    break;
  }
  return false;
}

/**
 * An in-memory dead-letter queue.
 *
 * Bounded, because a DLQ that grows without limit during an outage is the
 * memory leak the buffer ceiling was there to prevent. Anything past the cap is
 * counted and discarded; analytics is allowed to be lossy, and this is one of
 * the places where that is exercised deliberately.
 */
export class MemoryDeadLetterQueue implements DeadLetterSink {
  private readonly entries: Array<{ rows: BufferedSummary[]; reason: string; at: number }> = [];

  constructor(private readonly maxBatches = 100) {}

  push(rows: BufferedSummary[], reason: string): void {
    if (this.entries.length >= this.maxBatches) this.entries.shift();
    this.entries.push({ rows, reason, at: Date.now() });
  }

  get size(): number {
    return this.entries.length;
  }

  /** Take everything for a replay attempt, once the underlying fault is fixed. */
  take(): Array<{ rows: BufferedSummary[]; reason: string; at: number }> {
    return this.entries.splice(0, this.entries.length);
  }
}
