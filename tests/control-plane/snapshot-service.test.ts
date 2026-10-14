import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySnapshotStore } from "../../src/snapshot/memory-store.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

const ENV = "env-1";

function baseInput(flagKeys: string[] = ["f"]): CompilerInput {
  return {
    environment: { id: ENV, key: "production", bucketSalt: "s4lt" },
    flags: flagKeys.map((key) => ({
      id: `flag-${key}`,
      key,
      kind: "boolean" as const,
      archivedAt: null,
      clientAvailable: false,
    })),
    variations: flagKeys.flatMap((key) => [
      { id: `flag-${key}-v0`, flagId: `flag-${key}`, idx: 0, value: false },
      { id: `flag-${key}-v1`, flagId: `flag-${key}`, idx: 1, value: true },
    ]),
    flagEnvironments: flagKeys.map((key) => ({
      id: `fe-${key}`,
      flagId: `flag-${key}`,
      environmentId: ENV,
      enabled: true,
      offVariationId: `flag-${key}-v0`,
      fallthroughVariationId: `flag-${key}-v1`,
      fallthroughRollout: null,
      version: 1,
    })),
    targets: [],
    rules: [],
    clauses: [],
    prerequisites: [],
    segments: [],
    segmentMembers: [],
    segmentRules: [],
    segmentRuleClauses: [],
  };
}

function makeService(over: Partial<ConstructorParameters<typeof SnapshotService>[0]> = {}) {
  const store = new MemorySnapshotStore();
  let version = 0;
  const loadInput = vi.fn(async () => baseInput());
  const service = new SnapshotService({
    store,
    loadInput,
    nextVersion: async () => ++version,
    debounceMs: 20,
    patchHistoryDepth: 200,
    ...over,
  });
  return { service, store, loadInput };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SnapshotService.get", () => {
  it("compiles on a cold cache and stores the result", async () => {
    const { service, store, loadInput } = makeService();
    const got = await service.get(ENV);
    expect(got.snapshot.flags["f"]).toBeDefined();
    expect(loadInput).toHaveBeenCalledTimes(1);
    expect((await store.get(ENV))?.version).toBe(got.version);
    await service.close();
  });

  it("serves the cache without recompiling", async () => {
    const { service, loadInput } = makeService();
    await service.get(ENV);
    await service.get(ENV);
    await service.get(ENV);
    expect(loadInput).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("collapses concurrent cold reads into a single compile", async () => {
    // Ten SDKs connecting to a cold node must not each trigger a compile.
    const { service, loadInput } = makeService();
    const results = await Promise.all(Array.from({ length: 10 }, () => service.get(ENV)));
    expect(loadInput).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.version)).size).toBe(1);
    await service.close();
  });
});

