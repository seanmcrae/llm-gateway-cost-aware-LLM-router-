import type { GatewayConfig } from "../config/schema.js";
import type { Sleeper } from "../core/clock.js";
import { AnthropicProvider } from "./anthropic.js";
import { requireKey, type FetchLike } from "./http.js";
import { MockProvider, type MockProfile } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { Provider } from "./types.js";

export interface ProviderEnv {
  env: NodeJS.ProcessEnv;
  sleeper: Sleeper;
  fetch?: FetchLike;
}

/**
 * Builds one provider per configured model. API keys are read from the environment variable
 * the model names (OPENAI_API_KEY / ANTHROPIC_API_KEY by default) and only for models that
 * use a real provider, so the default all-mock config needs no keys.
 */
export function buildProviders(config: GatewayConfig, deps: ProviderEnv): Map<string, Provider> {
  const profiles: Record<string, MockProfile> = {};
  for (const model of config.models) {
    if (model.provider === "mock" && model.mock)
      profiles[model.upstreamModel ?? model.id] = model.mock;
  }
  const mock = new MockProvider(profiles, deps.sleeper);
  const fetchOption = deps.fetch ? { fetch: deps.fetch } : {};

  const providers = new Map<string, Provider>();
  for (const model of config.models) {
    const baseUrl = model.baseUrl ? { baseUrl: model.baseUrl } : {};
    switch (model.provider) {
      case "mock":
        providers.set(model.id, mock);
        break;
      case "openai":
        providers.set(
          model.id,
          new OpenAICompatibleProvider({
            apiKey: requireKey(deps.env, model.apiKeyEnv ?? "OPENAI_API_KEY"),
            ...baseUrl,
            ...fetchOption,
          }),
        );
        break;
      case "anthropic":
        providers.set(
          model.id,
          new AnthropicProvider({
            apiKey: requireKey(deps.env, model.apiKeyEnv ?? "ANTHROPIC_API_KEY"),
            ...baseUrl,
            ...fetchOption,
          }),
        );
        break;
    }
  }
  return providers;
}
