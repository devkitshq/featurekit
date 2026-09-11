"""Run the conformance corpus against the Python implementation.

This is the test the review's "cross-language determinism" claim actually needs.
Exits non-zero on any mismatch, so CI treats a divergence as a build failure
rather than a note.

    python conformance/python/run.py
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from featurekit import (  # noqa: E402
    CuckooFilter,
    HASH_SPACE,
    SegmentIndex,
    WEIGHT_SCALE,
    bucket,
    bucket_from_hash,
    evaluate,
    load_corpus,
    murmur3_utf8,
)

CORPUS = Path(__file__).resolve().parents[2] / "tests" / "conformance"

failures: list[str] = []
checks = 0


def check(name: str, actual: object, expected: object) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{name}\n    expected: {expected!r}\n    actual:   {actual!r}")


# ─────────────────────────── bucketing.json ────────────────────────────────

bucketing = load_corpus(str(CORPUS / "bucketing.json"))
check("bucketing: weightScale", WEIGHT_SCALE, bucketing["weightScale"])
check("bucketing: hashSpace", HASH_SPACE, bucketing["hashSpace"])

for case in bucketing["cases"]:
    label = f"bucketing: {case['prefix']}/{case['salt']}/{case['value']!r}"
    # The corpus prefix is the flag key unless the case pins a seed.
    if "seed" in case and case["seed"] is not None:
        actual = bucket(case["value"], "unused-flag-key", case["salt"], case["seed"])
    else:
        actual = bucket(case["value"], case["prefix"], case["salt"])
    check(label, actual, case["expected"])

for case in bucketing.get("hashCases", []):
    check(f"murmur3({case['input']!r})", murmur3_utf8(case["input"]), case["expected"])

for case in bucketing.get("edgeCases", []):
    check(f"bucketFromHash({case['raw']})", bucket_from_hash(case["raw"]), case["expected"])


# ────────────────────────── evaluation.json ────────────────────────────────

evaluation = load_corpus(str(CORPUS / "evaluation.json"))

for case in evaluation["cases"]:
    detail = evaluate(
        case["flagKey"],
        case["context"],
        case["snapshot"],
        case["defaultValue"],
        SegmentIndex(case["snapshot"].get("segments") or {}),
    )
    expected = case["expected"]
    label = f"evaluation: {case['name']}"

    check(f"{label} [value]", detail.value, expected["value"])
    check(f"{label} [variationIndex]", detail.variation_index, expected["variationIndex"])
    check(f"{label} [reason]", detail.reason.get("kind"), expected["reason"])
    if "ruleIndex" in expected:
        check(f"{label} [ruleIndex]", detail.reason.get("ruleIndex"), expected["ruleIndex"])
    if "error" in expected:
        check(f"{label} [error]", detail.reason.get("error"), expected["error"])


# ──────────────────────────── cuckoo.json ──────────────────────────────────

cuckoo = load_corpus(str(CORPUS / "cuckoo.json"))
header = cuckoo["header"]
encoded = cuckoo.get("filterBase64") or cuckoo.get("encodedBase64") or cuckoo.get("bytesBase64")

if encoded is None:
    print("cuckoo: corpus carries no encoded filter; skipping wire-format checks")
else:
    data = base64.b64decode(encoded)
    check("cuckoo: byte length", len(data), header["expectedByteLength"])

    filt = CuckooFilter(data)
    check("cuckoo: formatVersion", filt.format_version, header["formatVersion"])
    check("cuckoo: fingerprintBits", filt.fingerprint_bits, header["fingerprintBits"])
    check("cuckoo: slotsPerBucket", filt.slots_per_bucket, header["slotsPerBucket"])
    check("cuckoo: bucketsLog2", filt.buckets_log2, header["expectedBucketsLog2"])

    # Every member must be found: a false negative is a wrong flag value.
    missing = [m for m in cuckoo["members"] if not filt.contains(m)]
    check("cuckoo: every member is found", missing[:5], [])

    # Non-members may false-positive, but not at a silly rate.
    non_members = cuckoo.get("nonMembers") or [f"absent_{i}" for i in range(2_000)]
    false_positives = sum(1 for key in non_members if filt.contains(key))
    rate = false_positives / max(len(non_members), 1)
    if rate > 0.01:
        failures.append(f"cuckoo: false positive rate {rate:.4f} exceeds 1%")
    checks += 1


# ─────────────────────────────── report ────────────────────────────────────

print(f"featurekit conformance (python): {checks} checks")
if failures:
    print(f"\n{len(failures)} FAILED:\n")
    for failure in failures:
        print(f"  - {failure}")
    print(
        "\nA divergence here means the wire format or the evaluation semantics are "
        "not portable. That is a specification bug or an implementation bug — it is "
        "never 'just the Python'."
    )
    sys.exit(1)

print("all checks passed: the corpus is reproducible in a second language")
