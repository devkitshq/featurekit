/**
 * In-process `SnapshotStore`.
 *
 * Two real uses, not just tests:
 *
 * - **`services: ["all"]` on a single node.** A monolith deployment with one
 *   process has nobody to fan out to.
 * - **The contract fixture.** `MemorySnapshotStore` and `PostgresSnapshotStore`
 *   run the *same* suite, so the store tests use in production and the store
 *   tests run against cannot quietly diverge.
 *
 * It deliberately serialises through the same binary-safe codec as the Postgres
 * implementation rather than holding object references. Handing back a live
 * reference would let a caller mutate the cached snapshot in place, and would
 * hide exactly the `Uint8Array` round-trip bug the codec exists to prevent.
 */

import type { Snapshot } from "../sdk/index.js";
import {
  deserializeSnapshot,
  serializeSnapshot,
  type ChangeMessage,
  type SnapshotStore,
  type StreamPatch,
} from "./store.js";

export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, { text: string; version: number }>();
  private readonly patches = new Map<string, StreamPatch[]>();
  private readonly subscribers = new Map<string, Set<(m: ChangeMessage) => void>>();
  private readonly locks = new Set<string>();

  get(environmentId: string): Promise<{ snapshot: Snapshot; version: number } | null> {
    const stored = this.snapshots.get(environmentId);
    if (stored === undefined) return Promise.resolve(null);
    return Promise.resolve({
      snapshot: deserializeSnapshot(stored.text),
      version: stored.version,
    });
  }

  put(environmentId: string, snapshot: Snapshot): Promise<void> {
    this.snapshots.set(environmentId, {
      text: serializeSnapshot(snapshot),
      version: snapshot.version,
    });
    return Promise.resolve();
  }

  appendPatch(environmentId: string, patch: StreamPatch, depth = 200): Promise<void> {
    const history = this.patches.get(environmentId) ?? [];
    history.push(patch);
    // Retention is depth, not time: what matters is how many *changes* were
    // missed, not how long the SDK was away.
    while (history.length > depth) history.shift();
    this.patches.set(environmentId, history);
    return Promise.resolve();
  }

  patchesSince(
    environmentId: string,
    version: number,
    _depth: number,
  ): Promise<StreamPatch[] | null> {
    return Promise.resolve(resumeFrom(this.patches.get(environmentId) ?? [], version));
  }

  publish(environmentId: string, message: ChangeMessage): Promise<void> {
    for (const handler of this.subscribers.get(environmentId) ?? []) handler(message);
    return Promise.resolve();
  }

  /**
   * All three steps, in order, with nothing able to interleave.
   *
   * Trivially atomic here: this store is single-threaded and does no I/O, so
   * the interesting property — a subscriber never seeing the broadcast before
   * the snapshot it describes — falls out of ordering alone. The Postgres
   * implementation has to work for it, and both are held to the same contract
   * test.
   */
  async commit(
    environmentId: string,
    snapshot: Snapshot,
    patches: readonly StreamPatch[],
    message: ChangeMessage,
    depth = 200,
  ): Promise<void> {
    await this.put(environmentId, snapshot);
    for (const patch of patches) await this.appendPatch(environmentId, patch, depth);
    await this.publish(environmentId, message);
  }

  subscribe(
    environmentId: string,
    handler: (message: ChangeMessage) => void,
  ): Promise<() => Promise<void>> {
    const set = this.subscribers.get(environmentId) ?? new Set();
    set.add(handler);
    this.subscribers.set(environmentId, set);
    return Promise.resolve(() => {
      set.delete(handler);
      return Promise.resolve();
    });
  }

  async withCompileLock<T>(environmentId: string, work: () => Promise<T>): Promise<T | undefined> {
    if (this.locks.has(environmentId)) return undefined;
    this.locks.add(environmentId);
    try {
      return await work();
    } finally {
      // Released even when `work` throws: a failed compile must not lock the
      // environment out of every future compile.
      this.locks.delete(environmentId);
    }
  }
}

/**
 * The resume table, shared by every implementation so the four outcomes
 * cannot be spelled differently in two places.
 *
 * | `Last-Event-ID` vs history | Action |
 * | :-- | :-- |
 * | >= oldest retained version | replay from there, then stream live |
 * | < oldest retained version  | full `put` — more than `depth` changes missed |
 * | history empty              | full `put` — the cache was emptied |
 * | ahead of current version   | full `put` — indicates a rolled-back database |
 */
export function resumeFrom(history: readonly StreamPatch[], version: number): StreamPatch[] | null {
  if (history.length === 0) return null;

  const oldest = history[0]!.version;
  const newest = history[history.length - 1]!.version;

  // `version + 1 < oldest` rather than `version < oldest`: an SDK holding
  // exactly the version before the oldest retained patch can still be resumed,
  // because the patch that would take it forward is the one we still have.
  if (version + 1 < oldest) return null;
  if (version > newest) return null;

  return history.filter((p) => p.version > version);
}
