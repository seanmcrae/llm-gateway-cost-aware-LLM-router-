import type { Clock } from "../core/clock.js";

/** Classic token bucket: `capacity` tokens, refilled continuously at `capacity` per minute. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly clock: Clock,
  ) {
    this.tokens = capacity;
    this.updatedAt = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.updatedAt) * this.capacity) / 60_000,
    );
    this.updatedAt = now;
  }

  /** Milliseconds until `amount` would be available, or 0 if it is available now. */
  waitFor(amount: number): number {
    this.refill();
    // A single request larger than the bucket is admitted once the bucket is full.
    const needed = Math.min(amount, this.capacity);
    if (this.tokens >= needed) return 0;
    return Math.ceil(((needed - this.tokens) * 60_000) / this.capacity);
  }

  take(amount: number): void {
    this.refill();
    this.tokens -= Math.min(amount, this.capacity);
  }

  /** Corrects an earlier estimate once the real token count is known. */
  adjust(delta: number): void {
    this.refill();
    this.tokens = Math.min(this.capacity, this.tokens - delta);
  }
}

export interface RateDecision {
  allowed: boolean;
  retryAfterMs: number;
  limit?: "requests" | "tokens";
}

/**
 * Per-tenant requests-per-minute and tokens-per-minute limits. Token cost is estimated up
 * front (prompt estimate + max_tokens) and corrected with real usage after the call, the same
 * way the major providers account for TPM.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { requests: TokenBucket; tokens: TokenBucket }>();

  constructor(private readonly clock: Clock) {}

  private bucketsFor(tenantId: string, rpm: number, tpm: number) {
    let pair = this.buckets.get(tenantId);
    if (!pair) {
      pair = {
        requests: new TokenBucket(rpm, this.clock),
        tokens: new TokenBucket(tpm, this.clock),
      };
      this.buckets.set(tenantId, pair);
    }
    return pair;
  }

  check(
    tenant: { id: string; requestsPerMinute: number; tokensPerMinute: number },
    estimatedTokens: number,
  ): RateDecision {
    const { requests, tokens } = this.bucketsFor(
      tenant.id,
      tenant.requestsPerMinute,
      tenant.tokensPerMinute,
    );
    const requestWait = requests.waitFor(1);
    if (requestWait > 0) return { allowed: false, retryAfterMs: requestWait, limit: "requests" };
    const tokenWait = tokens.waitFor(estimatedTokens);
    if (tokenWait > 0) return { allowed: false, retryAfterMs: tokenWait, limit: "tokens" };
    requests.take(1);
    tokens.take(estimatedTokens);
    return { allowed: true, retryAfterMs: 0 };
  }

  settle(tenantId: string, estimatedTokens: number, actualTokens: number): void {
    this.buckets.get(tenantId)?.tokens.adjust(actualTokens - estimatedTokens);
  }
}
