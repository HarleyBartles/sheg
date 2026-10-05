import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DecisionProvider } from '../src/domain/decision/provider.js';
import type { DecisionBatchRequest, DecisionResult } from '../src/domain/decision/decision.js';
import { compileDecisionPacket, compileDecisionPacketForCompiler, promptContractHash, v6PromptContractHash, type PromptHistoryEvent, type PromptState } from '../src/domain/decision/prompt.js';
import type { JourneyRespondentState } from '../src/domain/run/lifecycle.js';
import { runRequestSchema, type InlineRunRequest, type InlineJourneyRequest, type PreparedJourneyRun } from '../src/domain/run/request.js';
import { materializeJourneyRun, prepareRun } from '../src/application/run-inspection.js';
import { executeQuestionRun as executeWorker } from '../src/application/question-worker.js';
import type { RunStore } from '../src/application/run-store.js';

function executeQuestionRun(store: RunStore, runId: string, providerFactory: Parameters<typeof executeWorker>[2]): Promise<void> {
  return executeWorker(splitRunStore(store), runId, providerFactory);
}
import { JevCallError } from '../src/providers/jev.js';
import { LayaCallError } from '../src/providers/laya.js';
import { openRunStore, splitRunStore } from '../src/infrastructure/run-store.js';
import { hashCanonical } from '../src/infrastructure/identity.js';

function request(respondents = 2): InlineRunRequest {
  return {
    kind: 'poll',
    respondents: Array.from({ length: respondents }, (_, index) => ({ id: `reader-${index + 1}`, intent: 'Learn', context: 'New buyer', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' })),
    material: [{ id: 'section-three', text: 'Section three' }],
    questions: [{ type: 'choice', id: 'interest', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } }],
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' },
    maxCalls: respondents,
  };
}

function answer(): DecisionResult {
  return { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 }, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} };
}

