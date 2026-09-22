/**
 * `TogglekitSDK` — the server-tier SDK (§11.2, §14).
 *
 * The three properties this class exists to guarantee:
 *
 * 1. **Every evaluation is synchronous** and reads an in-memory snapshot. No
 *    network call per check, no promise per check.
 * 2. **It survives the server being gone.** Bootstrap → persisted snapshot →
 *    last-known-good in memory → the caller's default. It never blocks and
 *    never throws.
 * 3. **`ready()` never rejects.** It times out into "serving defaults", which
 *    is a legitimate state to run in, not an error.
 *
 * Zero runtime dependencies. Node's `fetch` and `ReadableStream` are used
 * directly rather than an SSE library, so the same file works in Node, Deno,
 * Bun and an edge runtime.
 *
 * @see docs/sdk/server-sdk.md
 */

import { evaluate } from "../evaluation/evaluate.js";
import { SegmentIndex, type SegmentCacheProvider } from "../evaluation/segments.js";
import type {
  CompiledFlag,
  EvaluationContext,
  EvaluationDetail,
  Snapshot,
} from "../evaluation/types.js";
import { EventSummarizer } from "../events/summarizer.js";

export type SdkState = "initializing" | "connected" | "reconnecting" | "offline";

export interface SnapshotPersistence {
  load(): Promise<Snapshot | null> | Snapshot | null;
  save(snapshot: Snapshot): Promise<void> | void;
}

export interface TogglekitSdkOptions {
  sdkKey: string;
  baseUrl?: string;
  /**
   * The environment this key is for. Optional: the key already names the
   * environment server-side, and the server rejects a mismatch. Supplying it
   * makes the URL self-describing in a proxy log, which is worth the field.
   */
  environmentKey?: string;
  /**
   * A snapshot committed to the repo. The SDK is usable at import time, before
   * the first network round trip — the difference between a cold start serving
   * correct flags and one serving defaults.
   */
  bootstrap?: Snapshot;
  /** Survive a restart that happens during a control-plane outage. */
  persist?: { kind: "file"; path: string } | SnapshotPersistence;
  /** Where large-segment membership is confirmed (§9.7). */
  segmentCache?: SegmentCacheProvider;
  mode?: "streaming" | "polling" | "offline";
  pollIntervalMs?: number;
  events?: { enabled?: boolean; flushIntervalMs?: number; maxBuckets?: number };
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
}


type Listener = (payload: never) => void;

export class TogglekitSDK {
  private snapshot: Snapshot | null = null;
  private segments = new SegmentIndex({});
  private currentState: SdkState = "initializing";
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly summarizer: EventSummarizer;

  private abort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private persistence: SnapshotPersistence | null = null;

