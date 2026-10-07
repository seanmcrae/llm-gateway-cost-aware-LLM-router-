import { monthKey, type Clock } from "../core/clock.js";

export interface BudgetStatus {
  month: string;
  budgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  spentFraction: number;
}

interface Ledger {
  month: string;
  spentUsd: number;
  reserved: Map<string, number>;
}

/**
 * Monthly spend per tenant with reservations. A request reserves its worst-case cost before
 * the upstream call, so concurrent requests cannot jointly overshoot the budget, and settles
 * to the real cost afterwards. Spend resets on the UTC month boundary. State is in memory;
 * the telemetry log is the durable record.
 */
export class BudgetLedger {
  private readonly ledgers = new Map<string, Ledger>();
  private nextId = 0;

  constructor(private readonly clock: Clock) {}

  private ledger(tenantId: string): Ledger {
    const month = monthKey(this.clock.now());
    let ledger = this.ledgers.get(tenantId);
    if (ledger?.month !== month) {
      ledger = { month, spentUsd: 0, reserved: new Map() };
      this.ledgers.set(tenantId, ledger);
    }
    return ledger;
  }

  status(tenantId: string, budgetUsd: number): BudgetStatus {
    const ledger = this.ledger(tenantId);
    const reservedUsd = [...ledger.reserved.values()].reduce((a, b) => a + b, 0);
    const remainingUsd = Math.max(0, budgetUsd - ledger.spentUsd - reservedUsd);
    return {
      month: ledger.month,
      budgetUsd,
      spentUsd: ledger.spentUsd,
      reservedUsd,
      remainingUsd,
      spentFraction: budgetUsd > 0 ? Math.min(1, ledger.spentUsd / budgetUsd) : 1,
    };
  }

  reserve(tenantId: string, amountUsd: number): string {
    const id = `r${++this.nextId}`;
    this.ledger(tenantId).reserved.set(id, amountUsd);
    return id;
  }

  /** Replaces a reservation with the actual cost. A settled id cannot be charged twice. */
  commit(tenantId: string, reservationId: string, actualUsd: number): void {
    const ledger = this.ledger(tenantId);
    if (!ledger.reserved.delete(reservationId)) return;
    ledger.spentUsd += actualUsd;
  }

  release(tenantId: string, reservationId: string): void {
    this.ledger(tenantId).reserved.delete(reservationId);
  }
}
