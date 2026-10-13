import { describe, expect, it } from "vitest";
import { ROARING_ORDINAL_RE, RoaringBitmap, ordinalOf } from "../../src/sdk/evaluation/roaring.js";

describe("ordinalOf - roaring eligibility", () => {
  it("accepts a non-negative integer key of up to 9 digits", () => {
    expect(ordinalOf("0")).toBe(0);
    expect(ordinalOf("42")).toBe(42);
    expect(ordinalOf("999999999")).toBe(999_999_999);
  });

  it("rejects anything the SDK could not reproduce from the key alone", () => {
    // The ordinal cannot be a lookup. Shipping a Record<string, number>
    // alongside the bitmap is a 500k-entry dictionary - 30-40 MB of V8 heap
    // once live, which is worse than the Set the bitmap was meant to replace.
    // If it cannot be computed from the key, it does not exist.
    for (const k of ["usr_7f3a91", "", "-1", "1.5", "1e3", "0x10", " 42", "42 ", "1000000000", "٤٢"]) {
      expect(ordinalOf(k)).toBeNull();
    }
  });

  it("uses the pattern the generated Postgres column uses", () => {
    // The database computes this with `context_key ~ '^[0-9]{1,9}$'`. The two
    // must agree or the compiler will pick roaring for a segment the SDK
    // cannot read.
    expect(ROARING_ORDINAL_RE.source).toBe("^[0-9]{1,9}$");
  });

  it("rejects leading zeros, which would alias two distinct keys", () => {
    // "07" and "7" are different context keys but the same integer. Treating
    // them as one would make membership depend on how the id was formatted.
    expect(ordinalOf("07")).toBeNull();
    expect(ordinalOf("00")).toBeNull();
  });
});

describe("RoaringBitmap - membership is exact", () => {
  it("contains exactly what was added", () => {
    const b = RoaringBitmap.from([1, 5, 1000, 70_000, 4_000_000_000]);
    for (const v of [1, 5, 1000, 70_000, 4_000_000_000]) expect(b.contains(v)).toBe(true);
    for (const v of [0, 2, 999, 69_999, 3_999_999_999]) expect(b.contains(v)).toBe(false);
  });

  it("has zero false positives over a dense range - the reason to prefer it", () => {
    const members = Array.from({ length: 50_000 }, (_, i) => i * 2); // evens
    const b = RoaringBitmap.from(members);
    for (let i = 0; i < 100_000; i++) expect(b.contains(i)).toBe(i % 2 === 0);
  });

  it("deduplicates and ignores insertion order", () => {
    const a = RoaringBitmap.from([5, 1, 5, 1000, 1]);
    expect(a.cardinality).toBe(3);
    expect(a.toArray()).toEqual([1, 5, 1000]);
  });

  it("removes a member", () => {
    const b = RoaringBitmap.from([1, 2, 3]);
    expect(b.remove(2)).toBe(true);
    expect(b.contains(2)).toBe(false);
    expect(b.remove(2)).toBe(false);
    expect(b.cardinality).toBe(2);
  });

  it("rejects values outside the uint32 range rather than aliasing them", () => {
    const b = new RoaringBitmap();
    expect(() => b.add(-1)).toThrow();
    expect(() => b.add(2 ** 32)).toThrow();
    expect(() => b.add(1.5)).toThrow();
  });

  it("handles an empty bitmap", () => {
    const b = new RoaringBitmap();
    expect(b.cardinality).toBe(0);
    expect(b.contains(0)).toBe(false);
    expect(b.toArray()).toEqual([]);
  });
});

