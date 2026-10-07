/** Time source injected everywhere time matters, so breakers, buckets and budgets are testable. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Manually advanced clock for tests and simulations. */
export class ManualClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

/** Calendar month key in UTC, e.g. "2026-10". Budgets reset on this boundary. */
export function monthKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Waits are injected too: real timers in the server, virtual time in tests and replays. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export const realSleeper: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Advances a ManualClock instead of waiting, so simulated latency costs no wall time. */
export class VirtualSleeper implements Sleeper {
  constructor(private readonly clock: ManualClock) {}

  sleep(ms: number): Promise<void> {
    this.clock.advance(Math.max(0, ms));
    return Promise.resolve();
  }
}
