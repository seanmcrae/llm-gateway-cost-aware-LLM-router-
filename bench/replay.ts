import { loadConfig } from "../src/config/load.js";
import type { GatewayConfig, ModelConfig } from "../src/config/schema.js";
import { ManualClock, VirtualSleeper } from "../src/core/clock.js";
import { hashUnit, seededRandom } from "../src/core/random.js";
import { mean, percentile } from "../src/core/stats.js";
import { Gateway } from "../src/gateway/gateway.js";
import { buildProviders } from "../src/providers/factory.js";
import { createApp } from "../src/server/app.js";
import { MemorySink } from "../src/telemetry/events.js";
import type { BenchItem } from "./dataset.js";

export interface Variant {
  name: string;
  /** Sent as the request's `model`: "auto" (routed) or a tier name. */
  model: string;
  cache: "off" | "exact" | "semantic";
  thresholds?: number[];
}

export interface RunSummary {
  variant: string;
  model: string;
  cache: Variant["cache"];
  thresholds: number[] | null;
  requests: number;
  /** Share of requests whose answer the quality proxy scores as acceptable, in percent. */
  quality: number;
  costPer1kUsd: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  errors: number;
  /** Share of upstream-served requests per tier, in percent. */
  tierMix: Record<string, number>;
  cacheHits: number;
  /** Cache hits that returned an answer to a different question. */
  falseCacheHits: number;
  retries: number;
  fallbacks: number;
  /** Quality proxy per prompt category, in percent. */
  qualityByCategory: Record<string, number>;
}

/**
 * Quality proxy. A model with capability c answers an item of difficulty d acceptably with
 * probability sigmoid(2 (c - d) + 1). The draw u is fixed per item (common random numbers),
 * so a more capable model never fails an item a weaker model passes and policy comparisons
 * are not blurred by sampling noise. This measures routing decisions under a stated model of
 * capability; it is not a measurement of any real model's quality.
 */
export function passProbability(capability: number, difficulty: number): number {
  return 1 / (1 + Math.exp(-(2 * (capability - difficulty) + 1)));
}

export function passes(item: BenchItem, model: ModelConfig): boolean {
  const capability = model.mock?.capability;
  if (capability === undefined) throw new Error(`model ${model.id} has no simulated capability`);
  return hashUnit("quality", item.group) < passProbability(capability, item.difficulty);
}

const BENCH_KEY = "sk-bench-replay";

function benchConfig(variant: Variant): GatewayConfig {
  const config = loadConfig();
  config.cache.mode = variant.cache;
  if (variant.thresholds) config.routing.thresholds = variant.thresholds;
  config.tenants = [
    {
      id: "bench",
      apiKeys: [BENCH_KEY],
      monthlyBudgetUsd: 1_000_000,
      requestsPerMinute: 1_000_000,
      tokensPerMinute: 1_000_000_000,
    },
  ];
  return config;
}

const round = (x: number, digits: number) => Number(x.toFixed(digits));

/**
 * Replays items in order through the real HTTP app on a virtual clock. Requests run one
 * after another, so latency is per-request service time including retries and backoff, not
 * queueing under load.
 */
export async function replay(items: readonly BenchItem[], variant: Variant): Promise<RunSummary> {
  const config = benchConfig(variant);
  const clock = new ManualClock(Date.UTC(2026, 9, 1));
  const sleeper = new VirtualSleeper(clock);
  let next = 0;
  const sink = new MemorySink();
  const gateway = new Gateway({
    config,
    providers: buildProviders(config, { env: {}, sleeper }),
    clock,
    sleeper,
    random: seededRandom(7),
    newId: () => `r${++next}`,
    sinks: [sink],
  });
  const app = createApp(gateway);
  const models = new Map(config.models.map((m) => [m.id, m]));

  const answeredGroup = new Map<string, { group: string; pass: boolean }>();
  const latencies: number[] = [];
  const tierCounts: Record<string, number> = Object.fromEntries(
    config.routing.tiers.map((t) => [t, 0]),
  );
  let cost = 0;
  let passed = 0;
  let errors = 0;
  let cacheHits = 0;
  let falseCacheHits = 0;
  let retries = 0;
  let fallbacks = 0;
  const byCategory = new Map<string, { n: number; passed: number }>();
  const score = (item: BenchItem, pass: boolean) => {
    const entry = byCategory.get(item.category) ?? { n: 0, passed: 0 };
    entry.n += 1;
    if (pass) {
      entry.passed += 1;
      passed += 1;
    }
    byCategory.set(item.category, entry);
  };

  for (const item of items) {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${BENCH_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: variant.model,
        messages: item.messages,
        max_tokens: item.maxTokens,
        temperature: 0,
      }),
    });
    const header = (name: string) => res.headers.get(`x-llm-gateway-${name}`) ?? "";
    const event = sink.events[sink.events.length - 1];
    if (res.status !== 200 || !event) {
      errors++;
      continue;
    }
    latencies.push(Number(header("latency-ms")));
    cost += Number(header("cost-usd"));
    retries += event.retries;
    fallbacks += event.fallbacks;
    const requestId = res.headers.get("x-request-id") ?? "";
    if (event.cache === "exact" || event.cache === "semantic") {
      cacheHits++;
      const source = answeredGroup.get(event.cacheSource ?? "");
      const correct = source?.group === item.group && source.pass;
      if (source?.group !== item.group) falseCacheHits++;
      score(item, correct);
      continue;
    }
    const model = models.get(header("model"));
    if (!model) throw new Error(`unknown model in response: ${header("model")}`);
    tierCounts[model.tier] = (tierCounts[model.tier] ?? 0) + 1;
    const pass = passes(item, model);
    answeredGroup.set(requestId, { group: item.group, pass });
    score(item, pass);
  }

  const served = Object.values(tierCounts).reduce((a, b) => a + b, 0);
  return {
    variant: variant.name,
    model: variant.model,
    cache: variant.cache,
    thresholds: variant.model === "auto" ? config.routing.thresholds : null,
    requests: items.length,
    quality: round((passed / items.length) * 100, 1),
    costPer1kUsd: round((cost / items.length) * 1000, 3),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    meanMs: Math.round(mean(latencies)),
    errors,
    tierMix: Object.fromEntries(
      Object.entries(tierCounts).map(([tier, n]) => [
        tier,
        round((n / Math.max(1, served)) * 100, 1),
      ]),
    ),
    cacheHits,
    falseCacheHits,
    retries,
    fallbacks,
    qualityByCategory: Object.fromEntries(
      [...byCategory]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, { n, passed: ok }]) => [category, round((ok / n) * 100, 1)]),
    ),
  };
}
