import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRequest } from "../src/api/schema.js";
import type { GatewayConfig, TenantConfig } from "../src/config/schema.js";
import { ManualClock, VirtualSleeper } from "../src/core/clock.js";
import { GatewayError, ProviderError } from "../src/core/errors.js";
import { Gateway } from "../src/gateway/gateway.js";
import type { CompletionRequest, CompletionResult, Provider } from "../src/providers/types.js";
import { JsonlSink, MemorySink } from "../src/telemetry/events.js";
import { testConfig } from "./helpers.js";

type Step = "ok" | ProviderError;

/** Provider that plays back a script of outcomes and records every call. */
class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly calls: CompletionRequest[] = [];

  constructor(
    private readonly clock: ManualClock,
    private readonly script: Step[] = [],
    private readonly latencyMs = 100,
  ) {}

  complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request);
    this.clock.advance(this.latencyMs);
    const step = this.script.shift() ?? "ok";
    if (step !== "ok") return Promise.reject(step);
    return Promise.resolve({
      content: `answer from ${request.model}`,
      finishReason: "stop",
      usage: { promptTokens: 1_000, completionTokens: 200 },
    });
  }
}

const overloaded = () => new ProviderError("overloaded", "503", 503);

function setup(
  scripts: Partial<Record<string, Step[]>> = {},
  config: GatewayConfig = testConfig(),
) {
  const clock = new ManualClock(Date.UTC(2026, 9, 7));
  const providers = new Map(
    config.models.map((m) => [m.id, new ScriptedProvider(clock, scripts[m.id] ?? [])]),
  );
  const sink = new MemorySink();
  let id = 0;
  const gateway = new Gateway({
    config,
    providers,
    clock,
    sleeper: new VirtualSleeper(clock),
    random: () => 0.5,
    sinks: [sink],
    newId: () => `req-${++id}`,
  });
  const tenant = config.tenants[0] as TenantConfig;
  return { gateway, providers, sink, clock, tenant };
}

const ask = (content: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "auto",
  messages: [{ role: "user", content }],
  stream: false,
  maxTokens: 256,
  ...extra,
});

const EASY = 'Classify the sentiment of this review as positive or negative: "Arrived late."';
const HARD =
  "Design a sharding strategy and analyze the trade-offs. Explain why it is safe. It must have no downtime, must keep writes consistent and must roll back in at most 10 minutes. What breaks first? How do you test it?";

