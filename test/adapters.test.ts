import { describe, expect, it } from "vitest";
import { AnthropicProvider, toAnthropicMessages } from "../src/providers/anthropic.js";
import type { FetchLike } from "../src/providers/http.js";
import { requireKey } from "../src/providers/http.js";
import { OpenAICompatibleProvider } from "../src/providers/openai.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fake fetch that records the request and replies with a canned response. */
function fakeFetch(status: number, payload: unknown, headers: Record<string, string> = {}) {
  const calls: Captured[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    });
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return { calls, impl };
}

const request = {
  model: "upstream-model",
  messages: [
    { role: "system" as const, content: "Be terse." },
    { role: "user" as const, content: "Hello" },
  ],
  maxTokens: 50,
  temperature: 1.5,
  stop: ["###"],
};

describe("OpenAICompatibleProvider", () => {
  it("sends a chat completions request and maps the response", async () => {
    const { calls, impl } = fakeFetch(200, {
      choices: [{ message: { content: "Hi." }, finish_reason: "length" }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      baseUrl: "http://upstream.local/v1/",
      fetch: impl,
    });
    const result = await provider.complete(request, { timeoutMs: 1_000 });
    expect(result).toEqual({
      content: "Hi.",
      finishReason: "length",
      usage: { promptTokens: 12, completionTokens: 3 },
    });
    expect(calls[0]?.url).toBe("http://upstream.local/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]?.body).toMatchObject({
      model: "upstream-model",
      max_tokens: 50,
      stop: ["###"],
    });
  });

  it("classifies 429 with Retry-After as retryable rate limiting", async () => {
    const { impl } = fakeFetch(429, { error: { message: "slow down" } }, { "retry-after": "3" });
    const provider = new OpenAICompatibleProvider({ apiKey: "k", fetch: impl });
    await expect(provider.complete(request, { timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
      status: 429,
      retryAfterMs: 3_000,
    });
  });

  it("treats 401 as a non-retryable auth failure and bad shapes as server errors", async () => {
    const auth = new OpenAICompatibleProvider({ apiKey: "k", fetch: fakeFetch(401, {}).impl });
    await expect(auth.complete(request, { timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: "auth",
      retryable: false,
    });
    const odd = new OpenAICompatibleProvider({
      apiKey: "k",
      fetch: fakeFetch(200, { ok: 1 }).impl,
    });
    await expect(odd.complete(request, { timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: "server",
    });
  });

  it("times out when the upstream does not answer", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const provider = new OpenAICompatibleProvider({ apiKey: "k", fetch: hang });
    await expect(provider.complete(request, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("reports network failures as retryable", async () => {
    const down: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const provider = new OpenAICompatibleProvider({ apiKey: "k", fetch: down });
    await expect(provider.complete(request, { timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: "network",
      retryable: true,
    });
  });
});

describe("AnthropicProvider", () => {
  it("moves the system prompt, clamps temperature and maps usage", async () => {
    const { calls, impl } = fakeFetch(200, {
      content: [
        { type: "text", text: "Hi" },
        { type: "text", text: " there." },
      ],
      stop_reason: "max_tokens",
      usage: { input_tokens: 9, output_tokens: 4 },
    });
    const provider = new AnthropicProvider({ apiKey: "ak", fetch: impl });
    const result = await provider.complete(request, { timeoutMs: 1_000 });
    expect(result).toEqual({
      content: "Hi there.",
      finishReason: "length",
      usage: { promptTokens: 9, completionTokens: 4 },
    });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.headers["x-api-key"]).toBe("ak");
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]?.body).toMatchObject({
      system: "Be terse.",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 1,
      stop_sequences: ["###"],
      max_tokens: 50,
    });
  });

  it("treats 529 overloaded as retryable", async () => {
    const provider = new AnthropicProvider({ apiKey: "ak", fetch: fakeFetch(529, "{}").impl });
    await expect(provider.complete(request, { timeoutMs: 1_000 })).rejects.toMatchObject({
      kind: "overloaded",
      retryable: true,
    });
  });

  it("merges same-role turns and never starts with an assistant turn", () => {
    expect(
      toAnthropicMessages([
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ]),
    ).toEqual({
      messages: [
        { role: "user", content: "(continue)" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "a\n\nb" },
      ],
    });
  });
});

describe("requireKey", () => {
  it("names the missing variable", () => {
    expect(() => requireKey({}, "OPENAI_API_KEY")).toThrow(/OPENAI_API_KEY is not set/);
    expect(requireKey({ OPENAI_API_KEY: "x" }, "OPENAI_API_KEY")).toBe("x");
  });
});
