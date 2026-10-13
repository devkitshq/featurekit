import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MemorySnapshotStore } from "../../src/redis/memory-store.js";
import { RedisSnapshotStore } from "../../src/redis/redis-store.js";
import type { SnapshotStore, StreamPatch } from "../../src/redis/snapshot-store.js";
import type { Snapshot } from "../../src/sdk/index.js";

const ENV = "env-1";

const snapshot = (version: number): Snapshot => ({
  version,
  environmentKey: "production",
  salt: "s4lt",
  flags: {},
  segments: {},
});

const patch = (version: number, flagKey = "f"): StreamPatch => ({
  version,
  op: "patch",
  flagKey,
  payload: { key: flagKey, version },
});

/**
 * One suite, run against every implementation. `SnapshotStore` is a plugin
 * ("Plugins are a class with one method"), so its contract has to be a
 * property of the interface rather than of whichever backend is convenient —
 * otherwise the in-memory store used by tests and the Redis store used in
 * production quietly diverge, and the tests stop meaning anything.
 */
function storeContract(name: string, create: () => Promise<SnapshotStore> | SnapshotStore) {
  describe(name, () => {
    let store: SnapshotStore;

    beforeEach(async () => {
      store = await create();
    });

    describe("snapshot cache", () => {
      it("returns null before anything is stored", async () => {
        expect(await store.get(ENV)).toBeNull();
      });

      it("round-trips a snapshot and its version", async () => {
        await store.put(ENV, snapshot(3));
        const got = await store.get(ENV);
        expect(got?.version).toBe(3);
        expect(got?.snapshot.environmentKey).toBe("production");
      });

      it("keeps environments separate", async () => {
        await store.put(ENV, snapshot(1));
        expect(await store.get("env-2")).toBeNull();
      });

      it("overwrites on a newer version", async () => {
        await store.put(ENV, snapshot(1));
        await store.put(ENV, snapshot(2));
        expect((await store.get(ENV))?.version).toBe(2);
      });

      it("survives a Uint8Array in a segment filter", async () => {
        // Cuckoo and roaring payloads are binary. A store that JSON-round-trips
        // them into `{"0":1,...}` produces a filter that answers `false` for
        // every member -- silent, and only visible weeks later.
        const withFilter: Snapshot = {
          ...snapshot(1),
          segments: {
            big: {
              kind: "cuckoo",
              version: 1,
              filter: new Uint8Array([1, 2, 3, 250]),
              fpRate: 0.00012,
              loadFactor: 0.8,
            },
          },
        };
        await store.put(ENV, withFilter);
        const got = await store.get(ENV);
        const segment = got!.snapshot.segments["big"]!;
        if (segment.kind !== "cuckoo") throw new Error("expected cuckoo");
        expect(segment.filter).toBeInstanceOf(Uint8Array);
        expect([...segment.filter]).toEqual([1, 2, 3, 250]);
      });
    });

    describe("patch history and resume", () => {
      it("replays patches strictly after the version the SDK holds", async () => {
        for (const v of [2, 3, 4]) await store.appendPatch(ENV, patch(v));
        const replay = await store.patchesSince(ENV, 2, 200);
        expect(replay?.map((p) => p.version)).toEqual([3, 4]);
      });

      it("returns an empty replay when the SDK is already current", async () => {
        await store.appendPatch(ENV, patch(2));
        expect(await store.patchesSince(ENV, 2, 200)).toEqual([]);
      });

      it("returns null when history cannot cover the gap", async () => {
        // The SDK was disconnected across more than PATCH_HISTORY_DEPTH
        // changes. null means "send a full put", which is both correct and
        // cheaper than replay.
        for (const v of [5, 6, 7]) await store.appendPatch(ENV, patch(v));
        expect(await store.patchesSince(ENV, 1, 200)).toBeNull();
      });

      it("returns null when history is empty (Redis restarted)", async () => {
        expect(await store.patchesSince(ENV, 5, 200)).toBeNull();
      });

      it("returns null when the SDK claims to be ahead of history", async () => {
        // Should not happen; indicates a rolled-back database. A full put is
        // the only safe answer.
        await store.appendPatch(ENV, patch(2));
        expect(await store.patchesSince(ENV, 99, 200)).toBeNull();
      });

      it("caps history at the configured depth, dropping oldest", async () => {
        for (let v = 2; v <= 12; v++) await store.appendPatch(ENV, patch(v), 5);
        // Only the last 5 are retained, so a resume from before them is a put.
        expect(await store.patchesSince(ENV, 2, 5)).toBeNull();
        const recent = await store.patchesSince(ENV, 10, 5);
        expect(recent?.map((p) => p.version)).toEqual([11, 12]);
      });

      it("carries delete and segment-patch ops, not just flag patches", async () => {
        await store.appendPatch(ENV, { version: 2, op: "delete", flagKey: "gone", payload: {} });
        await store.appendPatch(ENV, {
          version: 3,
          op: "segment-patch",
          flagKey: "beta",
          payload: { segmentKey: "beta", version: 3, add: ["usr_1"], remove: [] },
        });
        const replay = await store.patchesSince(ENV, 1, 200);
        expect(replay?.map((p) => p.op)).toEqual(["delete", "segment-patch"]);
      });

    describe("commit", () => {
      it("applies the snapshot, the patches and the broadcast together", async () => {
        const seen: number[] = [];
        await store.subscribe(ENV, (m) => seen.push(m.version));

        await store.commit(ENV, snapshot(5), [patch(5)], { version: 5 }, 200);

        expect((await store.get(ENV))?.version).toBe(5);
        expect((await store.patchesSince(ENV, 4, 200))?.map((p) => p.version)).toEqual([5]);
        // Redis pub/sub delivery is asynchronous; the memory store is not.
        await vi.waitFor(() => expect(seen).toEqual([5]));
      });

      it("never broadcasts a version the store does not yet hold", async () => {
        // The failure this replaces: put, then patches, then publish, as three
        // round trips. A subscriber woken by the broadcast could read the
        // PREVIOUS snapshot under the new version and cache it — a stale
        // configuration that looks fresh.
        const observed: Array<{ broadcast: number; stored: number | undefined }> = [];
        await store.subscribe(ENV, (m) => {
          void store.get(ENV).then((got) => {
            observed.push({ broadcast: m.version, stored: got?.version });
          });
        });

        for (let v = 1; v <= 10; v++) {
          await store.commit(ENV, snapshot(v), [patch(v)], { version: v }, 200);
        }
        await new Promise((r) => setTimeout(r, 50));

        expect(observed.length).toBeGreaterThan(0);
        for (const { broadcast, stored } of observed) {
          expect(stored).toBeGreaterThanOrEqual(broadcast);
        }
      });

      it("accepts a commit with no patches", async () => {
        // A full recompile that changed nothing still has to move the version.
        await store.commit(ENV, snapshot(2), [], { version: 2 }, 200);
        expect((await store.get(ENV))?.version).toBe(2);
      });

      it("honours the retention depth", async () => {
        for (let v = 2; v <= 12; v++) {
          await store.commit(ENV, snapshot(v), [patch(v)], { version: v }, 5);
        }
        expect(await store.patchesSince(ENV, 2, 5)).toBeNull();
        expect((await store.patchesSince(ENV, 11, 5))?.map((p) => p.version)).toEqual([12]);
      });

      it("carries a targeted flag key on the broadcast", async () => {
        const seen: Array<string | undefined> = [];
        await store.subscribe(ENV, (m) => seen.push(m.flagKey));
        await store.commit(ENV, snapshot(2), [patch(2, "checkout")], {
          version: 2,
          flagKey: "checkout",
        });
        await vi.waitFor(() => expect(seen).toEqual(["checkout"]));
      });
    });

    });

    describe("pub/sub fan-out", () => {
      it("delivers a published change to a subscriber", async () => {
        const seen: number[] = [];
        const unsubscribe = await store.subscribe(ENV, (message) => seen.push(message.version));
        await store.publish(ENV, { version: 9 });
        await vi.waitFor(() => expect(seen).toEqual([9]));
        await unsubscribe();
      });

      it("stops delivering after unsubscribe", async () => {
        const seen: number[] = [];
        const unsubscribe = await store.subscribe(ENV, (m) => seen.push(m.version));
        await store.publish(ENV, { version: 1 });
        await vi.waitFor(() => expect(seen).toHaveLength(1));
        await unsubscribe();
        await store.publish(ENV, { version: 2 });
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toEqual([1]);
      });

      it("does not deliver another environment's changes", async () => {
        const seen: number[] = [];
        const unsubscribe = await store.subscribe(ENV, (m) => seen.push(m.version));
        await store.publish("env-other", { version: 5 });
        await new Promise((r) => setTimeout(r, 50));
        expect(seen).toEqual([]);
        await unsubscribe();
      });
    });

    describe("compile lock", () => {
      it("runs the work and returns its result", async () => {
        expect(await store.withCompileLock(ENV, async () => "compiled")).toBe("compiled");
      });

      it("prevents a thundering herd: only one holder compiles at a time", async () => {
        // Ten API nodes react to the same change. Exactly one should compile;
        // the rest should see the lock held and skip.
        let running = 0;
        let maxConcurrent = 0;
        let skipped = 0;
        await Promise.all(
          Array.from({ length: 10 }, () =>
            store.withCompileLock(ENV, async () => {
              running++;
              maxConcurrent = Math.max(maxConcurrent, running);
              await new Promise((r) => setTimeout(r, 20));
              running--;
            }).then((result) => {
              if (result === undefined) skipped++;
            }),
          ),
        );
        expect(maxConcurrent).toBe(1);
        expect(skipped).toBeGreaterThan(0);
      });

      it("releases the lock even when the work throws", async () => {
        await expect(
          store.withCompileLock(ENV, () => Promise.reject(new Error("compile failed"))),
        ).rejects.toThrow("compile failed");
        // The next attempt must not be locked out by the failed one.
        expect(await store.withCompileLock(ENV, async () => "ok")).toBe("ok");
      });
    });
  });
}

import { vi } from "vitest";
import { containerUnavailableReason, startInfrastructure } from "../integration/harness.js";

storeContract("MemorySnapshotStore", () => new MemorySnapshotStore());

const reason = await containerUnavailableReason();

describe("RedisSnapshotStore", () => {
  it(
    reason === null
      ? "container runtime available; Redis store contract runs"
      : `Redis store contract SKIPPED — ${reason}`,
    () => {
      expect(true).toBe(true);
    },
  );
});

if (reason === null) {
  const infra = await startInfrastructure();
  const stores: RedisSnapshotStore[] = [];
  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()));
    await infra.stop();
  });
  storeContract("RedisSnapshotStore", () => {
    const store = new RedisSnapshotStore({ url: infra.redisUrl, keyPrefix: `t${Date.now()}${Math.random()}` });
    stores.push(store);
    return store;
  });
}
