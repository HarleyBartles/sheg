import { randomUUID } from 'node:crypto';

export type AttemptSnapshot = {
  maxCalls: number;
  usedCalls: number;
  reservedCalls: number;
  remainingCalls: number;
};

export type AttemptReservation = { id: string; maxAttempts: number };

export class AttemptLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptLedgerError';
  }
}

export class AttemptLedger {
  private readonly reservations = new Map<string, AttemptReservation>();
  private usedCalls = 0;
  private reservedCalls = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly maxCalls: number) {
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new AttemptLedgerError('Call limit must be a positive safe integer.');
  }

  static restore(snapshot: AttemptSnapshot): AttemptLedger {
    if (!Number.isSafeInteger(snapshot.maxCalls) || snapshot.maxCalls < 1 ||
        !Number.isSafeInteger(snapshot.usedCalls) || snapshot.usedCalls < 0 ||
        !Number.isSafeInteger(snapshot.reservedCalls) || snapshot.reservedCalls < 0 ||
        !Number.isSafeInteger(snapshot.remainingCalls) || snapshot.remainingCalls < 0 ||
        snapshot.usedCalls + snapshot.reservedCalls > snapshot.maxCalls ||
        snapshot.remainingCalls !== snapshot.maxCalls - snapshot.usedCalls - snapshot.reservedCalls) {
      throw new AttemptLedgerError('Attempt snapshot is inconsistent or exceeds maxCalls.');
    }
    const ledger = new AttemptLedger(snapshot.maxCalls);
    ledger.usedCalls = snapshot.usedCalls;
    ledger.reservedCalls = snapshot.reservedCalls;
    return ledger;
  }

  reserve(maxAttempts: number): Promise<AttemptReservation> {
    return this.serialized(() => {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new AttemptLedgerError('Reservation attempts must be a positive safe integer.');
      if (this.usedCalls + this.reservedCalls + maxAttempts > this.maxCalls) throw new AttemptLedgerError('Reservation exceeds maxCalls.');
      const reservation = { id: randomUUID(), maxAttempts };
      this.reservations.set(reservation.id, reservation);
      this.reservedCalls += maxAttempts;
      return reservation;
    });
  }

  settle(reservation: AttemptReservation, evidence: { attempts: number }): Promise<void> {
    return this.serialized(() => {
      const stored = this.reservations.get(reservation.id);
      if (!stored || !sameReservation(stored, reservation)) throw new AttemptLedgerError('Reservation is unknown, modified, or already settled.');
      if (!Number.isSafeInteger(evidence.attempts) || evidence.attempts < 0 || evidence.attempts > stored.maxAttempts) {
        throw new AttemptLedgerError('Settlement attempts exceed the reservation.');
      }
      this.reservations.delete(stored.id);
      this.reservedCalls -= stored.maxAttempts;
      this.usedCalls += evidence.attempts;
    });
  }

  consumeInterruptedReservations(): void {
    this.usedCalls += this.reservedCalls;
    this.reservedCalls = 0;
    this.reservations.clear();
  }

  snapshot(): AttemptSnapshot {
    return {
      maxCalls: this.maxCalls,
      usedCalls: this.usedCalls,
      reservedCalls: this.reservedCalls,
      remainingCalls: this.maxCalls - this.usedCalls - this.reservedCalls,
    };
  }

  private serialized<T>(operation: () => T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function sameReservation(left: AttemptReservation, right: AttemptReservation): boolean {
  return left.id === right.id && left.maxAttempts === right.maxAttempts;
}
