import { parseConfig, type GatewayConfig } from "../src/config/schema.js";

const profile = (capability: number, ttftMs: number, msPerOutputToken: number) => ({
  ttftMs,
  msPerOutputToken,
  jitter: 0,
  slowRate: 0,
  slowMultiplier: 1,
  failureRate: 0,
  capability,
});

/** Small three-tier config with zero-jitter mock models, for deterministic unit tests. */
export function testConfig(overrides: Partial<Record<keyof GatewayConfig, unknown>> = {}) {
  return parseConfig({
    models: [
      {
        id: "small",
        provider: "mock",
        tier: "cheap",
        pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
        contextWindow: 16_000,
        latencyPriorMs: 1_000,
        mock: profile(2, 100, 5),
      },
      {
        id: "medium",
        provider: "mock",
        tier: "standard",
        pricing: { inputPerMTok: 1, outputPerMTok: 4 },
        contextWindow: 128_000,
        latencyPriorMs: 2_000,
        mock: profile(3.4, 200, 10),
      },
      {
        id: "large",
        provider: "mock",
        tier: "premium",
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        contextWindow: 200_000,
        latencyPriorMs: 4_000,
        mock: profile(4.6, 400, 20),
      },
      {
        id: "large-alt",
        provider: "mock",
        tier: "premium",
        pricing: { inputPerMTok: 3, outputPerMTok: 12 },
        contextWindow: 200_000,
        latencyPriorMs: 4_000,
        mock: profile(4.4, 400, 20),
      },
    ],
    routing: { tiers: ["cheap", "standard", "premium"], thresholds: [0.3, 0.6] },
    resilience: {
      timeoutMs: 10_000,
      maxRetries: 2,
      backoff: { baseMs: 100, maxMs: 1_000 },
      breaker: {
        consecutiveFailures: 3,
        failureRate: 0.5,
        windowSize: 20,
        minCalls: 10,
        cooldownMs: 5_000,
      },
    },
    cache: { mode: "exact" },
    tenants: [
      {
        id: "acme",
        apiKeys: ["acme-test-key"],
        monthlyBudgetUsd: 100,
        requestsPerMinute: 1_000,
        tokensPerMinute: 1_000_000,
      },
    ],
    ...overrides,
  });
}
