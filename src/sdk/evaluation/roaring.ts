/**
 * Roaring bitmaps — the exact large-segment structure, used only where the
 * context key is integral on its own (§7.6, §9.7).
 *
 * Where eligible this is strictly better than a cuckoo filter: exact matching,
 * so the confirmation step is unnecessary and the unresolved state cannot
 * arise at all; and run-length compression that beats a probabilistic filter
 * whenever ids are clustered, which sequential primary keys are by
 * construction.
 *
 * **The ordinal cannot be a lookup.** A roaring bitmap answers `contains(int)`
 * while the evaluator holds `"usr_7f3a91"`. Shipping a `Record<string, number>`
 * to bridge that is a 500,000-entry dictionary — 30–40 MB of V8 heap once it is
 * a live `Map`, worse than the `Set` the bitmap was meant to replace. So
 * roaring is available only when the ordinal *is* the key. Shops on numeric
 * primary keys get exact matching for free; shops on uuids do not.
 *
 * Serialisation is the **official Roaring portable format**, so a future Go,
 * Java or Python SDK reads it with an off-the-shelf library rather than a
 * bespoke port.
 *
 * Set operations (AND/OR/ANDNOT) are compiler-side work and land with the
 * snapshot compiler in M2; the SDK only ever reads.
 *
 * @see docs/evaluation/segments.md
 */

/** Must agree with the generated Postgres column: `context_key ~ '^[0-9]{1,9}$'`. */
export const ROARING_ORDINAL_RE = /^[0-9]{1,9}$/;

/**
 * The ordinal for a context key, or `null` if the key is not integral.
 *
 * Leading zeros are rejected: `"07"` and `"7"` are distinct context keys, and
 * collapsing them to one integer would make membership depend on how an id
 * happened to be formatted.
 */
export function ordinalOf(key: string): number | null {
  if (!ROARING_ORDINAL_RE.test(key)) return null;
  if (key.length > 1 && key.charCodeAt(0) === 48 /* '0' */) return null;
  return Number(key);
}

/* ───────────────────────────── containers ───────────────────────────── */

const ARRAY_MAX = 4096;
const BITMAP_WORDS = 2048; // 65536 bits / 32
const SERIAL_COOKIE_NO_RUNCONTAINER = 12_346;
const SERIAL_COOKIE = 12_347;
const NO_OFFSET_THRESHOLD = 4;

type Container =
  | { type: "array"; values: number[] }
  | { type: "bitmap"; words: Uint32Array; cardinality: number }
  | { type: "run"; runs: number[] }; // flat [start, lengthMinusOne, ...]

