import { randomUUID } from "node:crypto";
import {
  toChatCompletion,
  type ChatCompletion,
  type ChatRequest,
  type Usage,
} from "../api/schema.js";
import { isCacheable, ResponseCache } from "../cache/cache.js";
import type { GatewayConfig, ModelConfig, TenantConfig } from "../config/schema.js";
import { realSleeper, systemClock, type Clock, type Sleeper } from "../core/clock.js";
import { GatewayError, ProviderError } from "../core/errors.js";
import { sha256Hex, type Random } from "../core/random.js";
import { estimatePromptTokens } from "../core/tokens.js";
import type { CompletionResult, Provider } from "../providers/types.js";
import { backoffDelay } from "../resilience/backoff.js";
import { BreakerRegistry } from "../resilience/breaker.js";
import { LatencyTracker } from "../routing/latency.js";
import { costUsd, estimateCostUsd } from "../routing/pricing.js";
import { Router } from "../routing/router.js";
import type { EventSink, RequestEvent } from "../telemetry/events.js";
import { Metrics } from "../telemetry/metrics.js";
import { BudgetLedger, type BudgetStatus } from "../tenants/budget.js";
import { RateLimiter } from "../tenants/rate-limit.js";

export interface GatewayDeps {
  config: GatewayConfig;
  /** One provider per configured model id. */
  providers: ReadonlyMap<string, Provider>;
  clock?: Clock;
  sleeper?: Sleeper;
  random?: Random;
  sinks?: EventSink[];
  newId?: () => string;
}

export interface RequestOptions {
  tenant: TenantConfig;
  maxCostUsd?: number;
  latencySloMs?: number;
  cache?: "on" | "off";
}

export interface GatewayResult {
  completion: ChatCompletion;
  event: RequestEvent;
}

interface Served {
  model: ModelConfig;
  result: CompletionResult;
}

/**
 * The request pipeline: rate limit, cache, route, reserve budget, call upstream through the
 * fallback chain with retries and circuit breakers, settle budget and rate limits with real
 * usage, cache the answer, and emit one telemetry event. Transport-agnostic: the HTTP layer
 * and the replay benchmark both drive it through `handle`.
 */
export class Gateway {
  readonly metrics: Metrics;
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;
  private readonly random: Random;
  private readonly newId: () => string;
  private readonly sinks: EventSink[];
  private readonly router: Router;
  private readonly cache: ResponseCache;
  private readonly breakers: BreakerRegistry;
  private readonly latency: LatencyTracker;
  private readonly budgets: BudgetLedger;
  private readonly limiter: RateLimiter;
  private readonly tenantsByKey: Map<string, TenantConfig>;
  private readonly premiumReference: ModelConfig;

  constructor(private readonly deps: GatewayDeps) {
    const { config } = deps;
    this.clock = deps.clock ?? systemClock;
    this.sleeper = deps.sleeper ?? realSleeper;
    this.random = deps.random ?? Math.random;
    this.newId = deps.newId ?? (() => `chatcmpl-${randomUUID()}`);
    this.latency = new LatencyTracker();
    this.router = new Router(config, this.latency);
    this.cache = new ResponseCache(config.cache, this.clock);
    this.breakers = new BreakerRegistry(config.resilience.breaker, this.clock);
    this.budgets = new BudgetLedger(this.clock);
    this.limiter = new RateLimiter(this.clock);
    this.metrics = new Metrics(() => this.breakers.states());
    this.sinks = [this.metrics, ...(deps.sinks ?? [])];
    this.tenantsByKey = new Map(
      config.tenants.flatMap((t) => t.apiKeys.map((key) => [sha256Hex(key), t] as const)),
    );
    const topTier = config.routing.tiers[config.routing.tiers.length - 1];
    const premium = config.models.find((m) => m.tier === topTier);
    if (!premium) throw new Error("the top tier has no models");
    this.premiumReference = premium;
    for (const model of config.models) {
      if (!deps.providers.has(model.id)) throw new Error(`no provider for model "${model.id}"`);
    }
  }

  get config(): GatewayConfig {
    return this.deps.config;
  }

  /** Looks up a tenant by bearer key. Keys are compared by hash, never stored in telemetry. */
  authenticate(apiKey: string): TenantConfig | undefined {
    return this.tenantsByKey.get(sha256Hex(apiKey));
  }

