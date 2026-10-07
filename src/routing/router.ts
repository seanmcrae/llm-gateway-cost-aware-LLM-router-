import type { Message } from "../api/schema.js";
import type { GatewayConfig, ModelConfig } from "../config/schema.js";
import { GatewayError } from "../core/errors.js";
import { scoreComplexity, type Complexity } from "./complexity.js";
import type { LatencyTracker } from "./latency.js";
import { estimateCostUsd } from "./pricing.js";

export interface RouteInput {
  /** The `model` field of the request: "auto", a tier name, or a configured model id. */
  requestedModel: string;
  messages: readonly Message[];
  promptTokens: number;
  maxOutputTokens: number;
  /** The tenant's policy, used when requestedModel is "auto". */
  tenantPolicy: string;
  budget: { remainingUsd: number; spentFraction: number };
  latencySloMs?: number;
  maxCostUsd?: number;
}

export interface RoutePlan {
  /** "routed", "tier:<name>" or "pinned:<model>". */
  policy: string;
  tier: string;
  complexity: Complexity | null;
  /** Primary model first, then the fallback chain. */
  candidates: ModelConfig[];
  reasons: string[];
}

/**
 * Turns a request into an ordered candidate list. The primary comes from the policy (a tier
 * chosen by complexity score, a fixed tier, or a pinned model); the fallback chain is the rest
 * of that tier, then more capable tiers, then cheaper ones, so a failure degrades quality
 * last. Hard constraints (context window, per-request cost cap, remaining budget) remove
 * candidates; the latency SLO only reorders them, because a slow answer beats no answer.
 */
export class Router {
  private readonly tiers: string[];

  constructor(
    private readonly config: GatewayConfig,
    private readonly latency: LatencyTracker,
  ) {
    this.tiers = config.routing.tiers;
  }

  plan(input: RouteInput): RoutePlan {
    const reasons: string[] = [];
    const { policy, tierIndex, pinned, complexity } = this.resolvePolicy(input, reasons);

    let ceiling = this.tiers.length - 1;
    const { budgetDowngradeAt } = this.config.routing;
    if (input.budget.spentFraction >= budgetDowngradeAt && this.tiers.length > 1) {
      ceiling = this.tiers.length - 2;
      reasons.push(`budget ${Math.round(input.budget.spentFraction * 100)}% spent: top tier off`);
    }
    const primaryTier = Math.min(tierIndex, ceiling);
    if (primaryTier < tierIndex) reasons.push(`downgraded to ${this.tierName(primaryTier)}`);

    const ordered = this.fallbackOrder(primaryTier, ceiling, pinned);
    const candidates = this.applyConstraints(ordered, input, reasons);
    const sloOrdered = this.applySlo(candidates, input.latencySloMs, reasons);
    const limited = sloOrdered.slice(0, this.config.routing.maxModelsPerRequest);
    const primary = limited[0];
    if (!primary) throw new Error("router produced no candidates");
    return { policy, tier: primary.tier, complexity, candidates: limited, reasons };
  }

  private resolvePolicy(
    input: RouteInput,
    reasons: string[],
  ): { policy: string; tierIndex: number; pinned?: ModelConfig; complexity: Complexity | null } {
    const pinned = this.config.models.find((m) => m.id === input.requestedModel);
    if (pinned) {
      reasons.push(`pinned to ${pinned.id}`);
      return {
        policy: `pinned:${pinned.id}`,
        tierIndex: this.tiers.indexOf(pinned.tier),
        pinned,
        complexity: null,
      };
    }
    const name = input.requestedModel === "auto" ? input.tenantPolicy : input.requestedModel;
    const fixed = this.tiers.indexOf(name);
    if (fixed >= 0) {
      reasons.push(`fixed tier ${name}`);
      return { policy: `tier:${name}`, tierIndex: fixed, complexity: null };
    }
    if (name !== "routed") {
      throw new GatewayError(
        404,
        "invalid_request_error",
        "model_not_found",
        `Unknown model "${input.requestedModel}". Use "auto", a tier (${this.tiers.join(", ")}) or a configured model id.`,
      );
    }
    const complexity = scoreComplexity(input.messages);
    const tierIndex = this.config.routing.thresholds.filter((t) => complexity.score >= t).length;
    reasons.push(
      `complexity ${complexity.score.toFixed(2)} -> ${this.tierName(tierIndex)}` +
        (complexity.signals.length ? ` (${complexity.signals.join("; ")})` : ""),
    );
    return { policy: "routed", tierIndex, complexity };
  }

  private tierName(index: number): string {
    return this.tiers[index] ?? "unknown";
  }

  private fallbackOrder(primary: number, ceiling: number, pinned?: ModelConfig): ModelConfig[] {
    const inTier = (i: number) => this.config.models.filter((m) => m.tier === this.tiers[i]);
    const order: ModelConfig[] = [];
    if (pinned) order.push(pinned);
    order.push(...inTier(primary).filter((m) => m !== pinned));
    for (let i = primary + 1; i <= ceiling; i++) order.push(...inTier(i));
    for (let i = primary - 1; i >= 0; i--) order.push(...inTier(i));
    return order;
  }

  private applyConstraints(
    ordered: ModelConfig[],
    input: RouteInput,
    reasons: string[],
  ): ModelConfig[] {
    const needed = input.promptTokens + input.maxOutputTokens;
    const fits = ordered.filter((m) => m.contextWindow >= needed);
    if (fits.length === 0) {
      throw new GatewayError(
        400,
        "invalid_request_error",
        "context_length_exceeded",
        `The request needs about ${needed} tokens, more than any eligible model's context window.`,
      );
    }
    const estimate = (m: ModelConfig) =>
      estimateCostUsd(m, input.promptTokens, input.maxOutputTokens);
    let affordable = fits;
    if (input.maxCostUsd !== undefined) {
      const cap = input.maxCostUsd;
      affordable = fits.filter((m) => estimate(m) <= cap);
      if (affordable.length === 0) {
        throw new GatewayError(
          400,
          "invalid_request_error",
          "max_cost_too_low",
          `No eligible model can serve this request for at most $${cap}.`,
        );
      }
      if (affordable[0] !== fits[0]) reasons.push(`max cost $${cap} excluded ${fits[0]?.id ?? ""}`);
    }
    const withinBudget = affordable.filter((m) => estimate(m) <= input.budget.remainingUsd);
    if (withinBudget.length === 0) {
      throw new GatewayError(
        429,
        "insufficient_quota",
        "budget_exceeded",
        "The tenant's monthly budget cannot cover this request.",
      );
    }
    if (withinBudget[0] !== affordable[0]) reasons.push("remaining budget excluded the primary");
    return withinBudget;
  }

  private applySlo(candidates: ModelConfig[], sloMs: number | undefined, reasons: string[]) {
    if (sloMs === undefined) return candidates;
    const { latencyMinSamples } = this.config.routing;
    const fast = (m: ModelConfig) =>
      this.latency.p95(m.id, m.latencyPriorMs, latencyMinSamples) <= sloMs;
    const ordered = [...candidates.filter(fast), ...candidates.filter((m) => !fast(m))];
    if (ordered[0] !== candidates[0]) {
      reasons.push(
        `latency SLO ${sloMs} ms: ${ordered[0]?.id ?? ""} before ${candidates[0]?.id ?? ""}`,
      );
    }
    return ordered;
  }
}