async function fixture(input = request(), now = () => Date.now()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-question-worker-'));
  const store = openRunStore(root, { now });
  const prepared = await prepareRun(input, { measure: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), async decide() { return answer(); } });
  assert.ok(prepared.prepared);
  const accepted = store.accept(randomUUID(), prepared.prepared);
  return { root, store, runId: accepted.run.runId, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

function factory(provider: DecisionProvider) { return () => provider; }

function authoredJourney(respondentCount = 1, maxCalls = 3): InlineJourneyRequest {
  return {
    kind: 'journey',
    respondents: Array.from({ length: respondentCount }, (_, index) => ({ id: `reader-${String.fromCharCode(97 + index)}`, intent: 'Learn', context: `Reader ${String.fromCharCode(65 + index)}`, desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' })),
    journey: {
      id: 'article', label: 'Article journey',
      items: [{ id: 'section-one', text: 'Opening section.' }, { id: 'section-three', text: 'Later section.' }],
      tasks: [
        { id: 'interest', type: 'choice', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } },
        { id: 'clarity', type: 'score', instructions: 'How clear was it?', rubric: ['Unclear', 'Mixed', 'Clear'] },
        { id: 'likely', type: 'noul', instructions: 'Would you act on it?' },
      ],
      presentation: { kind: 'graph', entryNodeId: 'opening', maxDecisions: 3, nodes: [
        { id: 'opening', kind: 'expose', itemId: 'section-one' },
        { id: 'ask-interest', kind: 'ask', taskId: 'interest' },
        { id: 'expose-section-three', kind: 'expose', itemId: 'section-three' },
        { id: 'ask-clarity', kind: 'ask', taskId: 'clarity' },
        { id: 'ask-likely', kind: 'ask', taskId: 'likely' },
        { id: 'exit', kind: 'terminal', outcome: 'left' },
        { id: 'unlikely', kind: 'terminal', outcome: 'unlikely' },
        { id: 'likely-outcome', kind: 'terminal', outcome: 'likely' },
        { id: 'clear-outcome', kind: 'terminal', outcome: 'clear' },
      ], transitions: [
        { fromNodeId: 'opening', toNodeId: 'ask-interest' },
        { fromNodeId: 'ask-interest', optionId: 'continue', toNodeId: 'expose-section-three' },
        { fromNodeId: 'ask-interest', optionId: 'leave', toNodeId: 'exit' },
        { fromNodeId: 'expose-section-three', toNodeId: 'ask-clarity' },
        { fromNodeId: 'ask-clarity', when: { type: 'score', minimum: 0, maximum: 0.5, minimumInclusive: true, maximumInclusive: false }, toNodeId: 'ask-likely' },
        { fromNodeId: 'ask-clarity', when: { type: 'score', minimum: 0.5, maximum: 1.5, minimumInclusive: true, maximumInclusive: false }, toNodeId: 'ask-likely' },
        { fromNodeId: 'ask-clarity', when: { type: 'score', minimum: 1.5, maximum: 2, minimumInclusive: true, maximumInclusive: true }, toNodeId: 'clear-outcome' },
        { fromNodeId: 'ask-likely', when: { type: 'noul', minimum: 0, maximum: 0.5, minimumInclusive: true, maximumInclusive: false }, toNodeId: 'unlikely' },
        { fromNodeId: 'ask-likely', when: { type: 'noul', minimum: 0.5, maximum: 1, minimumInclusive: true, maximumInclusive: true }, toNodeId: 'likely-outcome' },
      ] },
    },
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' },
    maxCalls,
  };
}

function preparedJourney(respondentCount = 1, maxCalls = 3, compilerFingerprint = promptContractHash()): PreparedJourneyRun {
  const parsed = runRequestSchema.parse(authoredJourney(respondentCount, maxCalls));
  if (parsed.kind !== 'journey') throw new Error('Expected a journey request.');
  const requestFingerprint = hashCanonical({ request: parsed, compilerFingerprint });
  const states: JourneyRespondentState[] = [];
  const evaluations = parsed.respondents.map((respondent, ordinal) => {
    const events: PromptHistoryEvent[] = [{ type: 'exposure', sequence: 0, nodeId: 'opening', itemId: 'section-one' }];
    const packet = compileDecisionPacketForCompiler(parsed.journey, respondent, 'interest', events, compilerFingerprint);
    const evaluationId = randomUUID();
    const turnId = randomUUID();
    const contextId = randomUUID();
    states.push({ respondentId: respondent.id, status: 'active', currentNodeId: 'ask-interest', currentTurnId: turnId, currentContextId: contextId, revision: 0, events, route: [] });
    return { evaluationId, turnId, contextId, respondentId: respondent.id, questionId: 'interest', nodeId: 'ask-interest', pathId: 'root', occurrence: 1, ordinal,
      packet, packetFingerprint: hashCanonical({ packet, compilerFingerprint }) };
  });
  return {
    request: parsed, requestFingerprint, compilerFingerprint, respondents: states, evaluations,
  };
}

function preparedSequenceJourney(): PreparedJourneyRun {
  const source = authoredJourney();
  const parsed = runRequestSchema.parse({
    ...source,
    journey: { ...source.journey, tasks: [source.journey.tasks[0]!, source.journey.tasks[1]!], presentation: { kind: 'sequence' } },
    maxCalls: 2,
  });
  if (parsed.kind !== 'journey') throw new Error('Expected a sequence journey request.');
  const compilerFingerprint = promptContractHash();
  const requestFingerprint = hashCanonical({ request: parsed, compilerFingerprint });
  const respondent = parsed.respondents[0]!;
  const events: PromptHistoryEvent[] = parsed.journey.items.map((item, sequence) => ({ type: 'exposure', sequence, nodeId: `sequence-expose-${item.id}`, itemId: item.id }));
  const packet = compileDecisionPacket(parsed.journey, respondent, 'interest', events);
  const evaluationId = randomUUID();
  const turnId = randomUUID();
  const contextId = randomUUID();
  const state: JourneyRespondentState = {
    respondentId: respondent.id, status: 'active', currentNodeId: 'sequence-ask-interest', currentTurnId: turnId, currentContextId: contextId,
    revision: 0, events, route: [],
  };
  return {
    request: parsed, requestFingerprint, compilerFingerprint, respondents: [state],
    evaluations: [{ evaluationId, turnId, contextId, respondentId: respondent.id, questionId: 'interest', nodeId: 'sequence-ask-interest', pathId: 'root', occurrence: 1, ordinal: 0,
      packet, packetFingerprint: hashCanonical({ packet, compilerFingerprint }) }],
  };
}

async function journeyFixture(respondentCount = 1, maxCalls = 3, compilerFingerprint = promptContractHash()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-journey-worker-'));
  const store = openRunStore(root);
  const accepted = store.acceptJourney(randomUUID(), preparedJourney(respondentCount, maxCalls, compilerFingerprint));
  return { root, store, runId: accepted.run.runId, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('cancellation during an in-flight answer preserves it and stops the next respondent', async () => {
  const f = await fixture();
  let calls = 0;
  let attemptLimit = 0;
  try {
    const provider: DecisionProvider = {
      async decide(_request, maxAttempts) { calls += 1; attemptLimit = maxAttempts; f.store.requestCancel(f.runId); return answer(); },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    const answers = f.store.answers(f.runId).items;
    assert.equal(status.status, 'cancelled');
    assert.equal(calls, 1);
    assert.equal(attemptLimit, 1);
    assert.equal(answers[0]?.status, 'answered');
    assert.equal(answers[1]?.status, 'pending');
    assert.equal(status.usedCalls, 1);
  } finally { await f.close(); }
});

test('poll worker processes evaluations beyond the default answer page', async () => {
  const f = await fixture(request(51));
  let calls = 0;
  try {
    await executeQuestionRun(f.store, f.runId, factory({ async decide() { calls += 1; return answer(); } }));
    const status = f.store.getStatus(f.runId);
    assert.equal(calls, 51);
    assert.equal(status.status, 'completed');
    assert.equal(status.completedEvaluations, 51);
  } finally { await f.close(); }
});

test('a grouped poll batches independent questions and resumes only the failed question in the same context', async () => {
  const input = request(1);
  input.maxCalls = 2;
  input.questions = [input.questions[0]!, { type: 'noul', id: 'interest-loss', instructions: 'Did anything reduce your interest?' },
    { type: 'score', id: 'clarity', instructions: 'How clear was it?', rubric: ['Unclear', 'Mixed', 'Clear'] }];
  const settledAt = Date.now();
  const f = await fixture(input, () => settledAt); const dispatched: Array<{ ids: string[]; state: unknown }> = [];
  try {
    const provider: DecisionProvider = { measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), async decide() { throw new Error('Expected grouped request dispatch.'); }, async decideBatch(batch: DecisionBatchRequest) {
      dispatched.push({ ids: batch.questions.map(({ id }) => id), state: batch.state });
      if (dispatched.length === 1) return { execution: { attempts: 1, provider: 'jev', model: 'served-model-before-retry', latencyMs: 1, usage: {} }, answers: [
        { questionId: 'interest', value: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } },
        { questionId: 'interest-loss', value: { type: 'noul', noul: 0.4 } },
        { questionId: 'clarity', failure: { code: 'invalid_score', message: 'The score did not match the rubric.' } },
      ] };
      return { execution: { attempts: 1, provider: 'jev', model: 'served-model-after-retry', latencyMs: 1, usage: {} }, answers: [
        { questionId: 'clarity', value: { type: 'score', score: 2, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } } },
      ] };
    } };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.equal(f.store.getStatus(f.runId).status, 'partial');
    assert.equal(f.store.getStatus(f.runId).usedCalls, 1);
    const failedBefore = f.store.answers(f.runId).items.find(({ questionId }) => questionId === 'clarity')!;
    assert.equal(failedBefore.status, 'failed');
    const resumed = f.store.resume(f.runId, Date.now()); assert.equal(resumed.started, true);
    assert.equal(f.store.getRequest(f.runId).groups?.length, 1);
    assert.deepEqual(f.store.answers(f.runId).items.map(({ status }) => status), ['answered', 'answered', 'pending']);
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.equal(f.store.getStatus(f.runId).status, 'completed', JSON.stringify(f.store.getStatus(f.runId)));
    assert.deepEqual(f.store.answers(f.runId).items.map(({ status }) => status), ['answered', 'answered', 'answered']);
    assert.deepEqual(dispatched.map(({ ids }) => ids), [['interest', 'interest-loss', 'clarity'], ['clarity']]);
    assert.deepEqual(dispatched[0]!.state, dispatched[1]!.state);
    assert.equal(f.store.answers(f.runId).items.find(({ questionId }) => questionId === 'clarity')!.execution?.model, 'served-model-after-retry');
    const retriedEvidence = f.store.queryEvidence({ sourceRunId: f.runId, criteria: { questionId: 'clarity' }, limit: 1 });
    assert.equal(retriedEvidence.items[0]!.execution?.model, 'served-model-after-retry');
    assert.equal(f.store.getStatus(f.runId).usedCalls, 2);
    assert.equal(f.store.getStatus(f.runId).status, 'completed');
  } finally { await f.close(); }
});

test('cancellation during a grouped provider call settles every returned sibling and dispatches no later group', async () => {
  const input = request(2); input.maxCalls = 2;
  input.questions.push({ type: 'noul', id: 'interest-loss', instructions: 'Did anything reduce interest?' });
  const f = await fixture(input); let calls = 0;
  try {
    const provider: DecisionProvider = {
      measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }),
      async decide() { throw new Error('Expected a batch call.'); },
      async decideBatch(batch) {
        calls += 1; f.store.requestCancel(f.runId);
        return { execution: { attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} }, answers: batch.questions.map((question) => question.type === 'choice'
          ? { questionId: question.id, value: { type: 'choice' as const, choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } }
          : { questionId: question.id, value: { type: 'noul' as const, noul: 0.6 } }) };
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.equal(calls, 1);
    assert.equal(f.store.getStatus(f.runId).status, 'cancelled');
    assert.equal(f.store.getStatus(f.runId).usedCalls, 1);
    assert.deepEqual(f.store.answers(f.runId).items.map(({ status }) => status), ['answered', 'answered', 'pending', 'pending']);
  } finally { await f.close(); }
});

test('an interrupted grouped attempt consumes one call and resume dispatches only unresolved questions', async () => {
  const input = request(1); input.maxCalls = 2;
  input.questions.push({ type: 'noul', id: 'interest-loss', instructions: 'Did anything reduce interest?' },
    { type: 'score', id: 'clarity', instructions: 'How clear was it?', rubric: ['Unclear', 'Mixed', 'Clear'] });
  const f = await fixture(input); let calls = 0;
  try {
    const prepared = f.store.getRequest(f.runId); const group = prepared.groups![0]!;
    const claim = f.store.claim(f.runId, Date.now(), process.pid); assert.ok(claim);
    const reservation = f.store.reserveBatch(claim, group.groupId, prepared.evaluations.map(({ evaluationId }) => evaluationId), Date.now()); assert.ok(reservation);
    const interrupted = f.store.reconcile(f.runId, Date.now() + 31_000);
    assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.usedCalls, 1);
    assert.deepEqual(f.store.answers(f.runId).items.map(({ status }) => status), ['pending', 'pending', 'pending']);
    const resumed = f.store.resume(f.runId, Date.now() + 31_001); assert.equal(resumed.started, true);
    const provider: DecisionProvider = {
      measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }),
      async decide() { throw new Error('Expected a batch call.'); },
      async decideBatch(batch) {
        calls += 1;
        assert.deepEqual(batch.questions.map(({ id }) => id), ['interest', 'interest-loss', 'clarity']);
        return { execution: { attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} }, answers: batch.questions.map((question) => question.type === 'choice'
          ? { questionId: question.id, value: { type: 'choice' as const, choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } }
          : question.type === 'noul' ? { questionId: question.id, value: { type: 'noul' as const, noul: 0.6 } }
            : { questionId: question.id, value: { type: 'score' as const, score: 2, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } } }) };
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.equal(calls, 1); assert.equal(f.store.getStatus(f.runId).usedCalls, 2);
    assert.deepEqual(f.store.answers(f.runId).items.map(({ status }) => status), ['answered', 'answered', 'answered']);
  } finally { await f.close(); }
});

