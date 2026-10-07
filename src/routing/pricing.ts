import type { Usage } from "../api/schema.js";
import type { ModelConfig } from "../config/schema.js";

export function costUsd(model: Pick<ModelConfig, "pricing">, usage: Usage): number {
  const { inputPerMTok, outputPerMTok } = model.pricing;
  return (usage.promptTokens * inputPerMTok + usage.completionTokens * outputPerMTok) / 1_000_000;
}

/** Upper-bound estimate before the call: the full max_tokens is assumed to be generated. */
export function estimateCostUsd(
  model: Pick<ModelConfig, "pricing">,
  promptTokens: number,
  maxOutputTokens: number,
): number {
  return costUsd(model, { promptTokens, completionTokens: maxOutputTokens });
}
