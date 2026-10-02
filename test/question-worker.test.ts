import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DecisionProvider } from '../src/domain/decision/provider.js';
import type { DecisionBatchRequest, DecisionResult } from '../src/domain/decision/decision.js';
import { compileDecisionPacket, promptContractHash, type PromptHistoryEvent } from '../src/domain/decision/prompt.js';
import type { JourneyRespondentState } from '../src/domain/run/lifecycle.js';
import { runRequestSchema, type InlineRunRequest, type InlineJourneyRequest, type PreparedJourneyRun } from '../src/domain/run/request.js';
import { prepareRun } from '../src/application/run-inspection.js';
import { executeQuestionRun } from '../src/application/question-worker.js';
import { JevCallError } from '../src/providers/jev.js';
import { LayaCallError } from '../src/providers/laya.js';
import { openRunStore } from '../src/infrastructure/run-store.js';
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

async function fixture(input = request()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-question-worker-'));
  const store = openRunStore(root);
  const prepared = await prepareRun(input, { measure: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), async decide() { return answer(); } });
  assert.ok(prepared.prepared);
  const accepted = store.accept(randomUUID(), prepared.prepared);
  return { root, store, runId: accepted.run.runId, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

function factory(provider: DecisionProvider) { return () => provider; }

function authoredJourney(respondentCount = 1, maxCalls = 3): InlineJourneyRequest {
  return {
    kind: 'journey',
    respondents: Array.from({ length: respondentCount }, (_, index) => ({ id: `reader-${String.fromCharCode(97 + index)}`, intent: 'Learn', context: 'New buyer', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' })),
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
      ], transitions: [
        { fromNodeId: 'opening', toNodeId: 'ask-interest' },
        { fromNodeId: 'ask-interest', optionId: 'continue', toNodeId: 'expose-section-three' },
        { fromNodeId: 'ask-interest', optionId: 'leave', toNodeId: 'exit' },
        { fromNodeId: 'expose-section-three', toNodeId: 'ask-clarity' },
        { fromNodeId: 'ask-clarity', when: { type: 'score', minimum: 0, maximum: 0.5, minimumInclusive: true, maximumInclusive: false }, toNodeId: 'ask-likely' },
        { fromNodeId: 'ask-clarity', when: { type: 'score', minimum: 0.5, maximum: 1.5, minimumInclusive: true, maximumInclusive: false }, toNodeId: 'ask-likely' },
        { fromNodeId: 'ask-clarity', when: { type: 'score', minimum: 1.5, maximum: 2, minimumInclusive: true, maximumInclusive: true }, toNodeId: 'ask-likely' },
        { fromNodeId: 'ask-likely', when: { type: 'noul', minimum: 0, maximum: 0.5, minimumInclusive: true, maximumInclusive: false }, toNodeId: 'unlikely' },
        { fromNodeId: 'ask-likely', when: { type: 'noul', minimum: 0.5, maximum: 1, minimumInclusive: true, maximumInclusive: true }, toNodeId: 'likely-outcome' },
      ] },
    },
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' },
    maxCalls,
  };
}

function preparedJourney(respondentCount = 1, maxCalls = 3): PreparedJourneyRun {
  const parsed = runRequestSchema.parse(authoredJourney(respondentCount, maxCalls));
  if (parsed.kind !== 'journey') throw new Error('Expected a journey request.');
  const compilerFingerprint = promptContractHash();
  const requestFingerprint = hashCanonical({ request: parsed, compilerFingerprint });
  const states: JourneyRespondentState[] = [];
  const evaluations = parsed.respondents.map((respondent, ordinal) => {
    const events: PromptHistoryEvent[] = [{ type: 'exposure', sequence: 0, nodeId: 'opening', itemId: 'section-one' }];
    const packet = compileDecisionPacket(parsed.journey, respondent, 'interest', events);
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

async function journeyFixture(respondentCount = 1, maxCalls = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sheg-journey-worker-'));
  const store = openRunStore(root);
  const accepted = store.acceptJourney(randomUUID(), preparedJourney(respondentCount, maxCalls));
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

test('a grouped poll batches independent questions and resumes only the failed question in the same context', async () => {
  const input = request(1);
  input.maxCalls = 2;
  input.questions = [input.questions[0]!, { type: 'noul', id: 'interest-loss', instructions: 'Did anything reduce your interest?' },
    { type: 'score', id: 'clarity', instructions: 'How clear was it?', rubric: ['Unclear', 'Mixed', 'Clear'] }];
  const f = await fixture(input); const dispatched: Array<{ ids: string[]; state: unknown }> = [];
  try {
    const provider: DecisionProvider = { measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), async decide() { throw new Error('Expected grouped request dispatch.'); }, async decideBatch(batch: DecisionBatchRequest) {
      dispatched.push({ ids: batch.questions.map(({ id }) => id), state: batch.state });
      if (dispatched.length === 1) return { execution: { attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} }, answers: [
        { questionId: 'interest', value: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } },
        { questionId: 'interest-loss', value: { type: 'noul', noul: 0.4 } },
        { questionId: 'clarity', failure: { code: 'invalid_score', message: 'The score did not match the rubric.' } },
      ] };
      return { execution: { attempts: 1, provider: 'jev', model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} }, answers: [
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

test('a shared grouped authorization failure stops dispatch and explicit resume retries all reserved questions', async () => {
  const input = request(1); input.maxCalls = 2;
  input.questions.push({ type: 'noul', id: 'interest-loss', instructions: 'Did anything reduce interest?' });
  const f = await fixture(input); let calls = 0; const dispatched: string[][] = [];
  const provider: DecisionProvider = {
    measureBatch: () => ({ provider: 'jev', status: 'fits', method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated', tokens: 20, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }),
    async decide() { throw new Error('Expected grouped request.'); },
    async decideBatch(batch) {
      calls += 1; dispatched.push(batch.questions.map(({ id }) => id));
      if (calls === 1) throw new JevCallError('credential unavailable', 0, undefined, undefined, 'run', 'credential_unavailable');
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

test('a malformed answer fails only its respondent and the worker continues', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const provider: DecisionProvider = {
      async decide() {
        calls += 1;
        if (calls === 1) return { ...answer(), choice: 'not-an-option' };
        return answer();
      },
    };
    await executeQuestionRun(f.store, f.runId, factory(provider));
    const status = f.store.getStatus(f.runId);
    assert.equal(status.status, 'partial');
    assert.equal(calls, 2);
    assert.deepEqual(f.store.answers(f.runId).items.map((item) => item.status), ['failed', 'answered']);
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
    assert.deepEqual(requests[1]!.encounteredItems, [{ id: 'section-three', text: 'Later section.' }]);
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
