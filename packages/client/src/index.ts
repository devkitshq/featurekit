/**
 * `featurekit-client` — the client-tier SDK.
 *
 * **This SDK never receives the ruleset.** It receives evaluated values for one
 * context. That is a real architectural split, not a deployment detail: shipping
 * rules to a client leaks the business, not just the values — an unreleased
 * pricing tier's name, your churn-risk cohort's definition, your release plan.
 * A mobile binary a stranger can unzip makes that sharper, not softer.
 *
 * ```ts
 * const flags = new FeaturekitClient({ clientKey, baseUrl, context: user });
 * await flags.ready();
 *
 * flags.get("new-checkout", false);
 * ```
 *
 * One read for every type, and **no context argument**, because the connection
 * *is* the context. One instance serves one identity.
 * A process that answers for many identities at once — a backend handling
 * concurrent requests — needs one instance per identity, or it will serve one
 * user's flags to another. See `identify()`.
 *
 * **One client, no framework bindings.** It runs in a browser, React Native,
 * Node, Deno, Bun and edge runtimes, and it knows about none of them. Reads are
 * synchronous and `on("change")` returns an unsubscribe function, which is
 * every hook, store adapter and observable anyone needs — twenty lines in your
 * own codebase, where you can see it, rather than a framework package per
 * framework that lags the framework. `docs/client-tier/adapters.md` has those
 * twenty lines for React, Vue and Svelte.
 *
 * Not writing JavaScript at all? The two endpoints this wraps are a plain HTTP
 * contract any language can implement — see `docs/client-tier/http.md`.
 *
 * Zero runtime dependencies.
 *
 * @see docs/client-tier/client-sdk.md
 */

export type ClientState = "initializing" | "ready" | "identifying" | "offline";

export interface FlagValue {
  value: unknown;
  variationIndex: number | null;
  reason: string;
}

export interface FlagStateResponse {
  contextHash: string;
  seq: number;
  version: number;
  values: Record<string, FlagValue>;
  connectionId: string;
}

export interface EvaluationContextLike {
  key: string;
  [attribute: string]: unknown;
}

export interface SignaturePair {
  signature: string;
  expiresAt: number;
}

export interface FeaturekitClientOptions {
  clientKey: string;
  baseUrl: string;
  context: EvaluationContextLike;
  /** HMAC over `${key}:${expiresAt}`, minted by your own server. */
  contextSignature?: string;
  contextSignatureExpiresAt?: number;
  /** Called before expiry; returns a fresh pair. */
  onSignatureExpiring?: () => Promise<SignaturePair> | SignaturePair;
  /** Values inlined by SSR, so first paint uses what the server rendered. */
  bootstrap?: FlagStateResponse | Record<string, FlagValue>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
  stream?: boolean;
}


type Listener = (payload: never) => void;

export class FeaturekitClient {
  private values: Record<string, FlagValue> = {};
  private context: EvaluationContextLike;
  private currentState: ClientState = "initializing";
  private readonly listeners = new Map<string, Set<Listener>>();

  /** Monotonic per SDK instance. Sent with every request, echoed in every response. */
  private seq = 0;
  /** Highest `seq` whose response has been applied. */
  private appliedSeq = 0;
  /**
   * The context key each in-flight request was issued for, by `seq`.
   *
   * The client cannot recompute the server's `contextHash` without shipping the
   * same canonicalisation, so the identity half of the guard is enforced with
   * what the client does know: which context a given request was made for.
   */
  private readonly inFlight = new Map<number, string>();
  /** Hash of the context currently held, from the last applied response. */
  private currentHash: string | null = null;
  private connectionId: string | null = null;
  private eventSource: { close: () => void } | null = null;
  private abort: AbortController | null = null;
  private closed = false;

