import { describe, expect, it } from "vitest";
import bucketingCorpus from "./bucketing.json" with { type: "json" };
import cuckooCorpus from "./cuckoo.json" with { type: "json" };
import evaluationCorpus from "./evaluation.json" with { type: "json" };
import { bucket } from "../../src/sdk/evaluation/bucketing.js";
import { CuckooFilter, buildCuckooFilter } from "../../src/sdk/evaluation/cuckoo.js";
import { evaluate } from "../../src/sdk/evaluation/evaluate.js";
import { SegmentIndex } from "../../src/sdk/evaluation/segments.js";
import type {
  CompiledSegment,
  EvaluationContext,
  Snapshot,
} from "../../src/sdk/evaluation/types.js";

/**
 * The conformance corpus IS the spec.
 *
 * `bucketing.json` is produced by `tools/gen-conformance.mjs`, an independent
 * BigInt transcription of the murmur3 specification that shares no code with
 * `src/sdk`. Agreement between the two is therefore evidence, not a
 * tautology — which is exactly what r1's corpus would have lacked.
 *
 * Every SDK in every language runs this corpus.
 */

describe("bucketing corpus", () => {
  it("carries non-ASCII keys and boundary-adjacent buckets by construction", () => {
    const values = bucketingCorpus.cases.map((c) => c.value);
    expect(values.some((v) => /[^\0-]/.test(v))).toBe(true);
    const buckets = bucketingCorpus.cases.map((c) => c.expected);
    for (const boundary of [0, 9_999, 10_000, 50_000, 99_999]) {
      expect(buckets).toContain(boundary);
    }
  });

  it.each(bucketingCorpus.cases)(
    "buckets $value under prefix $prefix to $expected",
    ({ prefix, salt, value, expected }) => {
      // The corpus stores the hash prefix directly. A numeric-looking prefix is
      // what a frozen seed produces; anything else is a flag key.
      const seed = /^\d+$/.test(prefix) ? Number(prefix) : undefined;
      const flagKey = seed === undefined ? prefix : "ignored-when-seeded";
      expect(bucket(value, flagKey, salt, seed)).toBe(expected);
    },
  );

  it("keeps NFC and NFD spellings in different buckets", () => {
    // Different byte sequences must bucket differently. Normalising in the SDK
    // would be a silent spec change that no other language's SDK would match.
    const nfc = bucketingCorpus.cases.find((c) => c.value === "é");
    const nfd = bucketingCorpus.cases.find((c) => c.value === "é");
    expect(nfc).toBeDefined();
    expect(nfd).toBeDefined();
    expect(nfc!.expected).not.toBe(nfd!.expected);
  });

  it("separates a flag-key prefix from a seed prefix", () => {
    const seeded = bucketingCorpus.cases.find((c) => c.prefix === "0" && c.value === "usr_1")!;
    const unseeded = bucketingCorpus.cases.find(
      (c) => c.prefix === "conformance-flag" && c.value === "usr_1",
    )!;
    expect(seeded.expected).not.toBe(unseeded.expected);
  });
});

/* ─────────────────────────── evaluation corpus ──────────────────────── */

/**
 * The corpus spells a segment the SDK cannot read as `kind: "unresolvable"`.
 * The runner realises it as a version-1 cuckoo filter — a format this SDK
 * refuses — which is what an old persisted snapshot would hold.
 */
function buildSegments(
  segments: Record<string, unknown>,
  context: EvaluationContext,
): SegmentIndex {
  const keys = collectKeys(context);
  const realised: Record<string, CompiledSegment> = {};
  for (const [key, raw] of Object.entries(segments)) {
    const seg = raw as { kind: string } & Record<string, unknown>;
    if (seg.kind === "unresolvable") {
      realised[key] = {
        kind: "cuckoo",
        version: seg["version"] as number,
        filter: versionOne(buildCuckooFilter(keys).filter.encode()),
        fpRate: 1.9e-9,
        loadFactor: 0.8,
      };
    } else {
      realised[key] = seg as unknown as CompiledSegment;
    }
  }
  return new SegmentIndex(realised);
}

function versionOne(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[4] = 1;
  return copy;
}

function collectKeys(context: EvaluationContext): string[] {
  const record = context as Record<string, unknown>;
  if (record["kind"] === "multi") {
    return Object.entries(record)
      .filter(([k]) => k !== "kind")
      .map(([, v]) => (v as { key: string }).key);
  }
  return [record["key"] as string];
}

