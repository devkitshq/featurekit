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
 *    Previously every read went to the store, so a store failure turned
 *    `GET /v1/snapshot/:env` into a 500. Now it degrades to serving from
 *    memory, and to compiling when memory is cold.
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

import type { CompiledFlag, Snapshot } from "../sdk/index.js";
import { compileSnapshot, type CompilerInput } from "./compile.js";
import type { SnapshotStore, StreamPatch } from "./store.js";

export type SnapshotSource = "store" | "compiled" | "memory" | "postgres";

export interface SnapshotResult {
  snapshot: Snapshot;
  version: number;
  /** Where this came from. Anything but `store`/`compiled` is degraded. */
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
   * Floor between degraded compiles for one environment while the store is
   * unavailable. Without it, every request during a store outage compiles and
   * burns a version — a self-inflicted load spike on the database that is now
   * the only healthy component in the system.
   */
  degradedCompileIntervalMs?: number;
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

/**
 * Marks a failure that came from compiling (Postgres, or a malformed ruleset)
 * rather than from the store.
 *
 * The distinction decides the failure mode, so it must not be guessed from an
 * error message. **A store failure degrades** — that is the whole point of the
 * last-known-good path. **A compile failure propagates**: the caller is usually
 * a management write that has to know its change could not be compiled, and
 * swallowing it would report success for a snapshot nobody can build.
 */
class CompileFailure extends Error {
  constructor(override readonly cause: unknown) {
    super("featurekit: snapshot compile failed");
    this.name = "CompileFailure";
  }
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
  private readonly lastDegradedCompile = new Map<string, number>();
  private closed = false;

  constructor(private readonly options: SnapshotServiceOptions) {}

  /**
   * The current snapshot: from the store if present, compiled if not, and from
   * memory or Postgres when the store itself is unavailable.
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
    } catch (error) {
      // The store failed, not merely came back empty. Everything below is the
      // degraded path, and it must not throw into a request.
      this.options.onError?.(error, { environmentId });
      return this.degraded(environmentId);
    }

    const existing = this.inFlight.get(environmentId);
    if (existing !== undefined) return existing;

    const work = (async (): Promise<SnapshotResult> => {
      // Re-check under the in-flight guard: another caller may have populated
      // the store between our miss and our arrival here.
      const recheck = await this.options.store.get(environmentId).catch(() => null);
      if (recheck !== null) {
        this.remember(environmentId, recheck.snapshot, recheck.version);
        return { ...recheck, source: "store" };
      }

      const compiled = await this.recompile(environmentId);
      if (compiled !== undefined) return { ...compiled, source: "compiled" };

      // The lock was held by another node, which is compiling right now. Its
      // result lands in the store; wait briefly rather than compiling anyway.
      const settled = await this.awaitStore(environmentId);
      if (settled !== null) return { ...settled, source: "store" };

      // Nothing arrived. Rather than throwing — which is a 500 for an SDK that
      // would happily have taken a slightly stale answer — fall back.
      return this.degraded(environmentId);
    })().finally(() => this.inFlight.delete(environmentId));

    this.inFlight.set(environmentId, work);
    return work;
  }

  /**
   * Serve without the store: memory first, a fresh compile second.
   *
   * The alternative — propagating the store's error — means every SDK polling during
   * a cache outage receives a 500 and falls back to caller defaults, which is a
   * flag outage caused by a cache.
   */
  private async degraded(environmentId: string): Promise<SnapshotResult> {
    const known = this.lastKnownGood.get(environmentId);
    const now = Date.now();
    const interval = this.options.degradedCompileIntervalMs ?? 5_000;
    const lastCompile = this.lastDegradedCompile.get(environmentId) ?? 0;
    const knownAge = known === undefined ? Number.POSITIVE_INFINITY : now - known.at;

    // Memory wins while it is fresh, and also while it is stale but a compile
    // has already run recently. The second clause is the rate limit: without it
    // every request during a store outage compiles, which turns a cache failure
    // into a load spike against the only healthy component left — and burns a
    // snapshot version per request while doing it.
    if (known !== undefined && (knownAge < interval || now - lastCompile < interval)) {
      this.options.onSnapshot?.({
        environmentId,
        version: known.version,
        source: "memory",
      });
      return { snapshot: known.snapshot, version: known.version, source: "memory" };
    }

    try {
      this.lastDegradedCompile.set(environmentId, now);
      const { snapshot, version, compileMs } = await this.compileOnly(environmentId);
      this.remember(environmentId, snapshot, version);
      // Best effort: if the store has come back, put the result where the rest of
      // the fleet can see it. Failure here is expected and ignored.
      void this.options.store.put(environmentId, snapshot).catch(() => undefined);
      this.options.onSnapshot?.({ environmentId, version, source: "postgres", compileMs });
      return { snapshot, version, source: "postgres" };
    } catch (error) {
      this.options.onError?.(error, { environmentId });
      if (known !== undefined) {
        this.options.onSnapshot?.({
          environmentId,
          version: known.version,
          source: "memory",
        });
        return { snapshot: known.snapshot, version: known.version, source: "memory" };
      }
      // The store is gone, compiling failed, and this node never held a snapshot for
      // this environment. There is genuinely nothing to serve.
      throw new Error(`featurekit: could not obtain a snapshot for ${environmentId}`);
    }
  }

  private async awaitStore(environmentId: string, attempts = 20): Promise<SnapshotResult | null> {
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const got = await this.options.store.get(environmentId).catch(() => null);
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
    const snapshot = compileSnapshot(input, {
      version,
      ...(this.options.segmentInlineMax !== undefined
        ? { segmentInlineMax: this.options.segmentInlineMax }
        : {}),
    });
    return { snapshot, version, compileMs: Date.now() - startedAt };
  }

  /**
   * Compile, cache, record a patch, and broadcast — under the compile lock.
   *
   * Returns `undefined` when another node holds the lock: that node is already
   * doing this work and will publish the result. Recompiling anyway would be
   * the thundering herd the lock exists to prevent.
   *
   * A compile that throws leaves the previous snapshot in place. Stale beats
   * wrong, and both beat empty.
   */
  async recompile(
    environmentId: string,
    options: RecompileOptions = {},
  ): Promise<SnapshotResult | undefined> {
    try {
      return await this.options.store.withCompileLock(environmentId, async () => {
        const previous = await this.options.store.get(environmentId).catch(() => null);
        const compiled = await this.compileOnly(environmentId).catch((error: unknown) => {
          throw new CompileFailure(error);
        });
        const { snapshot, version, compileMs } = compiled;

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
    } catch (error) {
      if (error instanceof CompileFailure) {
        // Postgres, or a ruleset that will not compile. The previous snapshot is
        // untouched and keeps serving; the caller still hears about it, because a
        // management write that reports success for an uncompilable change is how
        // an operator believes a kill switch landed when it did not.
        throw error.cause;
      }
      // The store failed somewhere in the publish sequence. The configuration is
      // already committed in Postgres, so the change is not lost — but this node
      // must still be able to serve it, which is what the degraded path does.
      this.options.onError?.(error, { environmentId });
      return this.degraded(environmentId).catch(() => undefined);
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
      void this.recompile(environmentId, only !== undefined ? { flagKey: only } : {}).catch(
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
        return this.recompile(environmentId);
      }
    }
    return this.recompile(environmentId, flagKey !== undefined ? { flagKey } : {});
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
