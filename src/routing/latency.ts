import { percentile } from "../core/stats.js";

/** Rolling window of successful-call latencies per model, for SLO-aware routing. */
export class LatencyTracker {
  private readonly samples = new Map<string, number[]>();

  constructor(private readonly windowSize = 200) {}

  record(modelId: string, latencyMs: number): void {
    const window = this.samples.get(modelId) ?? [];
    window.push(latencyMs);
    if (window.length > this.windowSize) window.shift();
    this.samples.set(modelId, window);
  }

  count(modelId: string): number {
    return this.samples.get(modelId)?.length ?? 0;
  }

  /** Measured p95 once `minSamples` exist, otherwise the configured prior. */
  p95(modelId: string, priorMs: number, minSamples: number): number {
    const window = this.samples.get(modelId) ?? [];
    return window.length >= minSamples ? percentile(window, 0.95) : priorMs;
  }
}
