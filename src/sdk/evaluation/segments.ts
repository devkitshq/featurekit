/**
 * Segment membership resolution (§9.7).
 *
 * The contract that makes `boolean()` synchronous while still supporting
 * segments too large to inline:
 *
 * 1. A **deletable membership filter** ships in the snapshot. A negative is
 *    exact and final: not a member, no network, done.
 * 2. **Positives are confirmed** against a resolved membership set — in-process
 *    by default, or behind a `SegmentCacheProvider` when the process cannot
 *    afford the heap.
 * 3. When membership cannot be confirmed the answer is **`"unresolved"`** — a
 *    third state, never a boolean. `evaluate.ts` fails the whole *rule* closed
 *    on it, because a boolean here is something `negate` can invert, and
 *    inverting an unverified miss grants the gated feature to everyone.
 *
 * Nothing here throws. A provider that throws is treated as unresolved.
 *
 * @see docs/evaluation/segments.md
 */

import { CuckooFilter } from "./cuckoo.js";
import { RoaringBitmap, ordinalOf } from "./roaring.js";
import type { CompiledSegment } from "./types.js";

/**
 * Membership is three-valued. Collapsing this back into a boolean is exactly
 * the bug a well-meaning refactor reintroduces (§22.3).
 */
export type MembershipResult = "member" | "not-member" | "unresolved";

export interface SegmentDelta {
  add: readonly string[];
  remove: readonly string[];
}

/**
 * Where large-segment membership is confirmed.
 *
 * The default is an in-process `Set<string>`: synchronous, ~14 ns, and correct
 * for a long-lived microservice. It is also 50–80 MB of V8 heap for a few large
 * segments, which is fatal in a 128 MB Lambda or a memory-limited pod — the
 * failure there is not slow evaluation, it is OOMKilled, and it takes the whole
 * service with it. So the confirmation set is pluggable.
 */
export interface SegmentCacheProvider {
  /**
   * A **sync** return keeps evaluation synchronous. A provider may return a
   * promise; the index then treats the lookup as unresolved and the caller is
   * expected to warm the answer out of band. Never awaited on the hot path.
   */
  has(segmentKey: string, contextKey: string): boolean | Promise<boolean>;
  /** Whether this provider can answer for a segment at all. */
  isResolved?(segmentKey: string): boolean;
  /** Called when a segment-patch arrives; a shared remote provider may no-op. */
  apply?(segmentKey: string, delta: SegmentDelta): void | Promise<void>;
}

/** The default: full membership in the heap. Always resolved, always sync. */
export class InMemorySegmentCache implements SegmentCacheProvider {
  private readonly sets = new Map<string, Set<string>>();

  constructor(sets: Record<string, Iterable<string>> = {}) {
    for (const [key, members] of Object.entries(sets)) this.sets.set(key, new Set(members));
  }

  has(segmentKey: string, contextKey: string): boolean {
    return this.sets.get(segmentKey)?.has(contextKey) ?? false;
  }

  isResolved(segmentKey: string): boolean {
    return this.sets.has(segmentKey);
  }

  apply(segmentKey: string, delta: SegmentDelta): void {
    const set = this.sets.get(segmentKey);
    if (set === undefined) return;
    for (const k of delta.remove) set.delete(k);
    for (const k of delta.add) set.add(k);
  }

  load(segmentKey: string, members: Iterable<string>): void {
    this.sets.set(segmentKey, new Set(members));
  }
}

/**
 * The bounded confirmed-membership cache a remote provider reads through.
 *
 * A miss is unresolved, which fails the rule closed and should enqueue a
 * background fetch so the next evaluation for that context resolves. In
 * request-scoped workloads the same context usually evaluates several flags per
 * request, so warm-up is paid once per context rather than once per evaluation
 * — but a genuinely cold Lambda invocation *will* fail a large-segment rule
 * closed on its first look. `SEGMENT_CACHE_LRU_MAX` is the knob;
 * `featurekit_sdk_segment_unresolved_total` is the metric that says it is too
 * small.
 */
export class LruSegmentCache {
  private readonly entries = new Map<string, boolean>();

  constructor(private readonly max: number) {}

  private static id(segmentKey: string, contextKey: string): string {
    // Segment first, and length-prefixed, so no two (segment, context) pairs
    // can collide through the separator.
    return `${segmentKey.length}:${segmentKey}:${contextKey}`;
  }

  peek(segmentKey: string, contextKey: string): boolean | undefined {
    const id = LruSegmentCache.id(segmentKey, contextKey);
    const v = this.entries.get(id);
    if (v === undefined) return undefined;
    // Map preserves insertion order, so re-inserting marks it most-recent.
    this.entries.delete(id);
    this.entries.set(id, v);
    return v;
  }

