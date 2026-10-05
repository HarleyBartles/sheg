import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionValueSchema } from '../src/domain/decision/decision.js';
import type { DecisionValue } from '../src/domain/decision/decision.js';
import { evaluationFailureFromJson, evaluationFailureJson, failureEvidenceFromStorage, failureEvidenceJson } from '../src/infrastructure/sqlite/evidence-records.js';
import { decodeStoredPayload, encodeStoredPayload } from '../src/infrastructure/sqlite/payload-codecs.js';

test('stored decision values round-trip in a named versioned envelope', () => {
  const answer: DecisionValue = { type: 'choice', choice: 'clear', probabilities: { clear: 0.8, unclear: 0.2 } };
  const stored = encodeStoredPayload('answer', answer, decisionValueSchema);
  assert.deepEqual(JSON.parse(stored), { formatVersion: 1, kind: 'answer', value: answer });
  assert.deepEqual(decodeStoredPayload(stored, 'answer', decisionValueSchema), answer);
});

test('stored payload decoding rejects unknown versions and invalid values', () => {
  assert.throws(() => decodeStoredPayload('{"formatVersion":2,"kind":"answer","value":{"type":"noul","noul":0.4}}', 'answer', decisionValueSchema), /unsupported stored answer format/);
  assert.throws(() => decodeStoredPayload('{"formatVersion":1,"kind":"answer","value":{"type":"noul","noul":2}}', 'answer', decisionValueSchema), /invalid stored answer/);
});

test('stored attempt failures use a versioned contract and reject unknown versions', () => {
  const failure = { code: 'provider_failed', message: 'Provider request failed.' };
  const stored = evaluationFailureJson(failure);
  assert.deepEqual(JSON.parse(stored), { formatVersion: 1, kind: 'attempt-evaluation-failure', value: failure });
  assert.deepEqual(evaluationFailureFromJson(stored), failure);
  assert.throws(() => evaluationFailureFromJson(JSON.stringify({
    formatVersion: 2, kind: 'attempt-evaluation-failure', value: failure,
  })), /unsupported stored attempt-evaluation-failure format/);
});

test('stored evaluation failure evidence is versioned and rejects unknown versions', () => {
  const detail = { reason: 'unknown_option', field: 'choice', constraint: 'offered_option' } as const;
  const stored = failureEvidenceJson({ code: 'invalid_answer', message: 'The answer was invalid.', detail });
  assert.ok(stored);
  assert.deepEqual(JSON.parse(stored), { formatVersion: 1, kind: 'evaluation-failure-evidence', value: { detail } });
  assert.deepEqual(failureEvidenceFromStorage(stored), { detail });
  assert.throws(() => failureEvidenceFromStorage(JSON.stringify({
    formatVersion: 2, kind: 'evaluation-failure-evidence', value: { detail },
  })), /unsupported stored evaluation-failure-evidence format/);
});
