import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionError, validateDecision } from '../src/domain/decision/validate.js';
import type { DecisionRequest, DecisionResult } from '../src/domain/decision/contract.js';

const request: DecisionRequest = {
  state: { respondent: { profile: 'Wants a concrete, accessible account.' }, visibleText: 'The repair began with a confusing symptom.' },
  question: {
    id: 'attention:symptom',
    instructions: 'Choose the action that best matches this reader’s experience.',
    options: { continue: 'Continue reading.', leave: 'Leave now.' },
  },
  optionIds: ['continue', 'leave'],
};

function result(overrides: Partial<DecisionResult> = {}): DecisionResult {
  return {
    choice: 'continue',
    probabilities: { continue: 0.7, leave: 0.3 },
    attempts: 1,
    provider: 'jev',
    model: 'typesafe/jev-1.13',
    latencyMs: 120,
    usage: { inputTokens: 18, outputTokens: 2 },
    chargeStatus: 'billed',
    chargeUsd: 0.0001,
    ...overrides,
  };
}

test('accepts a complete finite distribution within the documented normalization tolerance', () => {
  const accepted = validateDecision(request, result({
    probabilities: { continue: 0.695, leave: 0.3 },
  }), { maxAttempts: 2, provider: 'jev', model: 'typesafe/jev-1.13' });

  assert.equal(accepted.choice, 'continue');
  assert.equal(accepted.probabilities.leave, 0.3);
});

test('preserves provider confidence as a separate signal from the choice distribution', () => {
  const accepted = validateDecision(request, { ...result(), confidence: 0.67 });
  assert.equal(accepted.confidence, 0.67);
});

test('rejects confidence outside its finite zero-to-one range', () => {
  for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01, 'high']) {
    assert.throws(() => validateDecision(request, { ...result(), confidence }), DecisionError);
  }
});

test('rejects choices outside the offered option IDs and incomplete or unnormalized distributions', () => {
  for (const invalid of [
    result({ choice: 'maybe' }),
    result({ probabilities: { continue: 1 } }),
    result({ probabilities: { continue: 0.7, leave: 0.4 } }),
  ]) {
    assert.throws(() => validateDecision(request, invalid, { maxAttempts: 2 }), DecisionError);
  }
});

test('rejects a request whose option IDs do not match its own options', () => {
  const invalidRequest = { ...request, optionIds: ['continue', 'unoffered'] };
  assert.throws(() => validateDecision(invalidRequest, result()), /option ids/i);
});

test('rejects nonfinite, negative, and nonnumeric probabilities', () => {
  for (const probabilities of [
    { continue: Number.NaN, leave: 0.3 },
    { continue: Number.POSITIVE_INFINITY, leave: 0 },
    { continue: -0.1, leave: 1.1 },
    { continue: true, leave: 0 },
  ] as unknown[]) {
    assert.throws(() => validateDecision(request, result({ probabilities: probabilities as Record<string, number> })), DecisionError);
  }
});

test('enforces attempt limits and configured provider identity', () => {
  for (const invalid of [
    result({ attempts: 0 }),
    result({ attempts: 3 }),
    result({ provider: 'laya' }),
    result({ model: 'typesafe/jev-other' }),
    result({ checkpoint: 'different-checkpoint' }),
  ]) {
    assert.throws(() => validateDecision(request, invalid, {
      maxAttempts: 2,
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      checkpoint: 'expected-checkpoint',
    }), DecisionError);
  }
});

test('requires billed cost and refuses invented local zero-cost billing', () => {
  const missingBilledCost = result();
  delete missingBilledCost.chargeUsd;
  assert.throws(() => validateDecision(request, missingBilledCost), /billed.*cost/i);
  const localWithInventedCost = result({
    provider: 'laya',
    model: 'local-checkpoint',
    chargeStatus: 'not_billed',
    chargeUsd: 0,
  });
  assert.throws(() => validateDecision(request, localWithInventedCost), /charge/i);

  const unbilledLocal = result({
    provider: 'laya',
    model: 'local-checkpoint',
    checkpoint: 'local-checkpoint',
    chargeStatus: 'not_billed',
  });
  delete unbilledLocal.chargeUsd;
  const local = validateDecision(request, unbilledLocal, {
    maxAttempts: 1,
    provider: 'laya',
    checkpoint: 'local-checkpoint',
  });
  assert.equal(local.chargeStatus, 'not_billed');
  assert.equal(local.chargeUsd, undefined);
});
