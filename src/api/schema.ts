import { z } from "zod";

/**
 * The subset of the OpenAI Chat Completions request the gateway accepts. Unknown fields are
 * ignored, as OpenAI-compatible servers commonly do; fields the gateway cannot honour (tools,
 * n > 1) are rejected explicitly rather than silently dropped.
 */
const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() });

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(TextPartSchema)]),
  name: z.string().optional(),
});

export const ChatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  stream: z.boolean().optional(),
  n: z.literal(1).optional(),
  user: z.string().optional(),
  tools: z.undefined({ error: "tools are not supported by this gateway" }).optional(),
});

export type ChatCompletionRequestBody = z.infer<typeof ChatCompletionRequestSchema>;

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

/** Normalised request used inside the gateway. */
export interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  stream: boolean;
  user?: string;
}

export function normalizeRequest(body: ChatCompletionRequestBody): ChatRequest {
  const messages = body.messages.map((m) => ({
    // "developer" is OpenAI's newer name for the system role.
    role: m.role === "developer" ? "system" : m.role,
    content: typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join(""),
  }));
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  const stop = body.stop === undefined ? undefined : [body.stop].flat();
  return {
    model: body.model,
    messages,
    stream: body.stream ?? false,
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.top_p !== undefined && { topP: body.top_p }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(stop !== undefined && { stop }),
    ...(body.user !== undefined && { user: body.user }),
  };
}

export type FinishReason = "stop" | "length" | "content_filter";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: "assistant"; content: string };
      finish_reason: FinishReason;
    },
  ];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function toChatCompletion(
  id: string,
  createdMs: number,
  model: string,
  content: string,
  finishReason: FinishReason,
  usage: Usage,
): ChatCompletion {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(createdMs / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    },
  };
}