test('a shared dispatched authorization failure consumes its call and explicit resume retries reserved questions', async () => {
  const input = request(1); input.maxCalls = 2;
  input.questions.push({ type: 'noul', id: 'interest-loss', instructions: 'Did anything reduce interest?' });
  const f = await fixture(input); let calls = 0; const dispatched: string[][] = [];
  const provider: DecisionProvider = {
    measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }),
    async decide() { throw new Error('Expected grouped request.'); },
    async decideBatch(batch) {
      calls += 1; dispatched.push(batch.questions.map(({ id }) => id));
      if (calls === 1) throw new JevCallError('authorization rejected', 1, undefined, undefined, 'run', 'credential_unavailable');
      return { execution: { attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} }, answers: batch.questions.map((question) => question.type === 'choice'
        ? { questionId: question.id, value: { type: 'choice' as const, choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } }
        : { questionId: question.id, value: { type: 'noul' as const, noul: 0.6 } }) };
    },
  };
  try {
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.equal(f.store.getStatus(f.runId).status, 'failed'); assert.equal(f.store.getStatus(f.runId).usedCalls, 1);
    assert.deepEqual(f.store.answers(f.runId).items.map(({ status }) => status), ['failed', 'failed']);
    assert.equal(f.store.resume(f.runId, Date.now()).started, true);
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.deepEqual(dispatched, [['interest', 'interest-loss'], ['interest', 'interest-loss']]);
    assert.deepEqual(f.store.answers(f.runId).items.map(({ status }) => status), ['answered', 'answered']);
    assert.equal(f.store.getStatus(f.runId).usedCalls, 2);
  } finally { await f.close(); }
});

test('a credential failure before dispatch preserves the call allowance for explicit resume', async () => {
  const input = request(1); input.maxCalls = 1;
  const f = await fixture(input); let calls = 0;
  const provider: DecisionProvider = {
    measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }),
    async decide() { throw new Error('Expected grouped request.'); },
    async decideBatch(batch) {
      calls += 1;
      if (calls === 1) throw new JevCallError('credential unavailable', 0, undefined, undefined, 'run', 'credential_unavailable');
      return { execution: { attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} }, answers: batch.questions.map((question) => ({ questionId: question.id, value: { type: 'choice' as const, choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } })) };
    },
  };
  try {
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.equal(f.store.getStatus(f.runId).status, 'failed');
    assert.equal(f.store.getStatus(f.runId).usedCalls, 0);
    assert.equal(f.store.getStatus(f.runId).reservedCalls, 0);
    assert.equal(f.store.answers(f.runId).items[0]!.status, 'failed');
    assert.equal(f.store.resume(f.runId, Date.now()).started, true);
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.equal(calls, 2);
    assert.equal(f.store.getStatus(f.runId).status, 'completed');
    assert.equal(f.store.getStatus(f.runId).usedCalls, 1);
  } finally { await f.close(); }
});

test('a typed provider validation failure gives safe reasons and the worker continues', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide() {
        calls += 1;
        if (calls === 1) throw new LayaCallError('Laya response failed decision validation.', 1, undefined, undefined, 'evaluation', {
          code: 'invalid_answer', message: 'The selected option was not offered by this question.',
          detail: { reason: 'unknown_option', field: 'choice', constraint: 'offered_option' },
        });
        return answer();
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'partial');
    assert.equal(calls, 2);
    assert.deepEqual(f.store.answers(f.runId).items.map((item) => item.status), ['failed', 'answered']);
    assert.deepEqual(f.store.answers(f.runId).items[0]?.failure, {
      code: 'invalid_answer', message: 'The selected option was not offered by this question.',
      detail: { reason: 'unknown_option', field: 'choice', constraint: 'offered_option' },
      providerFailure: { category: 'answer', attempts: 1, scope: 'evaluation' },
    });
    assert.deepEqual(f.store.attempts(f.runId).items[0]?.evaluationFailures?.[0]?.failure, f.store.answers(f.runId).items[0]?.failure);
    assert.equal(status.usedCalls, 2);
  } finally { await f.close(); }
});