describe("evaluation corpus", () => {
  it.each(evaluationCorpus.cases)("$name", (testCase) => {
    const snapshot = testCase.snapshot as unknown as Snapshot;
    const context = testCase.context as unknown as EvaluationContext;
    const expected = testCase.expected as Record<string, unknown>;

    const detail = evaluate(
      testCase.flagKey,
      context,
      snapshot,
      testCase.defaultValue as unknown,
      { segments: buildSegments(snapshot.segments ?? {}, context) },
    );

    expect(detail.value).toEqual(expected["value"]);
    expect(detail.variationIndex).toBe(expected["variationIndex"]);
    expect(detail.reason.kind).toBe(expected["reason"]);

    const reason = detail.reason as Record<string, unknown>;
    for (const field of ["ruleIndex", "ruleId", "prerequisiteKey", "error"]) {
      if (field in expected) expect(reason[field]).toBe(expected[field]);
    }
    if ("unresolvedSegments" in expected) {
      expect((detail.unresolved ?? []).map((u) => u.segmentKey)).toEqual(
        expected["unresolvedSegments"],
      );
    }
  });

  it("covers both polarities of the unresolved-segment case", () => {
    // Walks the parsed structure rather than matching serialized text: the
    // corpus is pretty-printed on disk but compact once re-stringified, so a
    // string match here silently passes by never matching anything.
    const segmentClausePolarities = (testCase: (typeof evaluationCorpus.cases)[number]) => {
      const flags = Object.values(
        (testCase.snapshot as { flags?: Record<string, unknown> }).flags ?? {},
      );
      const polarities: boolean[] = [];
      for (const flag of flags) {
        for (const rule of (flag as { rules?: unknown[] }).rules ?? []) {
          for (const clause of (rule as { clauses?: unknown[] }).clauses ?? []) {
            const c = clause as { op?: string; negate?: boolean };
            if (c.op === "segmentMatch") polarities.push(c.negate === true);
          }
        }
      }
      return polarities;
    };

    const unresolvedCases = evaluationCorpus.cases.filter(
      (c) => "unresolvedSegments" in c.expected,
    );
    const polarities = unresolvedCases.flatMap(segmentClausePolarities);
    expect(unresolvedCases.length).toBeGreaterThan(0);
    expect(polarities).toContain(true); // negated, against an unresolved segment
    expect(polarities).toContain(false); // positive, against an unresolved segment
  });
});

/* ──────────────────────────── cuckoo corpus ─────────────────────────── */

describe("cuckoo corpus - a porting SDK is verified against bytes", () => {
  const built = buildCuckooFilter(cuckooCorpus.members, {
    loadFactor: cuckooCorpus.header.targetLoadFactor,
    seed: cuckooCorpus.header.seed,
  });
  const bytes = built.filter.encode();

  it("matches the hand-specified header", () => {
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe(cuckooCorpus.header.magic);
    expect(bytes[4]).toBe(cuckooCorpus.header.formatVersion);
    expect(bytes[5]).toBe(cuckooCorpus.header.fingerprintBits);
    expect(bytes[6]).toBe(cuckooCorpus.header.expectedBucketsLog2);
    expect(bytes[7]).toBe(cuckooCorpus.header.slotsPerBucket);
    expect(bytes.byteLength).toBe(cuckooCorpus.header.expectedByteLength);
  });

  it("built without a rebuild", () => {
    expect(built.rebuilds).toBe(0);
  });

  it("finds every known member after a decode", () => {
    const decoded = CuckooFilter.decode(bytes);
    for (const member of cuckooCorpus.members) expect(decoded.contains(member)).toBe(true);
  });

  it("rejects every known non-member", () => {
    // eps ~= 1.9e-9 at 32 bits: a positive is membership, so none may slip in.
    const decoded = CuckooFilter.decode(bytes);
    expect(cuckooCorpus.nonMembers.filter((k) => decoded.contains(k))).toEqual([]);
  });

  it("decodes the corpus's own bytes, not only freshly encoded ones", () => {
    // A porting SDK has only the base64; it must find the members in it.
    const shipped = CuckooFilter.decode(new Uint8Array(Buffer.from(cuckooCorpus.filterBase64, "base64")));
    for (const member of cuckooCorpus.members) expect(shipped.contains(member)).toBe(true);
    expect(cuckooCorpus.nonMembers.filter((k) => shipped.contains(k))).toEqual([]);
  });

  it("finds non-ASCII members, which is where a byte-vs-code-unit port breaks", () => {
    const decoded = CuckooFilter.decode(bytes);
    for (const member of ["usr_josé", "日本語", "🚀"]) expect(decoded.contains(member)).toBe(true);
  });
});