function arrayContains(values: number[], v: number): boolean {
  let lo = 0;
  let hi = values.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const x = values[mid]!;
    if (x === v) return true;
    if (x < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function containerCardinality(c: Container): number {
  if (c.type === "array") return c.values.length;
  if (c.type === "bitmap") return c.cardinality;
  let n = 0;
  for (let i = 0; i < c.runs.length; i += 2) n += c.runs[i + 1]! + 1;
  return n;
}

function containerContains(c: Container, low: number): boolean {
  if (c.type === "array") return arrayContains(c.values, low);
  if (c.type === "bitmap") return (c.words[low >>> 5]! & (1 << (low & 31))) !== 0;
  for (let i = 0; i < c.runs.length; i += 2) {
    const start = c.runs[i]!;
    if (low < start) return false;
    if (low <= start + c.runs[i + 1]!) return true;
  }
  return false;
}

function toBitmap(c: Container): Container & { type: "bitmap" } {
  if (c.type === "bitmap") return c;
  const words = new Uint32Array(BITMAP_WORDS);
  let cardinality = 0;
  const set = (v: number) => {
    const w = v >>> 5;
    const bit = 1 << (v & 31);
    if ((words[w]! & bit) === 0) {
      words[w] = words[w]! | bit;
      cardinality++;
    }
  };
  if (c.type === "array") for (const v of c.values) set(v);
  else for (let i = 0; i < c.runs.length; i += 2) {
    const start = c.runs[i]!;
    for (let k = 0; k <= c.runs[i + 1]!; k++) set(start + k);
  }
  return { type: "bitmap", words, cardinality };
}

/** Every value in a container, ascending. */
function containerValues(c: Container): number[] {
  if (c.type === "array") return c.values.slice();
  if (c.type === "run") {
    const out: number[] = [];
    for (let i = 0; i < c.runs.length; i += 2) {
      const start = c.runs[i]!;
      for (let k = 0; k <= c.runs[i + 1]!; k++) out.push(start + k);
    }
    return out;
  }
  const out: number[] = [];
  for (let w = 0; w < BITMAP_WORDS; w++) {
    let word = c.words[w]!;
    while (word !== 0) {
      const bit = word & -word;
      out.push((w << 5) + 31 - Math.clz32(bit));
      word ^= bit;
    }
  }
  return out;
}

/** Encode a container's values as runs, for the size comparison at write time. */
function toRuns(values: number[]): number[] {
  const runs: number[] = [];
  let i = 0;
  while (i < values.length) {
    const start = values[i]!;
    let end = start;
    while (i + 1 < values.length && values[i + 1] === end + 1) {
      end++;
      i++;
    }
    runs.push(start, end - start);
    i++;
  }
  return runs;
}

/* ───────────────────────────── the bitmap ───────────────────────────── */

export class RoaringBitmap {
  /** High 16 bits of each container, ascending. Parallel to `containers`. */
  private keys: number[] = [];
  private containers: Container[] = [];

  static from(values: Iterable<number>): RoaringBitmap {
    const b = new RoaringBitmap();
    for (const v of values) b.add(v);
    return b;
  }

  private indexOfKey(high: number): number {
    let lo = 0;
    let hi = this.keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = this.keys[mid]!;
      if (k === high) return mid;
      if (k < high) lo = mid + 1;
      else hi = mid - 1;
    }
    return ~lo; // insertion point, bitwise-complemented
  }

  add(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`roaring: ${value} is not a uint32`);
    }
    const high = value >>> 16;
    const low = value & 0xffff;
    let idx = this.indexOfKey(high);
    if (idx < 0) {
      idx = ~idx;
      this.keys.splice(idx, 0, high);
      this.containers.splice(idx, 0, { type: "array", values: [] });
    }

    const c = this.containers[idx]!;
    if (c.type === "array") {
      if (arrayContains(c.values, low)) return;
      // Keep sorted on insert: containers are written ascending, and a sort at
      // serialize time would make the byte output depend on insertion order.
      let pos = c.values.length;
      while (pos > 0 && c.values[pos - 1]! > low) pos--;
      c.values.splice(pos, 0, low);
      if (c.values.length > ARRAY_MAX) this.containers[idx] = toBitmap(c);
      return;
    }
    if (c.type === "bitmap") {
      const w = low >>> 5;
      const bit = 1 << (low & 31);
      if ((c.words[w]! & bit) === 0) {
        c.words[w] = c.words[w]! | bit;
        c.cardinality++;
      }
      return;
    }
    // A run container only exists after a deserialize; convert to add.
    const promoted: Container = { type: "array", values: containerValues(c) };
    this.containers[idx] = promoted;
    this.add(value);
  }

  remove(value: number): boolean {
    const high = value >>> 16;
    const low = value & 0xffff;
    const idx = this.indexOfKey(high);
    if (idx < 0) return false;
    const c = this.containers[idx]!;

    if (c.type === "run") {
      this.containers[idx] = { type: "array", values: containerValues(c) };
      return this.remove(value);
    }
    if (c.type === "array") {
      const at = c.values.indexOf(low);
      if (at < 0) return false;
      c.values.splice(at, 1);
    } else {
      const w = low >>> 5;
      const bit = 1 << (low & 31);
      if ((c.words[w]! & bit) === 0) return false;
      c.words[w] = c.words[w]! & ~bit;
      c.cardinality--;
    }
    if (containerCardinality(this.containers[idx]!) === 0) {
      this.keys.splice(idx, 1);
      this.containers.splice(idx, 1);
    }
    return true;
  }

  contains(value: number): boolean {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
    const idx = this.indexOfKey(value >>> 16);
    return idx >= 0 && containerContains(this.containers[idx]!, value & 0xffff);
  }

  get cardinality(): number {
    let n = 0;
    for (const c of this.containers) n += containerCardinality(c);
    return n;
  }

  toArray(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.keys.length; i++) {
      const base = this.keys[i]! * 0x10000;
      for (const low of containerValues(this.containers[i]!)) out.push(base + low);
    }
    return out;
  }

  /** Diagnostic: what each container is currently stored as. */
  containerTypes(): string[] {
    return this.containers.map((c) => c.type);
  }

  /* ────────────────────── portable serialization ────────────────────── */

  /**
   * Serialise in the official Roaring portable format.
   *
   * Every container is run-optimised first when runs are strictly smaller, so
   * the output is a deterministic function of the member set — the compiler
   * re-encoding an unchanged segment must not produce different bytes and
   * therefore a spurious new version.
   */
  serialize(): Uint8Array {
    const n = this.containers.length;
    const encoded = this.containers.map((c) => {
      const values = containerValues(c);
      const cardinality = values.length;
      const runs = toRuns(values);
      const runBytes = 2 + runs.length * 2;
      const arrayBytes = cardinality * 2;
      const bitmapBytes = BITMAP_WORDS * 4;
      const plainBytes = cardinality > ARRAY_MAX ? bitmapBytes : arrayBytes;
      return runBytes < plainBytes
        ? ({ kind: "run", runs, cardinality, bytes: runBytes } as const)
        : cardinality > ARRAY_MAX
          ? ({ kind: "bitmap", values, cardinality, bytes: bitmapBytes } as const)
          : ({ kind: "array", values, cardinality, bytes: arrayBytes } as const);
    });

    const hasRun = encoded.some((e) => e.kind === "run");
    let headerBytes = 4; // cookie
    if (hasRun) headerBytes += Math.ceil(n / 8);
    else headerBytes += 4; // container count follows the plain cookie
    headerBytes += n * 4; // descriptive header: (key, cardinality-1) per container
    const withOffsets = !hasRun || n >= NO_OFFSET_THRESHOLD;
    if (withOffsets) headerBytes += n * 4;

    const total = headerBytes + encoded.reduce((s, e) => s + e.bytes, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let o = 0;

    if (hasRun) {
      view.setUint32(o, SERIAL_COOKIE | ((n - 1) << 16), true);
      o += 4;
      const flagBytes = Math.ceil(n / 8);
      for (let i = 0; i < n; i++) {
        if (encoded[i]!.kind === "run") {
          const at = o + (i >>> 3);
          out[at] = out[at]! | (1 << (i & 7));
        }
      }
      o += flagBytes;
    } else {
      view.setUint32(o, SERIAL_COOKIE_NO_RUNCONTAINER, true);
      view.setUint32(o + 4, n, true);
      o += 8;
    }

    for (let i = 0; i < n; i++) {
      view.setUint16(o, this.keys[i]!, true);
      view.setUint16(o + 2, encoded[i]!.cardinality - 1, true);
      o += 4;
    }

    let dataOffset = headerBytes;
    if (withOffsets) {
      for (const e of encoded) {
        view.setUint32(o, dataOffset, true);
        o += 4;
        dataOffset += e.bytes;
      }
    }

    for (const e of encoded) {
      if (e.kind === "array") {
        for (const v of e.values) {
          view.setUint16(o, v, true);
          o += 2;
        }
      } else if (e.kind === "run") {
        view.setUint16(o, e.runs.length / 2, true);
        o += 2;
        for (let i = 0; i < e.runs.length; i += 2) {
          view.setUint16(o, e.runs[i]!, true);
          view.setUint16(o + 2, e.runs[i + 1]!, true);
          o += 4;
        }
      } else {
        const words = new Uint32Array(BITMAP_WORDS);
        for (const v of e.values) words[v >>> 5] = words[v >>> 5]! | (1 << (v & 31));
        for (let w = 0; w < BITMAP_WORDS; w++) {
          view.setUint32(o, words[w]!, true);
          o += 4;
        }
      }
    }
    return out;
  }

  static deserialize(bytes: Uint8Array): RoaringBitmap {
    if (bytes.length < 8) throw new Error("roaring: truncated payload");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cookie = view.getUint32(0, true);
    let o = 4;
    let n: number;
    let runFlags: Uint8Array | null = null;

    if (cookie === SERIAL_COOKIE_NO_RUNCONTAINER) {
      n = view.getUint32(o, true);
      o += 4;
    } else if ((cookie & 0xffff) === SERIAL_COOKIE) {
      n = (cookie >>> 16) + 1;
      const flagBytes = Math.ceil(n / 8);
      runFlags = bytes.subarray(o, o + flagBytes);
      o += flagBytes;
    } else {
      throw new Error(`roaring: unrecognised cookie ${cookie}`);
    }

    const keys: number[] = [];
    const cards: number[] = [];
    for (let i = 0; i < n; i++) {
      keys.push(view.getUint16(o, true));
      cards.push(view.getUint16(o + 2, true) + 1);
      o += 4;
    }
    // Offsets are present for the plain cookie, and for the run cookie only
    // above the threshold. Skipped rather than used: containers are read in
    // order, so the offsets are redundant for a sequential reader.
    if (runFlags === null || n >= NO_OFFSET_THRESHOLD) o += n * 4;

    const b = new RoaringBitmap();
    for (let i = 0; i < n; i++) {
      const isRun = runFlags !== null && (runFlags[i >>> 3]! & (1 << (i & 7))) !== 0;
      const cardinality = cards[i]!;
      let container: Container;
      if (isRun) {
        const nRuns = view.getUint16(o, true);
        o += 2;
        const runs: number[] = [];
        for (let r = 0; r < nRuns; r++) {
          runs.push(view.getUint16(o, true), view.getUint16(o + 2, true));
          o += 4;
        }
        container = { type: "run", runs };
      } else if (cardinality > ARRAY_MAX) {
        const words = new Uint32Array(BITMAP_WORDS);
        for (let w = 0; w < BITMAP_WORDS; w++) {
          words[w] = view.getUint32(o, true);
          o += 4;
        }
        container = { type: "bitmap", words, cardinality };
      } else {
        const values: number[] = [];
        for (let k = 0; k < cardinality; k++) {
          values.push(view.getUint16(o, true));
          o += 2;
        }
        container = { type: "array", values };
      }
      b.keys.push(keys[i]!);
      b.containers.push(container);
    }
    return b;
  }
}
