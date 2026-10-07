import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AttemptOutcome = "ok" | "error" | "breaker_open";

export interface AttemptRecord {
  model: string;
  outcome: AttemptOutcome;
  latencyMs: number;
  error?: string;
  /** Backoff waited before the next attempt. */
  backoffMs?: number;
}

/** One structured record per request: the unit of cost and latency analysis. */
export interface RequestEvent {
  ts: string;
  requestId: string;
  tenant: string;
  requestedModel: string;
  policy: string;
  complexity: number | null;
  routeReason: string;
  /** Model that produced the response (or produced the cached response). */
  model: string | null;
  tier: string | null;
  cache: "miss" | "exact" | "semantic" | "bypass";
  /** For cache hits: the request whose upstream answer was reused. */
  cacheSource?: string;
  attempts: AttemptRecord[];
  /** Models tried and abandoned before the one that answered. */
  fallbacks: number;
  retries: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Cost the same tokens would have had on the most expensive configured model. */
  premiumCostUsd: number;
  latencyMs: number;
  status: number;
  errorCode?: string;
}

export interface EventSink {
  write(event: RequestEvent): void;
}

export class MemorySink implements EventSink {
  readonly events: RequestEvent[] = [];

  write(event: RequestEvent): void {
    this.events.push(event);
  }
}

/** Appends one JSON object per line. Synchronous so a crash never loses an acknowledged record. */
export class JsonlSink implements EventSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(event: RequestEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }
}
