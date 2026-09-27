import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetError, BudgetLedger } from '../src/infrastructure/budget-ledger.js';

const jevResult = (attempts: number, chargeUsd: number) => ({ attempts, chargeStatus: 'billed' as const, chargeUsd });

test('concurrent reservations cannot exceed call or hosted spend caps', async () => {
  const ledger = new BudgetLedger({ maxCalls: 4, maxUsd: 0.08 });
  const attempts = await Promise.allSettled([
    ledger.reserve(2, 0.02), ledger.reserve(2, 0.02), ledger.reserve(2, 0.02),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(ledger.snapshot().reservedCalls, 4);
  assert.equal(ledger.snapshot().reservedUsd, 0.08);
});

test('settlement reconciles unused attempts and actual billed cost', async () => {
  const ledger = new BudgetLedger({ maxCalls: 3, maxUsd: 0.1 });
  const reservation = await ledger.reserve(3, 0.02);
  await ledger.settle(reservation, jevResult(2, 0.025));
  assert.deepEqual(ledger.snapshot(), {
    maxCalls: 3, maxUsd: 0.1, usedCalls: 2, reservedCalls: 0, remainingCalls: 1,
    billedUsd: 0.025, reservedUsd: 0, unpricedReservations: 0, overspendUsd: 0, blocked: false,
  });
});

test('unknown possibly billed failures block new calls until reconciled', async () => {
  const ledger = new BudgetLedger({ maxCalls: 5, maxUsd: 0.2 });
  const reservation = await ledger.reserve(2, 0.05);
  await ledger.settle(reservation, { attempts: 1, chargeStatus: 'unknown' });
  assert.equal(ledger.snapshot().blocked, true);
  await assert.rejects(ledger.reserve(1, 0.01), /unpriced/);
  await ledger.reconcile(0.03);
  assert.equal(ledger.snapshot().blocked, false);
  assert.equal(ledger.snapshot().billedUsd, 0.03);
  assert.equal(ledger.snapshot().usedCalls, 1);
});

test('billed overshoot is recorded and prevents later reservations', async () => {
  const ledger = new BudgetLedger({ maxCalls: 5, maxUsd: 0.05 });
  const reservation = await ledger.reserve(1, 0.02);
  await ledger.settle(reservation, jevResult(1, 0.07));
  assert.ok(Math.abs(ledger.snapshot().overspendUsd - 0.02) < 1e-10);
  await assert.rejects(ledger.reserve(1, 0.01), /spend cap/);
});

test('local reservations enforce call limits without requiring a spend cap', async () => {
  const ledger = new BudgetLedger({ maxCalls: 1 });
  const reservation = await ledger.reserve(1);
  await ledger.settle(reservation, { attempts: 1, chargeStatus: 'not_billed' });
  assert.equal(ledger.snapshot().usedCalls, 1);
  await assert.rejects(ledger.reserve(1), /call cap/);
});

test('invalid limits, reservations, and charge evidence are rejected', async () => {
  assert.throws(() => new BudgetLedger({ maxCalls: 0 }), /positive/);
  assert.throws(() => new BudgetLedger({ maxCalls: 1, maxUsd: Number.NaN }), /finite/);
  const ledger = new BudgetLedger({ maxCalls: 2, maxUsd: 1 });
  await assert.rejects(ledger.reserve(0, 0.1), BudgetError);
  const reservation = await ledger.reserve(1, 0.1);
  await assert.rejects(ledger.settle(reservation, jevResult(1, Number.POSITIVE_INFINITY)), /finite/);
});
