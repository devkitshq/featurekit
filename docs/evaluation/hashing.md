# The hash

`src/sdk/evaluation/murmur3.ts` · §9.3, §9.4

**MurmurHash3 x86_32, over UTF-8 bytes.** Frozen.

## Why it is frozen

This is a wire format, not an implementation detail. Changing it re-buckets
every context in every percentage rollout in every environment simultaneously.
It is the one decision that cannot be revised after v1 without a coordinated
flag-by-flag migration.

## Why not a cryptographic hash

Revision 1 specified `parseInt(sha1(...).slice(0, 15), 16) / 0xFFFFFFFFFFFFFFF`.
Two defects, both measured (§9.4): 96.5% of hashes silently rounded past
`Number.MAX_SAFE_INTEGER`, which would have baked JS float artifacts into the
conformance corpus and failed a *correctly* implemented Go SDK; and it cost
~2,500 ns/op against a document promising millions per second.

SHA-1 was never doing security work here. This is a uniformity function.

## Bytes, not code units

```ts
murmur3Utf8("é")  ===  murmur3Bytes(new Uint8Array([0xc3, 0xa9]))   // UTF-8
murmur3Utf8("é")  !==  murmur3Bytes(new Uint8Array([0xe9]))          // UTF-16 unit
```

`String.charCodeAt` yields UTF-16 code units. An implementation built on it
hashes `"usr_josé"` as `[…,115,233]` while every language reading UTF-8 hashes
`[…,115,195,169]`. Context keys are routinely non-ASCII — emails, names,
unicode ids — so that silently splits such a user across SDKs at a rollout
boundary. `tests/evaluation/murmur3.test.ts` asserts the byte spelling directly.

**No Unicode normalisation.** NFC `"é"` and NFD `"é"` are different byte
sequences and bucket differently. Normalising in the SDK would be a silent spec
change no other language's SDK would match; the corpus pins both.

## The ASCII fast path

`murmur3Utf8` scans for a code unit ≥ 0x80. If there is none, it hashes
`charCodeAt` values directly, because for ASCII the code units *are* the UTF-8
bytes. Otherwise it falls back to `TextEncoder`.

It is an **optimisation, never a second specification**: the test asserts the
two paths agree over every ASCII code point, over every length residue, and on
strings that stay ASCII until their final character.

Measured: 74 ns for the ASCII path against 709 ns for the `TextEncoder`
fallback on an equivalent string — a ~10× gap, which is why the scan is worth it.

## Reference vectors

The test carries 16 published `MurmurHash3_x86_32` vectors from the canonical
Austin Appleby implementation, including empty input under three seeds and the
four length residues. These were **not** captured from this codebase — that is
the point of them.

## Porting notes

- 32-bit multiply must wrap. JS uses `Math.imul`; a float multiply loses the low bits.
- The tail is written as an explicit `if` chain rather than the reference's
  fallthrough `switch`. An accidental `break` in that form is a silent hash change.
- `fmix32` and the block mixer are shared between both input paths so they
  cannot drift.
