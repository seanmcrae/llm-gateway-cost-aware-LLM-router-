import { describe, expect, it } from "vitest";
import type { ChatRequest } from "../src/api/schema.js";
import { isCacheable, ResponseCache, type CachedResponse } from "../src/cache/cache.js";
import { cosine, HashingEmbedder } from "../src/cache/embedding.js";
import { ManualClock } from "../src/core/clock.js";

const response: CachedResponse = {
  content: "cached",
  finishReason: "stop",
  usage: { promptTokens: 10, completionTokens: 5 },
  modelId: "small",
  sourceRequestId: "req-1",
};

const ask = (content: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "auto",
  messages: [
    { role: "system", content: "You are a support assistant." },
    { role: "user", content },
  ],
  temperature: 0,
  stream: false,
  ...extra,
});

const config = (mode: "off" | "exact" | "semantic", maxEntries = 100) => ({
  mode,
  ttlMs: 1_000,
  maxEntries,
  similarityThreshold: 0.9,
});

describe("ResponseCache", () => {
  it("returns exact hits per tenant and expires them after the TTL", () => {
    const clock = new ManualClock();
    const cache = new ResponseCache(config("exact"), clock);
    cache.store("acme", ask("Where is my order?"), response);
    expect(cache.lookup("acme", ask("Where is my order?"))?.kind).toBe("exact");
    expect(cache.lookup("globex", ask("Where is my order?"))).toBeNull();
    expect(cache.lookup("acme", ask("Where is my order?", { maxTokens: 10 }))).toBeNull();
    clock.advance(1_000);
    expect(cache.lookup("acme", ask("Where is my order?"))).toBeNull();
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new ResponseCache(config("exact", 2), new ManualClock());
    cache.store("acme", ask("a"), response);
    cache.store("acme", ask("b"), response);
    cache.lookup("acme", ask("a"));
    cache.store("acme", ask("c"), response);
    expect(cache.lookup("acme", ask("a"))).not.toBeNull();
    expect(cache.lookup("acme", ask("b"))).toBeNull();
    expect(cache.size).toBe(2);
  });

  it("matches near-duplicate final messages in semantic mode only", () => {
    const original = "Where is my order 4471? It has not arrived yet.";
    const rephrased = "where is my order 4471?? it has not arrived yet";
    const exact = new ResponseCache(config("exact"), new ManualClock());
    exact.store("acme", ask(original), response);
    expect(exact.lookup("acme", ask(rephrased))).toBeNull();

    const semantic = new ResponseCache(config("semantic"), new ManualClock());
    semantic.store("acme", ask(original), response);
    const hit = semantic.lookup("acme", ask(rephrased));
    expect(hit?.kind).toBe("semantic");
    expect(hit?.similarity).toBeGreaterThan(0.9);
    expect(semantic.lookup("acme", ask("How do I reset my password?"))).toBeNull();
  });

  it("requires the earlier conversation to match exactly for a semantic hit", () => {
    const cache = new ResponseCache(config("semantic"), new ManualClock());
    cache.store("acme", ask("Where is my order 4471?"), response);
    const otherSystem = ask("Where is my order 4471?");
    otherSystem.messages[0] = { role: "system", content: "You are a pirate." };
    expect(cache.lookup("acme", otherSystem)).toBeNull();
  });

  it("is inert when off", () => {
    const cache = new ResponseCache(config("off"), new ManualClock());
    cache.store("acme", ask("a"), response);
    expect(cache.lookup("acme", ask("a"))).toBeNull();
  });
});

describe("isCacheable", () => {
  it("caches temperature 0 by default and honours per-request overrides", () => {
    expect(isCacheable(ask("x"))).toBe(true);
    expect(isCacheable(ask("x", { temperature: 0.7 }))).toBe(false);
    expect(isCacheable(ask("x", { temperature: 0.7 }), "on")).toBe(true);
    expect(isCacheable(ask("x"), "off")).toBe(false);
    expect(isCacheable(ask("x", { stream: true }))).toBe(false);
  });
});

describe("HashingEmbedder", () => {
  it("produces unit vectors where shared wording means higher similarity", () => {
    const embedder = new HashingEmbedder();
    const a = embedder.embed("Reset my password please");
    const b = embedder.embed("please reset my password");
    const c = embedder.embed("Quarterly revenue grew in Europe");
    expect(cosine(a, a)).toBeCloseTo(1, 5);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect(Array.from(embedder.embed("")).every((v) => v === 0)).toBe(true);
  });
});
