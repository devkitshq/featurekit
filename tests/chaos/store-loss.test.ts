/**
 * The control plane when its snapshot store fails.
 *
 * The configuration tables are truth and the snapshot store is a disposable
 * cache. Before this suite existed, that was an assertion: `SnapshotService.get`
 * read the store on every request and propagated the failure, so a store
 * outage turned `GET /v1/snapshot/:env` into a 500 for every SDK in the fleet —
 * a flag outage caused by a cache.
 *
 * What is asserted here:
 *
 * - a warm node keeps serving through a total store failure;
 * - a cold node compiles straight from Postgres instead of failing;
 * - it does that at a bounded rate, so an outage does not become a compile storm
 *   against the one healthy component left;
 * - a snapshot version never goes backwards, even if the store hands back an
 *   older one (Scenario D);
 * - a kill switch does not wait for the debounce.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySnapshotStore } from "../../src/snapshot/memory-store.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import type { SnapshotStore } from "../../src/snapshot/store.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

const ENV = "env-1";
const services: SnapshotService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  vi.useRealTimers();
});

function input(flagKeys: string[] = ["f"]): CompilerInput {
  return {
    environment: { id: ENV, key: "production", bucketSalt: "salt" },
    flags: flagKeys.map((key) => ({
      id: `flag-${key}`,
      key,
      kind: "boolean" as const,
      archivedAt: null,
      clientAvailable: true,
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

/** A store that can be switched off, the way a dependency switches off. */
class FlakyStore implements SnapshotStore {
  failing = false;
  constructor(private readonly inner = new MemorySnapshotStore()) {}

  private guard(): void {
    if (this.failing) throw new Error("READONLY You can't write against a read only replica.");
  }
  async get(environmentId: string) {
    this.guard();
    return this.inner.get(environmentId);
  }
  async put(environmentId: string, snapshot: Parameters<MemorySnapshotStore["put"]>[1]) {
    this.guard();
    return this.inner.put(environmentId, snapshot);
  }
  async appendPatch(...args: Parameters<MemorySnapshotStore["appendPatch"]>) {
    this.guard();
    return this.inner.appendPatch(...args);
  }
  async patchesSince(...args: Parameters<MemorySnapshotStore["patchesSince"]>) {
    this.guard();
    return this.inner.patchesSince(...args);
  }
  async publish(...args: Parameters<MemorySnapshotStore["publish"]>) {
    this.guard();
    return this.inner.publish(...args);
  }
  async subscribe(...args: Parameters<MemorySnapshotStore["subscribe"]>) {
    this.guard();
    return this.inner.subscribe(...args);
  }
  async withCompileLock<T>(environmentId: string, work: () => Promise<T>): Promise<T | undefined> {
    this.guard();
    return this.inner.withCompileLock(environmentId, work);
  }
}

function service(store: SnapshotStore, over: Partial<Parameters<typeof SnapshotService>[0]> = {}) {
  let version = 0;
  const created = new SnapshotService({
    store,
    loadInput: async () => input(),
    nextVersion: async () => ++version,
    debounceMs: 5,
    degradedCompileIntervalMs: 50,
    ...over,
  });
  services.push(created);
  return created;
}

describe("the store is gone", () => {
  it("keeps serving the last known good snapshot from memory", async () => {
    const store = new FlakyStore();
    const snapshots = service(store);
    const warm = await snapshots.get(ENV);
    expect(warm.version).toBeGreaterThan(0);

    store.failing = true;
    const degraded = await snapshots.get(ENV);

    expect(degraded.version).toBe(warm.version);
    expect(degraded.source).toBe("memory");
    expect(Object.keys(degraded.snapshot.flags)).toEqual(["f"]);
  });

  it("compiles from Postgres when the node is cold and the store is down", async () => {
    // Scenario C: the cache wiped, a node restarts. Postgres is truth, so there is
    // no reason for this to fail.
    const store = new FlakyStore();
    store.failing = true;
    const snapshots = service(store);

    const result = await snapshots.get(ENV);
    expect(result.source).toBe("postgres");
    expect(Object.keys(result.snapshot.flags)).toEqual(["f"]);
  });

  it("does not compile once per request during an outage", async () => {
    // Otherwise a store outage becomes a compile storm against the only healthy
    // component left, and burns a version per request besides.
    const store = new FlakyStore();
    store.failing = true;
    let compiles = 0;
    let version = 0;
    const snapshots = service(store, {
      loadInput: async () => {
        compiles++;
        return input();
      },
      nextVersion: async () => ++version,
      degradedCompileIntervalMs: 60_000,
    });

    for (let i = 0; i < 25; i++) await snapshots.get(ENV);
    expect(compiles).toBe(1);
  });

  it("throws only when the store, memory and compiling have all failed", async () => {
    const store = new FlakyStore();
    store.failing = true;
    const snapshots = service(store, {
      loadInput: async () => {
        throw new Error("postgres unreachable");
      },
    });
    await expect(snapshots.get(ENV)).rejects.toThrow(/could not obtain a snapshot/);
  });

  it("recovers to the store once it returns", async () => {
    const store = new FlakyStore();
    const snapshots = service(store);
    await snapshots.get(ENV);
    store.failing = true;
    expect((await snapshots.get(ENV)).source).toBe("memory");
    store.failing = false;
    expect((await snapshots.get(ENV)).source).toBe("store");
  });
});

describe("version regression", () => {
  it("never replaces a newer in-memory snapshot with an older one", async () => {
    // Scenario D: an API node — or a restored database — offers version 3 after
    // this node already served version 9.
    const store = new MemorySnapshotStore();
    let version = 10;
    const snapshots = service(store, { nextVersion: async () => version });

    const first = await snapshots.get(ENV);
    expect(first.version).toBe(10);

    // The store now regresses, as a restore or a replica would.
    version = 3;
    await store.put(ENV, { ...first.snapshot, version: 3 });
    await snapshots.get(ENV);

    expect(snapshots.knownVersion(ENV)).toBe(10);
  });
});

describe("kill switch propagation", () => {
  it("does not wait for the debounce", async () => {
    const store = new MemorySnapshotStore();
    let compiles = 0;
    let version = 0;
    const snapshots = service(store, {
      debounceMs: 5_000, // a debounce nobody would tolerate during an incident
      loadInput: async () => {
        compiles++;
        return input();
      },
      nextVersion: async () => ++version,
    });

    await snapshots.get(ENV);
    const before = compiles;
    await snapshots.notifyChangeImmediate(ENV, "f");
    expect(compiles).toBe(before + 1);
  });

  it("cancels a pending debounced compile rather than racing it", async () => {
    // A queued edit landing *after* the kill switch would undo the operator's
    // intent, which is the worst possible outcome for this path.
    const store = new MemorySnapshotStore();
    let version = 0;
    const snapshots = service(store, { debounceMs: 20, nextVersion: async () => ++version });

    await snapshots.get(ENV);
    snapshots.notifyChange(ENV, "other-flag");
    const result = await snapshots.notifyChangeImmediate(ENV, "f");
    const versionAfterKill = result?.version ?? 0;

    await new Promise((r) => setTimeout(r, 60));
    expect(snapshots.knownVersion(ENV)).toBe(versionAfterKill);
  });
});

describe("snapshot ages", () => {
  it("reports an age per environment for the readiness probe", async () => {
    const snapshots = service(new MemorySnapshotStore());
    await snapshots.get(ENV);
    expect(snapshots.ages().get(ENV)).toBeGreaterThanOrEqual(0);
  });
});
