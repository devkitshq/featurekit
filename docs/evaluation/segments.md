# Segments

`src/sdk/evaluation/segments.ts`, `cuckoo.ts`, `roaring.ts`

Large imported lists — an enterprise allow-list, a churn-risk cohort — can be
too big to inline in a snapshot sent to every SDK. Resolving them must not put
a network call on the evaluation path, which is what made `boolean()` async in
r1 and contradicted both the latency claim and the outage story.

## The contract

1. **Every segment is answered from the snapshot alone**, synchronously. No
   lookup service, no confirmation step, no warm-up.
2. Membership is still **three-valued**:

   ```ts
   type MembershipResult = "member" | "not-member" | "unresolved";
   ```

   `"unresolved"` means the segment's structure could not be read — a corrupt
   snapshot, or a filter in a format this SDK does not decode. The whole rule
   then fails closed in either polarity, because treating an unreadable segment
   as "not a member" would let a negated clause grant the feature to everyone.
   See [the evaluator](evaluator.md#fail-closed).
3. During an outage the segments are whatever the last snapshot held.

Order of resolution: **excluded wins over included**, in every encoding, before
anything else. Then the membership structure. Then the segment's own rules.

An **unknown segment key is `not-member`, not unresolved** — the compiler drops
archived segments, so a clause naming one that no longer exists is a definite
non-match.

## Choosing a structure

| | When | 500k members | False positives |
| :-- | :-- | --: | :-- |
| **inline** | small segments (`SEGMENT_INLINE_MAX`, 50,000) | — | none, exact |
| **roaring** | every member key is an integer | **117 B** for sequential ids | **none, exact** |
| **cuckoo** | everything else — uuids, emails, opaque strings | 4 MB | ~1.9e-9 per lookup |

Roaring where eligible is not a close call: exact, faster than a `Set`, and
four orders of magnitude smaller on sequential ids.

### Why a 32-bit cuckoo filter, and no confirmation

A filter smaller than the set it stands for has false positives; there is no
way around that. What can be chosen is how rare they are. With 16-bit
fingerprints a positive was wrong about once in 8,000 lookups, so every positive
had to be confirmed against the real member list — a provider the SDK had to be
given, and that the control plane never gave its own client tier. Members of
large segments failed closed.

At 32 bits a positive is wrong about once in 500 million lookups, rarer than the
hardware faults nobody guards against, so a positive is treated as membership.
It also grants nothing a caller could not get anyway: without secure mode a
caller can claim any key, including a real member's; with it, keys are signed
by the customer's backend, so a colliding key cannot be chosen.

Measured on 500,000 uuid members, cycling through 200,000 distinct keys
(`tools/bench-segments.mjs`):

| Structure | hit | miss | size | false positives / 500k non-members |
| :-- | --: | --: | --: | --: |
| 16-bit cuckoo (previous format), filter only | 465 ns | 500 ns | 2 MB | 38 — needs confirming |
| 16-bit cuckoo + confirmation against a `Set` | 720 ns | 505 ns | 2 MB + the keys | 0 |
| **32-bit cuckoo, one MurmurHash3 x86_128 call** | **229 ns** | **232 ns** | **4 MB** | **0** |
| hash table of 64-bit key hashes | 227 ns | 207 ns | 8 MB | 0 |
| `Set<string>` of the keys | 265 ns | 277 ns | 84 MB | 0 |

The speed came from hashing, not the table. The 16-bit format hashed the key
twice — once for the bucket, once for the fingerprint — and hashing was about
85% of a lookup. One MurmurHash3 x86_128 call yields both in a single pass
(~200 ns against ~410 ns for the two passes), and the alternate bucket is
integer mixing of the fingerprint with no allocation. Widening the fingerprint
alone, with the old hashing, measured no faster.

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
matching for free; shops on uuids get the cuckoo filter.

`ordinalOf` additionally rejects **leading zeros** — `"07"` and `"7"` are
distinct context keys but the same integer. See [decisions §9](../decisions.md).

## Cuckoo wire format {#wire-format}

A wire format, frozen alongside the bucketing hash. A disagreement about
hashing or layout does not throw — it silently answers `false` for members who
*are* in the segment, which surfaces as "the flag did not turn on for that
customer" weeks later.

```
 0..3   magic "FKCF"
 4      format version (2)
 5      fingerprint bits (32)
 6      log2(bucketCount)
 7      slots per bucket (4)
 8..11  seed, uint32 LE
12..15  item count, uint32 LE
16..    fingerprint table: per bucket, four uint32 LE
```

A bucket is 16 bytes. **No semi-sorting**: it saves a bit per item and costs a
decode on every lookup. Version 1 (12- or 16-bit fingerprints, two x86_32
hashes) is refused; a segment in that format is unresolved until the SDK
receives a fresh snapshot.

| Parameter | Value | Why |
| :-- | :-- | :-- |
| hash | MurmurHash3 x86_128 over UTF-8 bytes, filter seed | One pass yields bucket and fingerprint |
| primary bucket | `h[0] & mask` | |
| fingerprint | `h[1]`, with 0 remapped to 1 | 32 bits: eps = 2b/2^32 ≈ 1.9e-9 |
| alternate bucket | `i2 = i1 XOR h(fp)`, `h(fp) = fmix32(fp ^ seed ^ 0x5bd1e995) & mask`, 0 remapped to 1 | Relocation needs only the fingerprint |
| slots per bucket | 4 | The load-factor knee. b=2 saturates near 84%, b=4 reaches ~95% |
| bucket count | `nextPow2(ceil(n / (4 * 0.8)))` | Power of two **required** — see below |
| max relocations | 500, then rebuild | At alpha <= 0.8 it is not reached |

`h[0]` and `h[1]` are the first two of the four little-endian uint32 words
MurmurHash3 x86_128 produces. `tests/evaluation/murmur3-128.test.ts` pins the
hash to 212 vectors from the C reference implementation, and
`tests/conformance/cuckoo.json` ships an encoded filter with its members and
non-members for a porting SDK to check against.

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

500,000 members cost **4 MB, 67 bits each**, because the mandatory power-of-two
bucket count puts the achieved load factor at 0.477 rather than 0.8. A segment
of 1.6 million members lands near 0.76 and about 42 bits each. Twice the 16-bit
format's size is the price of answering without a confirmation step.

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

## On the client tier

The control plane evaluates for browsers and phones with the same index, built
once per environment per snapshot version — decoding a 4 MB filter per request
would cost more than evaluating.

## Deltas

```ts
index.applyDelta(segmentKey, version, { add: [...], remove: [...] });
```

A one-row membership change ships as a few hundred bytes rather than a full
re-encode. **Version-guarded** exactly like a flag patch: a delta at or below
the held version is ignored, so duplicate broadcasts and out-of-order delivery
are non-events rather than corruption. An `add` also clears a prior exclusion,
or the member would stay pinned out. (The server does not emit deltas yet; a
membership change re-sends the whole segment in the next snapshot.)