describe("RoaringBitmap - container promotion", () => {
  it("promotes an array container to a bitmap past 4096 entries", () => {
    const b = RoaringBitmap.from(Array.from({ length: 5_000 }, (_, i) => i * 3));
    expect(b.containerTypes()).toEqual(["bitmap"]);
    expect(b.cardinality).toBe(5_000);
    for (let i = 0; i < 5_000; i++) expect(b.contains(i * 3)).toBe(true);
  });

  it("keeps a small container as an array", () => {
    const b = RoaringBitmap.from([1, 2, 3]);
    expect(b.containerTypes()).toEqual(["array"]);
  });

  it("spans multiple containers across the 2^16 boundary", () => {
    const b = RoaringBitmap.from([0, 65_535, 65_536, 131_072]);
    expect(b.containerTypes().length).toBe(3);
    expect(b.contains(65_535)).toBe(true);
    expect(b.contains(65_536)).toBe(true);
  });
});

describe("RoaringBitmap - portable serialization format", () => {
  const roundTrip = (values: number[]) => {
    const bytes = RoaringBitmap.from(values).serialize();
    const back = RoaringBitmap.deserialize(bytes);
    expect(back.toArray()).toEqual([...new Set(values)].sort((x, y) => x - y));
    return bytes;
  };

  it("round-trips an empty bitmap", () => roundTrip([]));
  it("round-trips a sparse array container", () => roundTrip([1, 7, 9999]));
  it("round-trips a dense bitmap container", () =>
    roundTrip(Array.from({ length: 20_000 }, (_, i) => i * 3)));
  it("round-trips a run-compressible container", () =>
    roundTrip(Array.from({ length: 30_000 }, (_, i) => i)));
  it("round-trips containers spanning many high keys", () =>
    roundTrip(Array.from({ length: 5_000 }, (_, i) => i * 100_000)));
  it("round-trips a mix of array, bitmap and run containers", () =>
    roundTrip([
      ...Array.from({ length: 10 }, (_, i) => i), // run/array
      ...Array.from({ length: 20_000 }, (_, i) => 65_536 + i * 3), // bitmap
      ...Array.from({ length: 30_000 }, (_, i) => 262_144 + i), // run
    ]));

  it("writes the official cookie so other languages' roaring libraries can read it", () => {
    const bytes = RoaringBitmap.from([1, 2, 3]).serialize();
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const cookie = view.getUint32(0, true);
    // Either SERIAL_COOKIE_NO_RUNCONTAINER (12346) or SERIAL_COOKIE (12347)
    // in its low 16 bits, per the Roaring portable spec.
    expect(cookie === 12_346 || (cookie & 0xffff) === 12_347).toBe(true);
  });

  it("produces identical bytes for the same member set", () => {
    // A frozen wire format must be reproducible: the compiler re-encoding an
    // unchanged segment must not produce a new version.
    const values = Array.from({ length: 10_000 }, (_, i) => i * 7);
    expect(RoaringBitmap.from(values).serialize()).toEqual(
      RoaringBitmap.from([...values].reverse()).serialize(),
    );
  });

  it("run-compresses clustered ids far below a probabilistic filter", () => {
    // Sequential primary keys are clustered by construction, which is exactly
    // when roaring beats cuckoo - and it is exact as well as smaller.
    const bytes = RoaringBitmap.from(Array.from({ length: 500_000 }, (_, i) => i)).serialize();
    expect(bytes.byteLength).toBeLessThan(100_000);
  });

  it("stays compact for 500k clustered-but-gappy ids", () => {
    const bytes = RoaringBitmap.from(Array.from({ length: 500_000 }, (_, i) => i * 2)).serialize();
    // Still far below the ~1.25 MB a cuckoo filter costs at the same size.
    expect(bytes.byteLength).toBeLessThan(200_000);
  });

  it("rejects a truncated or foreign payload", () => {
    const good = RoaringBitmap.from([1, 2, 3]).serialize();
    expect(() => RoaringBitmap.deserialize(good.slice(0, 3))).toThrow();
    const badCookie = good.slice();
    new DataView(badCookie.buffer).setUint32(0, 999, true);
    expect(() => RoaringBitmap.deserialize(badCookie)).toThrow(/cookie/i);
  });
});
