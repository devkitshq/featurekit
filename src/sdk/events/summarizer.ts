/**
 * Evaluation event summarization.
 *
 * **Never one HTTP request per flag check.** At millions of evaluations per
 * second that is not a rate limit problem, it is an outage. The SDK
 * pre-aggregates into `(flagKey, variationIndex, reason)` buckets, flushes
 * every few seconds, and **drops on backpressure**.
 *
 * Dropping is the deliberate choice: analytics loss is acceptable, blocking an
 * evaluation is not. `featurekit_sdk_events_dropped_total` is how you find out
 * it happened.
 *
 * Zero dependencies, like everything else the SDK ships.
 */

export interface EvaluationSummary {
  flagKey: string;
  /** `null` means the caller's default was served. */
  variationIndex: number | null;
  reason: string;
  count: number;
  /** Distinct context keys seen, capped. Approximate above the cap. */
  uniqueContexts: number;
}

export interface SummaryBatch {
  /** Start of the aggregation window, ms since epoch, truncated to the minute. */
  bucketAt: number;
  summaries: EvaluationSummary[];
  /** Cumulative, so a server can see loss even if a whole batch is lost. */
  dropped: number;
}

export interface SummarizerOptions {
  /** Max distinct `(flag, variation, reason)` buckets before dropping. */
  maxBuckets?: number;
  /** Max distinct context keys tracked per bucket, for the unique estimate. */
  maxContextsPerBucket?: number;
  now?: () => number;
}

interface Bucket {
  flagKey: string;
  variationIndex: number | null;
  reason: string;
  count: number;
  /**
   * Bounded. An unbounded Set here is a memory leak proportional to traffic —
   * the exact failure the summarizer exists to prevent — so it stops growing at
   * the cap and the count becomes a floor rather than an exact figure.
   */
  contexts: Set<string>;
  contextsSaturated: boolean;
}

export class EventSummarizer {
  private buckets = new Map<string, Bucket>();
  private droppedTotal = 0;
  private windowStart: number;

  constructor(private readonly options: SummarizerOptions = {}) {
    this.windowStart = this.truncate(this.now());
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private truncate(ms: number): number {
    return Math.floor(ms / 60_000) * 60_000;
  }

  /**
   * Record one evaluation. **Must stay cheap** — this runs on the same path as
   * the evaluation itself, which is budgeted in tens of nanoseconds.
   */
  record(flagKey: string, variationIndex: number | null, reason: string, contextKey?: string): void {
    const id = `${flagKey}\0${variationIndex ?? "d"}\0${reason}`;
    let bucket = this.buckets.get(id);

    if (bucket === undefined) {
      if (this.buckets.size >= (this.options.maxBuckets ?? 100_000)) {
        // Bounded buffer, drop-oldest semantics at the bucket level. Blocking
        // or growing without limit are both worse than losing analytics.
        this.droppedTotal++;
        return;
      }
      bucket = {
        flagKey,
        variationIndex,
        reason,
        count: 0,
        contexts: new Set(),
        contextsSaturated: false,
      };
      this.buckets.set(id, bucket);
    }

    bucket.count++;
    if (contextKey !== undefined && !bucket.contextsSaturated) {
      if (bucket.contexts.size >= (this.options.maxContextsPerBucket ?? 10_000)) {
        bucket.contextsSaturated = true;
      } else {
        bucket.contexts.add(contextKey);
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  /** Take everything accumulated and start a new window. */
  flush(): SummaryBatch {
    const batch: SummaryBatch = {
      bucketAt: this.windowStart,
      summaries: [...this.buckets.values()].map((b) => ({
        flagKey: b.flagKey,
        variationIndex: b.variationIndex,
        reason: b.reason,
        count: b.count,
        uniqueContexts: b.contexts.size,
      })),
      dropped: this.droppedTotal,
    };
    this.buckets = new Map();
    this.windowStart = this.truncate(this.now());
    return batch;
  }
}
