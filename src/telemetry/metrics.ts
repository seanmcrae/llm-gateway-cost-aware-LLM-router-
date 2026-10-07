import type { BreakerState } from "../resilience/breaker.js";
import type { EventSink, RequestEvent } from "./events.js";

type Labels = Record<string, string>;

const LATENCY_BUCKETS_MS = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
    )
    .join(",");
}

class Counter {
  private readonly values = new Map<string, number>();

  inc(labels: Labels, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  lines(name: string): string[] {
    return [...this.values].map(([k, v]) => `${name}{${k}} ${v}`);
  }
}

class Histogram {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();

  constructor(private readonly buckets: number[]) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    const s = this.series.get(key) ?? { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((le, i) => {
      if (value <= le) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += value;
    s.count += 1;
    this.series.set(key, s);
  }

  lines(name: string): string[] {
    const out: string[] = [];
    for (const [key, s] of this.series) {
      const sep = key ? "," : "";
      this.buckets.forEach((le, i) => {
        out.push(`${name}_bucket{${key}${sep}le="${le}"} ${s.counts[i] ?? 0}`);
      });
      out.push(`${name}_bucket{${key}${sep}le="+Inf"} ${s.count}`);
      out.push(`${name}_sum{${key}} ${s.sum}`, `${name}_count{${key}} ${s.count}`);
    }
    return out;
  }
}

/**
 * Prometheus metrics derived from request events, exposed on GET /metrics in the text
 * exposition format. Implemented directly because the gateway needs four metric families,
 * not a client library.
 */
export class Metrics implements EventSink {
  private readonly requests = new Counter();
  private readonly cost = new Counter();
  private readonly tokens = new Counter();
  private readonly attempts = new Counter();
  private readonly latency = new Histogram(LATENCY_BUCKETS_MS);

  constructor(private readonly breakerStates: () => Map<string, BreakerState>) {}

  write(event: RequestEvent): void {
    const model = event.model ?? "none";
    this.requests.inc({
      tenant: event.tenant,
      model,
      status: String(event.status),
      cache: event.cache,
    });
    if (event.costUsd > 0) this.cost.inc({ tenant: event.tenant, model }, event.costUsd);
    this.tokens.inc({ tenant: event.tenant, model, kind: "prompt" }, event.promptTokens);
    this.tokens.inc({ tenant: event.tenant, model, kind: "completion" }, event.completionTokens);
    for (const attempt of event.attempts) {
      this.attempts.inc({ model: attempt.model, outcome: attempt.outcome });
    }
    this.latency.observe({ model }, event.latencyMs);
  }

  render(): string {
    const family = (name: string, type: string, help: string, lines: string[]) => [
      `# HELP ${name} ${help}`,
      `# TYPE ${name} ${type}`,
      ...lines,
    ];
    const stateValue: Record<BreakerState, number> = { closed: 0, half_open: 1, open: 2 };
    const breakers = [...this.breakerStates()].map(
      ([model, state]) => `llm_gateway_breaker_state{${labelKey({ model })}} ${stateValue[state]}`,
    );
    return [
      ...family(
        "llm_gateway_requests_total",
        "counter",
        "Requests by tenant, model, status and cache result.",
        this.requests.lines("llm_gateway_requests_total"),
      ),
      ...family(
        "llm_gateway_cost_usd_total",
        "counter",
        "Upstream spend in USD.",
        this.cost.lines("llm_gateway_cost_usd_total"),
      ),
      ...family(
        "llm_gateway_tokens_total",
        "counter",
        "Prompt and completion tokens.",
        this.tokens.lines("llm_gateway_tokens_total"),
      ),
      ...family(
        "llm_gateway_upstream_attempts_total",
        "counter",
        "Upstream attempts by model and outcome.",
        this.attempts.lines("llm_gateway_upstream_attempts_total"),
      ),
      ...family(
        "llm_gateway_request_latency_ms",
        "histogram",
        "End-to-end request latency in milliseconds.",
        this.latency.lines("llm_gateway_request_latency_ms"),
      ),
      ...family(
        "llm_gateway_breaker_state",
        "gauge",
        "Circuit breaker state per model: 0 closed, 1 half-open, 2 open.",
        breakers,
      ),
      "",
    ].join("\n");
  }
}
