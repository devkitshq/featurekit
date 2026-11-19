/**
 * Change propagation and the control plane's own last-known-good.
 *
 * ```
 * PATCH /v1/flags/:key/environments/:env
 *   -> transaction: write config, bump version, write audit row
 *   -> recompile snapshot (debounced ~200ms, guarded by a compile lock)
 *   -> one transaction: snapshot_cache, snapshot_patches, NOTIFY
 *   -> each API node pushes `patch` to its connections
 *   -> next evaluation reflects it
 * ```
 *
 * Target: **p99 under 300ms** from dashboard toggle to the flag flipping in a
 * production process. That number is the product. A flag system whose kill
 * switch takes 30 seconds is not a kill switch.
 *
 * **Two properties were added after the production review:**
 *
 * 1. **This class keeps its own last-known-good snapshot per environment.**
 *    Postgres is both the store and the truth, so a store failure is a
 *    database failure; a node that has served an environment keeps serving it
 *    from memory rather than turning `GET /v1/snapshot/:env` into a 500.
 * 2. **A kill switch does not wait for the debounce.** Coalescing five
 *    dashboard edits into one recompile is right; making an operator's "turn it
 *    off" wait 200ms behind a lock during an incident is not.
 *
 * This class takes `loadInput` and `nextVersion` as functions rather than a
 * `Database`, for the same reason the compiler takes rows: the interesting
 * behaviour here is debouncing, locking and failure handling, and none of it
 * should need a container to test.
 *
 * @see docs/control-plane/change-propagation.md
 */

import type { CompiledFlag, Snapshot } from "../sdk/evaluation/index.js";
import { compileSnapshot, type CompilerInput } from "./compile.js";
import type { SnapshotStore, StreamPatch } from "./store.js";

export type SnapshotSource = "store" | "compiled" | "memory";

export interface SnapshotResult {
  snapshot: Snapshot;
  version: number;
  /** Where this came from. `memory` is degraded. */
  source?: SnapshotSource;
}

export interface SnapshotServiceOptions {
  store: SnapshotStore;
  loadInput: (environmentId: string) => Promise<CompilerInput>;
  /** Allocates the next monotonic version. Durable — see `environments.snapshot_version`. */
  nextVersion: (environmentId: string) => Promise<number>;
  debounceMs?: number;
  patchHistoryDepth?: number;
  segmentInlineMax?: number;
  /**
   * How long a change waits for a compile lock another compile holds, before
   * giving up and reporting it. Longer than the store's lock lease, so a holder
   * that died cannot make a change wait forever.
   */
  lockWaitMs?: number;
  onError?: (error: unknown, context: { environmentId: string }) => void;
  /** Observability hook: version, source and compile duration per environment. */
  onSnapshot?: (event: {
    environmentId: string;
    version: number;
    source: SnapshotSource;
    compileMs?: number;
  }) => void;
}

export interface RecompileOptions {
  /** The flag that changed, for a targeted `patch` event. Absent = full `put`. */
  flagKey?: string;
}

interface CachedSnapshot {
  snapshot: Snapshot;
  version: number;
  /** When this node last confirmed the snapshot, for the age gauge. */
  at: number;
}

