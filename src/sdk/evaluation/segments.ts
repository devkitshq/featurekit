/**
 * Segment membership resolution.
 *
 * Every segment is answered from the snapshot, synchronously, with no lookup
 * anywhere else:
 *
 * - **inline** — the member list itself, for small segments;
 * - **roaring** — an exact bitmap, when every member key is an integer;
 * - **cuckoo** — a filter with 32-bit fingerprints for everything else, whose
 *   false-positive rate (~1.9e-9) is low enough to treat a positive as
 *   membership. See `cuckoo.ts`.
 *
 * Membership is still **three-valued**. A structure that fails to decode — a
 * corrupt snapshot, or a filter in a format this SDK does not read — answers
 * `"unresolved"`, never a boolean. `evaluate.ts` fails the whole *rule* closed
 * on it, because a boolean here is something `negate` can invert, and
 * inverting an unverified miss grants the gated feature to everyone.
 *
 * Nothing here throws.
 *
 * @see docs/evaluation/segments.md
 */

import { CuckooFilter } from "./cuckoo.js";
import { RoaringBitmap, ordinalOf } from "./roaring.js";
import type { CompiledSegment } from "./types.js";

/**
 * Membership is three-valued. Collapsing this back into a boolean is exactly
 * the bug a well-meaning refactor reintroduces.
 */
export type MembershipResult = "member" | "not-member" | "unresolved";

export interface SegmentDelta {
  add: readonly string[];
  remove: readonly string[];
  /** The context kind every key in this delta belongs to. Default `"user"`. */
  contextKind?: string;
}

/**
 * The identity a segment stores for a member: its context kind and key
 * together, so a `user` and an `org` that share a key are different members.
 * The kind is length-prefixed, which keeps the encoding unambiguous whatever
 * characters either part contains.
 */
export function segmentMemberId(contextKind: string, contextKey: string): string {
  return `${contextKind.length}:${contextKind}:${contextKey}`;
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

  /** The compiled segment, for the rule evaluation `evaluate.ts` does. */
  get(segmentKey: string): CompiledSegment | undefined {
    return this.resident.get(segmentKey)?.compiled;
  }

  /** Whether this segment can be answered: its structure decoded. */
  isResolved(segmentKey: string): boolean {
    const seg = this.resident.get(segmentKey);
    if (seg === undefined) return true; // a definite non-match, not an unknown
    return seg.members !== undefined || seg.filter !== undefined || seg.bitmap !== undefined;
  }

  membership(segmentKey: string, contextKind: string, contextKey: string): MembershipResult {
    const seg = this.resident.get(segmentKey);
    // The compiler drops archived segments. A clause naming one that no longer
    // exists is a definite non-match, not an unverifiable one.
    if (seg === undefined) return "not-member";

    const id = segmentMemberId(contextKind, contextKey);
    // Excluded wins over included, in every encoding, before anything else.
    if (seg.excluded.has(id)) return "not-member";

    if (seg.compiled.kind === "inline") {
      if (seg.members === undefined) return this.unresolved();
      return seg.members.has(id) ? "member" : "not-member";
    }

    if (seg.compiled.kind === "roaring") {
      if (seg.bitmap === undefined) return this.unresolved();
      // A bitmap holds ordinals of one kind only; any other kind is not in it.
      if (contextKind !== seg.compiled.contextKind) return "not-member";
      const ordinal = ordinalOf(contextKey);
      // A non-integral key cannot be in a roaring segment by construction:
      // the compiler refuses to encode one. Exact negative, not unresolved.
      if (ordinal === null) return "not-member";
      return seg.bitmap.contains(ordinal) ? "member" : "not-member";
    }

    if (seg.filter === undefined) return this.unresolved();
    return seg.filter.contains(id) ? "member" : "not-member";
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

    const kind = delta.contextKind ?? "user";
    // Roaring ordinals are only meaningful for the bitmap's own kind.
    const bitmap =
      seg.compiled.kind === "roaring" && seg.compiled.contextKind === kind ? seg.bitmap : undefined;
    for (const key of delta.remove) {
      const id = segmentMemberId(kind, key);
      seg.members?.delete(id);
      seg.filter?.delete(id);
      if (bitmap !== undefined) {
        const o = ordinalOf(key);
        if (o !== null) bitmap.remove(o);
      }
    }
    for (const key of delta.add) {
      const id = segmentMemberId(kind, key);
      seg.members?.add(id);
      seg.filter?.insert(id);
      if (bitmap !== undefined) {
        const o = ordinalOf(key);
        if (o !== null) bitmap.add(o);
      }
      // An add must clear a prior exclusion, or the member stays pinned out.
      seg.excluded.delete(id);
    }
  }
}