test('provider authentication failure ends the run without dispatching sibling respondents', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide() { calls += 1; throw new JevCallError('secret detail', 0, undefined, undefined, 'run'); },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(f.store.answers(f.runId).items[1]?.status, 'pending');
    assert.equal(status.failure?.message.includes('secret detail'), false);
  } finally { await f.close(); }
});

test('known pre-dispatch context refusal retains fit evidence through query and attempt recall without charging a call', async () => {
  const f = await fixture(request(1));
  const fit = { provider: 'jev' as const, status: 'overflow' as const, method: 'estimated-json', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated' as const, tokens: 1200, contextLimit: 1000, headroomTokens: 200, effectiveLimit: 800, details: {}, reason: 'estimated-context-over-limit' };
  try {
    await executeQuestionRun(f.store, f.runId, factory({ async decide() { throw new JevCallError('Raw diagnostic must not escape', 0, fit); } }));
    assert.equal(f.store.getStatus(f.runId).usedCalls, 0);
    const evidence = f.store.queryEvidence({ sourceRunId: f.runId, criteria: {} }).items[0]?.failure;
    assert.equal(evidence?.code, 'provider_context_overflow');
    assert.deepEqual((evidence as { providerFailure?: unknown })?.providerFailure, { category: 'admission', attempts: 0, scope: 'evaluation', contextFit: fit });
    const attempt = f.store.attempts(f.runId).items[0]?.evaluationFailures?.[0]?.failure;
    assert.deepEqual(attempt, evidence);
    assert.doesNotMatch(JSON.stringify(evidence), /Raw diagnostic/);
    f.store.close();
    const reopened = openRunStore(f.root);
    try { assert.deepEqual(reopened.queryEvidence({ sourceRunId: f.runId, criteria: {} }).items[0]?.failure, evidence); }
    finally { reopened.close(); }
  } finally { await f.close(); }
});

test('a run-wide Laya authorization failure stops before the next respondent', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide() { calls += 1; throw new LayaCallError('Laya local service returned HTTP 401.', 1, undefined, undefined, 'run'); },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(f.store.answers(f.runId).items[0]?.failure?.code, 'provider_unavailable');
    assert.equal(f.store.answers(f.runId).items[1]?.status, 'pending');
  } finally { await f.close(); }
});

test('an unclassified provider exception is charged as an uncertain failed evaluation', async () => {
  const f = await fixture({ ...request(1), maxCalls: 1 });
  let attemptLimit = 0;
  try {
    const provider: DecisionProvider = { async decide(_request, maxAttempts) { attemptLimit = maxAttempts; throw new Error('transport dropped after dispatch'); } };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'partial');
    assert.equal(status.usedCalls, 1);
    assert.equal(status.reservedCalls, 0);
    assert.equal(attemptLimit, 1);
    assert.equal(f.store.answers(f.runId).items[0]?.status, 'failed');
  } finally { await f.close(); }
});

test('a worker failure with untouched pending work remains explicitly resumable', async () => {
  const f = await fixture();
  try {
    const provider: DecisionProvider = {
      async decide() { throw new Error('not reached'); },
      async decideBatch() { throw new Error('not reached'); },
      measureBatch() { throw new Error('context measurement failed'); },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const failed = f.store.getStatus(f.runId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.completedEvaluations, 0);
    assert.equal(failed.usedCalls, 0);
    assert.deepEqual(failed.lifecycle.resume, { eligible: true });
    assert.equal(f.store.resume(f.runId, Date.now()).started, true);
  } finally { await f.close(); }
});

test('a duplicate worker cannot execute the same run while the owner is active', async () => {
  const f = await fixture({ ...request(1), maxCalls: 1 });
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  try {
    const provider: DecisionProvider = {
      async decide() { started?.(); await new Promise<void>((resolve) => { release = resolve; }); return answer(); },
    };
    const owner = executeQuestionRun(f.store, f.runId, factory(provider));
    await entered;
    await executeQuestionRun(f.store, f.runId, factory({ async decide() { throw new Error('duplicate worker called provider'); } }));
    release?.();
    await owner;
    assert.equal(f.store.getStatus(f.runId).status, 'completed');
  } finally { release?.(); await f.close(); }
});

test('a detached journey worker records reached Choice, Score and Noul turns through a reconvergent graph', async () => {
  const f = await journeyFixture();
  const requests: Array<{ questionId: string; encounteredItems: unknown[]; responseCount: number }> = [];
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide(request, maxAttempts) {
        calls += 1;
        assert.equal(maxAttempts, 1);
        requests.push({ questionId: request.question.id, encounteredItems: request.state.encounteredItems as unknown[], responseCount: (request.state.trajectory as { responses: unknown[] }).responses.length });
        if (request.question.type === 'choice') return { ...answer(), choice: 'continue' };
        if (request.question.type === 'score') return {
          type: 'score', score: 1, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 },
          attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {},
        };
        return { type: 'noul', noul: 0.8, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} };
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    const run = f.store.getJourneyRun(f.runId);
    assert.equal(status.status, 'completed');
    assert.equal(status.usedCalls, 3);
    assert.equal(calls, 3);
    assert.deepEqual(requests.map(({ questionId }) => questionId), ['interest', 'clarity', 'likely']);
    assert.deepEqual(requests[1]!.encounteredItems, [
      { id: 'section-one', text: 'Opening section.' },
      { id: 'section-three', text: 'Later section.' },
    ]);
    assert.equal(requests[1]!.responseCount, 1);
    assert.equal(requests[2]!.responseCount, 2);
    assert.deepEqual(run.evaluations.map(({ status: evaluationStatus, nodeId }) => [evaluationStatus, nodeId]), [
      ['answered', 'ask-interest'], ['answered', 'ask-clarity'], ['answered', 'ask-likely'],
    ]);
    assert.deepEqual(run.evaluations.map(({ result }) => result?.type), ['choice', 'score', 'noul']);
    assert.equal(run.respondents[0]!.status, 'completed');
    assert.equal(run.respondents[0]!.outcome, 'likely');
    assert.deepEqual(run.respondents[0]!.route.map(({ toNodeId }) => toNodeId), ['expose-section-three', 'ask-likely', 'likely-outcome']);
  } finally { await f.close(); }
});

