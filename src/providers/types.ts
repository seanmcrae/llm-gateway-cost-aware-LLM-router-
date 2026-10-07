import type { FinishReason, Message, Usage } from "../api/schema.js";

/** What the gateway sends to one upstream model after routing. */
export interface CompletionRequest {
  /** The provider's own model name, e.g. "gpt-4o-mini" or "claude-sonnet-4-5". */
  model: string;
  messages: Message[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

export interface CompletionResult {
  content: string;
  finishReason: FinishReason;
  usage: Usage;
}

export interface CallOptions {
  /** Per-attempt deadline. Providers must fail with a `timeout` ProviderError when it passes. */
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * One upstream API. Implementations translate to and from the vendor wire format and throw
 * ProviderError for every failure, so retry and fallback logic never sees vendor specifics.
 */
export interface Provider {
  readonly name: string;
  complete(request: CompletionRequest, options: CallOptions): Promise<CompletionResult>;
}
