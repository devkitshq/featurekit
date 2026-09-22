"""A second implementation of the togglekit evaluation core, in Python.

Its only purpose is to answer a question the TypeScript SDK cannot answer about
itself: **is the wire format and the evaluation semantics actually portable?**

Until this existed, "cross-language determinism" was a design claim with a
corpus and exactly one consumer. A corpus that only its own author reads proves
nothing about a future Go or Java SDK — it proves the implementation agrees with
itself, which was never in doubt.

So this is written from `docs/` and the conformance corpus, deliberately in the
idiom of the target language rather than as a transliteration of the TypeScript:

* integers are Python ints, not `Math.imul` emulation, so a wrong assumption
  about 32-bit wraparound shows up as a mismatch rather than being inherited;
* UTF-8 encoding is `str.encode`, not a hand-rolled encoder;
* the cuckoo filter is decoded from the frozen bytes in `cuckoo.json`, which is
  the actual test of the wire format — a porting SDK has to read *those* bytes
  and find *those* members.

Run `python conformance/python/run.py` to check it against the corpus. It has no
third-party dependencies and needs no build step, which is the point: a porting
author should be able to read one file.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

U32 = 0xFFFFFFFF

WEIGHT_SCALE = 100_000
HASH_SPACE = 2**32


# ───────────────────────────── murmur3 x86_32 ─────────────────────────────


def _rotl32(x: int, r: int) -> int:
    return ((x << r) | (x >> (32 - r))) & U32


def murmur3_bytes(data: bytes, seed: int = 0) -> int:
    """MurmurHash3 x86_32 over raw bytes."""
    h1 = seed & U32
    c1 = 0xCC9E2D51
    c2 = 0x1B873593

    block_count = len(data) // 4
    for i in range(block_count):
        k1 = int.from_bytes(data[i * 4 : i * 4 + 4], "little")
        k1 = (k1 * c1) & U32
        k1 = _rotl32(k1, 15)
        k1 = (k1 * c2) & U32
        h1 ^= k1
        h1 = _rotl32(h1, 13)
        h1 = (h1 * 5 + 0xE6546B64) & U32

    tail = data[block_count * 4 :]
    k1 = 0
    if len(tail) >= 3:
        k1 ^= tail[2] << 16
    if len(tail) >= 2:
        k1 ^= tail[1] << 8
    if len(tail) >= 1:
        k1 ^= tail[0]
        k1 = (k1 * c1) & U32
        k1 = _rotl32(k1, 15)
        k1 = (k1 * c2) & U32
        h1 ^= k1

    h1 ^= len(data)
    h1 ^= h1 >> 16
    h1 = (h1 * 0x85EBCA6B) & U32
    h1 ^= h1 >> 13
    h1 = (h1 * 0xC2B2AE35) & U32
    h1 ^= h1 >> 16
    return h1


def murmur3_utf8(value: str, seed: int = 0) -> int:
    """MurmurHash3 x86_32 over the UTF-8 bytes of `value`.

    The hash is frozen: changing it re-buckets every percentage rollout in every
    environment, silently. `tests/evaluation/bucketing-immutability.test.ts` is
    the TypeScript guard; this is the independent check that the algorithm is
    what the specification says rather than what one implementation does.
    """
    return murmur3_bytes(value.encode("utf-8"), seed)


# ────────────────────────────── bucketing ─────────────────────────────────


def bucket_from_hash(raw: int) -> int:
    """Map a uint32 onto `[0, 99999]` with exact integer arithmetic.

    The largest intermediate is `(2^32 - 1) * 100000`, about 4.29e14 — inside
    int64, which is why a Go or Java port needs no big integers and no floats.
    Python would survive either way, so the point here is to demonstrate the
    bound rather than to need it.
    """
    return (raw * WEIGHT_SCALE) // HASH_SPACE


def bucket(context_value: str, flag_key: str, salt: str, seed: int | None = None) -> int:
    """Hash `${prefix}.${salt}.${value}` and map it into the weight space.

    `prefix` is the rollout's frozen seed when it has one and the flag key
    otherwise. Note `seed is not None`: seed 0 is a real seed, and treating it as
    absent would re-randomise a running experiment.
    """
    prefix = str(seed) if seed is not None else flag_key
    return bucket_from_hash(murmur3_utf8(f"{prefix}.{salt}.{context_value}"))


def resolve_rollout(
    rollout: dict[str, Any],
    context: "NormalizedContext",
    flag_key: str,
    salt: str,
) -> int | None:
    """Assign a context to a rollout variation, or `None` if it cannot be placed."""
    value = context.bucket_value(rollout.get("contextKind", "user"), rollout.get("bucketBy", "key"))
    if value is None:
        return None

    b = bucket(value, flag_key, salt, rollout.get("seed"))
    cursor = 0
    for variation in rollout.get("variations", []):
        cursor += int(variation.get("weight", 0))
        # `b < cursor`, so a boundary bucket belongs to the LATER variation.
        if b < cursor:
            return int(variation["variationIndex"])
    return None


# ───────────────────────────── context ────────────────────────────────────


@dataclass
class NormalizedContext:
    """Attributes per context kind, with the key hoisted out."""

    kinds: dict[str, dict[str, Any]] = field(default_factory=dict)

    @staticmethod
    def normalize(context: Any) -> "NormalizedContext | None":
        """Accept both context shapes, or reject the context entirely.

        A key must be a non-blank string: it is hashed, indexed and displayed.
        `None` here means the evaluator returns the caller's default.
        """
        if not isinstance(context, dict):
            return None

        out: dict[str, dict[str, Any]] = {}
        if context.get("kind") == "multi":
            for kind, value in context.items():
                if kind == "kind":
                    continue
                if not isinstance(value, dict):
                    return None
                key = value.get("key")
                if not isinstance(key, str) or key.strip() == "":
                    return None
                out[kind] = value
            return NormalizedContext(out) if out else None

        key = context.get("key")
        if not isinstance(key, str) or key.strip() == "":
            return None
        out["user"] = context
        return NormalizedContext(out)

    def get_attribute(self, kind: str, attribute: str) -> Any:
        attrs = self.kinds.get(kind)
        if attrs is None:
            return None
        if attribute == "key":
            return attrs.get("key")
        # Dotted paths address nested attributes: `address.tier`.
        current: Any = attrs
        for part in attribute.split("."):
            if not isinstance(current, dict) or part not in current:
                return None
            current = current[part]
        return current

    def key_of(self, kind: str) -> str | None:
        attrs = self.kinds.get(kind)
        return attrs.get("key") if attrs else None

    def bucket_value(self, kind: str, bucket_by: str) -> str | None:
        value = self.get_attribute(kind, bucket_by)
        if isinstance(value, str):
            return value
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
        return None


# ───────────────────────────── operators ──────────────────────────────────


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    return None


def _parse_semver(value: Any) -> tuple[int, int, int, str | None] | None:
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?(?:\+[0-9A-Za-z.\-]+)?", value)
    if match is None:
        return None
    return (int(match[1]), int(match[2]), int(match[3]), match[4])


def _compare_semver(a: tuple[int, int, int, str | None], b: tuple[int, int, int, str | None]) -> int:
    for i in range(3):
        if a[i] != b[i]:
            return -1 if a[i] < b[i] else 1
    # A prerelease version precedes its release.
    if a[3] is None and b[3] is None:
        return 0
    if a[3] is None:
        return 1
    if b[3] is None:
        return -1
    for x, y in zip(a[3].split("."), b[3].split(".")):
        if x == y:
            continue
        xn, yn = x.isdigit(), y.isdigit()
        if xn and yn:
            return -1 if int(x) < int(y) else 1
        if xn != yn:
            return -1 if xn else 1
        return -1 if x < y else 1
    return -1 if len(a[3].split(".")) < len(b[3].split(".")) else 0


def _match_one(op: str, attr: Any, value: Any) -> bool:
    if op == "in":
        return attr == value
    if op in ("startsWith", "endsWith", "contains"):
        if not isinstance(attr, str) or not isinstance(value, str):
            return False
        return {
            "startsWith": attr.startswith,
            "endsWith": attr.endswith,
            "contains": lambda v: v in attr,
        }[op](value)
    if op == "matches":
        if not isinstance(attr, str) or not isinstance(value, str):
            return False
        try:
            return re.search(value, attr) is not None
        except re.error:
            return False
    if op in ("lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual"):
        a, b = _as_number(attr), _as_number(value)
        if a is None or b is None:
            return False
        return {
            "lessThan": a < b,
            "lessThanOrEqual": a <= b,
            "greaterThan": a > b,
            "greaterThanOrEqual": a >= b,
        }[op]
    if op.startswith("semVer"):
        a, b = _parse_semver(attr), _parse_semver(value)
        if a is None or b is None:
            return False
        cmp = _compare_semver(a, b)
        return {"semVerEqual": cmp == 0, "semVerLessThan": cmp < 0, "semVerGreaterThan": cmp > 0}.get(
            op, False
        )
    return False


def apply_operator(op: str, attr: Any, values: Iterable[Any]) -> bool:
    """A multi-valued attribute matches if ANY element matches ANY value."""
    candidates = attr if isinstance(attr, list) else [attr]
    for candidate in candidates:
        for value in values:
            if _match_one(op, candidate, value):
                return True
    return False


# ───────────────────────────── cuckoo filter ──────────────────────────────


class CuckooFilter:
    """Decoder for the frozen `TKCF` wire format (§9.7).

    Only membership is implemented — a porting SDK reads filters, it does not
    build them. This is the part of the corpus that tests the *format* rather
    than the semantics: these exact bytes must yield these exact answers.

    **The header layout, since a porting author needs it in one place:**

    | Offset | Size | Field |
    | --: | --: | :-- |
    | 0 | 4 | magic, ASCII `TKCF` |
    | 4 | 1 | format version (1) |
    | 5 | 1 | fingerprint bits (12 or 16) |
    | 6 | 1 | log2 of the bucket count |
    | 7 | 1 | slots per bucket (4) |
    | 8 | 4 | seed, little-endian uint32 |
    | 12 | 4 | member count, little-endian uint32 |
    | 16 | .. | table: `bucketCount` buckets of 4 slots |

    At 16-bit fingerprints a bucket is 8 bytes, four little-endian uint16s. At
    12 bits it is 6 bytes of nibble-packed fields. Zero means an empty slot,
    which is why a computed fingerprint of zero is remapped to 1.

    Writing this decoder from the documentation is what found that the field
    order was undocumented: the first attempt put slots-per-bucket where the
    bucket count belongs, and every lookup missed.
    """

    # Seed offsets, fixed by the format.
    FINGERPRINT_SEED_XOR = 0x9747B28C
    ALT_SEED_XOR = 0x5BD1E995

    def __init__(self, data: bytes) -> None:
        if len(data) < 16 or data[0:4] != b"TKCF":
            raise ValueError("not a togglekit cuckoo filter")
        self.format_version = data[4]
        self.fingerprint_bits = data[5]
        self.buckets_log2 = data[6]
        self.slots_per_bucket = data[7]
        self.seed = int.from_bytes(data[8:12], "little")
        self.count = int.from_bytes(data[12:16], "little")
        self.table = data[16:]
        self.bucket_count = 1 << self.buckets_log2
        self.mask = self.bucket_count - 1
        self.fp_mask = (1 << self.fingerprint_bits) - 1

    def fingerprint_of(self, key: str) -> int:
        fingerprint = murmur3_utf8(key, self.seed ^ self.FINGERPRINT_SEED_XOR) & self.fp_mask
        # Zero is the empty-slot sentinel, so it is never a valid fingerprint.
        return fingerprint if fingerprint != 0 else 1

    def index_of(self, key: str) -> int:
        return murmur3_utf8(key, self.seed) & self.mask

    def alt_index(self, index: int, fingerprint: int) -> int:
        """`i XOR h(fingerprint)`, masked — partial-key hashing.

        `h(fp)` is forced non-zero: at zero the alternate bucket equals the
        primary and the item has half the homes the table was sized for.
        """
        scratch = bytes([fingerprint & 0xFF, (fingerprint >> 8) & 0xFF])
        h = murmur3_bytes(scratch, self.seed ^ self.ALT_SEED_XOR) & self.mask
        if h == 0:
            h = 1 & self.mask
        return (index ^ h) & self.mask

    def _slot(self, index: int, slot: int) -> int:
        if self.fingerprint_bits == 16:
            offset = 16 + index * 8 + slot * 2
            return int.from_bytes(self.table[offset - 16 : offset - 14], "little")
        # 12-bit: six bytes per bucket, nibble-packed little-endian.
        base = index * 6
        b = self.table[base : base + 6]
        if slot == 0:
            return b[0] | ((b[1] & 0x0F) << 8)
        if slot == 1:
            return ((b[1] >> 4) & 0x0F) | (b[2] << 4)
        if slot == 2:
            return b[3] | ((b[4] & 0x0F) << 8)
        return ((b[4] >> 4) & 0x0F) | (b[5] << 4)

    def contains(self, key: str) -> bool:
        fingerprint = self.fingerprint_of(key)
        i1 = self.index_of(key)
        i2 = self.alt_index(i1, fingerprint)
        for index in (i1, i2):
            for slot in range(self.slots_per_bucket):
                if self._slot(index, slot) == fingerprint:
                    return True
        return False


# ───────────────────────────── segments ───────────────────────────────────

Membership = Literal["member", "not-member", "unresolved"]


class SegmentIndex:
    """Three-valued membership. `unresolved` is never collapsed to a boolean."""

    def __init__(self, segments: dict[str, Any]) -> None:
        self.segments = segments or {}

    def get(self, key: str) -> dict[str, Any] | None:
        return self.segments.get(key)

    def membership(self, segment_key: str, context_key: str) -> Membership:
        segment = self.segments.get(segment_key)
        # A clause naming a segment that no longer exists is a definite miss.
        if segment is None:
            return "not-member"
        if context_key in (segment.get("excluded") or []):
            return "not-member"

        kind = segment.get("kind")
        if kind == "inline":
            members = segment.get("members")
            if members is None:
                return "unresolved"
            return "member" if context_key in members else "not-member"
        # Filters need a confirmation source this port does not have, so a
        # positive is unresolved rather than assumed.
        return "unresolved"


# ───────────────────────────── the evaluator ──────────────────────────────

MAX_PREREQUISITE_DEPTH = 20
MAX_SEGMENT_DEPTH = 10


@dataclass
class Detail:
    value: Any
    variation_index: int | None
    reason: dict[str, Any]


def _error(kind: str, default_value: Any) -> Detail:
    return Detail(default_value, None, {"kind": "ERROR", "error": kind})


def _matches_kind(value: Any, kind: str) -> bool:
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "string":
        return isinstance(value, str)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return kind == "json"


class _State:
    def __init__(self, context: NormalizedContext, snapshot: dict[str, Any], segments: SegmentIndex):
        self.context = context
        self.snapshot = snapshot
        self.segments = segments


def _serve(flag: dict[str, Any], index: Any, reason: dict[str, Any], default_value: Any) -> Detail:
    variations = flag.get("variations")
    if not isinstance(variations, list) or not isinstance(index, int) or isinstance(index, bool):
        return _error("VARIATION_OUT_OF_RANGE", default_value)
    if index < 0 or index >= len(variations):
        return _error("VARIATION_OUT_OF_RANGE", default_value)
    value = variations[index]
    if not _matches_kind(value, flag.get("kind", "")):
        return _error("WRONG_TYPE", default_value)
    return Detail(value, index, reason)


def _evaluate_clause(clause: dict[str, Any], state: _State, depth: int) -> Membership | bool:
    """Returns True/False, or the string `unresolved` as a third state."""
    if clause.get("op") == "segmentMatch":
        kind = clause.get("contextKind", "user")
        key = state.context.key_of(kind)
        if key is None:
            return bool(clause.get("negate", False))
        for value in clause.get("values", []):
            if not isinstance(value, str):
                continue
            result = _segment_membership(value, key, state, depth)
            if result == "unresolved":
                return "unresolved"
            if result == "member":
                return not clause.get("negate", False)
        return bool(clause.get("negate", False))

    attr = state.context.get_attribute(clause.get("contextKind", "user"), clause.get("attribute", ""))
    matched = apply_operator(clause.get("op", ""), attr, clause.get("values", []) or [])
    return (not matched) if clause.get("negate", False) else matched


def _segment_membership(segment_key: str, context_key: str, state: _State, depth: int) -> Membership:
    if depth >= MAX_SEGMENT_DEPTH:
        return "not-member"
    direct = state.segments.membership(segment_key, context_key)
    if direct != "not-member":
        return direct

    segment = state.segments.get(segment_key)
    for rule in (segment or {}).get("rules", []) or []:
        outcome = _evaluate_segment_rule(rule, segment_key, state, depth + 1)
        if outcome == "unresolved":
            return "unresolved"
        if outcome == "member":
            return "member"
    return "not-member"


def _evaluate_segment_rule(rule: dict[str, Any], segment_key: str, state: _State, depth: int) -> Membership:
    for clause in rule.get("clauses", []) or []:
        result = _evaluate_clause(clause, state, depth)
        if result == "unresolved":
            return "unresolved"
        if result is False:
            return "not-member"
    if "weight" not in rule or rule["weight"] is None:
        return "member"

    value = state.context.bucket_value(rule.get("contextKind", "user"), rule.get("bucketBy", "key"))
    if value is None:
        return "not-member"
    b = bucket(value, segment_key, state.snapshot.get("salt", ""))
    return "member" if b < min(int(rule["weight"]), WEIGHT_SCALE) else "not-member"


def _evaluate_flag(flag: dict[str, Any], default_value: Any, state: _State, depth: int) -> Detail:
    if depth > MAX_PREREQUISITE_DEPTH:
        return _error("PREREQUISITE_DEPTH_EXCEEDED", default_value)

    def off(reason: dict[str, Any]) -> Detail:
        off_variation = flag.get("offVariation")
        if off_variation is None:
            return Detail(default_value, None, reason)
        return _serve(flag, off_variation, reason, default_value)

    # 2. Flag off.
    if flag.get("on") is not True:
        return off({"kind": "OFF"})

    # 3. Prerequisites.
    for prerequisite in flag.get("prerequisites", []) or []:
        failed = {"kind": "PREREQUISITE_FAILED", "prerequisiteKey": prerequisite.get("key")}
        prereq_flag = (state.snapshot.get("flags") or {}).get(prerequisite.get("key"))
        if prereq_flag is None or prereq_flag.get("on") is not True:
            return off(failed)
        prereq_detail = _evaluate_flag(prereq_flag, None, state, depth + 1)
        if prereq_detail.reason.get("kind") == "ERROR":
            return _error(prereq_detail.reason.get("error", "MALFORMED_FLAG"), default_value)
        if prereq_detail.variation_index != prerequisite.get("variation"):
            return off(failed)

    # 4. Individual targets.
    for target in flag.get("targets", []) or []:
        key = state.context.key_of(target.get("contextKind", "user"))
        if key is None:
            continue
        if key in (target.get("keys") or []):
            return _serve(flag, target.get("variation"), {"kind": "TARGET_MATCH"}, default_value)

    # 5. First matching rule.
    for index, rule in enumerate(flag.get("rules", []) or []):
        unresolved = False
        matched = True
        for clause in rule.get("clauses", []) or []:
            result = _evaluate_clause(clause, state, 0)
            if result == "unresolved":
                unresolved = True
                break
            if result is False:
                matched = False
                break
        # An unresolved clause fails the whole rule closed, in either polarity.
        if unresolved or not matched:
            continue

        reason = {"kind": "RULE_MATCH", "ruleIndex": index, "ruleId": rule.get("id")}
        if rule.get("rollout") is not None:
            variation = resolve_rollout(
                rule["rollout"], state.context, flag.get("key", ""), state.snapshot.get("salt", "")
            )
            if variation is None:
                continue
            return _serve(flag, variation, reason, default_value)
        if rule.get("variation") is None:
            continue
        return _serve(flag, rule["variation"], reason, default_value)

    # 6. Fallthrough.
    fallthrough = flag.get("fallthrough")
    if not isinstance(fallthrough, dict):
        return _error("MALFORMED_FLAG", default_value)
    if "rollout" in fallthrough:
        variation = resolve_rollout(
            fallthrough["rollout"], state.context, flag.get("key", ""), state.snapshot.get("salt", "")
        )
        if variation is None:
            return _error("MALFORMED_CONTEXT", default_value)
        return _serve(flag, variation, {"kind": "FALLTHROUGH"}, default_value)
    return _serve(flag, fallthrough.get("variation"), {"kind": "FALLTHROUGH"}, default_value)


def evaluate(
    flag_key: str,
    context: Any,
    snapshot: dict[str, Any],
    default_value: Any,
    segments: SegmentIndex | None = None,
) -> Detail:
    """Evaluate one flag. Never raises; returns the caller's default on error."""
    try:
        flag = (snapshot.get("flags") or {}).get(flag_key)
        if flag is None:
            return Detail(default_value, None, {"kind": "FLAG_NOT_FOUND"})

        normalized = NormalizedContext.normalize(context)
        if normalized is None:
            return _error("MALFORMED_CONTEXT", default_value)

        index = segments if segments is not None else SegmentIndex(snapshot.get("segments") or {})
        return _evaluate_flag(flag, default_value, _State(normalized, snapshot, index), 0)
    except Exception:  # noqa: BLE001 - the contract is "never throws"
        return _error("MALFORMED_FLAG", default_value)


def load_corpus(path: str) -> Any:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)
