/**
 * The server-tier SDK, inside `featurekit`.
 *
 * Evaluation is synchronous and in-memory: the SDK holds the compiled ruleset
 * and answers for **any** context passed per call, with no network round trip.
 * That is the difference from `featurekit-client`, which holds evaluated values
 * for one identity and asks the server for another.
 *
 * Nothing under `src/sdk/` may import from the rest of `src/` — the evaluator
 * has to stay reachable without the control plane's database and Redis layers.
 * `tools/check-package.mjs` asserts that boundary.
 */

export * from "./evaluation/index.js";

export {
  FeaturekitSDK,
} from "./client/sdk.js";
export type {
  FeaturekitSdkOptions,
  SdkState,
  SnapshotPersistence,
} from "./client/sdk.js";
export { deserialize, serialize, fromBase64, toBase64 } from "./client/codec.js";
export { EventSummarizer } from "./events/summarizer.js";
export type { EvaluationSummary, SummaryBatch, SummarizerOptions } from "./events/summarizer.js";
