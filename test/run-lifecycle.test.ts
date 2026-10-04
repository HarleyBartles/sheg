import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveRunLifecycle, type RunLifecycleFacts } from '../src/domain/run/lifecycle.js';

const partialJourney: RunLifecycleFacts = {
  status: 'partial', kind: 'journey', cancelRequested: false,
  usedCalls: 2, reservedCalls: 0, maxCalls: 5,
  hasPendingEvaluations: false, hasFailedEvaluations: true,
  canRetrySharedFailure: false, hasRetryableJourneyFailure: true,
};

test('partial journey resume requires one safe failed turn and all run-level safety gates', () => {
  assert.deepEqual(deriveRunLifecycle(partialJourney).resume, { eligible: true });
  assert.deepEqual(deriveRunLifecycle({ ...partialJourney, hasRetryableJourneyFailure: false }).resume,
    { eligible: false, reason: 'partial_journey' });
  assert.deepEqual(deriveRunLifecycle({ ...partialJourney, hasRetryableJourneyFailure: false, cancelRequested: true }).resume,
    { eligible: false, reason: 'cancellation_requested' });
  assert.deepEqual(deriveRunLifecycle({ ...partialJourney, cancelRequested: true }).resume,
    { eligible: false, reason: 'cancellation_requested' });
  assert.deepEqual(deriveRunLifecycle({ ...partialJourney, reservedCalls: 1 }).resume,
    { eligible: false, reason: 'attempt_unresolved' });
  assert.deepEqual(deriveRunLifecycle({ ...partialJourney, usedCalls: 5 }).resume,
    { eligible: false, reason: 'call_allowance_exhausted' });
});