  usage(tenant: TenantConfig): BudgetStatus {
    return this.budgets.status(tenant.id, tenant.monthlyBudgetUsd);
  }

  async handle(request: ChatRequest, options: RequestOptions): Promise<GatewayResult> {
    const start = this.clock.now();
    const { tenant } = options;
    const promptTokens = estimatePromptTokens(request.messages);
    const maxOutputTokens = request.maxTokens ?? this.config.defaults.maxOutputTokens;
    const estimatedTokens = promptTokens + maxOutputTokens;
    const event: RequestEvent = {
      ts: new Date(start).toISOString(),
      requestId: this.newId(),
      tenant: tenant.id,
      requestedModel: request.model,
      policy: "none",
      complexity: null,
      routeReason: "",
      model: null,
      tier: null,
      cache: "miss",
      attempts: [],
      fallbacks: 0,
      retries: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      premiumCostUsd: 0,
      latencyMs: 0,
      status: 200,
    };
    try {
      const rate = this.limiter.check(tenant, estimatedTokens);
      if (!rate.allowed) {
        throw new GatewayError(
          429,
          "rate_limit_error",
          `${rate.limit ?? "requests"}_per_minute_exceeded`,
          `Rate limit on ${rate.limit ?? "requests"} per minute reached for tenant ${tenant.id}.`,
          rate.retryAfterMs,
        );
      }

      const cacheable = isCacheable(request, options.cache);
      if (!cacheable) event.cache = "bypass";
      const hit = cacheable ? this.cache.lookup(tenant.id, request) : null;
      if (hit) {
        this.limiter.settle(tenant.id, estimatedTokens, 0);
        const { response } = hit;
        event.cache = hit.kind;
        event.cacheSource = response.sourceRequestId;
        event.policy = "cache";
        event.routeReason = `${hit.kind} cache hit (similarity ${hit.similarity.toFixed(3)})`;
        event.model = response.modelId;
        event.tier = this.model(response.modelId)?.tier ?? null;
        event.premiumCostUsd = costUsd(this.premiumReference, response.usage);
        return this.result(
          event,
          start,
          response.modelId,
          response.content,
          response.finishReason,
          response.usage,
        );
      }

      const budget = this.budgets.status(tenant.id, tenant.monthlyBudgetUsd);
      const latencySloMs = options.latencySloMs ?? tenant.latencySloMs;
      const plan = this.router.plan({
        requestedModel: request.model,
        messages: request.messages,
        promptTokens,
        maxOutputTokens,
        tenantPolicy: tenant.policy ?? this.config.routing.defaultPolicy,
        budget,
        ...(latencySloMs !== undefined && { latencySloMs }),
        ...(options.maxCostUsd !== undefined && { maxCostUsd: options.maxCostUsd }),
      });
      event.policy = plan.policy;
      event.complexity = plan.complexity?.score ?? null;
      event.routeReason = plan.reasons.join("; ");

      // Reserve the worst case across the chain, since a fallback may land on a pricier model.
      const worstCase = Math.max(
        ...plan.candidates.map((m) => estimateCostUsd(m, promptTokens, maxOutputTokens)),
      );
      const reservation = this.budgets.reserve(tenant.id, Math.min(worstCase, budget.remainingUsd));
      let served: Served;
      try {
        served = await this.execute(plan.candidates, request, maxOutputTokens, event);
      } catch (error) {
        this.budgets.release(tenant.id, reservation);
        this.limiter.settle(tenant.id, estimatedTokens, 0);
        throw error;
      }
      const { model, result } = served;
      event.costUsd = costUsd(model, result.usage);
      event.premiumCostUsd = costUsd(this.premiumReference, result.usage);
      event.promptTokens = result.usage.promptTokens;
      event.completionTokens = result.usage.completionTokens;
      event.model = model.id;
      event.tier = model.tier;
      this.budgets.commit(tenant.id, reservation, event.costUsd);
      this.limiter.settle(
        tenant.id,
        estimatedTokens,
        result.usage.promptTokens + result.usage.completionTokens,
      );
      if (cacheable) {
        this.cache.store(tenant.id, request, {
          content: result.content,
          finishReason: result.finishReason,
          usage: result.usage,
          modelId: model.id,
          sourceRequestId: event.requestId,
        });
      }
      return this.result(event, start, model.id, result.content, result.finishReason, result.usage);
    } catch (error) {
      const failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(500, "server_error", "internal_error", "Internal gateway error.");
      event.status = failure.status;
      event.errorCode = failure.code;
      event.latencyMs = this.clock.now() - start;
      this.emit(event);
      throw failure;
    }
  }