test('a journey worker advances from its checkpoint without reading earlier turn packets', async () => {
  const f = await journeyFixture(1, 6);
  const database = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
  let calls = 0;
  try {
    database.exec(`CREATE TRIGGER corrupt_prior_journey_packet AFTER UPDATE OF status ON evaluations
      WHEN NEW.run_id = '${f.runId}' AND NEW.question_id = 'interest' AND NEW.status = 'answered'
      BEGIN UPDATE evaluations SET packet_json = '{' WHERE evaluation_id = NEW.evaluation_id; END`);
    await executeQuestionRun(f.store, f.runId, factory({
      async decide(request) {
        calls += 1;
        if (calls === 1) {
          assert.equal(request.question.id, 'interest');
          return { ...answer(), choice: 'continue' };
        }
        assert.equal(request.question.id, 'clarity');
        database.prepare('UPDATE runs SET cancel_requested = 1 WHERE run_id = ?').run(f.runId);
        return { type: 'score', score: 1, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 }, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} };
      },
    }));
    assert.equal(calls, 2);
    assert.equal(f.store.getStatus(f.runId).status, 'cancelled');
    const rows = database.prepare('SELECT respondent_id, question_id, status FROM evaluations WHERE run_id = ? ORDER BY ordinal').all(f.runId) as Array<{ respondent_id: string; question_id: string; status: string }>;
    assert.deepEqual(rows.map(({ question_id, status }) => [question_id, status]), [
      ['interest', 'answered'], ['clarity', 'answered'], ['likely', 'pending'],
    ]);
  } finally { database.close(); await f.close(); }
});

test('repeated journey task nodes receive increasing task occurrences', async () => {
  const base = authoredJourney(1, 2);
  const input = {
    ...base,
    journey: {
      ...base.journey,
      tasks: [base.journey.tasks[0]!],
      presentation: { kind: 'graph' as const, entryNodeId: 'ask-first', maxDecisions: 2, nodes: [
        { id: 'ask-first', kind: 'ask' as const, taskId: 'interest' },
        { id: 'ask-second', kind: 'ask' as const, taskId: 'interest' },
        { id: 'done', kind: 'terminal' as const, outcome: 'complete' },
      ], transitions: [
        { fromNodeId: 'ask-first', optionId: 'continue', toNodeId: 'ask-second' },
        { fromNodeId: 'ask-first', optionId: 'leave', toNodeId: 'done' },
        { fromNodeId: 'ask-second', optionId: 'continue', toNodeId: 'done' },
        { fromNodeId: 'ask-second', optionId: 'leave', toNodeId: 'done' },
      ] },
    },
    maxCalls: 2,
  };
  const admission = await prepareRun(input, {
    measure: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'mock', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }),
    async decide() { throw new Error('Admission must not infer.'); },
  });
  assert.ok(admission.journey);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-repeated-task-occurrence-'));
  const store = openRunStore(root);
  const accepted = store.acceptJourney(randomUUID(), materializeJourneyRun(admission.journey));
  try {
    await executeQuestionRun(store, accepted.run.runId, factory({ async decide() { return { ...answer(), choice: 'continue' }; } }));
    const run = store.getJourneyRun(accepted.run.runId);
    assert.deepEqual(run.evaluations.map(({ questionId, occurrence }) => [questionId, occurrence]), [['interest', 1], ['interest', 2]]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a respondent-local journey failure does not block another respondent', async () => {
  const f = await journeyFixture(2, 6);
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide(request) {
        calls += 1;
        if (calls === 1) return { ...answer(), choice: 'invalid' };
        assert.equal(request.question.id, 'interest');
        return { ...answer(), choice: 'leave' };
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const run = f.store.getJourneyRun(f.runId);
    assert.equal(f.store.getStatus(f.runId).status, 'partial');
    assert.equal(calls, 2);
    assert.equal(run.respondents.find(({ respondentId }) => respondentId === 'reader-a')?.status, 'failed');
    assert.equal(run.respondents.find(({ respondentId }) => respondentId === 'reader-b')?.status, 'completed');
    assert.equal(run.evaluations[0]?.status, 'failed');
    assert.equal(run.evaluations[1]?.status, 'answered');
  } finally { await f.close(); }
});

test('a partial journey failure retains the respondent-local checkpoint and prior path', async () => {
  const f = await journeyFixture(2, 8);
  try {
    await executeQuestionRun(f.store, f.runId, factory({
      async decide(request) {
        const respondent = (request.state as PromptState).respondent.profile.context;
        if (respondent === 'Reader A' && request.question.id === 'interest') return { ...answer(), choice: 'continue' };
        if (respondent === 'Reader A' && request.question.id === 'clarity') throw new Error('local typed evaluation failure');
        if (respondent === 'Reader B' && request.question.id === 'interest') return { ...answer(), choice: 'leave' };
        throw new Error(`Unexpected question for ${respondent}: ${request.question.id}`);
      },
    }));
    const run = f.store.getJourneyRun(f.runId);
    const failedEvaluation = run.evaluations.find(({ respondentId, status }) => respondentId === 'reader-a' && status === 'failed');
    const failedRespondent = run.respondents.find(({ respondentId }) => respondentId === 'reader-a');
    assert.ok(failedEvaluation);
    assert.ok(failedRespondent);
    assert.equal(failedRespondent.status, 'failed');
    assert.equal(failedRespondent.currentTurnId, null);
    assert.equal(failedRespondent.currentContextId, null);
    assert.equal(failedRespondent.currentNodeId, null);
    assert.deepEqual(failedRespondent.route.map(({ nodeId, toNodeId }) => [nodeId, toNodeId]), [['ask-interest', 'expose-section-three']]);
    assert.equal(failedRespondent.events.filter(({ type }) => type === 'response').length, 1);
    assert.equal(run.evaluations.some(({ respondentId, questionId }) => respondentId === 'reader-a' && questionId === 'likely'), false);
    assert.equal(run.respondents.find(({ respondentId }) => respondentId === 'reader-b')?.status, 'completed');
    const before = f.store.getStatus(f.runId);
    assert.deepEqual(before.lifecycle.resume, { eligible: true });
    const failedPacket = structuredClone(failedEvaluation.packet);
    const failedPacketFingerprint = failedEvaluation.packetFingerprint;
    const previousRoute = structuredClone(failedRespondent.route);
    const previousEvents = structuredClone(failedRespondent.events);
    const successfulSibling = structuredClone(run.evaluations.find(({ respondentId }) => respondentId === 'reader-b'));
    const failedAttemptsBefore = f.store.attempts(f.runId).items.filter(({ evaluationIds }) => evaluationIds.includes(failedEvaluation.evaluationId));
    assert.equal(failedAttemptsBefore.length, 1);
    assert.equal(failedAttemptsBefore[0]?.status, 'failed');

    const resumed = f.store.resume(f.runId, Date.now());
    assert.equal(resumed.started, true);
    assert.equal(resumed.run.runId, f.runId);
    assert.equal(resumed.run.maxCalls, before.maxCalls);
    assert.equal(resumed.run.usedCalls, before.usedCalls);
    const reopened = f.store.getJourneyRun(f.runId);
    const activeRespondent = reopened.respondents.find(({ respondentId }) => respondentId === 'reader-a');
    const retryEvaluation = reopened.evaluations.find(({ evaluationId }) => evaluationId === failedEvaluation.evaluationId);
    assert.equal(activeRespondent?.status, 'active');
    assert.equal(activeRespondent?.currentTurnId, failedEvaluation.turnId);
    assert.equal(activeRespondent?.currentContextId, failedEvaluation.contextId);
    assert.equal(activeRespondent?.currentNodeId, failedEvaluation.nodeId);
    assert.ok(activeRespondent!.revision > failedRespondent.revision);
    assert.deepEqual(activeRespondent?.route, previousRoute);
    assert.deepEqual(activeRespondent?.events, previousEvents);
    assert.equal(retryEvaluation?.status, 'pending');
    assert.deepEqual(retryEvaluation?.packet, failedPacket);
    assert.equal(retryEvaluation?.packetFingerprint, failedPacketFingerprint);
    assert.deepEqual(reopened.evaluations.find(({ respondentId }) => respondentId === 'reader-b'), successfulSibling);

    const resumedCalls: Array<{ questionId: string; profile: string }> = [];
    await executeQuestionRun(f.store, f.runId, factory({
      async decide(request) {
        resumedCalls.push({ questionId: request.question.id, profile: (request.state as PromptState).respondent.profile.context });
        if (request.question.type === 'score') return {
          type: 'score', score: 2, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 },
          attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {},
        };
        return { type: 'noul', noul: 0.8, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} };
      },
    }));
    assert.deepEqual(resumedCalls, [{ questionId: 'clarity', profile: 'Reader A' }]);
    const completed = f.store.getJourneyRun(f.runId);
    assert.equal(f.store.getStatus(f.runId).status, 'completed');
    assert.equal(completed.evaluations.find(({ evaluationId }) => evaluationId === failedEvaluation.evaluationId)?.turnId, failedEvaluation.turnId);
    assert.deepEqual(completed.respondents.find(({ respondentId }) => respondentId === 'reader-a')?.route.slice(0, 1), previousRoute);
    assert.deepEqual(completed.respondents.find(({ respondentId }) => respondentId === 'reader-a')?.route.slice(1).map(({ nodeId, toNodeId }) => [nodeId, toNodeId]), [['ask-clarity', 'clear-outcome']]);
    assert.equal(completed.respondents.find(({ respondentId }) => respondentId === 'reader-a')?.events.filter(({ type }) => type === 'response').length, 2);
    const failedAttemptsAfter = f.store.attempts(f.runId).items.filter(({ evaluationIds }) => evaluationIds.includes(failedEvaluation.evaluationId));
    assert.deepEqual(failedAttemptsAfter.map(({ status }) => status), ['failed', 'answered']);
  } finally { await f.close(); }
});