  put(segmentKey: string, contextKey: string, value: boolean): void {
    const id = LruSegmentCache.id(segmentKey, contextKey);
    this.entries.delete(id);
    this.entries.set(id, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

interface ResidentSegment {
  compiled: CompiledSegment;
  version: number;
  excluded: Set<string>;
  /** Inline only. */
  members?: Set<string>;
  /** Cuckoo only, decoded once at load. */
  filter?: CuckooFilter;
  /** Roaring only, decoded once at load. */
  bitmap?: RoaringBitmap;
}

/**
 * The SDK's resident view of every segment in a snapshot, and the only thing
 * `evaluate.ts` asks about membership.
 */
export class SegmentIndex {
  private readonly resident = new Map<string, ResidentSegment>();
  private cache: SegmentCacheProvider | null = null;

  /** Backs `featurekit_sdk_segment_unresolved_total` — rules failing closed. */
  unresolvedCount = 0;

  constructor(segments: Readonly<Record<string, CompiledSegment>> = {}) {
    for (const [key, compiled] of Object.entries(segments)) this.load(key, compiled);
  }

  private load(key: string, compiled: CompiledSegment): void {
    const entry: ResidentSegment = {
      compiled,
      version: compiled.version,
      excluded: new Set(compiled.excluded ?? []),
    };
    // A malformed structure must degrade to "unresolved", not throw at load
    // and take the whole snapshot with it.
    try {
      if (compiled.kind === "inline") entry.members = new Set(compiled.members);
      else if (compiled.kind === "cuckoo") entry.filter = CuckooFilter.decode(compiled.filter);
      else entry.bitmap = RoaringBitmap.deserialize(compiled.bitmap);
    } catch {
      /* leave the structure absent; membership() reports unresolved */
    }
    this.resident.set(key, entry);
  }

  setCache(cache: SegmentCacheProvider | null): void {
    this.cache = cache;
  }

  /** The compiled segment, for the rule evaluation `evaluate.ts` does. */
  get(segmentKey: string): CompiledSegment | undefined {
    return this.resident.get(segmentKey)?.compiled;
  }

  /**
   * Whether this segment can be answered exactly right now.
   *
   * Inline and roaring segments are always resolved — which is a second reason
   * to prefer roaring: the unresolved state cannot arise at all.
   */
  isResolved(segmentKey: string): boolean {
    const seg = this.resident.get(segmentKey);
    if (seg === undefined) return true; // a definite non-match, not an unknown
    if (seg.compiled.kind === "inline") return seg.members !== undefined;
    if (seg.compiled.kind === "roaring") return seg.bitmap !== undefined;
    if (seg.filter === undefined) return false;
    return this.cache !== null && (this.cache.isResolved?.(segmentKey) ?? true);
  }

  membership(segmentKey: string, contextKey: string): MembershipResult {
    const seg = this.resident.get(segmentKey);
    // The compiler drops archived segments. A clause naming one that no longer
    // exists is a definite non-match, not an unverifiable one.
    if (seg === undefined) return "not-member";

    // Excluded wins over included, in every encoding, before anything else.
    if (seg.excluded.has(contextKey)) return "not-member";

    if (seg.compiled.kind === "inline") {
      if (seg.members === undefined) return this.unresolved();
      return seg.members.has(contextKey) ? "member" : "not-member";
    }

    if (seg.compiled.kind === "roaring") {
      if (seg.bitmap === undefined) return this.unresolved();
      const ordinal = ordinalOf(contextKey);
      // A non-integral key cannot be in a roaring segment by construction:
      // the compiler refuses to encode one. Exact negative, not unresolved.
      if (ordinal === null) return "not-member";
      return seg.bitmap.contains(ordinal) ? "member" : "not-member";
    }

    if (seg.filter === undefined) return this.unresolved();
    // Step 1: a filter negative is exact and final.
    if (!seg.filter.contains(contextKey)) return "not-member";

    // Step 2: confirm the positive. Anything else is unresolved.
    if (this.cache === null) return this.unresolved();
    let confirmed: boolean | Promise<boolean>;
    try {
      confirmed = this.cache.has(segmentKey, contextKey);
    } catch {
      // Provider errors are caught, not thrown: evaluation never blocks and
      // never rejects, and the rule fails closed above.
      return this.unresolved();
    }
    if (typeof confirmed !== "boolean") return this.unresolved();
    return confirmed ? "member" : "not-member";
  }

  private unresolved(): MembershipResult {
    this.unresolvedCount++;
    return "unresolved";
  }

  /**
   * Apply a `segment-patch` from the stream. A one-row membership change ships
   * as a few hundred bytes rather than a full filter re-encode.
   *
   * Version-guarded exactly like a flag patch: a delta at or below the held
   * version is ignored, so duplicate broadcasts and out-of-order delivery are
   * non-events rather than corruption.
   */
  applyDelta(segmentKey: string, version: number, delta: SegmentDelta): void {
    const seg = this.resident.get(segmentKey);
    if (seg === undefined || version <= seg.version) return;
    seg.version = version;

    for (const key of delta.remove) {
      seg.members?.delete(key);
      seg.filter?.delete(key);
      if (seg.bitmap !== undefined) {
        const o = ordinalOf(key);
        if (o !== null) seg.bitmap.remove(o);
      }
    }
    for (const key of delta.add) {
      seg.members?.add(key);
      seg.filter?.insert(key);
      if (seg.bitmap !== undefined) {
        const o = ordinalOf(key);
        if (o !== null) seg.bitmap.add(o);
      }
      // An add must clear a prior exclusion, or the member stays pinned out.
      seg.excluded.delete(key);
    }

    void this.cache?.apply?.(segmentKey, delta);
  }
}
