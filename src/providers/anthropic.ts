import { z } from "zod";
import type { FinishReason, Message } from "../api/schema.js";
import { ProviderError } from "../core/errors.js";
import { postJson, type FetchLike } from "./http.js";
import type { CallOptions, CompletionRequest, CompletionResult, Provider } from "./types.js";

const ResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The Messages API takes the system prompt as a top-level field and requires the
 * conversation to alternate user/assistant turns, starting with user. Consecutive turns with
 * the same role are merged, and a leading assistant turn gets an empty user turn before it.
 */
export function toAnthropicMessages(messages: readonly Message[]): {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const last = turns[turns.length - 1];
    if (last?.role === m.role) last.content += `\n\n${m.content}`;
    else turns.push({ role: m.role, content: m.content });
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "(continue)" });
  return { ...(system && { system }), messages: turns };
}

function finishReason(raw: string | null): FinishReason {
  return raw === "max_tokens" ? "length" : "stop";
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: AnthropicOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(request: CompletionRequest, options: CallOptions): Promise<CompletionResult> {
    const body = {
      model: request.model,
      max_tokens: request.maxTokens,
      ...toAnthropicMessages(request.messages),
      // Anthropic accepts temperature in [0, 1]; OpenAI clients may send up to 2.
      ...(request.temperature !== undefined && { temperature: Math.min(1, request.temperature) }),
      ...(request.topP !== undefined && { top_p: request.topP }),
      ...(request.stop !== undefined && { stop_sequences: request.stop }),
    };
    const raw = await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.options.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body,
      options.timeoutMs,
      options.signal,
    );
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError("server", "unexpected response shape from anthropic");
    }
    return {
      content: parsed.data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(""),
      finishReason: finishReason(parsed.data.stop_reason),
      usage: {
        promptTokens: parsed.data.usage.input_tokens,
        completionTokens: parsed.data.usage.output_tokens,
      },
    };
  }
}