test('a reached journey turn that overflows fit stops only that respondent without charging a provider call', async () => {
  const input = authoredJourney(2, 8);
  const initialFit = { provider: 'jev' as const, status: 'fits' as const, method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated' as const, tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} };
  const admission = await prepareRun(input, {
    measure: () => initialFit,
    async decide() { throw new Error('Admission must not infer.'); },
  });
  assert.equal(admission.inspection.valid, true);
  assert.equal(admission.inspection.warnings?.some(({ code }) => code === 'reached_turn_fit_check'), true);
  assert.ok(admission.journey);

  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-late-journey-fit-'));
  const store = openRunStore(root);
  const accepted = store.acceptJourney(randomUUID(), materializeJourneyRun(admission.journey));
  const overflow = { ...initialFit, status: 'overflow' as const, tokens: 1200, contextLimit: 1000, effectiveLimit: 900, reason: 'estimated-context-over-limit' };
  let dispatches = 0;
  try {
    await executeQuestionRun(store, accepted.run.runId, factory({
      async decide(packet) {
        dispatches += 1;
        const profile = (packet.state as PromptState).respondent.profile.context;
        if (profile === 'Reader A' && packet.question.id === 'interest') return { ...answer(), choice: 'continue' };
        if (profile === 'Reader B' && packet.question.id === 'interest') return { ...answer(), choice: 'leave' };
        if (profile === 'Reader A' && packet.question.id === 'clarity') throw new JevCallError('Fit changed for reached input.', 0, overflow);
        throw new Error(`Unexpected packet ${profile}/${packet.question.id}`);
      },
    }));

    const run = store.getJourneyRun(accepted.run.runId);
    const status = store.getStatus(accepted.run.runId);
    const failedRespondent = run.respondents.find(({ respondentId }) => respondentId === 'reader-a');
    const completedRespondent = run.respondents.find(({ respondentId }) => respondentId === 'reader-b');
    const failedEvaluation = run.evaluations.find(({ respondentId, status: evaluationStatus }) => respondentId === 'reader-a' && evaluationStatus === 'failed');
    assert.equal(status.status, 'partial');
    assert.equal(status.usedCalls, 2);
    assert.equal(dispatches, 3);
    assert.equal(failedRespondent?.status, 'failed');
    assert.equal(failedRespondent?.events.filter(({ type }) => type === 'response').length, 1);
    assert.deepEqual(failedRespondent?.route.map(({ nodeId, toNodeId }) => [nodeId, toNodeId]), [['ask-interest', 'expose-section-three']]);
    assert.equal(completedRespondent?.status, 'completed');
    assert.equal(failedEvaluation?.failure?.code, 'provider_context_overflow');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed retry stays partial and preserves every attempt for the same reached turn', async () => {
  const f = await journeyFixture(1, 6);
  try {
    await executeQuestionRun(f.store, f.runId, factory({ async decide(request) {
      if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
      throw new Error('respondent-local evaluation failure');
    } }));
    const failedId = f.store.getJourneyRun(f.runId).evaluations.find(({ status }) => status === 'failed')!.evaluationId;
    assert.equal(f.store.getStatus(f.runId).status, 'partial');
    assert.equal(f.store.resume(f.runId, Date.now()).started, true);
    await executeQuestionRun(f.store, f.runId, factory({ async decide() { throw new Error('respondent-local retry failure'); } }));
    const attempts = f.store.attempts(f.runId).items.filter(({ evaluationIds }) => evaluationIds.includes(failedId));
    assert.deepEqual(attempts.map(({ status }) => status), ['failed', 'failed']);
    assert.equal(f.store.getJourneyRun(f.runId).evaluations.find(({ evaluationId }) => evaluationId === failedId)?.status, 'failed');
    assert.equal(f.store.getStatus(f.runId).status, 'partial');
    assert.deepEqual(f.store.getStatus(f.runId).lifecycle.resume, { eligible: true });
  } finally { await f.close(); }
});

test('a partial journey whose original allowance is exhausted refuses resume', async () => {
  const f = await journeyFixture(1, 2);
  try {
    await executeQuestionRun(f.store, f.runId, factory({ async decide(request) {
      if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
      throw new Error('respondent-local evaluation failure');
    } }));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'partial');
    assert.equal(status.usedCalls, status.maxCalls);
    assert.deepEqual(status.lifecycle.resume, { eligible: false, reason: 'call_allowance_exhausted' });
    assert.throws(() => f.store.resume(f.runId, Date.now()), /no remaining provider-call allowance/i);
  } finally { await f.close(); }
});

test('resuming multiple failed respondents never exceeds the one call left in the original allowance', async () => {
  const f = await journeyFixture(2, 5);
  let retryPhase = false;
  let retryCalls = 0;
  try {
    await executeQuestionRun(f.store, f.runId, factory({ async decide(request) {
      if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
      if (!retryPhase) throw new Error('respondent-local evaluation failure');
      retryCalls += 1;
      if (retryCalls > 1) throw new Error('worker exceeded the remaining physical-call allowance');
      return {
        type: 'score', score: 2, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 },
        attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {},
      };
    } }));
    const before = f.store.getStatus(f.runId);
    assert.equal(before.status, 'partial');
    assert.equal(before.usedCalls, 4);
    assert.equal(before.maxCalls, 5);
    assert.deepEqual(before.lifecycle.resume, { eligible: true });
    assert.equal(f.store.getJourneyRun(f.runId).evaluations.filter(({ questionId, status }) => questionId === 'clarity' && status === 'failed').length, 2);

    retryPhase = true;
    assert.equal(f.store.resume(f.runId, Date.now()).started, true);
    await executeQuestionRun(f.store, f.runId, factory({ async decide(request) {
      if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
      retryCalls += 1;
      if (retryCalls > 1) throw new Error('worker exceeded the remaining physical-call allowance');
      return {
        type: 'score', score: 2, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 },
        attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {},
      };
    } }));
    const after = f.store.getJourneyRun(f.runId);
    const status = f.store.getStatus(f.runId);
    assert.equal(retryCalls, 1);
    assert.equal(status.usedCalls, status.maxCalls);
    assert.equal(status.status, 'partial');
    assert.deepEqual(status.lifecycle.resume, { eligible: false, reason: 'call_allowance_exhausted' });
    assert.equal(after.evaluations.filter(({ questionId, status: evaluationStatus }) => questionId === 'clarity' && evaluationStatus === 'answered').length, 1);
    const unresolved = after.evaluations.find(({ respondentId, questionId, status: evaluationStatus }) => respondentId === 'reader-b' && questionId === 'clarity' && evaluationStatus === 'unreached');
    assert.ok(unresolved);
    assert.deepEqual(f.store.attempts(f.runId).items.filter(({ evaluationIds }) => evaluationIds.includes(unresolved.evaluationId)).map(({ status: attemptStatus }) => attemptStatus), ['failed']);
    assert.equal(f.store.attempts(f.runId).items.length, 5);
  } finally { await f.close(); }
});

