# Segments

`src/sdk/evaluation/segments.ts`, `cuckoo.ts`, `roaring.ts` · §9.7

Large imported lists — an enterprise allow-list, a churn-risk cohort — can be
too big to inline in a snapshot sent to every SDK. Resolving them must not put
a network call on the evaluation path, which is what made `boolean()` async in
r1 and contradicted both the latency claim and the outage story.

## The contract

1. A **deletable membership filter** ships in the snapshot. A negative is exact
   and final: not a member, no network, done.
2. **Positives are confirmed** against a resolved membership set — in-process by
   default, or behind a `SegmentCacheProvider`.
3. When membership cannot be confirmed the answer is **`"unresolved"`**, and
   the whole rule fails closed. See [the evaluator](evaluator.md#fail-closed).
4. During an outage the resolved set is whatever was last loaded, exactly like
   the snapshot.

```ts
type MembershipResult = "member" | "not-member" | "unresolved";
```

Order of resolution: **excluded wins over included**, in every encoding, before
anything else. Then the membership structure. Then the segment's own rules.

An **unknown segment key is `not-member`, not unresolved** — the compiler drops
archived segments, so a clause naming one that no longer exists is a definite
non-match.

## Choosing a structure

| | When | 500k members, measured | False positives |
| :-- | :-- | --: | :-- |
| **inline** | small segments (`SEGMENT_INLINE_MAX`) | — | none, exact |
| **cuckoo** | **the default** — opaque string keys | 2,097,168 B · 140 ns lookup | 0.012%, confirmed at step 2 |
| **roaring** | only when the key is integral | **117 B** · 12 ns lookup | **none, exact** |

Roaring where eligible is not a close call: exact, 12x faster to query, and
four orders of magnitude smaller on sequential ids. It is also the only
structure that **cannot enter the unresolved state at all**, which is a second
reason to prefer it.

### Why not Bloom

**Bloom filters cannot delete.** Removing one person from a 500k-member
allow-list — the single most common operation on exactly this kind of
segment — forces a full re-encode and a re-broadcast to every connected SDK, on
the same SSE stream that carries kill switches.

### Why the ordinal cannot be a lookup

A roaring bitmap answers `contains(int)`; the evaluator holds `"usr_7f3a91"`.
The obvious bridge — ship a `Record<string, number>` — is a 500,000-entry
dictionary, roughly 30-40 MB of V8 heap once it is a live `Map`, which is
*worse* than the `Set` the bitmap was meant to replace.

So roaring is available only when the ordinal **is** the key: it parses as a
non-negative integer under 10^9. Then `contains(Number(key))` is the whole
lookup and nothing extra ships. Shops on numeric primary keys get exact
matching for free; shops on uuids do not.

`ordinalOf` additionally rejects **leading zeros** — `"07"` and `"7"` are
distinct context keys but the same integer. This diverges from the SQL in §7.6
and must be reconciled in M2; see [decisions §9](../decisions.md).

## Cuckoo wire format {#wire-format}

Frozen in M1, alongside the bucketing hash. A disagreement about fingerprint
width or alternate-bucket derivation does not throw — it silently answers
`false` for members who *are* in the segment, which surfaces as "the flag did
not turn on for that customer" weeks later.

```
 0..3   magic "FKCF"
 4      format version (1)
 5      fingerprint bits (12 | 16)
 6      log2(bucketCount)
 7      slots per bucket (4)
 8..11  seed, uint32 LE
12..15  item count, uint32 LE
16..    fingerprint table
```

At f=16 a bucket is four uint16 LE — 8 bytes, read with no shifting. At f=12
four fingerprints are nibble-packed into 6 bytes. **No semi-sorting**: it saves
~1 bit per item and costs a decode on every lookup.

| Parameter | Value | Why |
| :-- | :-- | :-- |
| slots per bucket | 4 | The load-factor knee. b=2 saturates near 84%, b=4 reaches ~95% |
| fingerprint bits | 16 (12 optional) | eps = 2b/2^f = 0.012%, and byte-aligned |
| bucket count | `nextPow2(ceil(n / (4 * 0.8)))` | Power of two **required** — see below |
| max relocations | 500, then rebuild | At alpha <= 0.8 it is not reached |
| alternate bucket | `i2 = i1 XOR h(fingerprint)` | Relocation needs only the fingerprint |

### The four details that make it work

1. **The bucket count must be a power of two.** `i2 = i1 XOR h(fp)` only stays
   in range when the index space is one. The usual patch for another size —
   `% numBuckets` — quietly breaks the involution, so `alt(alt(i)) != i`,
   relocated items become unfindable, and inserts loop until the kick limit on
   a filter that is only half full. **This is the single most common cuckoo
   filter bug and it is invisible until the table gets large**, so the test
   asserts `alt(alt(i)) === i` over the *entire* index space for every table
   size the compiler can emit, rather than sampling.
2. **A fingerprint is never zero.** Zero is the empty-slot sentinel; a computed
   zero is remapped to 1.
3. **`delete` clears ONE matching fingerprint, not all of them.** Two distinct
   members can share a fingerprint in the same bucket; clearing both silently
   evicts someone who is still in the segment.
4. **`h(fp)` is forced non-zero**, or the alternate bucket would equal the
   primary and the item would have half the homes it is sized for.

Victim selection during relocation is deterministic, not random, so the same
member set always produces the same bytes — the compiler re-encoding an
unchanged segment must not produce a spurious new version.

### Space, honestly

The plan prices 500k members at ~1.25 MB (20 bits/member at alpha=0.8).
Measured: **2.0 MB, 33.6 bits/member**, because the mandatory power-of-two
bucket count puts the achieved load factor at 0.477 rather than 0.8. See
[decisions §2](../decisions.md) — this is a property of the frozen parameters,
not a defect, but the plan's figures should be restated as a range.

`buildCuckooFilter` retries once with an incremented seed, then doubles the
table, reporting `rebuilds` and reasons so
`featurekit_segment_filter_rebuild_total` can see it. Verified at 1M members
and at a true alpha=0.8 saturation (1,677,721 members): **zero rebuilds**.

## Roaring wire format

The **official Roaring portable format** — array, bitmap and run containers,
with the standard cookies — so a future Go, Java or Python SDK reads it with an
off-the-shelf library rather than a bespoke port. Run-optimisation is applied
whenever runs are strictly smaller, which is why 500k sequential ids serialise
to 117 bytes.

Set operations (AND/OR/ANDNOT) are compiler-side and land with M2; the SDK only
reads.

## `SegmentCacheProvider`

The default is an in-process `Set<string>`: synchronous, ~18 ns, correct for a
long-lived microservice. It is also **50-80 MB of V8 heap** for a few large
segments, which is fatal in a 128 MB Lambda or a memory-limited pod. The
failure there is not slow evaluation — it is OOMKilled, and it takes the whole
service with it.

```ts
interface SegmentCacheProvider {
  has(segmentKey, contextKey): boolean | Promise<boolean>;
  isResolved?(segmentKey): boolean;
  apply?(segmentKey, delta): void | Promise<void>;
}
```

| Provider | Unresolved evaluations | Heap |
| :-- | :-- | :-- |
| `InMemorySegmentCache` | none, ever | 50-80 MB |
| remote (Redis/sidecar) | first evaluation per `(segment, context)` fails closed and warms | bounded by `LruSegmentCache` |

**`boolean()` stays synchronous — non-negotiable.** An async provider is
therefore consulted out of band: a synchronous evaluation reads only the LRU,
and an LRU miss is *unresolved*, which fails the rule closed and should enqueue
a background fetch. A provider that returns a promise, or **throws**, is
treated as unresolved — evaluation never blocks and never rejects.

In request-scoped workloads the same context usually evaluates several flags
per request, so warm-up is paid once per context. But a genuinely cold Lambda
invocation *will* fail a large-segment rule closed on its first look. A
deployment that cannot accept that keeps the in-memory provider and sizes the
container for it. Both are defensible; silently OOMing is not.

## Deltas

```ts
index.applyDelta(segmentKey, version, { add: [...], remove: [...] });
```

A one-row membership change ships as a few hundred bytes rather than a full
re-encode. **Version-guarded** exactly like a flag patch: a delta at or below
the held version is ignored, so duplicate broadcasts and out-of-order delivery
are non-events rather than corruption. An `add` also clears a prior exclusion,
or the member would stay pinned out.
