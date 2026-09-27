import { randomUUID } from 'node:crypto';

export type BudgetLimits = { maxCalls: number; maxUsd?: number };
export type Reservation = { id: string; maxAttempts: number; maxPerCallUsd?: number };
export type SettlementEvidence = {
  attempts: number;
  chargeStatus: 'billed' | 'not_billed' | 'unknown';
  chargeUsd?: number;
};
export type BudgetSnapshot = {
  maxCalls: number;
  maxUsd?: number;
  usedCalls: number;
  reservedCalls: number;
  remainingCalls: number;
  billedUsd: number;
  reservedUsd: number;
  unpricedReservations: number;
  overspendUsd: number;
  blocked: boolean;
};

type StoredReservation = {
  reservation: Reservation;
  reservedUsd: number;
  perCallUsd: number;
  state: 'pending' | 'unpriced';
};

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

export class BudgetLedger {
  private readonly reservations = new Map<string, StoredReservation>();
  private usedCalls = 0;
  private reservedCalls = 0;
  private billedUsd = 0;
  private reservedUsd = 0;
  private blocked = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly limits: BudgetLimits) {
    if (!Number.isInteger(limits.maxCalls) || limits.maxCalls < 1) {
      throw new BudgetError('Call limit must be a positive integer.');
    }
    if (limits.maxUsd !== undefined && (!Number.isFinite(limits.maxUsd) || limits.maxUsd < 0)) {
      throw new BudgetError('Spend limit must be finite and nonnegative.');
    }
  }

  reserve(maxAttempts: number, maxPerCallUsd?: number): Promise<Reservation> {
    return this.serialized(() => {
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new BudgetError('Reservation attempts must be a positive integer.');
      if (maxPerCallUsd !== undefined && (!Number.isFinite(maxPerCallUsd) || maxPerCallUsd < 0)) {
        throw new BudgetError('Per-call allowance must be finite and nonnegative.');
      }
      if (this.blocked) throw new BudgetError('New calls are blocked until unpriced charges are reconciled.');
      if (this.usedCalls + this.reservedCalls + maxAttempts > this.limits.maxCalls) {
        throw new BudgetError('Reservation exceeds the call cap.');
      }
      if (this.limits.maxUsd !== undefined && maxPerCallUsd === undefined) {
        throw new BudgetError('A hosted spend cap requires a per-call allowance.');
      }
      if (this.limits.maxUsd !== undefined && maxPerCallUsd === 0) {
        throw new BudgetError('Per-call allowance must be positive when a hosted spend cap is enabled.');
      }
      const perCallUsd = maxPerCallUsd ?? 0;
      const reservation: Reservation = {
        id: randomUUID(),
        maxAttempts,
        ...(maxPerCallUsd === undefined ? {} : { maxPerCallUsd }),
      };
      const reservedUsd = perCallUsd * maxAttempts;
      if (!Number.isFinite(reservedUsd) || this.limits.maxUsd !== undefined &&
          this.billedUsd + this.reservedUsd + reservedUsd > this.limits.maxUsd) {
        throw new BudgetError('Reservation exceeds the spend cap.');
      }
      this.reservations.set(reservation.id, { reservation, reservedUsd, perCallUsd, state: 'pending' });
      this.reservedCalls += maxAttempts;
      this.reservedUsd += reservedUsd;
      return reservation;
    });
  }

  settle(reservation: Reservation, evidence: SettlementEvidence): Promise<void> {
    return this.serialized(() => {
      const stored = this.reservations.get(reservation.id);
      if (!stored || stored.state !== 'pending' || !sameReservation(stored.reservation, reservation)) {
        throw new BudgetError('Reservation is unknown, modified, or already settled.');
      }
      if (!Number.isInteger(evidence.attempts) || evidence.attempts < 0 || evidence.attempts > reservation.maxAttempts) {
        throw new BudgetError('Settlement attempts exceed the reservation.');
      }
      if (evidence.chargeStatus !== 'not_billed' && evidence.attempts < 1) {
        throw new BudgetError('Billed or unpriced settlement requires at least one attempted call.');
      }
      if (evidence.chargeStatus === 'billed') {
        if (evidence.chargeUsd === undefined || !Number.isFinite(evidence.chargeUsd) || evidence.chargeUsd < 0) {
          throw new BudgetError('Billed settlement requires a finite nonnegative charge.');
        }
      } else if (evidence.chargeUsd !== undefined) {
        throw new BudgetError('Charge evidence requires billed status.');
      }

      this.reservedCalls -= reservation.maxAttempts;
      this.usedCalls += evidence.attempts;
      this.reservedUsd -= stored.reservedUsd;
      if (evidence.chargeStatus === 'billed') {
        this.billedUsd += evidence.chargeUsd!;
      } else if (evidence.chargeStatus === 'unknown') {
        const uncertainUsd = stored.perCallUsd * evidence.attempts;
        stored.reservedUsd = uncertainUsd;
        stored.state = 'unpriced';
        this.reservedUsd += uncertainUsd;
        this.blocked = true;
        return;
      }
      this.reservations.delete(reservation.id);
    });
  }

  reconcile(unpricedUsd: number): Promise<void> {
    return this.serialized(() => {
      if (!Number.isFinite(unpricedUsd) || unpricedUsd < 0) throw new BudgetError('Reconciled charges must be finite and nonnegative.');
      const pending = [...this.reservations.values()].filter((entry) => entry.state === 'unpriced');
      if (pending.length === 0) throw new BudgetError('There are no unpriced reservations to reconcile.');
      this.reservedUsd -= pending.reduce((sum, entry) => sum + entry.reservedUsd, 0);
      for (const entry of pending) this.reservations.delete(entry.reservation.id);
      this.billedUsd += unpricedUsd;
      this.blocked = false;
    });
  }

  snapshot(): BudgetSnapshot {
    const unpricedReservations = [...this.reservations.values()].filter((entry) => entry.state === 'unpriced').length;
    return {
      maxCalls: this.limits.maxCalls,
      ...(this.limits.maxUsd === undefined ? {} : { maxUsd: this.limits.maxUsd }),
      usedCalls: this.usedCalls,
      reservedCalls: this.reservedCalls,
      remainingCalls: this.limits.maxCalls - this.usedCalls - this.reservedCalls,
      billedUsd: this.billedUsd,
      reservedUsd: this.reservedUsd,
      unpricedReservations,
      overspendUsd: this.limits.maxUsd === undefined ? 0 : Math.max(0, this.billedUsd - this.limits.maxUsd),
      blocked: this.blocked,
    };
  }

  private serialized<T>(operation: () => T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function sameReservation(left: Reservation, right: Reservation): boolean {
  return left.id === right.id && left.maxAttempts === right.maxAttempts && left.maxPerCallUsd === right.maxPerCallUsd;
}