test('journey resume lifecycle refuses a failed evaluation without a failed respondent checkpoint', async () => {
  const f = await journeyFixture(1, 5);
  const database = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
  try {
    await executeQuestionRun(f.store, f.runId, factory({ async decide(request) {
      if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
      throw new Error('respondent-local evaluation failure');
    } }));
    assert.deepEqual(f.store.getStatus(f.runId).lifecycle.resume, { eligible: true });
    database.prepare("UPDATE journey_respondents SET status = 'unreached' WHERE run_id = ? AND respondent_id = 'reader-a'").run(f.runId);
    assert.deepEqual(f.store.getStatus(f.runId).lifecycle.resume, { eligible: false, reason: 'partial_journey' });
    assert.throws(() => f.store.resume(f.runId, Date.now()), /partial journey run cannot be resumed/i);
  } finally { database.close(); await f.close(); }
});

test('journey resume lifecycle refuses a failed respondent with no failed evaluation', async () => {
  const f = await journeyFixture(2, 8);
  const database = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
  try {
    await executeQuestionRun(f.store, f.runId, factory({ async decide(request) {
      if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
      throw new Error('respondent-local evaluation failure');
    } }));
    const failures = f.store.getJourneyRun(f.runId).evaluations.filter(({ status }) => status === 'failed');
    assert.equal(failures.length, 2);
    database.prepare("UPDATE evaluations SET status = 'pending', failure_code = NULL, failure_message = NULL WHERE evaluation_id = ?").run(failures[1]!.evaluationId);

    assert.deepEqual(f.store.getStatus(f.runId).lifecycle.resume, { eligible: false, reason: 'partial_journey' });
    assert.throws(() => f.store.resume(f.runId, Date.now()), /partial journey run cannot be resumed/i);
  } finally { database.close(); await f.close(); }
});

test('journey resume lifecycle refuses a failed evaluation with no saved turn checkpoint', async () => {
  const f = await journeyFixture(1, 5);
  const database = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
  try {
    await executeQuestionRun(f.store, f.runId, factory({ async decide(request) {
      if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
      throw new Error('respondent-local evaluation failure');
    } }));
    const failed = f.store.getJourneyRun(f.runId).evaluations.find(({ status }) => status === 'failed')!;
    database.prepare('UPDATE evaluations SET turn_id = NULL, node_id = NULL, path_id = NULL, occurrence = NULL WHERE evaluation_id = ?').run(failed.evaluationId);

    assert.deepEqual(f.store.getStatus(f.runId).lifecycle.resume, { eligible: false, reason: 'partial_journey' });
    assert.throws(() => f.store.resume(f.runId, Date.now()), /partial journey run cannot be resumed/i);
  } finally { database.close(); await f.close(); }
});

test('an explicit resume restarts the failed reached turn without replaying earlier answers', async () => {
  const f = await journeyFixture(1, 5);
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide(request) {
        calls += 1;
        if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
        if (request.question.id === 'clarity') throw new LayaCallError('local service is unavailable', 1, undefined, undefined, 'run');
        throw new Error(`Unexpected question ${request.question.id}.`);
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    assert.equal(f.store.getStatus(f.runId).status, 'failed');
    const paused = f.store.getJourneyRun(f.runId);
    assert.deepEqual(paused.evaluations.map(({ status }) => status), ['answered', 'failed']);
    const failedTurn = paused.respondents[0]!.currentTurnId;
    assert.equal(paused.respondents[0]!.status, 'active');
    assert.ok(failedTurn);

    const resumed = f.store.resume(f.runId, Date.now());
    assert.equal(resumed.started, true);
    const resumedProvider: DecisionProvider = {
      async decide(request) {
        calls += 1;
        assert.notEqual(request.question.id, 'interest');
        if (request.question.type === 'score') return {
          type: 'score', score: 1, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 },
          attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {},
        };
        return { type: 'noul', noul: 0.8, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} };
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(resumedProvider));
    const run = f.store.getJourneyRun(f.runId);
    assert.equal(f.store.getStatus(f.runId).status, 'completed');
    assert.equal(calls, 4);
    assert.equal(run.evaluations[0]!.status, 'answered');
    assert.equal(run.evaluations[1]!.turnId, failedTurn);
    assert.deepEqual(run.evaluations.map(({ status }) => status), ['answered', 'answered', 'answered']);
  } finally { await f.close(); }
});

