/**
 * Snapshot versions with holes in them (review PR-B2).
 *
 * Versions are allocated from a durable counter, and not every allocation ends
 * up published. `compileOnly` loads the rows first and allocates second, so the
 * common failure (Postgres unreachable) costs nothing — but a ruleset that will
 * not *compile* fails after the number is taken, and that number is gone.
 * Versions 41, 43, 44 is a perfectly ordinary sequence for a production
 * environment that had one bad configuration on a busy afternoon.
 *
 * That is fine — but "fine" was an assumption, and versions are compared in
 * four separate places: the SDK's patch guard, the SSE `id:` a client resumes
 * from, the ETag a poller sends back, and the control plane's own
 * last-known-good. A gap that any one of them treated as "missing patch" rather
 * than "number we skipped" would freeze an environment on its last good
 * snapshot with nothing in the logs to explain it.
 *
 * So the property is asserted directly: **only strict monotonicity matters, not
 * contiguity.**
 */

import { afterEach, describe, expect, it } from "vitest";
import { MemorySnapshotStore } from "../../src/snapshot/memory-store.js";
import { SnapshotService } from "../../src/snapshot/service.js";
import { resumeFrom } from "../../src/snapshot/memory-store.js";
import type { StreamPatch } from "../../src/snapshot/store.js";
import type { CompilerInput } from "../../src/snapshot/compile.js";

const ENV = "env-1";
const services: SnapshotService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});

function input(): CompilerInput {
  return {
    environment: { id: ENV, key: "production", bucketSalt: "salt" },
    flags: [{ id: "f1", key: "f", kind: "boolean", archivedAt: null, clientAvailable: true }],
    variations: [
      { id: "v0", flagId: "f1", idx: 0, value: false },
      { id: "v1", flagId: "f1", idx: 1, value: true },
    ],
    flagEnvironments: [
      {
        id: "fe1",
        flagId: "f1",
        environmentId: ENV,
        enabled: true,
        offVariationId: "v0",
        fallthroughVariationId: "v1",
        fallthroughRollout: null,
        version: 1,
      },
    ],
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

describe("where a failed compile does and does not burn a version", () => {
  it("burns nothing when loading the input fails", async () => {
    // `compileOnly` loads the rows BEFORE allocating a version, so the common
    // failure — Postgres unreachable — costs no version at all. Worth pinning:
    // reordering those two lines would silently start punching holes in the
    // sequence on every database blip.
    const store = new MemorySnapshotStore();
    let version = 0;
    let failing = false;
    const service = new SnapshotService({
      store,
      loadInput: async () => {
        if (failing) throw new Error("database unreachable");
        return input();
      },
      // Allocated before the compile: a failure consumes the number.
      nextVersion: async () => ++version,
      debounceMs: 5,
    });
    services.push(service);

    const first = await service.get(ENV);
    expect(first.version).toBe(1);

    failing = true;
    await expect(service.recompile(ENV)).rejects.toThrow("database unreachable");
    await expect(service.recompile(ENV)).rejects.toThrow("database unreachable");

    failing = false;
    const recovered = await service.recompile(ENV);

    expect(recovered?.version).toBe(2);
    expect((await store.get(ENV))?.version).toBe(2);
  });

  it("burns a version when the compile itself fails, and carries on past the gap", async () => {
    // A ruleset that will not compile — a prerequisite cycle, a rule naming a
    // variation that no longer exists — fails after the version is allocated.
    // That gap is permanent and must be harmless.
    const store = new MemorySnapshotStore();
    const allocated: number[] = [];
    let version = 0;
    let poison = false;

    const service = new SnapshotService({
      store,
      loadInput: async () => {
        const rows = input();
        // A flag environment pointing at a variation that does not exist: the
        // compiler rejects this, after `nextVersion` has already run.
        if (poison) rows.flagEnvironments[0]!.fallthroughVariationId = "does-not-exist";
        return rows;
      },
      nextVersion: async () => {
        allocated.push(++version);
        return version;
      },
      debounceMs: 5,
    });
    services.push(service);

    await service.get(ENV);
    expect(allocated).toEqual([1]);

    poison = true;
    await expect(service.recompile(ENV)).rejects.toThrow();
    expect(allocated).toEqual([1, 2]); // 2 was allocated and never published

    poison = false;
    const recovered = await service.recompile(ENV);
    expect(recovered?.version).toBe(3);

    // The store never held 2, and the SDK-facing sequence is 1 then 3.
    expect((await store.get(ENV))?.version).toBe(3);
  });

  it("keeps serving the last good snapshot across the failures", async () => {
    const store = new MemorySnapshotStore();
    let version = 0;
    let failing = false;
    const service = new SnapshotService({
      store,
      loadInput: async () => {
        if (failing) throw new Error("nope");
        return input();
      },
      nextVersion: async () => ++version,
      debounceMs: 5,
    });
    services.push(service);

    const good = await service.get(ENV);
    failing = true;
    await expect(service.recompile(ENV)).rejects.toThrow();

    const still = await service.get(ENV);
    expect(still.version).toBe(good.version);
    expect(Object.keys(still.snapshot.flags)).toEqual(["f"]);
  });
});

describe("every version comparison tolerates a gap", () => {
  const patch = (version: number): StreamPatch => ({
    version,
    op: "patch",
    flagKey: "f",
    payload: { key: "f", version },
  });

  it("resumes across a non-contiguous history", () => {
    // Versions 41, 43, 44: 42 was burned by a failed compile. An SDK holding 41
    // must be resumable, not forced to a full `put`.
    const history = [patch(41), patch(43), patch(44)];
    expect(resumeFrom(history, 41)?.map((p) => p.version)).toEqual([43, 44]);
    expect(resumeFrom(history, 43)?.map((p) => p.version)).toEqual([44]);
  });

  it("still forces a full put when the SDK is genuinely too far behind", () => {
    const history = [patch(41), patch(43), patch(44)];
    expect(resumeFrom(history, 10)).toBeNull();
  });

  it("still forces a full put when the SDK claims to be ahead", () => {
    const history = [patch(41), patch(43), patch(44)];
    expect(resumeFrom(history, 99)).toBeNull();
  });

  it("treats the version before the oldest patch as resumable", () => {
    // The patch that would carry it forward is the one still retained.
    expect(resumeFrom([patch(43), patch(44)], 42)?.map((p) => p.version)).toEqual([43, 44]);
  });

  it("does not resume a version that predates the retained window", () => {
    expect(resumeFrom([patch(43), patch(44)], 41)).toBeNull();
  });

  it("the last-known-good guard compares by ordering, not by succession", async () => {
    const store = new MemorySnapshotStore();
    const versions = [10, 13, 14, 12, 20];
    let index = 0;
    const service = new SnapshotService({
      store,
      loadInput: async () => input(),
      nextVersion: async () => versions[index++] ?? 99,
      debounceMs: 5,
    });
    services.push(service);

    await service.recompile(ENV); // 10
    await service.recompile(ENV); // 13 — a gap, accepted
    expect(service.knownVersion(ENV)).toBe(13);
    await service.recompile(ENV); // 14
    expect(service.knownVersion(ENV)).toBe(14);
    await service.recompile(ENV); // 12 — older, must not win
    expect(service.knownVersion(ENV)).toBe(14);
    await service.recompile(ENV); // 20 — a large jump, accepted
    expect(service.knownVersion(ENV)).toBe(20);
  });
});
