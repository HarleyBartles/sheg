import assert from 'node:assert/strict';
import test from 'node:test';
import { AttemptLedger, AttemptLedgerError } from '../src/domain/attempt-ledger.js';

test('concurrent reservations cannot exceed maxCalls', async () => {
  const ledger = new AttemptLedger(4);
  const results = await Promise.allSettled([ledger.reserve(2), ledger.reserve(2), ledger.reserve(2)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.deepEqual(ledger.snapshot(), { maxCalls: 4, usedCalls: 0, reservedCalls: 4, remainingCalls: 0 });
});

test('settlement consumes observed attempts and releases unused reserved capacity', async () => {
  const ledger = new AttemptLedger(5);
  const reservation = await ledger.reserve(3);
  await ledger.settle(reservation, { attempts: 2 });
  assert.deepEqual(ledger.snapshot(), { maxCalls: 5, usedCalls: 2, reservedCalls: 0, remainingCalls: 3 });
});

test('zero-attempt cancellation releases its reservation', async () => {
  const ledger = new AttemptLedger(1);
  const reservation = await ledger.reserve(1);
  await ledger.settle(reservation, { attempts: 0 });
  assert.deepEqual(ledger.snapshot(), { maxCalls: 1, usedCalls: 0, reservedCalls: 0, remainingCalls: 1 });
});

test('failed attempts still consume call allowance', async () => {
  const ledger = new AttemptLedger(2);
  const reservation = await ledger.reserve(1);
  await ledger.settle(reservation, { attempts: 1 });
  assert.equal(ledger.snapshot().remainingCalls, 1);
});

test('duplicate and modified settlement is rejected', async () => {
  const ledger = new AttemptLedger(3);
  const reservation = await ledger.reserve(2);
  await assert.rejects(ledger.settle({ ...reservation, maxAttempts: 1 }, { attempts: 1 }), AttemptLedgerError);
  await ledger.settle(reservation, { attempts: 1 });
  await assert.rejects(ledger.settle(reservation, { attempts: 1 }), AttemptLedgerError);
});

test('interrupted reservations are conservatively consumed once', async () => {
  const ledger = new AttemptLedger(5);
  await ledger.reserve(2);
  await ledger.reserve(1);
  ledger.consumeInterruptedReservations();
  assert.deepEqual(ledger.snapshot(), { maxCalls: 5, usedCalls: 3, reservedCalls: 0, remainingCalls: 2 });
  ledger.consumeInterruptedReservations();
  assert.equal(ledger.snapshot().usedCalls, 3);
});

test('restore rejects inconsistent snapshots instead of increasing call allowance', () => {
  assert.throws(() => AttemptLedger.restore({ maxCalls: 3, usedCalls: 1, reservedCalls: 1, remainingCalls: 3 }), AttemptLedgerError);
});
