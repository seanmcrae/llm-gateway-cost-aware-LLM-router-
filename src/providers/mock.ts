import type { Sleeper } from "../core/clock.js";
import { ProviderError } from "../core/errors.js";
import { hashUnit } from "../core/random.js";
import { estimatePromptTokens } from "../core/tokens.js";
import type { CallOptions, CompletionRequest, CompletionResult, Provider } from "./types.js";

/**
 * Latency and reliability profile of a simulated model. The defaults in config/default.json
 * are illustrative shapes (cheap models are faster), not measurements of any real API.
 */
export interface MockProfile {
  /** Time to first token. */
  ttftMs: number;
  /** Generation time per output token. */
  msPerOutputToken: number;
  /** Uniform jitter applied to the total, as a fraction (0.2 = +/-20%). */
  jitter: number;
  /** Share of calls that hit a slow tail. */
  slowRate: number;
  slowMultiplier: number;
  /** Share of calls that fail with a transient 429 or 503. */
  failureRate: number;
}

const WORDS = [
  "the",
  "request",
  "was",
  "routed",
  "to",
  "a",
  "simulated",
  "model",
  "which",
  "returns",
  "deterministic",
  "text",
  "so",
  "replays",
  "and",
  "tests",
  "are",
  "repeatable",
  "across",
  "runs",
  "cost",
  "latency",
  "quality",
  "budget",
  "tenant",
  "cache",
  "policy",
  "tier",
  "fallback",
  "retry",
];

/** Words are ~1.3 tokens on average, which keeps reported usage close to the 4-chars rule. */
function fillerText(tokens: number, seed: string): string {
  const words: string[] = [];
  let chars = 0;
  for (let i = 0; chars < tokens * 4; i++) {
    const word = WORDS[Math.floor(hashUnit(seed, i) * WORDS.length)] ?? "text";
    words.push(word);
    chars += word.length + 1;
  }
  return words.join(" ");
}

/**
 * Deterministic stand-in for an LLM API. Output length depends only on the prompt, so every
 * tier answers the same request with the same number of tokens and cost comparisons are fair.
 * Latency and failures are drawn from a hash of (model, prompt, call number): the same replay
 * produces the same timings, and a retry of the same prompt gets an independent draw.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  private readonly calls = new Map<string, number>();

  constructor(
    private readonly profiles: Readonly<Record<string, MockProfile>>,
    private readonly sleeper: Sleeper,
  ) {}

  async complete(request: CompletionRequest, options: CallOptions): Promise<CompletionResult> {
    const profile = this.profiles[request.model];
    if (!profile) {
      throw new ProviderError(
        "bad_request",
        `mock model "${request.model}" is not configured`,
        404,
      );
    }
    const fingerprint = request.messages.map((m) => `${m.role}:${m.content}`).join("\n");
    const callKey = `${request.model}\u0000${fingerprint}`;
    const call = (this.calls.get(callKey) ?? 0) + 1;
    this.calls.set(callKey, call);
    const draw = (stream: string) => hashUnit(stream, request.model, fingerprint, call);

    const promptTokens = estimatePromptTokens(request.messages);
    const wanted = 24 + Math.floor(hashUnit("length", fingerprint) * (40 + promptTokens * 0.8));
    const completionTokens = Math.min(wanted, request.maxTokens);

    let latency = profile.ttftMs + profile.msPerOutputToken * completionTokens;
    latency *= 1 + (draw("jitter") * 2 - 1) * profile.jitter;
    if (draw("slow") < profile.slowRate) latency *= profile.slowMultiplier;
    latency = Math.round(latency);

    if (draw("fail") < profile.failureRate) {
      await this.sleeper.sleep(Math.min(profile.ttftMs, options.timeoutMs));
      throw draw("kind") < 0.5
        ? new ProviderError("rate_limited", "simulated 429 from mock provider", 429, 250)
        : new ProviderError("overloaded", "simulated 503 from mock provider", 503);
    }
    if (latency > options.timeoutMs) {
      await this.sleeper.sleep(options.timeoutMs);
      throw new ProviderError("timeout", `mock call exceeded ${options.timeoutMs} ms`);
    }
    await this.sleeper.sleep(latency);
    return {
      content: fillerText(completionTokens, fingerprint),
      finishReason: completionTokens < wanted ? "length" : "stop",
      usage: { promptTokens, completionTokens },
    };
  }
}
