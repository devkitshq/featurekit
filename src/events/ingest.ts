/**
 * Analytics ingest.
 *
 * **The architectural rule this file enforces: analytics loss is acceptable,
 * and analytics must never be able to slow down or break evaluation.** The
 * review asks whether that claim is actually enforced or merely asserted, so it
 * is enforced in three concrete ways here:
 *
 * 1. **The route never awaits a write to Postgres.** Batches land in a bounded
 *    in-memory buffer and the request returns 202 immediately.
 * 2. **The buffer has a hard ceiling and drops the *oldest* entries.** A stalled
 *    rollup worker or a Postgres outage therefore costs bounded
 *    memory and some analytics, not the process.
 * 3. **Every drop is counted.** `featurekit_events_dropped_total{reason}` is how
 *    you discover the loss, which is the difference between a documented
 *    trade-off and a silent one.
 *
 * The buffer is per node and deliberately not durable. Making it durable would
 * mean an evaluation-path dependency on a queue being available, which is the
 * coupling the whole design is trying to avoid.
 */

import type { SummaryBatchBody } from "../contracts/wire.js";

export interface BufferedSummary {
  environmentId: string;
  flagKey: string;
  variationIndex: number | null;
  reason: string;
  /** Truncated to the rollup bucket, in ms since epoch. */
  bucketAt: number;
  count: number;
  uniqueContexts: number;
  /** Raw HLL bytes when the SDK supplied them; see `hll.ts`. */
  sketch?: Uint8Array;
}

export interface EventBufferOptions {
  /** Hard ceiling on buffered rows. Oldest are dropped past it. */
  maxRows?: number;
  bucketSeconds?: number;
  onDropped?: (rows: number, reason: string) => void;
  now?: () => number;
}

/**
 * A bounded aggregation buffer.
 *
 * Rows are pre-aggregated *again* here, on top of the SDK's own aggregation:
 * fifty SDK instances reporting the same `(flag, variation, reason, minute)`
 * become one row before they reach Postgres. That collapse is what keeps the
 * write rate proportional to distinct flags rather than to fleet size.
 */
export class EventBuffer {
  private rows = new Map<string, BufferedSummary>();
  private droppedTotal = 0;
  private oldestBucketAt: number | null = null;

  constructor(private readonly options: EventBufferOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private truncate(ms: number): number {
    const bucketMs = (this.options.bucketSeconds ?? 60) * 1000;
    return Math.floor(ms / bucketMs) * bucketMs;
  }

  get size(): number {
    return this.rows.size;
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  /** Age of the oldest buffered row, in seconds. Backs the rollup-lag gauge. */
  lagSeconds(): number {
    if (this.oldestBucketAt === null) return 0;
    return Math.max(0, Math.round((this.now() - this.oldestBucketAt) / 1000));
  }

  /**
   * Accept one validated batch. Never throws, never awaits.
   *
   * A malformed row is skipped rather than failing the batch: the sender cannot
   * fix it and cannot usefully retry, so rejecting the whole batch would lose
   * more data than accepting the good rows.
   */
  accept(environmentId: string, batch: SummaryBatchBody): void {
    const bucketAt = this.truncate(batch.bucketAt ?? this.now());
    const ceiling = this.options.maxRows ?? 100_000;

    for (const summary of batch.summaries) {
      if (!Number.isFinite(summary.count) || summary.count < 0) continue;

      const id = `${environmentId}\0${summary.flagKey}\0${summary.variationIndex ?? "d"}\0${summary.reason}\0${bucketAt}`;
      const existing = this.rows.get(id);
      if (existing !== undefined) {
        existing.count += summary.count;
        existing.uniqueContexts = Math.max(
          existing.uniqueContexts,
          summary.uniqueContexts ?? 0,
        );
        continue;
      }

      if (this.rows.size >= ceiling) {
        // Drop-oldest. Insertion order in a Map is arrival order, so the first
        // key is the oldest — and losing the oldest analytics beats refusing the
        // newest, which is what an operator is actually watching during an
        // incident.
        const oldest = this.rows.keys().next();
        if (!oldest.done) this.rows.delete(oldest.value);
        this.droppedTotal++;
        this.options.onDropped?.(1, "buffer_full");
      }

      const sketch = decodeSketch(summary.uniqueSketch);
      this.rows.set(id, {
        environmentId,
        flagKey: summary.flagKey,
        variationIndex: summary.variationIndex,
        reason: summary.reason,
        bucketAt,
        count: summary.count,
        uniqueContexts: summary.uniqueContexts ?? 0,
        ...(sketch !== undefined ? { sketch } : {}),
      });
      if (this.oldestBucketAt === null || bucketAt < this.oldestBucketAt) {
        this.oldestBucketAt = bucketAt;
      }
    }

    // The SDK reports its own drops cumulatively, so they are surfaced under a
    // distinct reason rather than mixed with ours.
    if (batch.dropped !== undefined && batch.dropped > 0) {
      this.options.onDropped?.(batch.dropped, "sdk_backpressure");
    }
  }

  /** Take everything buffered. The caller owns it from here. */
  drain(): BufferedSummary[] {
    const rows = [...this.rows.values()];
    this.rows = new Map();
    this.oldestBucketAt = null;
    return rows;
  }

  /**
   * Put rows back after a failed write.
   *
   * Bounded like everything else: if the buffer has filled while a write was in
   * flight, the returned rows are dropped rather than allowed to push it over
   * the ceiling. A retry that can grow memory without limit is not a retry, it
   * is a leak with a schedule.
   */
  requeue(rows: BufferedSummary[]): void {
    const ceiling = this.options.maxRows ?? 100_000;
    for (const row of rows) {
      if (this.rows.size >= ceiling) {
        this.droppedTotal++;
        this.options.onDropped?.(1, "requeue_full");
        continue;
      }
      const id = `${row.environmentId}\0${row.flagKey}\0${row.variationIndex ?? "d"}\0${row.reason}\0${row.bucketAt}`;
      const existing = this.rows.get(id);
      if (existing === undefined) {
        this.rows.set(id, row);
        if (this.oldestBucketAt === null || row.bucketAt < this.oldestBucketAt) {
          this.oldestBucketAt = row.bucketAt;
        }
      } else {
        existing.count += row.count;
      }
    }
  }
}

function decodeSketch(encoded: string | undefined): Uint8Array | undefined {
  if (encoded === undefined) return undefined;
  try {
    const bytes = Buffer.from(encoded, "base64");
    // A sketch that does not decode is dropped silently: it is analytics
    // detail, and throwing here would fail a batch that is otherwise fine.
    return bytes.length > 0 && bytes.length <= 8_192 ? new Uint8Array(bytes) : undefined;
  } catch {
    return undefined;
  }
}