test('a frozen v6 journey resumes with its original exposure window and packet identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-v6-journey-resume-'));
  let store = openRunStore(root);
  const accepted = store.acceptJourney(randomUUID(), preparedJourney(1, 5, v6PromptContractHash));
  let clarityCalls = 0;
  const firstClarityPacket: unknown[] = [];
  try {
    const initialProvider: DecisionProvider = {
      async decide(request) {
        if (request.question.id === 'interest') return { ...answer(), choice: 'continue' };
        if (request.question.id === 'clarity') {
          firstClarityPacket.push(structuredClone(request));
          clarityCalls += 1;
          throw new LayaCallError('local service is unavailable', 1, undefined, undefined, 'run');
        }
        throw new Error(`Unexpected question ${request.question.id}.`);
      },
    };
    await executeQuestionRun(store, accepted.run.runId, factory(initialProvider));
    const beforeResume = store.getJourneyRun(accepted.run.runId);
    const frozenPacket = structuredClone(beforeResume.evaluations[1]!.packet);
    const frozenFingerprint = beforeResume.evaluations[1]!.packetFingerprint;
    assert.equal(beforeResume.compilerFingerprint, v6PromptContractHash);
    assert.deepEqual(frozenPacket.state.encounteredItems.map(({ id }) => id), ['section-three']);
    assert.deepEqual(beforeResume.evaluations[0]!.packet.state.encounteredItems.map(({ id }) => id), ['section-one']);

    store.close();
    store = openRunStore(root);
    const reopened = store.getJourneyRun(accepted.run.runId);
    assert.deepEqual(reopened.evaluations[1]!.packet, frozenPacket);
    assert.equal(reopened.evaluations[1]!.packetFingerprint, frozenFingerprint);
    assert.equal(store.resume(accepted.run.runId, Date.now()).started, true);
    const resumedProvider: DecisionProvider = {
      async decide(request) {
        if (request.question.id === 'clarity') assert.deepEqual(request, firstClarityPacket[0]);
        if (request.question.type === 'score') return {
          type: 'score', score: 1, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 },
          attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {},
        };
        return { type: 'noul', noul: 0.8, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} };
      },
    };
    await executeQuestionRun(store, accepted.run.runId, factory(resumedProvider));
    const completed = store.getJourneyRun(accepted.run.runId);
    assert.equal(store.getStatus(accepted.run.runId).status, 'completed');
    assert.equal(completed.compilerFingerprint, v6PromptContractHash);
    assert.deepEqual(completed.evaluations[0]!.packet.state.encounteredItems.map(({ id }) => id), ['section-one']);
    assert.deepEqual(completed.evaluations[1]!.packet, frozenPacket);
    assert.equal(completed.evaluations[1]!.packetFingerprint, frozenFingerprint);
    assert.equal(clarityCalls, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling during a journey call preserves its answer and pending next turn', async () => {
  const f = await journeyFixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide() { calls += 1; f.store.requestCancel(f.runId); return { ...answer(), choice: 'continue' }; },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const run = f.store.getJourneyRun(f.runId);
    assert.equal(f.store.getStatus(f.runId).status, 'cancelled');
    assert.equal(calls, 1);
    assert.equal(run.evaluations[0]!.status, 'answered');
    assert.equal(run.evaluations[1]!.status, 'pending');
    assert.equal(run.respondents[0]!.currentTurnId, run.evaluations[1]!.turnId);
  } finally { await f.close(); }
});

test('a terminal branch stops before asking for unreached tasks', async () => {
  const f = await journeyFixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = { async decide() { calls += 1; return { ...answer(), choice: 'leave' }; } };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const run = f.store.getJourneyRun(f.runId);
    assert.equal(f.store.getStatus(f.runId).status, 'completed');
    assert.equal(calls, 1);
    assert.equal(run.evaluations.length, 1);
    assert.equal(run.respondents[0]!.outcome, 'left');
  } finally { await f.close(); }
});

test('the original physical call ceiling records the next turn as unreached', async () => {
  const f = await journeyFixture(1, 1);
  let calls = 0;
  try {
    const provider: DecisionProvider = { async decide() { calls += 1; return { ...answer(), choice: 'continue' }; } };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const run = f.store.getJourneyRun(f.runId);
    assert.equal(f.store.getStatus(f.runId).status, 'partial');
    assert.equal(f.store.getStatus(f.runId).usedCalls, 1);
    assert.equal(calls, 1);
    assert.equal(run.evaluations.length, 2);
    assert.equal(run.evaluations[0]!.status, 'answered');
    assert.equal(run.evaluations[1]!.status, 'unreached');
    assert.equal(run.respondents[0]!.status, 'unreached');
    assert.equal(run.respondents[0]!.currentTurnId, null);
  } finally { await f.close(); }
});

test('a sequence journey preserves all authored exposure before each ordered typed question', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-sequence-worker-'));
  const store = openRunStore(root);
  const accepted = store.acceptJourney(randomUUID(), preparedSequenceJourney());
  const requests: Array<{ questionId: string; items: string[]; priorResponses: number }> = [];
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide(request) {
        calls += 1;
        const state = request.state as { encounteredItems: Array<{ id: string }>; trajectory: { responses: unknown[] } };
        requests.push({ questionId: request.question.id, items: state.encounteredItems.map(({ id }) => id), priorResponses: state.trajectory.responses.length });
        if (request.question.type === 'choice') return answer();
        return { type: 'score', score: 2, legend: { 0: 'Unclear', 1: 'Mixed', 2: 'Clear' }, probabilities: { 0: 0.05, 1: 0.05, 2: 0.9 }, attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} };
      },
    };
    await executeQuestionRun(store, accepted.run.runId, factory(provider));
    const run = store.getJourneyRun(accepted.run.runId);
    assert.equal(store.getStatus(accepted.run.runId).status, 'completed');
    assert.equal(calls, 2);
    assert.deepEqual(requests, [
      { questionId: 'interest', items: ['section-one', 'section-three'], priorResponses: 0 },
      { questionId: 'clarity', items: ['section-one', 'section-three'], priorResponses: 1 },
    ]);
    assert.deepEqual(run.evaluations.map(({ nodeId }) => nodeId), ['sequence-ask-interest', 'sequence-ask-clarity']);
    assert.equal(run.respondents[0]!.outcome, 'complete');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
