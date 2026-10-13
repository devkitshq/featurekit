/**
 * Client-tier evaluation and fingerprint-keyed fan-out (§11.5, §22.1).
 *
 * **The problem.** The naive fan-out is a thundering herd pointed at your own
 * control plane. Toggle one flag with 50,000 connected browsers and the control
 * plane immediately owes 50,000 evaluations and 50,000 distinct SSE writes — a
 * self-inflicted load spike, triggered by the most routine action in the
 * product, at exactly the moment an operator is most likely to be flipping a
 * kill switch during an incident. Sharding the API tier does not fix it; it
 * distributes the same total work while multiplying the connection state.
 *
 * **The observation that collapses it.** An evaluation is a function of the
 * attributes the flag's rules actually reference, and nothing else. The
 * compiler already emits that set (`referencedAttributes`, §10.1), so contexts
 * are normalised down to those attributes and grouped. 50,000 contexts collapse
 * to the few hundred distinct `(country, plan)` pairs that exist. Evaluation
 * count drops from *connections* to *distinct attribute combinations*.
 *
 * **Three details that make it correct rather than approximately correct:**
 *
 * 1. **Percentage rollouts break the collapse and are handled separately.** A
 *    rollout buckets on the context key, so such a flag has a per-context
 *    answer by construction. The compiler marks these (`perContext`) and their
 *    fan-out computes the bucket per connection — an integer hash, not a rule
 *    evaluation, so 50,000 of them is under a millisecond of CPU.
 * 2. **Individual targets break it too**, in the same way and with the same
 *    handling.
 * 3. **The fingerprint excludes the context key** — that is the entire point —
 *    which makes the cache safe to share across users but means it must be
 *    invalidated on a snapshot version bump. It is keyed
 *    `(version, flagKey, fingerprint)`, so a bump invalidates by construction
 *    rather than by an explicit sweep.
 *
 * @see docs/client-tier/fanout.md
 */

import { canonicalize } from "../contracts/context-hash.js";
import {
  evaluate,
  getAttribute,
  normalizeContext,
  type EvaluationContext,
  type EvaluationDetail,
  type SegmentIndex,
  type Snapshot,
} from "../sdk/index.js";

export interface ClientValue {
  value: unknown;
  variationIndex: number | null;
  reason: string;
}

export type ClientValues = Record<string, ClientValue>;

export interface ClientConnection {
  id: string;
  context: EvaluationContext;
}

function toClientValue(detail: EvaluationDetail<unknown>): ClientValue {
  return {
    value: detail.value,
    variationIndex: detail.variationIndex,
    // Only the reason kind crosses to the browser. `ruleIndex` and `ruleId`
    // would disclose the shape of the ruleset the client tier exists to
    // withhold — the same leak as shipping the rules, one field at a time.
    reason: detail.reason.kind,
  };
}

/**
 * Re-exported so existing callers keep one import, defined in
 * `../contracts/context-hash.js` so a customer's backend can import the same
 * function from `featurekit/secure-mode` without pulling the evaluator in.
 */
export { contextHash } from "../contracts/context-hash.js";

/**
 * The fan-out fingerprint: the values of exactly the attributes the changed
 * flags reference, and **not the context key**.
 *
 * Excluding the key is what makes 50,000 connections collapse to a few hundred
 * groups. It is also why the resulting cache is safe to share between users:
 * two contexts with the same fingerprint are, for these flags, indistinguishable.
 */
export function fingerprintOf(
  context: EvaluationContext,
  referencedAttributes: readonly string[],
): string {
  const normalized = normalizeContext(context);
  if (normalized === null) return "invalid";

  const parts: string[] = [];
  for (const qualified of referencedAttributes) {
    const dot = qualified.indexOf(".");
    const kind = dot === -1 ? "user" : qualified.slice(0, dot);
    // Only the FIRST dot separates kind from attribute; the rest belongs to the
    // attribute, because `referencedAttributes` is emitted as
    // `${kind}.${attribute}` and an attribute may itself be a path
    // (`address.country`).
    const attribute = dot === -1 ? qualified : qualified.slice(dot + 1);
    // `key` never contributes: including it would give every connection its own
    // fingerprint and reinstate exactly the fan-out this collapses.
    if (attribute === "key") continue;

    // Resolved with the evaluator's own accessor rather than a flat property
    // read, and that is load-bearing rather than tidiness.
    //
    // A flat `attrs["address.country"]` looks for a property spelled with a dot
    // in it, finds nothing, and yields `undefined` for *every* context — while
    // `evaluate()` walks the path and gets the real value. Two connections
    // differing only in a nested attribute then share a fingerprint, and the
    // cache below hands one of them the other's evaluated value. That is one
    // user's flags reaching another user, which is the single failure this
    // whole tier exists to prevent.
    //
    // `getAttribute` also refuses `kind` and never reads through the prototype
    // chain, so the fingerprint agrees with evaluation on those too.
    parts.push(`${qualified}=${canonicalize(getAttribute(normalized, kind, attribute))}`);
  }
  return parts.join("|");
}

