import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionError, validateDecision } from '../src/domain/decision/validate.js';
import type { DecisionRequest, DecisionResult } from '../src/domain/decision/decision.js';

const request: DecisionRequest = {
  state: { respondent: { profile: 'Wants a concrete, accessible account.' }, visibleText: 'The repair began with a confusing symptom.' },
  question: {
    type: 'choice',
    id: 'attention:symptom',
    instructions: 'Choose the action that best matches this reader’s experience.',
    options: { continue: 'Continue reading.', leave: 'Leave now.' },
  },
  optionIds: ['continue', 'leave'],
};

function result(overrides: Partial<Extract<DecisionResult, { type: 'choice' }>> = {}): Extract<DecisionResult, { type: 'choice' }> {
  return {
    type: 'choice',
    choice: 'continue',
    probabilities: { continue: 0.7, leave: 0.3 },
    attempts: 1,
    provider: 'jev',
    model: 'typesafe/jev-1.13',
    latencyMs: 120,
    usage: { inputTokens: 18, outputTokens: 2 },
    cost: { amountUsd: 0.0001, basis: 'provider-reported' },
    ...overrides,
  };
}

test('accepts a complete finite distribution within the documented normalization tolerance', () => {
  const accepted = validateDecision(request, result({
    probabilities: { continue: 0.695, leave: 0.3 },
  }), { maxAttempts: 2, provider: 'jev', model: 'typesafe/jev-1.13' });

  assert.equal(accepted.type, 'choice');
  if (accepted.type !== 'choice') return;
  assert.equal(accepted.choice, 'continue');
  assert.equal(accepted.probabilities.leave, 0.3);
});

test('preserves provider confidence as a separate signal from the choice distribution', () => {
  const accepted = validateDecision(request, { ...result(), confidence: 0.67 });
  assert.equal(accepted.type === 'choice' ? accepted.confidence : undefined, 0.67);
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

test('accepts decisions without cost evidence and validates evidence provenance when present', () => {
  const resultWithoutCost = { ...result() } as Record<string, unknown>;
  delete resultWithoutCost.cost;
  const accepted = validateDecision(request, resultWithoutCost);
  assert.equal(accepted.cost, undefined);

  assert.equal(validateDecision(request, { ...resultWithoutCost, cost: { amountUsd: 0.0001, basis: 'provider-reported' } }).cost?.basis, 'provider-reported');
  assert.equal(validateDecision(request, { ...resultWithoutCost, cost: { amountUsd: 0.0001, basis: 'published-rate-estimate' } }).cost?.basis, 'published-rate-estimate');
  for (const cost of [
    { amountUsd: -0.01, basis: 'provider-reported' },
    { amountUsd: Number.NaN, basis: 'published-rate-estimate' },
    { amountUsd: 0.01, basis: 'invented' },
  ]) assert.throws(() => validateDecision(request, { ...resultWithoutCost, cost }), DecisionError);
});

test('validates typed Score and Noul responses without converting them to Choice', () => {
  const scoreRequest = {
    state: request.state,
    question: { type: 'score', id: 'professional-tone', instructions: 'How professional does this sound?', rubric: ['casual', 'balanced', 'professional'] },
  } as unknown as DecisionRequest;
  const scoreResult = {
    type: 'score', score: 1.25, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' },
    probabilities: { '0': 0.25, '1': 0.25, '2': 0.5 }, confidence: 0.8,
    attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 120,
    usage: { inputTokens: 18, outputTokens: 2 }, cost: { amountUsd: 0.0001, basis: 'provider-reported' },
  };
  const score = validateDecision(scoreRequest, scoreResult);
  assert.equal(score.type, 'score');
  assert.equal(score.score, 1.25);
  assert.deepEqual(score.probabilities, scoreResult.probabilities);
  assert.deepEqual(score.legend, scoreResult.legend);

  const noulRequest = {
    state: request.state,
    question: { type: 'noul', id: 'holds-attention', instructions: 'Does this hold attention?', criteria: { true: 'Yes', false: 'No' } },
  } as unknown as DecisionRequest;
  const noul = validateDecision(noulRequest, {
    type: 'noul', noul: 0.74, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 120,
    usage: { inputTokens: 18, outputTokens: 2 }, cost: { amountUsd: 0.0001, basis: 'provider-reported' },
  });
  assert.equal(noul.type, 'noul');
  assert.equal(noul.noul, 0.74);
});

test('rejects out-of-domain typed values, incomplete evidence, and responses with the wrong task type', () => {
  const scoreRequest = {
    ...request,
    question: { type: 'score', id: 'professional-tone', instructions: 'Rate the tone.', rubric: ['casual', 'balanced', 'professional'] },
  } as unknown as DecisionRequest;
  const score = {
    type: 'score', score: 1, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' },
    probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 },
    attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 120,
    usage: { inputTokens: 18, outputTokens: 2 }, cost: { amountUsd: 0.0001, basis: 'provider-reported' },
  };
  for (const invalid of [
    { ...score, type: 'noul', noul: 0.4 },
    { ...score, score: 3 },
    { ...score, score: Number.NaN },
    { ...score, probabilities: { '0': 0.2, '1': 0.8 } },
    { ...score, probabilities: { '0': 0.2, '1': 0.3, '2': 0.8 } },
    { ...score, legend: { '0': 'other', '1': 'balanced', '2': 'professional' } },
  ]) {
    assert.throws(() => validateDecision(scoreRequest, invalid), DecisionError);
  }

  const noulRequest = {
    ...request,
    question: { type: 'noul', id: 'holds-attention', instructions: 'Does this hold attention?' },
  } as unknown as DecisionRequest;
  for (const noul of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateDecision(noulRequest, {
      type: 'noul', noul, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1,
      usage: {}, cost: { amountUsd: 0.0001, basis: 'provider-reported' },
    }), DecisionError);
  }
});
