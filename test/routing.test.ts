import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/schema.js";
import { GatewayError } from "../src/core/errors.js";
import { percentile } from "../src/core/stats.js";
import { scoreComplexity } from "../src/routing/complexity.js";
import { LatencyTracker } from "../src/routing/latency.js";
import { costUsd, estimateCostUsd } from "../src/routing/pricing.js";
import { Router, type RouteInput } from "../src/routing/router.js";
import { testConfig } from "./helpers.js";

const user = (content: string) => [{ role: "user" as const, content }];

const EASY = user('Classify the sentiment of this review as positive or negative: "Great value."');
const HARD = user(
  [
    "Design a migration strategy for moving our billing service from a single Postgres",
    "instance to a sharded cluster. Analyze the trade-offs, explain why each step is safe,",
    "and cover edge cases such as in-flight invoices. Constraints:",
    "1. There must be no downtime.",
    "2. Writes must stay strongly consistent.",
    "3. The rollback must take at most 10 minutes.",
    "What is the riskiest step? How would you test it?",
  ].join("\n"),
);

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    requestedModel: "auto",
    messages: EASY,
    promptTokens: 40,
    maxOutputTokens: 256,
    tenantPolicy: "routed",
    budget: { remainingUsd: 100, spentFraction: 0 },
    ...overrides,
  };
}

describe("scoreComplexity", () => {
  it("scores simple labelling tasks low and multi-constraint design work high", () => {
    const easy = scoreComplexity(EASY);
    const hard = scoreComplexity(HARD);
    expect(easy.score).toBeLessThan(0.3);
    expect(easy.signals.some((s) => s.startsWith("simple:"))).toBe(true);
    expect(hard.score).toBeGreaterThan(0.6);
    expect(hard.signals.join(" ")).toMatch(/reasoning:.*constraints:\d+.*questions:2/);
  });

  it("detects code and ignores the system prompt for length", () => {
    const withCode = scoreComplexity(
      user("Why does this loop never end?\n```js\nwhile (i < 3) {}\n```"),
    );
    expect(withCode.signals).toContain("code");
    const longSystem = scoreComplexity([
      { role: "system", content: "x ".repeat(5_000) },
      ...user("Hi"),
    ]);
    expect(longSystem.signals.some((s) => s.startsWith("long:"))).toBe(false);
  });

  it("stays within [0, 1]", () => {
    for (const messages of [user(""), EASY, HARD, user(HARD[0]?.content.repeat(20) ?? "")]) {
      const { score } = scoreComplexity(messages);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("pricing", () => {
  it("charges per million tokens and estimates with the full max_tokens", () => {
    const model = { pricing: { inputPerMTok: 3, outputPerMTok: 15 } };
    expect(costUsd(model, { promptTokens: 1_000, completionTokens: 100 })).toBeCloseTo(0.0045);
    expect(estimateCostUsd(model, 1_000, 1_000)).toBeCloseTo(0.018);
  });
});

describe("Router", () => {
  const config = testConfig();
  const router = () => new Router(config, new LatencyTracker());

  it("routes by complexity and falls back up the tiers, then down", () => {
    const easy = router().plan(input());
    expect(easy.policy).toBe("routed");
    expect(easy.candidates.map((m) => m.id)).toEqual(["small", "medium", "large"]);
    const hard = router().plan(input({ messages: HARD }));
    expect(hard.candidates.map((m) => m.id)).toEqual(["large", "large-alt", "medium"]);
    expect(hard.reasons[0]).toMatch(/complexity 0\.\d+ -> premium/);
  });

  it("honours fixed tiers, pinned models and the tenant policy", () => {
    expect(router().plan(input({ requestedModel: "cheap", messages: HARD })).tier).toBe("cheap");
    const pinned = router().plan(input({ requestedModel: "large-alt" }));
    expect(pinned.policy).toBe("pinned:large-alt");
    expect(pinned.candidates[0]?.id).toBe("large-alt");
    expect(router().plan(input({ tenantPolicy: "premium" })).candidates[0]?.id).toBe("large");
  });

  it("rejects unknown model names with 404", () => {
    expect(() => router().plan(input({ requestedModel: "gpt-9" }))).toThrow(GatewayError);
  });

  it("drops the top tier once the budget passes the downgrade threshold", () => {
    const plan = router().plan(
      input({ messages: HARD, budget: { remainingUsd: 10, spentFraction: 0.9 } }),
    );
    expect(plan.candidates.map((m) => m.id)).toEqual(["medium", "small"]);
    expect(plan.reasons.join(" ")).toMatch(/budget 90% spent/);
  });

  it("removes candidates the per-request cost cap or the remaining budget cannot cover", () => {
    const capped = router().plan(input({ messages: HARD, maxCostUsd: 0.002 }));
    expect(capped.candidates.map((m) => m.id)).toEqual(["medium", "small"]);
    expect(() => router().plan(input({ maxCostUsd: 0.000001 }))).toThrow(/max_cost|at most/);
    expect(() => router().plan(input({ budget: { remainingUsd: 0, spentFraction: 0.5 } }))).toThrow(
      /budget/,
    );
  });

  it("skips models whose context window is too small", () => {
    const plan = router().plan(input({ promptTokens: 20_000 }));
    expect(plan.candidates.map((m) => m.id)).toEqual(["medium", "large", "large-alt"]);
    expect(() => router().plan(input({ promptTokens: 500_000 }))).toThrow(/context window/);
  });

  it("puts models that meet the latency SLO first, using measured p95 when available", () => {
    const latency = new LatencyTracker();
    const r = new Router(config, latency);
    const slo = r.plan(input({ messages: HARD, latencySloMs: 2_500 }));
    expect(slo.candidates.map((m) => m.id)).toEqual(["medium", "small", "large"]);
    for (let i = 0; i < 20; i++) latency.record("large", 1_500);
    const measured = r.plan(input({ messages: HARD, latencySloMs: 2_500 }));
    expect(measured.candidates[0]?.id).toBe("large");
  });
});

describe("config validation", () => {
  it("reports every problem with its path", () => {
    expect(() =>
      parseConfig({
        ...testConfig(),
        routing: { tiers: ["cheap", "premium"], thresholds: [0.5, 0.7], defaultPolicy: "fast" },
      }),
    ).toThrow(
      /thresholds needs 1 values[\s\S]*unknown tier "standard"[\s\S]*unknown policy "fast"/,
    );
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile([], 0.5)).toBeNaN();
  });
});