export interface FanoutStats {
  /** Full rule evaluations performed. Should track fingerprints, not connections. */
  evaluations: number;
  /** Distinct attribute combinations resident. Backs `featurekit_client_fingerprints`. */
  fingerprints: number;
  /** Per-connection specialisations for rollout/target/segment flags. */
  perContextEvaluations: number;
  cacheHits: number;
}

export interface FanoutOptions {
  cacheMax?: number;
  segments?: SegmentIndex;
}

/**
 * Evaluates a set of flags for many connections, collapsing shared work.
 *
 * The cache is keyed `(version, flagKey, fingerprint)`. A version bump changes
 * every key, so a new snapshot invalidates the cache by construction rather
 * than by an explicit sweep that someone eventually forgets to call.
 */
export class ClientFanout {
  private cache = new Map<string, ClientValue>();
  readonly stats: FanoutStats = {
    evaluations: 0,
    fingerprints: 0,
    perContextEvaluations: 0,
    cacheHits: 0,
  };

  constructor(private readonly options: FanoutOptions = {}) {}

  /** Every flag the client tier may see, evaluated for one context. */
  evaluateAll(snapshot: Snapshot, context: EvaluationContext): ClientValues {
    const values: ClientValues = {};
    for (const flag of Object.values(snapshot.flags)) {
      if (flag.clientAvailable !== true) continue;
      values[flag.key] = this.evaluateOne(snapshot, flag.key, context);
    }
    return values;
  }

  private evaluateOne(snapshot: Snapshot, flagKey: string, context: EvaluationContext): ClientValue {
    this.stats.evaluations++;
    return toClientValue(
      evaluate(flagKey, context, snapshot, null, {
        ...(this.options.segments !== undefined ? { segments: this.options.segments } : {}),
      }),
    );
  }

  /**
   * Fan a set of changed flags out to many connections.
   *
   * Returns the values each connection needs to be sent. Connections whose
   * values did not change are still included — the caller compares against what
   * it last sent, because only it knows that.
   */
  fanout(
    snapshot: Snapshot,
    changedFlagKeys: readonly string[],
    connections: readonly ClientConnection[],
  ): Map<string, ClientValues> {
    const out = new Map<string, ClientValues>();
    for (const connection of connections) out.set(connection.id, {});

    const seenFingerprints = new Set<string>();

    for (const flagKey of changedFlagKeys) {
      const flag = snapshot.flags[flagKey];
      if (flag === undefined || flag.clientAvailable !== true) continue;

      if (flag.perContext === true) {
        // A rollout buckets on the key; a target is a key lookup; a segment
        // clause resolves membership by key. All three have a per-context
        // answer by construction and cannot share a fingerprint. This is an
        // integer hash per connection, not a rule evaluation.
        for (const connection of connections) {
          this.stats.perContextEvaluations++;
          out.get(connection.id)![flagKey] = toClientValue(
            evaluate(flagKey, connection.context, snapshot, null, {
              ...(this.options.segments !== undefined ? { segments: this.options.segments } : {}),
            }),
          );
        }
        continue;
      }

      const referenced = flag.referencedAttributes ?? [];
      for (const connection of connections) {
        const fingerprint = fingerprintOf(connection.context, referenced);
        seenFingerprints.add(fingerprint);
        const cacheKey = `${snapshot.version}\0${flagKey}\0${fingerprint}`;

        let value = this.cache.get(cacheKey);
        if (value === undefined) {
          value = this.evaluateOne(snapshot, flagKey, connection.context);
          this.remember(cacheKey, value);
        } else {
          this.stats.cacheHits++;
        }
        out.get(connection.id)![flagKey] = value;
      }
    }

    this.stats.fingerprints = seenFingerprints.size;
    return out;
  }

  private remember(key: string, value: ClientValue): void {
    const max = this.options.cacheMax ?? 50_000;
    if (this.cache.size >= max) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.cache.keys().next();
      if (oldest.done !== true) this.cache.delete(oldest.value);
    }
    this.cache.set(key, value);
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  resetStats(): void {
    this.stats.evaluations = 0;
    this.stats.perContextEvaluations = 0;
    this.stats.cacheHits = 0;
  }
}
