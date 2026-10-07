import { z } from "zod";
import type { FinishReason } from "../api/schema.js";
import { ProviderError } from "../core/errors.js";
import { postJson, type FetchLike } from "./http.js";
import type { CallOptions, CompletionRequest, CompletionResult, Provider } from "./types.js";

const ResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable(),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
});

export interface OpenAICompatibleOptions {
  apiKey: string;
  /** Any OpenAI-compatible base URL: OpenAI, Azure OpenAI, vLLM, Ollama, OpenRouter. */
  baseUrl?: string;
  name?: string;
  fetch?: FetchLike;
}

function finishReason(raw: string | null): FinishReason {
  if (raw === "length") return "length";
  if (raw === "content_filter") return "content_filter";
  return "stop";
}

export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = options.name ?? "openai";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(request: CompletionRequest, options: CallOptions): Promise<CompletionResult> {
    const body = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.topP !== undefined && { top_p: request.topP }),
      ...(request.stop !== undefined && { stop: request.stop }),
    };
    const raw = await postJson(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.options.apiKey}` },
      body,
      options.timeoutMs,
      options.signal,
    );
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError("server", `unexpected response shape from ${this.name}`);
    }
    const [choice] = parsed.data.choices;
    return {
      content: choice?.message.content ?? "",
      finishReason: finishReason(choice?.finish_reason ?? null),
      usage: {
        promptTokens: parsed.data.usage.prompt_tokens,
        completionTokens: parsed.data.usage.completion_tokens,
      },
    };
  }
}