describe("Gateway", () => {
  it("serves an easy request from the cheap tier and records cost, tokens and latency", async () => {
    const { gateway, sink, tenant } = setup();
    const { completion, event } = await gateway.handle(ask(EASY), { tenant });
    expect(completion.model).toBe("small");
    expect(completion.choices[0].message.content).toBe("answer from small");
    expect(event).toMatchObject({
      requestId: "req-1",
      policy: "routed",
      model: "small",
      tier: "cheap",
      cache: "bypass",
      fallbacks: 0,
      retries: 0,
      promptTokens: 1_000,
      completionTokens: 200,
      latencyMs: 100,
      status: 200,
    });
    expect(event.costUsd).toBeCloseTo((1_000 * 0.1 + 200 * 0.4) / 1e6);
    expect(event.premiumCostUsd).toBeCloseTo((1_000 * 3 + 200 * 15) / 1e6);
    expect(sink.events).toHaveLength(1);
    expect(gateway.usage(tenant).spentUsd).toBeCloseTo(event.costUsd);
  });

  it("retries a transient failure on the same model with backoff", async () => {
    const { gateway, clock, tenant } = setup({ large: [overloaded()] });
    const before = clock.now();
    const { event } = await gateway.handle(ask(HARD), { tenant });
    expect(event.model).toBe("large");
    expect(event.retries).toBe(1);
    expect(event.attempts.map((a) => a.outcome)).toEqual(["error", "ok"]);
    // random() = 0.5 -> half of baseMs (100) for the first retry.
    expect(event.attempts[0]?.backoffMs).toBe(50);
    expect(clock.now() - before).toBe(100 + 50 + 100);
  });

  it("falls back to the next model once retries are exhausted", async () => {
    const { gateway, tenant } = setup({ large: [overloaded(), overloaded(), overloaded()] });
    const { event } = await gateway.handle(ask(HARD), { tenant });
    expect(event.model).toBe("large-alt");
    expect(event.fallbacks).toBe(1);
    expect(event.retries).toBe(2);
  });

  it("skips a model whose breaker is open without calling it", async () => {
    const failures = Array.from({ length: 3 }, overloaded);
    const { gateway, providers, tenant } = setup({ large: failures });
    await gateway.handle(ask(HARD), { tenant });
    const callsBefore = providers.get("large")?.calls.length;
    const { event } = await gateway.handle(ask(`${HARD} Second request.`), { tenant });
    expect(providers.get("large")?.calls.length).toBe(callsBefore);
    expect(event.attempts[0]).toMatchObject({ model: "large", outcome: "breaker_open" });
    expect(event.model).toBe("large-alt");
    expect(gateway.metrics.render()).toContain('llm_gateway_breaker_state{model="large"} 2');
  });

  it("moves past an auth failure without retrying it", async () => {
    const { gateway, providers, tenant } = setup({
      small: [new ProviderError("auth", "bad key", 401)],
    });
    const { event } = await gateway.handle(ask(EASY), { tenant });
    expect(providers.get("small")?.calls).toHaveLength(1);
    expect(event.model).toBe("medium");
  });

  it("aborts on an upstream 400 instead of trying other models", async () => {
    const { gateway, providers, tenant, sink } = setup({
      small: [new ProviderError("bad_request", "bad", 400)],
    });
    await expect(gateway.handle(ask(EASY), { tenant })).rejects.toMatchObject({
      status: 400,
      code: "upstream_rejected",
    });
    expect(providers.get("medium")?.calls).toHaveLength(0);
    expect(sink.events[0]).toMatchObject({ status: 400, errorCode: "upstream_rejected" });
  });

  it("returns 502 when every candidate fails and releases the budget reservation", async () => {
    const down = () => Array.from({ length: 3 }, overloaded);
    const { gateway, tenant } = setup({ small: down(), medium: down(), large: down() });
    const call = gateway.handle(ask(EASY), { tenant });
    await expect(call).rejects.toBeInstanceOf(GatewayError);
    await expect(call).rejects.toMatchObject({ status: 502, code: "all_upstreams_failed" });
    expect(gateway.usage(tenant)).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
  });

  it("answers a repeated temperature-0 request from the cache at zero cost", async () => {
    const { gateway, providers, tenant } = setup();
    const request = ask(EASY, { temperature: 0 });
    const first = await gateway.handle(request, { tenant });
    const second = await gateway.handle(request, { tenant });
    expect(providers.get("small")?.calls).toHaveLength(1);
    expect(second.event).toMatchObject({ cache: "exact", costUsd: 0, model: "small" });
    expect(second.event.routeReason).toContain(first.event.requestId);
    expect(second.completion.choices[0].message.content).toBe("answer from small");
    const bypass = await gateway.handle(request, { tenant, cache: "off" });
    expect(bypass.event.cache).toBe("bypass");
  });

  it("rejects requests over the tenant's rate limit with a retry hint", async () => {
    const config = testConfig();
    const tenant = { ...(config.tenants[0] as TenantConfig), requestsPerMinute: 1 };
    const { gateway } = setup({}, { ...config, tenants: [tenant] });
    await gateway.handle(ask(EASY), { tenant });
    await expect(gateway.handle(ask(EASY), { tenant })).rejects.toMatchObject({
      status: 429,
      code: "requests_per_minute_exceeded",
      retryAfterMs: 59_900,
    });
  });

  it("downgrades near the budget limit and refuses once it is spent", async () => {
    const config = testConfig();
    const tenant = { ...(config.tenants[0] as TenantConfig), monthlyBudgetUsd: 0.0075 };
    const { gateway } = setup({}, { ...config, tenants: [tenant] });
    const first = await gateway.handle(ask(HARD), { tenant });
    expect(first.event.model).toBe("large");
    const second = await gateway.handle(ask(HARD), { tenant });
    expect(second.event.model).toBe("medium");
    expect(second.event.routeReason).toMatch(/budget \d+% spent/);
    await expect(gateway.handle(ask(HARD), { tenant })).rejects.toMatchObject({
      status: 429,
      type: "insufficient_quota",
    });
  });

  it("authenticates by API key and writes JSONL telemetry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "llmgw-"));
    try {
      const config = testConfig();
      const path = join(dir, "logs", "events.jsonl");
      const clock = new ManualClock();
      const gateway = new Gateway({
        config,
        providers: new Map(config.models.map((m) => [m.id, new ScriptedProvider(clock)])),
        clock,
        sinks: [new JsonlSink(path)],
      });
      expect(gateway.authenticate("nope")).toBeUndefined();
      const tenant = gateway.authenticate("acme-test-key");
      expect(tenant?.id).toBe("acme");
      if (!tenant) return;
      await gateway.handle(ask(EASY), { tenant });
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ tenant: "acme", model: "small" });
      const metrics = gateway.metrics.render();
      expect(metrics).toContain(
        'llm_gateway_requests_total{cache="bypass",model="small",status="200",tenant="acme"} 1',
      );
      expect(metrics).toContain('llm_gateway_request_latency_ms_bucket{model="small",le="100"} 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
