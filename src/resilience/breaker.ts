import type { Clock } from "../core/clock.js";

export interface BreakerPolicy {
  /** Open after this many consecutive failures... */
  consecutiveFailures: number;
  /** ...or when the failure rate over the last `windowSize` calls reaches this share... */
  failureRate: number;
  windowSize: number;
  /** ...once the window holds at least this many calls. */
  minCalls: number;
  /** How long an open breaker rejects calls before letting one probe through. */
  cooldownMs: number;
}

export type BreakerState = "closed" | "open" | "half_open";

/**
 * Per-model circuit breaker. While open, the router skips the model and the fallback chain
 * moves on immediately instead of spending retries and latency on a failing upstream. After
 * the cooldown one probe call is allowed; its outcome closes or re-opens the breaker.
 */
export class CircuitBreaker {
  private outcomes: boolean[] = [];
  private consecutive = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;

  constructor(
    private readonly policy: BreakerPolicy,
    private readonly clock: Clock,
  ) {}

  get state(): BreakerState {
    if (this.openedAt === null) return "closed";
    return this.clock.now() - this.openedAt >= this.policy.cooldownMs ? "half_open" : "open";
  }

  /** Whether a call may proceed now. In half-open state only one probe is admitted. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open" || this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.probeInFlight = false;
    if (this.openedAt !== null) this.reset();
    this.push(true);
    this.consecutive = 0;
  }

  recordFailure(): void {
    if (this.openedAt !== null) {
      // A failed probe re-opens for a full cooldown.
      this.probeInFlight = false;
      this.openedAt = this.clock.now();
      return;
    }
    this.push(false);
    this.consecutive += 1;
    const failures = this.outcomes.filter((ok) => !ok).length;
    const rateTripped =
      this.outcomes.length >= this.policy.minCalls &&
      failures / this.outcomes.length >= this.policy.failureRate;
    if (this.consecutive >= this.policy.consecutiveFailures || rateTripped) {
      this.openedAt = this.clock.now();
    }
  }

  private push(ok: boolean): void {
    this.outcomes.push(ok);
    if (this.outcomes.length > this.policy.windowSize) this.outcomes.shift();
  }

  private reset(): void {
    this.outcomes = [];
    this.consecutive = 0;
    this.openedAt = null;
  }
}

export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly policy: BreakerPolicy,
    private readonly clock: Clock,
  ) {}

  get(modelId: string): CircuitBreaker {
    let breaker = this.breakers.get(modelId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.policy, this.clock);
      this.breakers.set(modelId, breaker);
    }
    return breaker;
  }

  states(): Map<string, BreakerState> {
    return new Map([...this.breakers].map(([id, b]) => [id, b.state]));
  }
}
