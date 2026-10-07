import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/core/clock.js";
import { seededRandom } from "../src/core/random.js";
import { backoffDelay } from "../src/resilience/backoff.js";
import { CircuitBreaker, type BreakerPolicy } from "../src/resilience/breaker.js";

describe("backoffDelay", () => {
  const policy = { baseMs: 100, maxMs: 2_000 };

  it("draws from [0, base * 2^retry] and caps at maxMs", () => {
    expect(backoffDelay(0, policy, () => 0.999)).toBe(100);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(400);
    expect(backoffDelay(10, policy, () => 0.999)).toBe(1_998);
    expect(backoffDelay(2, policy, () => 0)).toBe(0);
  });

  it("treats Retry-After as a floor but never waits past maxMs", () => {
    expect(backoffDelay(0, policy, () => 0, 750)).toBe(750);
    expect(backoffDelay(0, policy, () => 0, 60_000)).toBe(2_000);
  });

  it("is reproducible with a seeded random source", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const draws = (r: () => number) => [0, 1, 2, 3].map((n) => backoffDelay(n, policy, r));
    expect(draws(a)).toEqual(draws(b));
  });
});

describe("CircuitBreaker", () => {
  const policy: BreakerPolicy = {
    consecutiveFailures: 3,
    failureRate: 0.5,
    windowSize: 10,
    minCalls: 6,
    cooldownMs: 1_000,
  };

  it("opens after consecutive failures and rejects until the cooldown passes", () => {
    const clock = new ManualClock();
    const breaker = new CircuitBreaker(policy, clock);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("closed");
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
    expect(breaker.tryAcquire()).toBe(false);
    clock.advance(999);
    expect(breaker.tryAcquire()).toBe(false);
    clock.advance(1);
    expect(breaker.state).toBe("half_open");
  });

  it("admits exactly one probe when half-open and closes on its success", () => {
    const clock = new ManualClock();
    const breaker = new CircuitBreaker(policy, clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    clock.advance(1_000);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
    expect(breaker.tryAcquire()).toBe(true);
  });

  it("re-opens for a full cooldown when the probe fails", () => {
    const clock = new ManualClock();
    const breaker = new CircuitBreaker(policy, clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    clock.advance(1_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
    clock.advance(999);
    expect(breaker.state).toBe("open");
  });

  it("opens on failure rate over the window even without a consecutive run", () => {
    const breaker = new CircuitBreaker(policy, new ManualClock());
    for (const ok of [true, false, true, false, true, false]) {
      if (ok) breaker.recordSuccess();
      else breaker.recordFailure();
    }
    expect(breaker.state).toBe("open");
  });

  it("stays closed while the window is too small to judge", () => {
    const breaker = new CircuitBreaker(policy, new ManualClock());
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
  });
});
