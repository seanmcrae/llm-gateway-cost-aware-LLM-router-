import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/core/clock.js";
import { BudgetLedger } from "../src/tenants/budget.js";
import { RateLimiter, TokenBucket } from "../src/tenants/rate-limit.js";

describe("TokenBucket", () => {
  it("refills continuously and reports how long to wait", () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket(60, clock);
    bucket.take(60);
    expect(bucket.waitFor(1)).toBe(1_000);
    clock.advance(500);
    expect(bucket.waitFor(1)).toBe(500);
    clock.advance(500);
    expect(bucket.waitFor(1)).toBe(0);
  });

  it("never refills past capacity and admits oversized requests when full", () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket(10, clock);
    clock.advance(600_000);
    expect(bucket.waitFor(500)).toBe(0);
    bucket.take(500);
    expect(bucket.waitFor(10)).toBe(60_000);
  });
});

describe("RateLimiter", () => {
  const tenant = { id: "acme", requestsPerMinute: 2, tokensPerMinute: 1_000 };

  it("limits requests per minute", () => {
    const limiter = new RateLimiter(new ManualClock());
    expect(limiter.check(tenant, 10).allowed).toBe(true);
    expect(limiter.check(tenant, 10).allowed).toBe(true);
    const third = limiter.check(tenant, 10);
    expect(third).toEqual({ allowed: false, retryAfterMs: 30_000, limit: "requests" });
  });

  it("limits tokens per minute and credits back unused estimates", () => {
    const limiter = new RateLimiter(new ManualClock());
    const roomy = { ...tenant, requestsPerMinute: 100 };
    expect(limiter.check(roomy, 900).allowed).toBe(true);
    expect(limiter.check(roomy, 200)).toMatchObject({ allowed: false, limit: "tokens" });
    limiter.settle("acme", 900, 300);
    expect(limiter.check(roomy, 200).allowed).toBe(true);
  });

  it("keeps tenants independent", () => {
    const limiter = new RateLimiter(new ManualClock());
    limiter.check(tenant, 1);
    limiter.check(tenant, 1);
    expect(limiter.check({ ...tenant, id: "globex" }, 1).allowed).toBe(true);
  });
});

describe("BudgetLedger", () => {
  it("counts reservations against the remaining budget and settles to actual cost", () => {
    const ledger = new BudgetLedger(new ManualClock(Date.UTC(2026, 9, 7)));
    const r1 = ledger.reserve("acme", 4);
    expect(ledger.status("acme", 10)).toMatchObject({ reservedUsd: 4, remainingUsd: 6 });
    ledger.commit("acme", r1, 1.5);
    ledger.commit("acme", r1, 1.5);
    expect(ledger.status("acme", 10)).toMatchObject({
      spentUsd: 1.5,
      reservedUsd: 0,
      remainingUsd: 8.5,
      spentFraction: 0.15,
    });
    const r2 = ledger.reserve("acme", 2);
    ledger.release("acme", r2);
    expect(ledger.status("acme", 10).remainingUsd).toBe(8.5);
  });

  it("resets on the UTC month boundary", () => {
    const clock = new ManualClock(Date.UTC(2026, 9, 31, 23, 59));
    const ledger = new BudgetLedger(clock);
    ledger.commit("acme", ledger.reserve("acme", 1), 9);
    expect(ledger.status("acme", 10).month).toBe("2026-10");
    clock.set(Date.UTC(2026, 10, 1, 0, 0));
    expect(ledger.status("acme", 10)).toMatchObject({ month: "2026-11", spentUsd: 0 });
  });

  it("treats a zero budget as fully spent", () => {
    const ledger = new BudgetLedger(new ManualClock());
    expect(ledger.status("acme", 0)).toMatchObject({ remainingUsd: 0, spentFraction: 1 });
  });
});
