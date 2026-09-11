/**
 * The evaluation core — the shared source of truth (§3, §5).
 *
 * Everything re-exported here is pure, synchronous and dependency-free.
 */

export { assignBucket, bucket, bucketFromHash, resolveRollout, validateRolloutWeights, HASH_SPACE, WEIGHT_SCALE } from "./bucketing.js";
export { bucketValue, getAttribute, normalizeContext } from "./context.js";
export {
  buildCuckooFilter,
  bucketCountFor,
  altIndex,
  CuckooFilter,
  CUCKOO_HEADER_BYTES,
  CUCKOO_MAX_KICKS,
  SLOTS_PER_BUCKET,
} from "./cuckoo.js";
export type { CuckooBuildResult, CuckooOptions, FingerprintBits } from "./cuckoo.js";
export { evaluate } from "./evaluate.js";
export type { EvaluateOptions } from "./evaluate.js";
export { murmur3Bytes, murmur3Utf8 } from "./murmur3.js";
export { applyOperator, compareSemVer, parseSemVer } from "./operators.js";
export type { SemVer } from "./operators.js";
export { ordinalOf, RoaringBitmap, ROARING_ORDINAL_RE } from "./roaring.js";
export {
  InMemorySegmentCache,
  LruSegmentCache,
  SegmentIndex,
} from "./segments.js";
export type { MembershipResult, SegmentCacheProvider, SegmentDelta } from "./segments.js";
export type * from "./types.js";
export {
  checkRegexPattern,
  compileSafeRegExp,
  MAX_REGEX_INPUT_LENGTH,
  MAX_REGEX_LENGTH,
  type RegexCheck,
  type RegexRejection,
} from "./regex.js";
