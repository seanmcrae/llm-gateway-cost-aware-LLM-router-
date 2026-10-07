import type { Random } from "../core/random.js";

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/**
 * "Full jitter" exponential backoff: a uniform draw from [0, min(max, base * 2^retry)].
 * Spreading retries uniformly avoids synchronised retry storms against a struggling upstream.
 * A Retry-After hint from the upstream is a floor, capped at maxMs so one slow hint cannot
 * stall a request past its fallback.
 */
export function backoffDelay(
  retry: number,
  policy: BackoffPolicy,
  random: Random,
  retryAfterMs?: number,
): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** retry);
  const jittered = Math.round(random() * ceiling);
  if (retryAfterMs === undefined) return jittered;
  return Math.min(policy.maxMs, Math.max(jittered, retryAfterMs));
}