  private signature: SignaturePair | null = null;
  private readyResolve: (() => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private isReady = false;

  constructor(private readonly options: FeaturekitClientOptions) {
    this.context = options.context;
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    if (options.contextSignature !== undefined && options.contextSignatureExpiresAt !== undefined) {
      this.signature = {
        signature: options.contextSignature,
        expiresAt: options.contextSignatureExpiresAt,
      };
    }

    if (options.bootstrap !== undefined) {
      // SSR: first paint uses the same values the server rendered, so there is
      // no flag flicker and the payload leaks nothing.
      const bootstrap = options.bootstrap;
      if ("values" in bootstrap && typeof bootstrap.values === "object") {
        this.values = { ...(bootstrap as FlagStateResponse).values };
        this.currentHash = (bootstrap as FlagStateResponse).contextHash;
      } else {
        this.values = { ...(bootstrap as Record<string, FlagValue>) };
      }
      this.markReady("ready");
    }

    void this.refresh();
  }

  /* ─────────────────────────── synchronous reads ────────────────────── */

  /**
   * One read, for every flag type.
   *
   * ```ts
   * flags.get("new-checkout", false);        // boolean
   * flags.get("loyalty-discount", 0);        // number
   * flags.get("checkout-flow", "classic");   // string
   * flags.get("theme", { accent: "blue" });  // json
   * ```
   *
   * **No context argument**, because the connection *is* the context.
   *
   * **The default is required**, and it does two jobs. It states what happens
   * when featurekit is unavailable — the one decision a flag SDK must not make
   * on your behalf, because an optional default produces `undefined` during an
   * outage and `if (undefined)` is a wrong answer that reads like a right one.
   * And its type is the expected type: `T` is inferred from it, so
   * `get("new-checkout", false)` is `boolean` with no annotation.
   *
   * **Synchronous, and it stays that way.** Values are already in memory; there
   * is no request behind this call. That is what lets it be called during a
   * render, where a promise cannot. `await flags.get(…)` is still valid if you
   * prefer the shape — awaiting a plain value is a no-op — but nothing is
   * gained by it.
   */
  get<T>(flagKey: string, defaultValue: T): T {
    const found = this.values[flagKey];
    if (found === undefined) return defaultValue;

    // A wrong-typed value must not reach the caller in place of its default.
    // A flag whose type was changed in the dashboard, or a stale value held
    // across that change, otherwise hands a string to `if (flags.get(k, false))`
    // — which is truthy for "false".
    const expected = typeof defaultValue;
    if (expected === "boolean" || expected === "number" || expected === "string") {
      return typeof found.value === expected ? (found.value as T) : defaultValue;
    }

    // Objects, arrays and null: passed through. Their shape is the caller's to
    // know, and a structural check here would be a schema nobody declared.
    return found.value as T;
  }

  detail(flagKey: string): FlagValue | undefined {
    return this.values[flagKey];
  }

  /** Every value currently held. Used by the React binding's store snapshot. */
  allValues(): Readonly<Record<string, FlagValue>> {
    return this.values;
  }

  get state(): ClientState {
    return this.currentState;
  }

  ready(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.isReady) return Promise.resolve();
    return Promise.race([
      this.readyPromise,
      new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs ?? 2_000)),
    ]);
  }

  /* ───────────────────────────── identify ───────────────────────────── */

  /**
   * The one async operation.
   *
   * **One instance, one identity.** Reads take no context because this instance
   * holds exactly one; `identify()` replaces it. In a browser or a mobile app
   * that is the whole point — there is one user on the device. In a process
   * serving many users concurrently it is a hazard: a shared instance whose
   * identity is swapped per request will answer a request for user B with
   * whatever the last `identify()` left behind. Build one instance per identity
   * there, or evaluate with the server SDK, which takes a context per call.
   *
   * **On a context-key change, previous values are discarded, not reused.**
   * Serving user A's flags to user B after a login is a real bug class and a
   * privacy leak. Between `identify()` and its response every lookup returns
   * the caller's default. Attribute-only changes on the same key keep serving
   * the old values, since those are stale but not misattributed.
   */
  async identify(context: EvaluationContextLike): Promise<void> {
    const keyChanged = context.key !== this.context.key;
    this.context = context;
    if (keyChanged) {
      this.values = {};
      this.currentHash = null;
      this.setState("identifying");
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.closed) return;

    // Allocated BEFORE the await, so ordering reflects call order.
    const seq = ++this.seq;
    const contextAtCall = this.context;
    this.inFlight.set(seq, contextAtCall.key);

    try {
      await this.ensureSignature();
      const response = await this.fetch(`${this.options.baseUrl}/v1/client/state`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.clientKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          context: contextAtCall,
          seq,
          ...(this.signature !== null
            ? { signature: this.signature.signature, expiresAt: this.signature.expiresAt }
            : {}),
        }),
      });

      if (response.status === 401) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (body.error === "SIGNATURE_EXPIRED") {
          // An expired signature is NOT an identity change: the last known
          // values keep serving while a fresh pair is fetched.
          this.signature = null;
          await this.ensureSignature();
          if (this.signature !== null) await this.refresh();
          return;
        }
        // Invalid or missing: drop to caller defaults. Never a silent downgrade.
        this.values = {};
        this.setState("offline");
        this.markReady("offline");
        return;
      }

      if (!response.ok) throw new Error(`client state failed: ${response.status}`);
      this.applyState((await response.json()) as FlagStateResponse);
    } catch (error) {
      this.options.onError?.(error);
      // A failed identify during an outage times out; values stay invalidated
      // and defaults serve. A login must not inherit the previous user's flags.
      this.setState(this.currentHash === null ? "offline" : "ready");
      this.markReady(this.currentState);
    }
  }

  /**
   * Apply a response, or drop it.
   *
   * Concurrent `identify()` calls apply in **call order, not response order**.
   * Discarding on key change is necessary but not sufficient — two rapid calls
   * reintroduce the same bug through the network:
   *
   * ```
   * fk.identify({ key: "user_A" });   // request 1 -- slow response
   * fk.identify({ key: "user_B" });   // request 2 -- fast response, applied
   *                                   // request 1 lands late, overwriting B with A
   * ```
   *
   * An account switcher, a React effect that fires twice, or a login right
   * after an anonymous identify all produce this, and the result is exactly the
   * failure discard-on-change exists to prevent, arriving by a route that rule
   * does not cover.
   *
   * **Both checks, not either**: `seq` catches reordering; `contextHash`
   * catches a stale response for a context that was re-identified back to an
   * equal value.
   */
  private applyState(state: FlagStateResponse): void {
    const requestedFor = this.inFlight.get(state.seq);
    this.inFlight.delete(state.seq);

    // `seq` catches reordering: a response older than one already applied is
    // superseded by definition.
    if (state.seq < this.appliedSeq) return;

    // Identity catches the rest: a response for a context we are no longer on
    // must never be applied, however recent its `seq`. This is what stops
    // user A's values landing in user B's session.
    if (requestedFor !== undefined && requestedFor !== this.context.key) return;

    // And the server's own hash must agree with what we last accepted for this
    // key, so an attribute change that raced an in-flight request cannot apply
    // values evaluated against the older attributes.
    if (
      this.currentHash !== null &&
      requestedFor === this.context.key &&
      state.contextHash !== this.currentHash &&
      state.seq < this.seq
    ) {
      return;
    }

    this.appliedSeq = state.seq;
    this.currentHash = state.contextHash;
    this.connectionId = state.connectionId;
    this.values = state.values;
    this.setState("ready");
    this.markReady("ready");
    this.emit("change", Object.keys(state.values));

    // Re-subscribe only on the winning response, so a late reply cannot
    // resurrect a closed connection's context.
    if (this.options.stream !== false) void this.openStream();
  }

  private async ensureSignature(): Promise<void> {
    const provider = this.options.onSignatureExpiring;
    if (provider === undefined) return;
    const now = Math.floor(Date.now() / 1000);
    // Refresh a little early: a signature that expires mid-flight produces a
    // 401 the user did not need to experience.
    if (this.signature !== null && this.signature.expiresAt - now > 60) return;
    try {
      this.signature = await provider();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async openStream(): Promise<void> {
    if (this.closed || this.connectionId === null) return;
    this.eventSource?.close();
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    // A newer openStream() aborts this one on purpose. That is a handover, not
    // a lost connection: recovering from it would open yet another stream,
    // abort this one's successor, and loop forever.
    const replaced = () => this.abort !== controller;

    const url =
      `${this.options.baseUrl}/v1/client/stream?connection=${encodeURIComponent(this.connectionId)}` +
      `&key=${encodeURIComponent(this.options.clientKey)}`;
    try {
      const response = await this.fetch(url, { signal: controller.signal });
      if (replaced()) return;
      if (!response.ok || response.body === null) {
        if (!this.closed) {
          // If 409 (server restarted/dropped connectionId) or error, re-identify to recover
          this.setState("offline");
          setTimeout(() => {
            if (!this.closed) void this.refresh();
          }, 1500);
        }
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.handleFrame(frame);
        }
      }
    } catch (error) {
      if (replaced()) return;
      if (!this.closed) this.options.onError?.(error);
    }

    if (replaced()) return;
    if (!this.closed) {
      // Stream ended or broke, automatically recover connection and reconcile state
      this.setState("offline");
      setTimeout(() => {
        if (!this.closed) void this.refresh();
      }, 1500);
    }
  }

  private handleFrame(frame: string): void {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event !== "values" || data.length === 0) return;
    try {
      const payload = JSON.parse(data) as { version: number; values: Record<string, FlagValue> };
      this.values = { ...this.values, ...payload.values };
      this.emit("change", Object.keys(payload.values));
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const fn = this.options.fetchImpl ?? globalThis.fetch;
    return fn.call(globalThis, input, init);
  }

  private setState(state: ClientState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.emit("state", state);
  }

  private markReady(_state: ClientState): void {
    if (this.isReady) return;
    this.isReady = true;
    this.readyResolve?.();
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
    this.eventSource?.close();
  }

  on(event: "change", handler: (flagKeys: string[]) => void): () => void;
  on(event: "state", handler: (state: ClientState) => void): () => void;
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
        this.options.onError?.(error);
      }
    }
  }
}

