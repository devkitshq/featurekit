/**
 * A circuit breaker for Redis commands (§11, review PR-B10).
 *
 * **Why a breaker and not just a timeout.** The last-known-good path (§14) is
 * only useful if reaching it is *fast*. With Redis down and no breaker, every
 * request pays a connection attempt and a command timeout before falling back —
 * so a cache outage turns into seconds of latency on every flag fetch, which is
 * indistinguishable from an outage to the SDK waiting on it. The snapshot is
 * sitting in memory the whole time.
 *
 * The breaker converts that into an immediate, cheap failure: after a handful
 * of consecutive errors it stops trying, requests degrade in microseconds, and
 * one probe every few seconds notices when Redis comes back.
 *
 * Three states, and the half-open one is the part people leave out:
 *
 * - **closed** — everything runs. Failures are counted.
 * - **open** — nothing runs; calls fail instantly. After `resetAfterMs`, one
 *   probe is allowed through.
 * - **half-open** — a single probe is in flight. Success closes the breaker;
 *   failure re-opens it. Without this state, recovery means every request in
 *   flight hits a Redis that has just come back and may still be loading its
 *   dataset — a thundering herd aimed at a convalescent.
 */

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  constructor(readonly openedFor: number) {
    super(`featurekit: circuit open, failing fast (${openedFor}ms)`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long it stays open before a single probe is allowed. */
  resetAfterMs?: number;
  onStateChange?: (state: CircuitState) => void;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = "closed";
  private probeInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get current(): CircuitState {
    return this.state;
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  /**
   * May a call proceed?
   *
   * Exposed separately from `run` so a caller can skip building an expensive
   * argument — a serialised snapshot, say — for a call that would fail anyway.
   */
  canAttempt(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < (this.options.resetAfterMs ?? 5_000)) return false;
      this.transition("half-open");
      this.probeInFlight = false;
    }

    // half-open: exactly one probe at a time.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  succeed(): void {
    this.failures = 0;
    this.probeInFlight = false;
    this.transition("closed");
  }

  fail(): void {
    this.probeInFlight = false;
    this.failures++;
    if (this.state === "half-open" || this.failures >= (this.options.failureThreshold ?? 5)) {
      this.openedAt = this.now();
      this.transition("open");
    }
  }

  /**
   * Run `work` under the breaker.
   *
   * Throws `CircuitOpenError` without calling `work` when the circuit is open.
   * The caller treats that exactly like any other Redis failure — which is the
   * point: no new code path, just a much faster one.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.canAttempt()) {
      throw new CircuitOpenError(this.now() - this.openedAt);
    }
    try {
      const result = await work();
      this.succeed();
      return result;
    } catch (error) {
      this.fail();
      throw error;
    }
  }
}
