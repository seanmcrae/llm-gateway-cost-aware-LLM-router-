import { describe, expect, it } from "vitest";
import {
  ChatCompletionRequestSchema,
  normalizeRequest,
  toChatCompletion,
} from "../src/api/schema.js";
import { kindForStatus, parseRetryAfter, ProviderError } from "../src/core/errors.js";

describe("chat completion request schema", () => {
  it("normalises developer roles, text parts, max_completion_tokens and stop", () => {
    const body = ChatCompletionRequestSchema.parse({
      model: "auto",
      messages: [
        { role: "developer", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "Hi " },
            { type: "text", text: "there" },
          ],
        },
      ],
      max_completion_tokens: 64,
      max_tokens: 10,
      stop: "END",
      response_format: { type: "text" },
    });
    expect(normalizeRequest(body)).toEqual({
      model: "auto",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi there" },
      ],
      maxTokens: 64,
      stop: ["END"],
      stream: false,
    });
  });

  it("rejects tools and n > 1 instead of silently ignoring them", () => {
    const base = { model: "auto", messages: [{ role: "user", content: "x" }] };
    expect(ChatCompletionRequestSchema.safeParse({ ...base, tools: [] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, n: 2 }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, messages: [] }).success).toBe(false);
  });

  it("builds an OpenAI-shaped response", () => {
    const res = toChatCompletion("id1", 1_700_000_000_500, "m", "ok", "stop", {
      promptTokens: 3,
      completionTokens: 2,
    });
    expect(res.created).toBe(1_700_000_000);
    expect(res.usage.total_tokens).toBe(5);
    expect(res.choices[0].message.content).toBe("ok");
  });
});

describe("provider error classification", () => {
  it("maps statuses to retryable and terminal kinds", () => {
    expect(kindForStatus(429)).toBe("rate_limited");
    expect(kindForStatus(529)).toBe("overloaded");
    expect(kindForStatus(500)).toBe("server");
    expect(kindForStatus(401)).toBe("auth");
    expect(kindForStatus(400)).toBe("bad_request");
    expect(new ProviderError("server", "x").retryable).toBe(true);
    expect(new ProviderError("auth", "x").retryable).toBe(false);
  });

  it("parses Retry-After in seconds and as an HTTP date", () => {
    expect(parseRetryAfter("2", 0)).toBe(2_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
  });
});
