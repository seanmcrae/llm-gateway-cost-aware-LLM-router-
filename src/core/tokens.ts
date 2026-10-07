/**
 * Provider-agnostic token estimate used before a provider has reported real usage:
 * for rate limiting, budget reservations and routing cost estimates. Roughly four
 * characters per token for English text, plus a small per-message framing overhead,
 * which is the same rule of thumb the major providers publish.
 */
const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 4;
const REPLY_PRIMING = 2;

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimatePromptTokens(messages: readonly { content: string }[]): number {
  let total = REPLY_PRIMING;
  for (const message of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateTextTokens(message.content);
  }
  return total;
}
