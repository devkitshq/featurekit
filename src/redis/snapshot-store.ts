/**
 * The `SnapshotStore` port (§2, §6, §8).
 *
 * "Plugins are a class with one method" — notifkit had `Transport.send()`;
 * featkit has `SnapshotStore` and `EventSink`. This one owns everything the
 * control plane keeps in Redis for the server tier: the compiled snapshot, the
 * patch history that makes SSE resume possible, the pub/sub channel that fans a
 * change out to every API node, and the compile lock that stops them all
 * recompiling at once.
 *
 * **Nothing here is authoritative.** Postgres is truth; every method's failure
 * mode is "recompile from Postgres", which is why §8 can mark the patch stream
 * lossy without hedging.
 *
 * @see docs/control-plane/change-propagation.md
 */

import type { Snapshot } from "../sdk/index.js";

/** One entry in `fk:patches:{envId}` (§10.3). */
export interface StreamPatch {
  /** The snapshot version this patch produced. Becomes the SSE `id:`. */
  version: number;
  op: "patch" | "delete" | "segment-patch";
  /** Flag key, or segment key for `segment-patch`. */
  flagKey: string;
  payload: unknown;
}

export interface ChangeMessage {
  version: number;
  /** Absent for a full recompile broadcast. */
  flagKey?: string;
}

export interface SnapshotStore {
  get(environmentId: string): Promise<{ snapshot: Snapshot; version: number } | null>;
  put(environmentId: string, snapshot: Snapshot): Promise<void>;

  /** Append to the capped patch history, in the same step that publishes. */
  appendPatch(environmentId: string, patch: StreamPatch, depth?: number): Promise<void>;

  /**
   * Patches strictly after `version`, or `null` when replay is impossible.
   *
   * `null` is not an error — it means "send a full `put`", which §10.3 lists as
   * the correct outcome for three distinct situations: the SDK was disconnected
   * across more than `depth` changes, history is empty because Redis restarted,
   * or the SDK claims a version ahead of history (a rolled-back database).
   * Collapsing them into one return value is deliberate: the response is
   * identical, and a caller that had to distinguish them would get it wrong.
   */
  patchesSince(environmentId: string, version: number, depth: number): Promise<StreamPatch[] | null>;

  publish(environmentId: string, message: ChangeMessage): Promise<void>;

  /**
   * Store the snapshot, append its patches, and broadcast — as one step.
   *
   * The three used to be three round trips, and a crash between them left the
   * patch history describing a snapshot the store did not hold. Worse, a
   * subscriber woken by the broadcast could read the *previous* snapshot under
   * the new version and cache it, which is a stale configuration that looks
   * fresh — the §5 "internally consistent but semantically stale" failure.
   *
   * Implementations must apply all of it or none of it.
   */
  commit(
    environmentId: string,
    snapshot: Snapshot,
    patches: readonly StreamPatch[],
    message: ChangeMessage,
    depth?: number,
  ): Promise<void>;
  subscribe(
    environmentId: string,
    handler: (message: ChangeMessage) => void,
  ): Promise<() => Promise<void>>;

  /**
   * Run `work` under the environment's compile lock.
   *
   * Returns `undefined` **without running `work`** when the lock is already
   * held: a second compile of the same version is waste, not a queue. The
   * caller that skipped will receive the result via pub/sub like every other
   * node. The lock is always released, including when `work` throws.
   */
  withCompileLock<T>(environmentId: string, work: () => Promise<T>): Promise<T | undefined>;
}

/* ─────────────── binary-safe (de)serialisation for snapshots ────────── */

/**
 * Segment filters are `Uint8Array`. `JSON.stringify` turns one into
 * `{"0":1,"1":2,...}`, and `JSON.parse` gives back a plain object — a filter
 * that answers `false` for every member. Silent, and only visible weeks later
 * as "the flag didn't turn on for that customer" (§9.7).
 *
 * So binary fields are tagged on the way out and revived on the way in.
 */
const BINARY_TAG = "$fkBytes";

export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, (_key, value: unknown) => {
    if (value instanceof Uint8Array) {
      return { [BINARY_TAG]: Buffer.from(value).toString("base64") };
    }
    return value;
  });
}

export function deserializeSnapshot(text: string): Snapshot {
  return JSON.parse(text, (_key, value: unknown) => {
    if (
      typeof value === "object" &&
      value !== null &&
      BINARY_TAG in value &&
      typeof (value as Record<string, unknown>)[BINARY_TAG] === "string"
    ) {
      return new Uint8Array(
        Buffer.from((value as Record<string, string>)[BINARY_TAG]!, "base64"),
      );
    }
    return value;
  }) as Snapshot;
}
