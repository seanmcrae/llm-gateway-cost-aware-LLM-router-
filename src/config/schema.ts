import { z } from "zod";

const MockProfileSchema = z.object({
  ttftMs: z.number().nonnegative(),
  msPerOutputToken: z.number().nonnegative(),
  jitter: z.number().min(0).max(1).default(0.15),
  slowRate: z.number().min(0).max(1).default(0),
  slowMultiplier: z.number().min(1).default(3),
  failureRate: z.number().min(0).max(1).default(0),
  /**
   * Simulated capability on the benchmark's 1-5 difficulty scale. Read only by the replay
   * benchmark's quality proxy; the gateway never routes on it.
   */
  capability: z.number().min(0).max(6),
});

export const ModelSchema = z
  .object({
    id: z.string().min(1),
    provider: z.enum(["mock", "openai", "anthropic"]),
    /** Model name sent upstream; defaults to `id`. */
    upstreamModel: z.string().optional(),
    tier: z.string(),
    pricing: z.object({
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
    }),
    contextWindow: z.number().int().positive(),
    /** Expected p95 latency, used for SLO routing until enough real samples exist. */
    latencyPriorMs: z.number().positive(),
    baseUrl: z.url().optional(),
    apiKeyEnv: z.string().optional(),
    mock: MockProfileSchema.optional(),
  })
  .refine((m) => m.provider !== "mock" || m.mock !== undefined, {
    message: "mock models need a `mock` profile",
  });

export const TenantSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** Bearer keys accepted for this tenant. Use long random values outside local development. */
  apiKeys: z.array(z.string().min(8)).min(1),
  monthlyBudgetUsd: z.number().nonnegative(),
  requestsPerMinute: z.number().positive(),
  tokensPerMinute: z.number().positive(),
  /** Requests are routed to models whose p95 fits this, when one does. */
  latencySloMs: z.number().positive().optional(),
  /** "routed" or a tier name; overrides routing.defaultPolicy for this tenant. */
  policy: z.string().optional(),
});

export const GatewayConfigSchema = z
  .object({
    models: z.array(ModelSchema).min(1),
    routing: z.object({
      /** Tier names from cheapest to most capable. */
      tiers: z.array(z.string()).min(1),
      /** Complexity cut points between consecutive tiers, ascending, length tiers - 1. */
      thresholds: z.array(z.number().min(0).max(1)),
      defaultPolicy: z.string().default("routed"),
      /** Share of the monthly budget after which the top tier is no longer used. */
      budgetDowngradeAt: z.number().min(0).max(1).default(0.8),
      maxModelsPerRequest: z.number().int().positive().default(3),
      /** Observed samples needed before measured p95 replaces latencyPriorMs. */
      latencyMinSamples: z.number().int().positive().default(20),
    }),
    resilience: z.object({
      timeoutMs: z.number().positive().default(30_000),
      maxRetries: z.number().int().nonnegative().default(2),
      backoff: z.object({ baseMs: z.number().positive(), maxMs: z.number().positive() }),
      breaker: z.object({
        consecutiveFailures: z.number().int().positive(),
        failureRate: z.number().min(0).max(1),
        windowSize: z.number().int().positive(),
        minCalls: z.number().int().positive(),
        cooldownMs: z.number().positive(),
      }),
    }),
    cache: z.object({
      mode: z.enum(["off", "exact", "semantic"]).default("exact"),
      ttlMs: z.number().positive().default(3_600_000),
      maxEntries: z.number().int().positive().default(5_000),
      similarityThreshold: z.number().min(0).max(1).default(0.95),
    }),
    defaults: z.object({ maxOutputTokens: z.number().int().positive().default(512) }).default({
      maxOutputTokens: 512,
    }),
    tenants: z.array(TenantSchema).min(1),
    telemetry: z.object({ jsonlPath: z.string().optional() }).default({}),
  })
  .superRefine((config, ctx) => {
    const issue = (message: string) => {
      ctx.addIssue({ code: "custom", message });
    };
    const { tiers, thresholds, defaultPolicy } = config.routing;
    if (thresholds.length !== tiers.length - 1) {
      issue(`routing.thresholds needs ${tiers.length - 1} values for ${tiers.length} tiers`);
    }
    if (thresholds.some((t, i) => i > 0 && t < (thresholds[i - 1] ?? 0))) {
      issue("routing.thresholds must be ascending");
    }
    const ids = new Set<string>();
    for (const model of config.models) {
      if (ids.has(model.id)) issue(`duplicate model id "${model.id}"`);
      ids.add(model.id);
      if (!tiers.includes(model.tier))
        issue(`model "${model.id}" has unknown tier "${model.tier}"`);
    }
    for (const tier of tiers) {
      if (!config.models.some((m) => m.tier === tier)) issue(`tier "${tier}" has no models`);
    }
    const policies = new Set(["routed", ...tiers]);
    for (const policy of [defaultPolicy, ...config.tenants.map((t) => t.policy)]) {
      if (policy !== undefined && !policies.has(policy)) issue(`unknown policy "${policy}"`);
    }
    const keys = config.tenants.flatMap((t) => t.apiKeys);
    if (new Set(keys).size !== keys.length) issue("an API key is assigned to more than one tenant");
  });

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type ModelConfig = z.infer<typeof ModelSchema>;
export type TenantConfig = z.infer<typeof TenantSchema>;

export function parseConfig(raw: unknown): GatewayConfig {
  const result = GatewayConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "config"}: ${i.message}`)
      .join("\n  ");
    throw new Error(`Invalid gateway config:\n  ${details}`);
  }
  return result.data;
}