  private result(
    event: RequestEvent,
    start: number,
    modelId: string,
    content: string,
    finishReason: CompletionResult["finishReason"],
    usage: Usage,
  ): GatewayResult {
    event.latencyMs = this.clock.now() - start;
    this.emit(event);
    return {
      completion: toChatCompletion(event.requestId, start, modelId, content, finishReason, usage),
      event,
    };
  }

  private model(id: string): ModelConfig | undefined {
    return this.config.models.find((m) => m.id === id);
  }

  private emit(event: RequestEvent): void {
    for (const sink of this.sinks) sink.write(event);
  }

  /**
   * Walks the fallback chain. Each model gets up to 1 + maxRetries attempts for retryable
   * errors, with jittered backoff between them; an open breaker skips the model without an
   * attempt; a non-retryable error (auth) moves straight to the next model; an upstream 400
   * aborts, because the same request would be rejected everywhere.
   */
  private async execute(
    candidates: ModelConfig[],
    request: ChatRequest,
    maxTokens: number,
    event: RequestEvent,
  ): Promise<Served> {
    const { timeoutMs, maxRetries, backoff } = this.config.resilience;
    let lastError: ProviderError | undefined;
    for (const [index, model] of candidates.entries()) {
      const breaker = this.breakers.get(model.id);
      const provider = this.deps.providers.get(model.id);
      if (!provider) throw new Error(`no provider for model "${model.id}"`);
      for (let retry = 0; retry <= maxRetries; retry++) {
        if (!breaker.tryAcquire()) {
          event.attempts.push({ model: model.id, outcome: "breaker_open", latencyMs: 0 });
          break;
        }
        const attemptStart = this.clock.now();
        try {
          const result = await provider.complete(
            {
              model: model.upstreamModel ?? model.id,
              messages: request.messages,
              maxTokens,
              ...(request.temperature !== undefined && { temperature: request.temperature }),
              ...(request.topP !== undefined && { topP: request.topP }),
              ...(request.stop !== undefined && { stop: request.stop }),
            },
            { timeoutMs },
          );
          const latencyMs = this.clock.now() - attemptStart;
          breaker.recordSuccess();
          this.latency.record(model.id, latencyMs);
          event.attempts.push({ model: model.id, outcome: "ok", latencyMs });
          event.fallbacks = index;
          return { model, result };
        } catch (thrown) {
          const error =
            thrown instanceof ProviderError
              ? thrown
              : new ProviderError("server", `provider threw: ${String(thrown)}`);
          const attempt = {
            model: model.id,
            outcome: "error" as const,
            latencyMs: this.clock.now() - attemptStart,
            error: `${error.kind}${error.status ? ` ${error.status}` : ""}`,
          };
          event.attempts.push(attempt);
          if (error.kind === "bad_request") {
            // The upstream answered, so it is healthy; the request itself is the problem.
            breaker.recordSuccess();
            throw new GatewayError(
              400,
              "invalid_request_error",
              "upstream_rejected",
              error.message,
            );
          }
          breaker.recordFailure();
          lastError = error;
          if (!error.retryable || retry === maxRetries) break;
          const wait = backoffDelay(retry, backoff, this.random, error.retryAfterMs);
          event.attempts[event.attempts.length - 1] = { ...attempt, backoffMs: wait };
          event.retries += 1;
          await this.sleeper.sleep(wait);
        }
      }
    }
    if (!lastError) {
      throw new GatewayError(
        503,
        "upstream_error",
        "no_healthy_upstream",
        "Every candidate model's circuit breaker is open.",
      );
    }
    throw new GatewayError(
      502,
      "upstream_error",
      "all_upstreams_failed",
      `All candidate models failed; last error: ${lastError.message}`,
    );
  }
}
