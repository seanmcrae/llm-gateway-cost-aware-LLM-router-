import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/config/load.js";
import type { GatewayConfig } from "../src/config/schema.js";
import { ManualClock, VirtualSleeper } from "../src/core/clock.js";
import { Gateway } from "../src/gateway/gateway.js";
import { buildProviders } from "../src/providers/factory.js";
import { createApp } from "../src/server/app.js";

const KEY = "sk-local-acme-demo";

function app(edit: (config: GatewayConfig) => void = () => undefined) {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  edit(config);
  const clock = new ManualClock(Date.UTC(2026, 9, 7));
  const sleeper = new VirtualSleeper(clock);
  const gateway = new Gateway({
    config,
    providers: buildProviders(config, { env: {}, sleeper }),
    clock,
    sleeper,
    random: () => 0.5,
  });
  return createApp(gateway);
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const chat = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "auto",
  messages: [{ role: "user", content }],
  ...extra,
});

describe("HTTP API", () => {
  it("serves an OpenAI-shaped completion with routing headers", async () => {
    const res = await app().request(
      "/v1/chat/completions",
      post(chat("Translate to French: good morning", { temperature: 0 })),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-llm-gateway-model")).toBe("mock-small");
    expect(res.headers.get("x-llm-gateway-tier")).toBe("cheap");
    expect(res.headers.get("x-llm-gateway-cache")).toBe("miss");
    expect(res.headers.get("x-llm-gateway-route")).toMatch(/^complexity 0\.\d+ -> cheap/);
    const body = (await res.json()) as { object: string; model: string; usage: object };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("mock-small");
    expect(body.usage).toHaveProperty("total_tokens");
  });

  it("rejects missing keys, bad JSON, invalid bodies and unknown models", async () => {
    const a = app();
    const noKey = await a.request("/v1/chat/completions", { method: "POST", body: "{}" });
    expect(noKey.status).toBe(401);
    expect(await noKey.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    expect((await a.request("/v1/chat/completions", post("{nope"))).status).toBe(400);
    const invalid = await a.request("/v1/chat/completions", post({ model: "auto", messages: [] }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    const unknown = await a.request("/v1/chat/completions", post(chat("hi", { model: "gpt-9" })));
    expect(unknown.status).toBe(404);
    const header = await a.request(
      "/v1/chat/completions",
      post(chat("hi"), { "x-llm-gateway-max-cost-usd": "free" }),
    );
    expect(header.status).toBe(400);
  });

  it("rejects bodies over 1 MB", async () => {
    const res = await app().request("/v1/chat/completions", post(chat("x".repeat(1_100_000))));
    expect(res.status).toBe(413);
  });

  it("applies per-request cost caps from headers", async () => {
    const hard =
      "Design a migration strategy, analyze the trade-offs and explain why each step is safe. It must have no downtime and must stay consistent.";
    const res = await app().request(
      "/v1/chat/completions",
      post(chat(hard, { model: "premium" }), { "x-llm-gateway-max-cost-usd": "0.003" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-llm-gateway-tier")).toBe("standard");
    expect(res.headers.get("x-llm-gateway-route")).toMatch(/max cost/);
  });

  it("streams buffered completions as server-sent events", async () => {
    const res = await app().request("/v1/chat/completions", post(chat("Say hi", { stream: true })));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events
      .slice(0, -1)
      .map((e) => JSON.parse(e) as { choices: { delta: object; finish_reason: string | null }[] });
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  it("lists models, reports usage and exposes metrics", async () => {
    const a = app();
    await a.request("/v1/chat/completions", post(chat("Classify this as spam or not: hi")));
    const models = (await (
      await a.request("/v1/models", { headers: { authorization: `Bearer ${KEY}` } })
    ).json()) as { data: { id: string }[] };
    expect(models.data.map((m) => m.id)).toEqual(
      expect.arrayContaining(["auto", "cheap", "premium", "mock-large"]),
    );
    const usage = (await (
      await a.request("/v1/usage", { headers: { authorization: `Bearer ${KEY}` } })
    ).json()) as { tenant: string; spentUsd: number; month: string };
    expect(usage).toMatchObject({ tenant: "acme", month: "2026-10" });
    expect(usage.spentUsd).toBeGreaterThan(0);
    const metrics = await (await a.request("/metrics")).text();
    expect(metrics).toContain("# TYPE llm_gateway_requests_total counter");
    expect(metrics).toContain('tenant="acme"');
    expect((await a.request("/healthz")).status).toBe(200);
  });

  it("sends Retry-After when a tenant is rate limited", async () => {
    const a = app((config) => {
      for (const tenant of config.tenants) tenant.requestsPerMinute = 2;
    });
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 3; i++) {
      last = await a.request("/v1/chat/completions", post(chat(`Classify ticket ${i}`)));
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(await last?.json()).toMatchObject({ error: { code: "requests_per_minute_exceeded" } });
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("bundled configs", () => {
  it("parse, and the example config fails fast without API keys", () => {
    const example = new URL("../config/providers.example.json", import.meta.url).pathname;
    const config = loadConfig(example);
    expect(config.models.map((m) => m.provider)).toContain("anthropic");
    const sleeper = new VirtualSleeper(new ManualClock());
    expect(() => buildProviders(config, { env: {}, sleeper })).toThrow(/OPENAI_API_KEY/);
    const providers = buildProviders(config, {
      env: { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" },
      sleeper,
    });
    expect(providers.get("claude-haiku")?.name).toBe("anthropic");
    expect(() => loadConfig("/nonexistent.json")).toThrow(/Cannot read config/);
  });
});