  private readyResolve: (() => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private isReady = false;

  constructor(private readonly options: TogglekitSdkOptions) {
    this.summarizer = new EventSummarizer(
      options.events?.maxBuckets !== undefined ? { maxBuckets: options.events.maxBuckets } : {},
    );
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    // Bootstrap is applied synchronously in the constructor, so a caller that
    // never awaits `ready()` still evaluates real flags on its first request.
    if (options.bootstrap !== undefined) this.applySnapshot(options.bootstrap, { persist: false });
    if (options.segmentCache !== undefined) this.segments.setCache(options.segmentCache);

    void this.start();
  }

  /* ───────────────────────────── lifecycle ──────────────────────────── */

  private async start(): Promise<void> {
    try {
      this.persistence = await this.resolvePersistence();
      if (this.snapshot === null && this.persistence !== null) {
        const stored = await this.persistence.load();
        // Only if the network has not already won the race.
        if (stored !== null && this.snapshot === null) {
          this.applySnapshot(stored, { persist: false });
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    }

    if (this.options.events?.enabled !== false && this.mode !== "offline") {
      this.flushTimer = setInterval(
        () => void this.flushEvents(),
        this.options.events?.flushIntervalMs ?? 5_000,
      );
      this.flushTimer.unref?.();
    }

    if (this.mode === "offline") {
      // Offline never touches the network. If bootstrap or persistence gave us
      // a snapshot we are ready; otherwise we are ready to serve defaults.
      this.setState("offline");
      this.markReady();
      return;
    }

    if (this.mode === "polling") {
      await this.poll();
      this.pollIntervalHandle();
      return;
    }
    void this.connectStream();
  }

  private get mode(): "streaming" | "polling" | "offline" {
    return this.options.mode ?? "streaming";
  }

  private pollIntervalHandle(): void {
    this.pollTimer = setInterval(
      () => void this.poll(),
      this.options.pollIntervalMs ?? 30_000,
    );
    this.pollTimer.unref?.();
  }

  private async resolvePersistence(): Promise<SnapshotPersistence | null> {
    const persist = this.options.persist;
    if (persist === undefined) return null;
    if (!("kind" in persist)) return persist;

    // Imported dynamically so a browser or edge bundle never pulls in `node:fs`
    // merely because this file was included.
    const { mkdir, readFile, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { deserialize, serialize } = await import("./codec.js");
    const path = persist.path;
    return {
      load: async () => {
        try {
          return deserialize(await readFile(path, "utf8"));
        } catch {
          // A missing or corrupt file is not an error: it is the ordinary
          // first-run state, and a corrupt one must not stop the process.
          return null;
        }
      },
      save: async (snapshot) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, serialize(snapshot), "utf8");
      },
    };
  }

  /**
   * Resolves when a snapshot is in hand from any source — stream, poll,
   * persisted file, or bootstrap.
   *
   * **Rejects nothing.** It times out into "serving defaults", which is a
   * legitimate state to run in. A `ready()` that throws turns a control-plane
   * outage into a failed deploy.
   */
  ready(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.isReady) return Promise.resolve();
    const timeoutMs = options.timeoutMs ?? 5_000;
    return Promise.race([
      this.readyPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  private markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    this.readyResolve?.();
  }

  get state(): SdkState {
    return this.currentState;
  }

  /** True once a snapshot is held. False means every call serves its default. */
  get initialized(): boolean {
    return this.snapshot !== null;
  }

  get snapshotVersion(): number | null {
    return this.snapshot?.version ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    await this.flushEvents();
  }

  /* ───────────────────────────── evaluation ─────────────────────────── */

  /**
   * One read, for every flag type.
   *
   * ```ts
   * flags.get("new-checkout", context, false);        // boolean
   * flags.get("loyalty-discount", context, 0);        // number
   * flags.get("checkout-flow", context, "classic");   // string
   * flags.get("theme", context, { accent: "blue" });  // json
   * ```
   *
   * **A context per call**, which is the signature difference from
   * `togglekit-client`: this SDK holds the ruleset, so one instance answers
   * for every identity your process serves. Nothing is held per user and there
   * is no network call, so a request handler can evaluate for whoever it is
   * serving without an instance, a round trip, or a promise.
   *
   * **The default is required**, and it does two jobs. It states what happens
   * when togglekit is unavailable — an optional default produces `undefined`
   * in production during an outage, and `if (undefined)` is a silent wrong
   * answer nobody notices for a week. And its type is the expected type, so
   * `get("new-checkout", ctx, false)` is a `boolean` with no annotation.
   *
   * Type safety comes from the flag's declared `kind` rather than from this
   * default: a snapshot serving a string for a boolean flag yields
   * `ERROR / WRONG_TYPE` and your default, whatever you passed (§9.2).
   */
  get<T>(flagKey: string, context: EvaluationContext, defaultValue: T): T {
    return this.detail<T>(flagKey, context, defaultValue).value;
  }

  detail<T>(
    flagKey: string,
    context: EvaluationContext,
    defaultValue: T,
  ): EvaluationDetail<T> {
    const snapshot = this.snapshot;
    if (snapshot === null) {
      // No snapshot from any source. The caller's default is the answer, and
      // `togglekit_sdk_default_served_total` is what should page.
      const detail: EvaluationDetail<T> = {
        value: defaultValue,
        variationIndex: null,
        reason: { kind: "FLAG_NOT_FOUND" },
      };
      this.recordEvaluation(flagKey, detail, context);
      return detail;
    }

    const detail = evaluate(flagKey, context, snapshot, defaultValue, {
      segments: this.segments,
    });
    this.recordEvaluation(flagKey, detail, context);
    return detail;
  }

  private recordEvaluation(
    flagKey: string,
    detail: EvaluationDetail<unknown>,
    context: EvaluationContext,
  ): void {
    if (this.options.events?.enabled === false) return;
    const key = (context as { key?: unknown }).key;
    this.summarizer.record(
      flagKey,
      detail.variationIndex,
      detail.reason.kind,
      typeof key === "string" ? key : undefined,
    );
  }

  /* ───────────────────────────── transport ──────────────────────────── */

  private get baseUrl(): string {
    return (this.options.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  }

  private get fetch(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.options.sdkKey}`, ...extra };
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    try {
      const { deserialize } = await import("./codec.js");
      const etag = this.snapshot === null ? undefined : `"${this.snapshot.version}"`;
      const response = await this.fetch(`${this.baseUrl}/v1/snapshot/${this.environmentPath()}`, {
        headers: this.headers(etag === undefined ? {} : { "if-none-match": etag }),
      });
      if (response.status === 304) {
        this.setState("connected");
        this.markReady();
        return;
      }
      if (!response.ok) throw new Error(`snapshot poll failed: ${response.status}`);
      this.applySnapshot(deserialize(await response.text()), { persist: true });
      this.setState("connected");
    } catch (error) {
      this.options.onError?.(error);
      this.setState("reconnecting");
      // A failed poll is not fatal: the last good snapshot keeps serving and
      // the next interval tries again.
      this.markReady();
    }
  }

  /**
   * The environment segment of the SDK-facing URLs.
   *
   * The key names the environment server-side, so the SDK does not need to know
   * it — but the routes take one for symmetry with the management API. `-` is
   * accepted by the server as "whatever this key is for".
   */
  private environmentPath(): string {
    return this.options.environmentKey ?? "-";
  }

  private async connectStream(): Promise<void> {
    if (this.closed) return;
    this.abort = new AbortController();
    try {
      const headers = this.headers(
        this.snapshot === null ? {} : { "last-event-id": String(this.snapshot.version) },
      );
      const response = await this.fetch(`${this.baseUrl}/v1/stream/${this.environmentPath()}`, {
        headers,
        signal: this.abort.signal,
      });

      if (response.status === 503) {
        // The server shed us to polling rather than accepting a connection it
        // cannot serve. That is a curve, not a cliff — take the hint.
        this.setState("connected");
        await this.poll();
        this.pollIntervalHandle();
        return;
      }
      if (!response.ok || response.body === null) {
        throw new Error(`stream failed: ${response.status}`);
      }

      this.setState("connected");
      this.reconnectAttempt = 0;
      await this.consume(response.body);
      // A clean end of stream is still a disconnect.
      if (!this.closed) this.scheduleReconnect();
    } catch (error) {
      if (this.closed) return;
      this.options.onError?.(error);
      // Never block startup on a control plane that is down.
      this.markReady();
      this.scheduleReconnect();
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const { deserialize } = await import("./codec.js");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!this.closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Anything short of one is a
      // partial frame and must stay in the buffer.
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        this.handleFrame(frame, deserialize);
      }
    }
  }

  private handleFrame(frame: string, deserialize: (text: string) => Snapshot): void {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // comment / heartbeat
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data.length === 0) return;

    try {
      if (event === "put") {
        this.applySnapshot(deserialize(data), { persist: true });
      } else if (event === "patch") {
        this.applyPatch(JSON.parse(data) as CompiledFlag);
      } else if (event === "delete") {
        this.applyDelete(JSON.parse(data) as { key: string });
      } else if (event === "segment-patch") {
        const payload = JSON.parse(data) as {
          segmentKey: string;
          version: number;
          add: string[];
          remove: string[];
        };
        this.segments.applyDelta(payload.segmentKey, payload.version, payload);
      }
    } catch (error) {
      // A malformed frame must not tear down a healthy stream.
      this.options.onError?.(error);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.setState("reconnecting");
    const attempt = Math.min(this.reconnectAttempt++, 6);
    const base = Math.min(1_000 * 2 ** attempt, 30_000);
    // Full jitter. Without it, a control-plane restart is followed by every
    // SDK in the fleet reconnecting in the same millisecond.
    const delay = Math.random() * base;
    this.reconnectTimer = setTimeout(() => void this.connectStream(), delay);
    this.reconnectTimer.unref?.();
  }

  /* ─────────────────────────── snapshot state ───────────────────────── */

  private applySnapshot(snapshot: Snapshot, options: { persist: boolean }): void {
    // Version guard: an out-of-order or duplicate delivery is a non-event
    // rather than a corruption.
    if (this.snapshot !== null && snapshot.version < this.snapshot.version) return;

    this.snapshot = snapshot;
    this.segments = new SegmentIndex(snapshot.segments);
    if (this.options.segmentCache !== undefined) this.segments.setCache(this.options.segmentCache);
    this.markReady();
    this.emit("change", { flagKey: null });
    if (options.persist && this.persistence !== null) {
      void Promise.resolve(this.persistence.save(snapshot)).catch((error: unknown) =>
        this.options.onError?.(error),
      );
    }
  }

  private applyPatch(flag: CompiledFlag): void {
    const snapshot = this.snapshot;
    if (snapshot === null) return;
    const existing = snapshot.flags[flag.key];
    // Per-flag version guard (§10.2): discard any patch at or below what we hold.
    if (existing !== undefined && flag.version <= existing.version) return;

    this.snapshot = {
      ...snapshot,
      flags: { ...snapshot.flags, [flag.key]: flag },
    };
    this.markReady();
    this.emit("change", { flagKey: flag.key });
  }

  private applyDelete(payload: { key: string }): void {
    const snapshot = this.snapshot;
    if (snapshot === null) return;
    const { [payload.key]: _removed, ...rest } = snapshot.flags;
    this.snapshot = { ...snapshot, flags: rest };
    this.emit("change", { flagKey: payload.key });
  }

  private setState(state: SdkState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emit("state", state);
  }

  /* ─────────────────────────────── events ───────────────────────────── */

  private async flushEvents(): Promise<void> {
    if (this.summarizer.size === 0) return;
    const batch = this.summarizer.flush();
    if (this.mode === "offline") return;
    try {
      await this.fetch(`${this.baseUrl}/v1/events`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(batch),
      });
    } catch (error) {
      // Fire and forget. A failed flush drops a batch rather than retrying
      // into a buffer that grows without bound (§14).
      this.options.onError?.(error);
    }
  }

  /* ─────────────────────────────── emitter ──────────────────────────── */

  on(event: "change", handler: (payload: { flagKey: string | null }) => void): () => void;
  on(event: "state", handler: (state: SdkState) => void): () => void;
  on(event: string, handler: (payload: never) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
    return () => set.delete(handler);
  }

  private emit(event: string, payload: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        (handler as (p: unknown) => void)(payload);
      } catch (error) {
        // A throwing listener must not break snapshot application.
        this.options.onError?.(error);
      }
    }
  }
}