export class SnapshotService {
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; flagKeys: Set<string> }>();
  /** De-duplicates concurrent cold reads of the same environment. */
  private readonly inFlight = new Map<string, Promise<SnapshotResult>>();
  /**
   * Last-known-good, per environment. This is the control plane's equivalent of
   * the SDK's in-memory snapshot: stale beats wrong, and both beat empty.
   */
  private readonly lastKnownGood = new Map<string, CachedSnapshot>();
  private closed = false;

  constructor(private readonly options: SnapshotServiceOptions) {}

  /**
   * The current snapshot: from the store if present, compiled if not, and from
   * memory when the database is unavailable.
   *
   * Concurrent cold reads collapse into one compile. Ten SDKs connecting to a
   * freshly started node must not trigger ten compiles of the same rows.
   */
  async get(environmentId: string): Promise<SnapshotResult> {
    try {
      const cached = await this.options.store.get(environmentId);
      if (cached !== null) {
        this.remember(environmentId, cached.snapshot, cached.version);
        return { ...cached, source: "store" };
      }
      return await this.compileCold(environmentId);
    } catch (error) {
      this.options.onError?.(error, { environmentId });
      return this.fromMemory(environmentId);
    }
  }

  private compileCold(environmentId: string): Promise<SnapshotResult> {
    const existing = this.inFlight.get(environmentId);
    if (existing !== undefined) return existing;

    const work = (async (): Promise<SnapshotResult> => {
      const compiled = await this.recompile(environmentId);
      if (compiled !== undefined) return { ...compiled, source: "compiled" };

      // The lock was held by another node, which is compiling right now. Its
      // result lands in the store; wait briefly rather than compiling anyway.
      const settled = await this.awaitStore(environmentId);
      if (settled !== null) return { ...settled, source: "store" };

      // Nothing arrived. Rather than throwing — which is a 500 for an SDK that
      // would happily have taken a slightly stale answer — fall back.
      return this.fromMemory(environmentId);
    })().finally(() => this.inFlight.delete(environmentId));

    this.inFlight.set(environmentId, work);
    return work;
  }

  /** Serve what this node last proved, or fail: there is nothing else to serve. */
  private fromMemory(environmentId: string): SnapshotResult {
    const known = this.lastKnownGood.get(environmentId);
    if (known === undefined) {
      throw new Error(`featurekit: could not obtain a snapshot for ${environmentId}`);
    }
    this.options.onSnapshot?.({ environmentId, version: known.version, source: "memory" });
    return { snapshot: known.snapshot, version: known.version, source: "memory" };
  }

  private async awaitStore(environmentId: string, attempts = 20): Promise<SnapshotResult | null> {
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const got = await this.options.store.get(environmentId);
      if (got !== null) {
        this.remember(environmentId, got.snapshot, got.version);
        return got;
      }
    }
    return null;
  }

  private remember(environmentId: string, snapshot: Snapshot, version: number): void {
    const existing = this.lastKnownGood.get(environmentId);
    // Never move backwards. A store that answers with an older version — after a
    // Postgres restore, or a replica serving a stale read — must not overwrite a
    // newer snapshot this node already proved (version rollback).
    if (existing !== undefined && existing.version > version) return;
    this.lastKnownGood.set(environmentId, { snapshot, version, at: Date.now() });
  }

  /** Snapshot age in seconds per environment, for the readiness gauge. */
  ages(): Map<string, number> {
    const now = Date.now();
    const ages = new Map<string, number>();
    for (const [environmentId, cached] of this.lastKnownGood) {
      ages.set(environmentId, Math.round((now - cached.at) / 1000));
    }
    return ages;
  }

  /** The version this node currently believes is current, if any. */
  knownVersion(environmentId: string): number | null {
    return this.lastKnownGood.get(environmentId)?.version ?? null;
  }

  /**
   * Load, allocate, compile — in that order, deliberately.
   *
   * Loading first means the common failure, an unreachable database, costs no
   * version at all. Only a ruleset that will not compile burns one, which is
   * rare and harmless: every version comparison in the system (the SDK's patch
   * guard, the SSE `id:`, the ETag, the last-known-good below) tests ordering,
   * never succession. `tests/chaos/version-gaps.test.ts` pins both halves.
   */
  private async compileOnly(
    environmentId: string,
  ): Promise<{ snapshot: Snapshot; version: number; compileMs: number }> {
    const input = await this.options.loadInput(environmentId);
    const version = await this.options.nextVersion(environmentId);
    const startedAt = Date.now();
    const snapshot = this.compile(input, version);
    return { snapshot, version, compileMs: Date.now() - startedAt };
  }

  /**
   * The snapshot this environment would compile to with `change` applied to
   * the compiler's input. Nothing is written or locked: applying a change for
   * real and undoing it would be visible to every SDK and write two audit rows
   * for a change nobody made.
   */
  async preview(
    environmentId: string,
    change: (input: CompilerInput) => Promise<CompilerInput>,
    version: number,
  ): Promise<Snapshot> {
    return this.compile(await change(await this.options.loadInput(environmentId)), version);
  }

  private compile(input: CompilerInput, version: number): Snapshot {
    return compileSnapshot(input, {
      version,
      ...(this.options.segmentInlineMax !== undefined
        ? { segmentInlineMax: this.options.segmentInlineMax }
        : {}),
    });
  }

  /**
   * Compile, cache, record a patch, and broadcast — under the compile lock.
   *
   * Returns `undefined` when another node holds the lock: that node is already
   * doing this work and will publish the result. Recompiling anyway would be
   * the thundering herd the lock exists to prevent.
   *
   * A compile that throws leaves the previous snapshot in place and reaches
   * the caller: a management write that reports success for a change nobody
   * compiled is how an operator believes a kill switch landed when it did not.
   */
  async recompile(
    environmentId: string,
    options: RecompileOptions = {},
  ): Promise<SnapshotResult | undefined> {
    return this.options.store.withCompileLock(environmentId, async () => {
      const previous = await this.options.store.get(environmentId);
      const { snapshot, version, compileMs } = await this.compileOnly(environmentId);

      // One step, not three. A subscriber that reacts to the broadcast by
      // reading the store must never find the old snapshot under the new
      // version, and a crash mid-sequence must not leave the patch history
      // describing a snapshot nobody holds.
      await this.options.store.commit(
        environmentId,
        snapshot,
        diffPatches(previous?.snapshot, snapshot, options.flagKey),
        { version, ...(options.flagKey !== undefined ? { flagKey: options.flagKey } : {}) },
        this.options.patchHistoryDepth ?? 200,
      );

      this.remember(environmentId, snapshot, version);
      this.options.onSnapshot?.({ environmentId, version, source: "compiled", compileMs });
      return { snapshot, version, source: "compiled" as const };
    });
  }

  /**
   * Recompile for a change that has already committed, waiting out any compile
   * that holds the lock.
   *
   * Skipping when the lock is held is right for a cold read, where the holder
   * is producing the same snapshot. It is wrong here: the holder may have read
   * the configuration before this change committed, and then nothing would ever
   * compile the change — a kill switch that never reaches anyone, until some
   * unrelated edit happens to recompile. So the change waits its turn. The worst
   * case is one redundant compile, which costs a version and nothing else.
   */
  private async recompileWhenFree(
    environmentId: string,
    options: RecompileOptions = {},
  ): Promise<SnapshotResult | undefined> {
    const deadline = Date.now() + (this.options.lockWaitMs ?? 35_000);
    for (let delay = 20; ; delay = Math.min(delay * 2, 500)) {
      const result = await this.recompile(environmentId, options);
      if (result !== undefined || this.closed) return result;
      if (Date.now() >= deadline) {
        this.options.onError?.(
          new Error("featurekit: compile lock still held; a change was not propagated"),
          { environmentId },
        );
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Note that something changed and recompile shortly.
   *
   * Debounced per environment. Editing five rules in a dashboard session is
   * five PATCHes; recompiling and broadcasting five times means every connected
   * SDK applies five snapshots for one logical change. Per environment rather
   * than globally, so a busy staging cannot delay a production kill switch.
   */
  notifyChange(environmentId: string, flagKey?: string): void {
    if (this.closed) return;

    const existing = this.pending.get(environmentId);
    if (existing !== undefined) {
      if (flagKey !== undefined) existing.flagKeys.add(flagKey);
      return;
    }

    const flagKeys = new Set<string>();
    if (flagKey !== undefined) flagKeys.add(flagKey);

    const timer = setTimeout(() => {
      const entry = this.pending.get(environmentId);
      this.pending.delete(environmentId);
      // A burst touching one flag stays a targeted `patch`; a burst touching
      // several is a full recompile, because a patch naming one of them would
      // leave the others stale on every connected SDK.
      const keys = [...(entry?.flagKeys ?? [])];
      const only = keys.length === 1 ? keys[0] : undefined;
      void this.recompileWhenFree(environmentId, only !== undefined ? { flagKey: only } : {}).catch(
        (error: unknown) => this.options.onError?.(error, { environmentId }),
      );
    }, this.options.debounceMs ?? 200);
    timer.unref?.();

    this.pending.set(environmentId, { timer, flagKeys });
  }

  /**
   * Propagate a change **now**, bypassing the debounce.
   *
   * This is the kill-switch path. Anything an operator does to reduce blast
   * radius during an incident — disabling a flag, dropping a rollout to zero —
   * takes it, and it takes any pending debounced work with it so a queued edit
   * cannot land afterwards and undo the intent.
   */
  async notifyChangeImmediate(environmentId: string, flagKey?: string): Promise<SnapshotResult | undefined> {
    if (this.closed) return undefined;
    const pending = this.pending.get(environmentId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pending.delete(environmentId);
      // A coalesced burst plus this change is more than one flag, so the
      // targeted patch is no longer sufficient.
      if (pending.flagKeys.size > 0 && !(pending.flagKeys.size === 1 && pending.flagKeys.has(flagKey ?? ""))) {
        return this.recompileWhenFree(environmentId);
      }
    }
    return this.recompileWhenFree(environmentId, flagKey !== undefined ? { flagKey } : {});
  }

  /** Cancel pending work. A shutting-down node must not compile on its way out. */
  async close(): Promise<void> {
    this.closed = true;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    await Promise.resolve();
  }
}

/**
 * The stream events one recompile produced.
 *
 * A targeted `flagKey` yields a single `patch`, which is the common case and
 * the cheap one. Otherwise every flag whose version moved gets a `patch`, and
 * every flag that vanished gets a `delete` — a flag archived between compiles
 * must be removed from connected SDKs, not merely absent from future `put`s.
 */
function diffPatches(
  previous: Snapshot | undefined,
  next: Snapshot,
  flagKey?: string,
): StreamPatch[] {
  if (flagKey !== undefined) {
    const flag = next.flags[flagKey];
    return [
      flag === undefined
        ? { version: next.version, op: "delete", flagKey, payload: { key: flagKey } }
        : { version: next.version, op: "patch", flagKey, payload: flag },
    ];
  }

  const patches: StreamPatch[] = [];
  for (const [key, flag] of Object.entries(next.flags)) {
    const before: CompiledFlag | undefined = previous?.flags[key];
    if (before === undefined || before.version !== flag.version) {
      patches.push({ version: next.version, op: "patch", flagKey: key, payload: flag });
    }
  }
  for (const key of Object.keys(previous?.flags ?? {})) {
    if (next.flags[key] === undefined) {
      patches.push({ version: next.version, op: "delete", flagKey: key, payload: { key } });
    }
  }
  return patches;
}