describe("SnapshotService.recompile", () => {
  it("allocates a new monotonic version each time", async () => {
    const { service } = makeService();
    const a = await service.recompile(ENV);
    const b = await service.recompile(ENV);
    expect(b!.version).toBeGreaterThan(a!.version);
    await service.close();
  });

  it("publishes the change and records a patch for resume", async () => {
    const { service, store } = makeService();
    const seen: number[] = [];
    const unsubscribe = await store.subscribe(ENV, (m) => seen.push(m.version));

    await service.recompile(ENV, { flagKey: "f" });

    const compiled = (await store.get(ENV))!;
    expect(seen).toEqual([compiled.version]);
    const patches = await store.patchesSince(ENV, compiled.version - 1, 200);
    expect(patches).toHaveLength(1);
    expect(patches![0]).toMatchObject({ op: "patch", flagKey: "f", version: compiled.version });
    await unsubscribe();
    await service.close();
  });

  it("records a delete patch when a flag is gone from the recompiled snapshot", async () => {
    const store = new MemorySnapshotStore();
    let version = 0;
    let keys = ["f", "doomed"];
    const { service } = {
      service: new SnapshotService({
        store,
        loadInput: async () => baseInput(keys),
        nextVersion: async () => ++version,
        debounceMs: 20,
        patchHistoryDepth: 200,
      }),
    };
    await service.recompile(ENV);
    keys = ["f"];
    await service.recompile(ENV, { flagKey: "doomed" });

    const patches = (await store.patchesSince(ENV, 1, 200))!;
    expect(patches.at(-1)).toMatchObject({ op: "delete", flagKey: "doomed" });
    await service.close();
  });

  it("does not poison the cache when a compile fails", async () => {
    // A compile that throws must leave the last good snapshot serving. That is
    // the whole reliability claim: stale beats wrong, and both beat empty.
    const store = new MemorySnapshotStore();
    let version = 0;
    let shouldFail = false;
    const service = new SnapshotService({
      store,
      loadInput: async () => {
        if (shouldFail) throw new Error("database unreachable");
        return baseInput();
      },
      nextVersion: async () => ++version,
      debounceMs: 20,
      patchHistoryDepth: 200,
    });

    const good = await service.get(ENV);
    shouldFail = true;
    await expect(service.recompile(ENV)).rejects.toThrow("database unreachable");

    const stillServing = await store.get(ENV);
    expect(stillServing?.version).toBe(good.version);
    expect(stillServing?.snapshot.flags["f"]).toBeDefined();
    await service.close();
  });

  it("skips when another node already holds the compile lock", async () => {
    const { service, store } = makeService();
    // Hold the lock from "another node" for the duration of the attempt.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockHeld = store.withCompileLock(ENV, async () => {
      await held;
    });

    expect(await service.recompile(ENV)).toBeUndefined();
    release!();
    await lockHeld;
    await service.close();
  });
});

describe("SnapshotService debounce", () => {
  it("coalesces a burst of changes into one compile", async () => {
    // Editing five rules in a dashboard session is five PATCHes. Recompiling
    // and broadcasting five times is five snapshots every connected SDK has to
    // apply, for one logical change.
    const { service, loadInput } = makeService({ debounceMs: 30 });
    for (let i = 0; i < 5; i++) service.notifyChange(ENV, `flag-${i}`);
    await vi.waitFor(() => expect(loadInput).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    await new Promise((r) => setTimeout(r, 60));
    expect(loadInput).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("compiles again for a change arriving after the window closes", async () => {
    const { service, loadInput } = makeService({ debounceMs: 20 });
    service.notifyChange(ENV, "a");
    await vi.waitFor(() => expect(loadInput).toHaveBeenCalledTimes(1));
    service.notifyChange(ENV, "b");
    await vi.waitFor(() => expect(loadInput).toHaveBeenCalledTimes(2));
    await service.close();
  });

  it("debounces per environment, so a busy staging cannot delay production", async () => {
    const { service, loadInput } = makeService({ debounceMs: 30 });
    service.notifyChange(ENV, "a");
    service.notifyChange("env-2", "a");
    await vi.waitFor(() => expect(loadInput).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    await service.close();
  });

  it("cancels pending work on close, so a shutting-down node compiles nothing", async () => {
    const { service, loadInput } = makeService({ debounceMs: 50 });
    service.notifyChange(ENV, "a");
    await service.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(loadInput).not.toHaveBeenCalled();
  });
});

describe("SnapshotService.applyRemoteChange", () => {
  it("adopts a snapshot another node compiled, without compiling itself", async () => {
    // The point of pub/sub: one node compiles, everyone else reads the result.
    const store = new MemorySnapshotStore();
    const loadInput = vi.fn(async () => baseInput());
    let version = 0;
    const writer = new SnapshotService({
      store,
      loadInput,
      nextVersion: async () => ++version,
      debounceMs: 5,
      patchHistoryDepth: 200,
    });
    const reader = new SnapshotService({
      store,
      loadInput: async () => {
        throw new Error("reader must not compile");
      },
      nextVersion: async () => {
        throw new Error("reader must not allocate a version");
      },
      debounceMs: 5,
      patchHistoryDepth: 200,
    });

    const compiled = await writer.recompile(ENV);
    const adopted = await reader.get(ENV);
    expect(adopted.version).toBe(compiled!.version);
    await writer.close();
    await reader.close();
  });
});
