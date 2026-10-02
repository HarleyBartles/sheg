import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeJourneyRun, prepareFollowOnRun, prepareRun } from '../src/application/run-inspection.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import type { DecisionResult } from '../src/domain/decision/decision.js';
import { followOnRunRequestSchema, runRequestSchema, type InlineJourneyRequest, type InlineRunRequest, type ParsedFollowOnRunRequest, type ParsedInlineJourneyRequest, type PreparedJourneyRun, type PreparedRun } from '../src/domain/run/request.js';
import type { JourneyRespondentState } from '../src/domain/run/lifecycle.js';
import { compileDecisionPacket, promptContractHash, type PromptHistoryEvent } from '../src/domain/decision/prompt.js';
import { hashCanonical } from '../src/infrastructure/identity.js';
import { openRunStore, RunStoreError } from '../src/infrastructure/run-store.js';

const input: InlineRunRequest = {
  kind: 'poll',
  respondents: [
    { id: 'reader-a', intent: 'Understand the product', context: 'New buyer', desired_outcome: 'Choose a tool', engagement_cues: 'Examples', friction_cues: 'Hype' },
    { id: 'reader-b', intent: 'Compare options', context: 'Returning buyer', desired_outcome: 'Save time', engagement_cues: 'Evidence', friction_cues: 'Repetition' },
  ],
  material: [{ id: 'section-three', text: 'Exact authored section' }],
  questions: [{ type: 'choice', id: 'interest', instructions: 'Would you keep reading?', options: { continue: 'Continue', leave: 'Leave' } }],
  provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:7071', checkpoint: 'test-model', contextLimit: 4096, headLimit: 2048, tokenizerJsonPath: 'tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 1000 },
  maxCalls: 2,
};

const fit: ProviderContextFit = {
  provider: 'laya', status: 'fits', method: 'test', modelIdentity: 'test-model', tokenCount: 'measured',
  tokens: 12, contextLimit: 4096, headroomTokens: 128, effectiveLimit: 3968, details: {},
};

const provider: DecisionProvider = {
  measure: () => fit,
  async decide(): Promise<DecisionResult> { throw new Error('This fixture only prepares requests.'); },
};

async function preparedRun(value: InlineRunRequest = input): Promise<PreparedRun> {
  const result = await prepareRun(value, provider);
  assert.ok(result.prepared);
  return result.prepared;
}

const savedAnswer: DecisionResult = {
  type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 },
  attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 1, usage: {},
};

const journeyRequest: InlineJourneyRequest = {
  kind: 'journey',
  respondents: input.respondents,
  journey: {
    id: 'article', label: 'Article journey',
    items: [{ id: 'section-one', text: 'Opening section.' }, { id: 'section-three', text: 'Later section.' }],
    tasks: [{ id: 'interest', type: 'choice', instructions: 'Would you keep reading?', options: { continue: 'Continue', leave: 'Stop' } }],
    presentation: { kind: 'graph', entryNodeId: 'opening', maxDecisions: 2, nodes: [
      { id: 'opening', kind: 'expose', itemId: 'section-one' },
      { id: 'ask-interest', kind: 'ask', taskId: 'interest' },
      { id: 'expose-section-three', kind: 'expose', itemId: 'section-three' },
      { id: 'ask-interest-followup', kind: 'ask', taskId: 'interest' },
      { id: 'complete', kind: 'terminal', outcome: 'complete' },
      { id: 'left', kind: 'terminal', outcome: 'left' },
    ], transitions: [
      { fromNodeId: 'opening', toNodeId: 'ask-interest' },
      { fromNodeId: 'ask-interest', optionId: 'continue', toNodeId: 'expose-section-three' },
      { fromNodeId: 'ask-interest', optionId: 'leave', toNodeId: 'left' },
      { fromNodeId: 'expose-section-three', toNodeId: 'ask-interest-followup' },
      { fromNodeId: 'ask-interest-followup', optionId: 'continue', toNodeId: 'complete' },
      { fromNodeId: 'ask-interest-followup', optionId: 'leave', toNodeId: 'complete' },
    ] },
  },
  provider: input.provider,
  maxCalls: 4,
};

function preparedJourneyRun(): PreparedJourneyRun {
  const parsed = runRequestSchema.parse(journeyRequest);
  if (parsed.kind !== 'journey') throw new Error('Journey test fixture was not parsed as a journey request.');
  const request: ParsedInlineJourneyRequest = parsed;
  const compilerFingerprint = promptContractHash();
  const requestFingerprint = hashCanonical({ request, compilerFingerprint });
  const initialEvents: PromptHistoryEvent[] = [{ type: 'exposure', sequence: 0, nodeId: 'opening', itemId: 'section-one' }];
  const evaluations = request.respondents.map((respondent, index) => {
    const turnId = `turn-${respondent.id}-opening`;
    const contextId = `context-${respondent.id}-opening`;
    const nodeId = 'ask-interest';
    const packet = compileDecisionPacket(journeyRequest.journey, respondent, 'interest', initialEvents);
    return {
      evaluationId: `evaluation-${respondent.id}-opening`, contextId, respondentId: respondent.id,
      questionId: 'interest', packet, packetFingerprint: hashCanonical({ packet, compilerFingerprint }),
      turnId, nodeId, pathId: 'root', occurrence: 1, ordinal: index,
    };
  });
  const respondents: JourneyRespondentState[] = evaluations.map((evaluation) => ({
    respondentId: evaluation.respondentId,
    status: 'active',
    currentNodeId: evaluation.nodeId,
    currentTurnId: evaluation.turnId,
    currentContextId: evaluation.contextId,
    revision: 0,
    events: initialEvents,
    route: [],
  }));
  return { request, requestFingerprint, compilerFingerprint, evaluations, respondents };
}

async function resumableFixture(value: InlineRunRequest = input) {
  const root = await temporaryRoot();
  let nowMs = 10_000;
  const store = openRunStore(root, { now: () => nowMs });
  const accepted = store.accept(randomUUID(), await preparedRun(value));
  return {
    root, store, runId: accepted.run.runId, request: value,
    now: () => nowMs,
    advance: (milliseconds: number) => { nowMs += milliseconds; },
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sheg-run-store-'));
}

test('acceptance survives a second connection and matching submission retries share one run ID', async () => {
  const root = await temporaryRoot();
  const first = openRunStore(root);
  const second = openRunStore(root);
  try {
    const request = await preparedRun();
    const submissionId = randomUUID();
    const accepted = first.accept(submissionId, request);
    const retry = second.accept(submissionId, request);
    assert.equal(accepted.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.run.runId, accepted.run.runId);
    const saved = second.getRequest(accepted.run.runId);
    assert.equal(saved.request.kind, 'poll');
    if (saved.request.kind === 'poll') assert.equal(saved.request.material[0]!.text, 'Exact authored section');
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a physical batch reserves and settles once while preserving one typed evaluation per question', async () => {
  const value: InlineRunRequest = { ...input, respondents: [input.respondents[0]!], maxCalls: 1, questions: [
    input.questions[0]!,
    { type: 'score', id: 'clarity', instructions: 'How clear was it?', rubric: ['Unclear', 'Clear'] },
    { type: 'noul', id: 'appeal', instructions: 'Was it appealing?' },
  ] };
  const batchProvider: DecisionProvider = { ...provider, measureBatch: () => fit };
  const prepared = await prepareRun(value, batchProvider);
  assert.ok(prepared.prepared);
  const root = await temporaryRoot(); const store = openRunStore(root, { now: () => 10_000 });
  try {
    const accepted = store.accept(randomUUID(), prepared.prepared);
    const claim = store.claim(accepted.run.runId, 10_000, 1234); assert.ok(claim);
    const group = prepared.prepared.groups![0]!;
    const ids = prepared.prepared.evaluations.map(({ evaluationId }) => evaluationId);
    const reservation = store.reserveBatch(claim, group.groupId, ids, 10_000); assert.ok(reservation);
    assert.equal(store.getStatus(accepted.run.runId).reservedCalls, 1);
    store.settleBatch(claim, reservation.attemptId, { kind: 'answered', result: { execution: { attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 7, usage: {} }, answers: [
      { questionId: 'interest', value: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } },
      { questionId: 'clarity', value: { type: 'score', score: 1, legend: { 0: 'Unclear', 1: 'Clear' }, probabilities: { 0: 0.1, 1: 0.9 } } },
      { questionId: 'appeal', failure: { code: 'invalid_noul', message: 'The provider returned an invalid Noul value.' } },
    ] } });
    const answers = store.answers(accepted.run.runId).items;
    assert.equal(store.getStatus(accepted.run.runId).usedCalls, 1);
    assert.equal(new Set(answers.map(({ evaluationId }) => evaluationId)).size, 3);
    assert.deepEqual(answers.map(({ status, result, failure }) => [status, result?.type, failure?.code]), [['answered', 'choice', undefined], ['answered', 'score', undefined], ['failed', undefined, 'invalid_noul']]);
    assert.equal(answers[1]?.execution?.provider, 'laya');
    const filtered = store.queryEvidence({ sourceRunId: accepted.run.runId, criteria: { questionId: 'clarity' } });
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0]?.questionId, 'clarity');
    assert.equal(filtered.items[0]?.contextId, group.contextId);
    assert.equal(filtered.items[0]?.execution?.model, 'test-model');
    store.finish(claim);
    const followRequest = followOnRunRequestSchema.parse({ kind: 'follow-on', sourceRunId: accepted.run.runId,
      selection: { criteria: { questionId: 'interest' } }, context: { mode: 'recorded' },
      questions: [{ type: 'noul', id: 'why', instructions: 'Did anything reduce your interest?' },
        { type: 'choice', id: 'continue-reading', instructions: 'Would you continue?', options: { yes: 'Yes', no: 'No' } }],
      provider: value.provider, maxCalls: 1 });
    const sources = store.resolveFollowOnSources(followRequest);
    const follow = await prepareFollowOnRun(followRequest, sources, batchProvider);
    assert.equal(follow.inspection.valid, true);
    const followAccepted = store.accept(randomUUID(), follow.prepared);
    assert.equal(followAccepted.run.totalEvaluations, 2);
    assert.equal(store.getRequest(followAccepted.run.runId).groups?.length, 1);
    const db = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(accepted.run.runId) as { count: number }).count, 1);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM attempt_evaluations').get() as { count: number }).count, 3);
    } finally { db.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('a batch-wide provider failure records one physical call and fails every reserved evaluation together', async () => {
  const value: InlineRunRequest = { ...input, respondents: [input.respondents[0]!], maxCalls: 1, questions: [input.questions[0]!,
    { type: 'noul', id: 'interest-score', instructions: 'How interested are you?' }] };
  const prepared = await prepareRun(value, { ...provider, measureBatch: () => fit }); assert.ok(prepared.prepared);
  const root = await temporaryRoot(); const store = openRunStore(root, { now: () => 10_000 });
  try {
    const accepted = store.accept(randomUUID(), prepared.prepared); const claim = store.claim(accepted.run.runId, 10_000, 1234); assert.ok(claim);
    const reservation = store.reserveBatch(claim, prepared.prepared.groups![0]!.groupId, prepared.prepared.evaluations.map(({ evaluationId }) => evaluationId), 10_000); assert.ok(reservation);
    store.settleBatch(claim, reservation.attemptId, { kind: 'failed', code: 'provider_authentication_failed', message: 'Provider authentication failed.', scope: 'run' });
    assert.equal(store.getStatus(accepted.run.runId).usedCalls, 1);
    assert.deepEqual(store.answers(accepted.run.runId).items.map(({ status, failure }) => [status, failure?.code]), [
      ['failed', 'provider_authentication_failed'], ['failed', 'provider_authentication_failed'],
    ]);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('journey acceptance freezes exact reached packets and respondent state across reopen', async () => {
  const root = await temporaryRoot();
  const first = openRunStore(root);
  try {
    const accepted = first.acceptJourney(randomUUID(), preparedJourneyRun());
    const run = first.getJourneyRun(accepted.run.runId);
    assert.equal(run.request.journey.id, 'article');
    assert.deepEqual(run.evaluations.map(({ turnId, contextId, nodeId }) => ({ turnId, contextId, nodeId })), [
      { turnId: 'turn-reader-a-opening', contextId: 'context-reader-a-opening', nodeId: 'ask-interest' },
      { turnId: 'turn-reader-b-opening', contextId: 'context-reader-b-opening', nodeId: 'ask-interest' },
    ]);
    assert.deepEqual(run.evaluations[0]!.packet.state.encounteredItems, [{ id: 'section-one', text: 'Opening section.' }]);
    assert.equal(run.respondents[0]!.events[0]?.type, 'exposure');
    assert.equal(run.respondents[0]!.currentTurnId, run.evaluations[0]!.turnId);
  } finally {
    first.close();
  }
  const reopened = openRunStore(root);
  try {
    const run = reopened.getJourneyRun(reopened.list({ limit: 1 }).items[0]!.runId);
    assert.equal(run.evaluations[0]!.packet.state.encounteredItems[0]!.text, 'Opening section.');
    assert.deepEqual(run.respondents[0]!.route, []);
    assert.equal(run.respondents[1]!.respondentId, 'reader-b');
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('answer, route transition and next reached turn commit atomically', async () => {
  const root = await temporaryRoot();
  let store = openRunStore(root, { now: () => 10_000 });
  try {
    const accepted = store.acceptJourney(randomUUID(), preparedJourneyRun());
    const claim = store.claim(accepted.run.runId, 10_000, 1234);
    assert.ok(claim);
    const current = store.reserveNext(claim, 10_000);
    assert.ok(current);
    const response: DecisionResult = { ...savedAnswer, choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 }, confidence: 0.73 };
    const events = [...store.getJourneyRun(accepted.run.runId).respondents[0]!.events,
      { type: 'response' as const, sequence: 1, nodeId: 'ask-interest', taskId: 'interest', result: { type: 'choice' as const, choice: response.choice, probabilities: response.probabilities, confidence: response.confidence } },
      { type: 'exposure' as const, sequence: 2, nodeId: 'expose-section-three', itemId: 'section-three' }];
    const prepared = preparedJourneyRun();
    const nextPacket = compileDecisionPacket(prepared.request.journey, prepared.request.respondents[0]!, 'interest', events);
    const nextEvaluation = {
      evaluationId: 'evaluation-reader-a-followup', turnId: 'turn-reader-a-followup', contextId: 'context-reader-a-followup',
      respondentId: 'reader-a', questionId: 'interest', nodeId: 'ask-interest-followup', pathId: 'ask-interest=continue', occurrence: 1, ordinal: 2,
      packet: nextPacket, packetFingerprint: hashCanonical({ packet: nextPacket, compilerFingerprint: promptContractHash() }),
    };
    const nextState: JourneyRespondentState = {
      respondentId: 'reader-a', status: 'active', currentNodeId: 'ask-interest-followup', currentTurnId: nextEvaluation.turnId,
      currentContextId: nextEvaluation.contextId, revision: 1, events,
      route: [{ nodeId: 'ask-interest', response: { type: 'choice', choice: 'continue', probabilities: response.probabilities, confidence: response.confidence }, toNodeId: 'expose-section-three' }],
    };
    store.settleJourney(claim, current.attemptId, { kind: 'answered', result: response }, {
      respondentId: 'reader-a', expectedRevision: 0, state: nextState, nextEvaluation,
    });
    const run = store.getJourneyRun(accepted.run.runId);
    assert.equal(run.evaluations[0]!.result?.type, 'choice');
    assert.equal(run.evaluations.length, 3);
    assert.equal(run.evaluations[2]!.turnId, 'turn-reader-a-followup');
    assert.deepEqual(run.respondents[0]!.route, [{ nodeId: 'ask-interest', response: { type: 'choice', choice: 'continue', probabilities: response.probabilities, confidence: response.confidence }, toNodeId: 'expose-section-three' }]);
    assert.equal(run.respondents[0]!.currentTurnId, 'turn-reader-a-followup');
    assert.equal(run.respondents[1]!.revision, 0);
    assert.deepEqual(run.evaluations[0]!.result, response);
    store.close();
    store = openRunStore(root, { now: () => 10_000 });
    const reopened = store.getJourneyRun(accepted.run.runId);
    assert.deepEqual(reopened.respondents[0]!.route, run.respondents[0]!.route);
    assert.equal(reopened.respondents[0]!.currentContextId, 'context-reader-a-followup');
    assert.equal(reopened.evaluations[0]!.result?.type === 'choice' ? reopened.evaluations[0]!.result.confidence : undefined, 0.73);
    assert.equal(reopened.evaluations[2]!.packet.state.trajectory.responses[0]?.type, 'choice');
    assert.notEqual(reopened.evaluations[0]!.turnId, reopened.evaluations[2]!.turnId);
    assert.equal(reopened.evaluations[0]!.questionId, reopened.evaluations[2]!.questionId);
    assert.notEqual(reopened.evaluations[0]!.nodeId, reopened.evaluations[2]!.nodeId);
    assert.deepEqual(reopened.evaluations[2]!.packet.state.encounteredItems, [{ id: 'section-three', text: 'Later section.' }]);
    const history = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try {
      const attempts = history.prepare('SELECT status, result_json FROM attempts WHERE run_id = ? ORDER BY started_ms').all(accepted.run.runId) as Array<{ status: string; result_json: string }>;
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]!.status, 'answered');
      assert.equal(JSON.parse(attempts[0]!.result_json).confidence, 0.73);
    } finally { history.close(); }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('journey storage preserves terminal and unreached respondents without fabricating turns', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root, { now: () => 10_000 });
  try {
    const prepared = preparedJourneyRun();
    prepared.respondents[1] = {
      respondentId: 'reader-b', status: 'unreached', currentNodeId: null, currentTurnId: null, currentContextId: null,
      revision: 0, events: [], route: [],
    };
    prepared.evaluations.pop();
    const accepted = store.acceptJourney(randomUUID(), prepared);
    const claim = store.claim(accepted.run.runId, 10_000, 1234);
    assert.ok(claim);
    const current = store.reserveNext(claim, 10_000);
    assert.ok(current);
    const result: DecisionResult = { ...savedAnswer, choice: 'leave', probabilities: { continue: 0.1, leave: 0.9 } };
    const old = store.getJourneyRun(accepted.run.runId).respondents[0]!;
    const events = [...old.events, { type: 'response' as const, sequence: 1, nodeId: 'ask-interest', taskId: 'interest', result: { type: 'choice' as const, choice: 'leave', probabilities: result.probabilities } }];
    store.settleJourney(claim, current.attemptId, { kind: 'answered', result }, {
      respondentId: 'reader-a', expectedRevision: 0,
    state: { ...old, status: 'completed', currentNodeId: null, currentTurnId: null, currentContextId: null, revision: 1, events,
        route: [{ nodeId: 'ask-interest', response: { type: 'choice', choice: 'leave', probabilities: result.probabilities }, toNodeId: 'left' }], outcome: 'left' },
    });
    const run = store.getJourneyRun(accepted.run.runId);
    assert.equal(run.evaluations.length, 1);
    assert.equal(run.respondents[0]!.status, 'completed');
    assert.equal(run.respondents[0]!.outcome, 'left');
    assert.deepEqual(run.respondents[1], prepared.respondents[1]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('journey answer and route transition roll back together when next-turn persistence fails', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root, { now: () => 10_000 });
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    const accepted = store.acceptJourney(randomUUID(), preparedJourneyRun());
    const claim = store.claim(accepted.run.runId, 10_000, 1234);
    assert.ok(claim);
    const current = store.reserveNext(claim, 10_000);
    assert.ok(current);
    database.exec("CREATE TRIGGER fail_next_turn BEFORE INSERT ON evaluations WHEN NEW.turn_id = 'turn-reader-a-followup' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;");
    const response: DecisionResult = { ...savedAnswer, choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } };
    const old = store.getJourneyRun(accepted.run.runId).respondents[0]!;
    const events = [...old.events,
      { type: 'response' as const, sequence: 1, nodeId: 'ask-interest', taskId: 'interest', result: { type: 'choice' as const, choice: response.choice, probabilities: response.probabilities } },
      { type: 'exposure' as const, sequence: 2, nodeId: 'expose-section-three', itemId: 'section-three' }];
    const prepared = preparedJourneyRun();
    const packet = compileDecisionPacket(prepared.request.journey, prepared.request.respondents[0]!, 'interest', events);
    const nextEvaluation = {
      evaluationId: 'evaluation-reader-a-followup', turnId: 'turn-reader-a-followup', contextId: 'context-reader-a-followup',
      respondentId: 'reader-a', questionId: 'interest', nodeId: 'ask-interest-followup', pathId: 'ask-interest=continue', occurrence: 1, ordinal: 2,
      packet, packetFingerprint: hashCanonical({ packet, compilerFingerprint: promptContractHash() }),
    };
    const state: JourneyRespondentState = {
      ...old, currentNodeId: 'ask-interest-followup', currentTurnId: nextEvaluation.turnId, currentContextId: nextEvaluation.contextId,
      revision: 1, events, route: [{ nodeId: 'ask-interest', response: { type: 'choice', choice: 'continue' }, toNodeId: 'expose-section-three' }],
    };
    assert.throws(() => store.settleJourney(claim, current.attemptId, { kind: 'answered', result: response }, {
      respondentId: 'reader-a', expectedRevision: 0, state, nextEvaluation,
    }));
    const run = store.getJourneyRun(accepted.run.runId);
    assert.equal(run.evaluations[0]!.status, 'pending');
    assert.equal(run.respondents[0]!.revision, 0);
    assert.equal(run.respondents[0]!.currentTurnId, 'turn-reader-a-opening');
    assert.equal(store.getStatus(accepted.run.runId).usedCalls, 0);
    const attempts = database.prepare('SELECT status FROM attempts WHERE run_id = ?').all(accepted.run.runId) as Array<{ status: string }>;
    assert.deepEqual(attempts.map(({ status }) => status), ['reserved']);
  } finally {
    database.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('two processes can initialize the same fresh datastore concurrently', async () => {
  const root = await temporaryRoot();
  const moduleUrl = new URL('../src/infrastructure/run-store.ts', import.meta.url).href;
  const script = `import { openRunStore } from ${JSON.stringify(moduleUrl)}; const store = openRunStore(process.env.SHEG_TEST_ROOT); store.close();`;
  const launch = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, SHEG_TEST_ROOT: root },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Initializer exited with ${code}.`)));
  });
  try {
    await Promise.all([launch(), launch()]);
    const store = openRunStore(root);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsupported pre-v1 datastore versions return explicit export or reset guidance', async () => {
  const root = await temporaryRoot();
  const database = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    database.exec('PRAGMA user_version = 2');
  } finally { database.close(); }
  try {
    assert.throws(() => openRunStore(root), (error: unknown) => error instanceof RunStoreError &&
      error.code === 'unsupported_schema_version' && /Export or reset this pre-v1 datastore/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resume preserves the run and saved answer and uses a fresh claim window', async () => {
  const f = await resumableFixture();
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const first = f.store.reserveNext(claim, f.now());
    assert.ok(first);
    f.store.settle(claim, first.attemptId, { kind: 'answered', result: savedAnswer });
    f.advance(30_001);
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');

    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    assert.equal(resumed.run.runId, f.runId);
    assert.equal(resumed.run.status, 'prepared');
    assert.equal(resumed.run.usedCalls, 1);
    assert.equal(resumed.run.maxCalls, f.request.maxCalls);
    assert.equal(f.store.answers(f.runId).items[0]?.status, 'answered');
    assert.deepEqual(f.store.getRequest(f.runId).request, f.request);

    assert.equal(f.store.resume(f.runId, f.now()).started, false, 'a second resume must not claim or launch the prepared run again');
    const resumedClaim = f.store.claim(f.runId, f.now(), 5678);
    assert.ok(resumedClaim, 'an old run must use the fresh resume launch window');
  } finally { await f.close(); }
});

test('resume consumes an uncertain attempt once and never increases the original call limit', async () => {
  const f = await resumableFixture();
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const reservation = f.store.reserveNext(claim, f.now());
    assert.ok(reservation);
    f.advance(30_001);
    const interrupted = f.store.getStatus(f.runId);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.usedCalls, 1);
    assert.equal(interrupted.reservedCalls, 0);
    const history = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
    try {
      const attempts = history.prepare('SELECT status FROM attempts WHERE run_id = ?').all(f.runId) as Array<{ status: string }>;
      assert.deepEqual(attempts.map(({ status }) => status), ['uncertain']);
    } finally { history.close(); }

    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    assert.equal(resumed.run.usedCalls, 1);
    assert.equal(resumed.run.maxCalls, f.request.maxCalls);
    assert.equal(f.store.answers(f.runId).items[0]?.status, 'pending');
    const resumedClaim = f.store.claim(f.runId, f.now(), 5678);
    assert.ok(resumedClaim);
    assert.ok(f.store.reserveNext(resumedClaim, f.now()));
    assert.equal(f.store.reserveNext(resumedClaim, f.now()), null);
  } finally { await f.close(); }
});

test('resume reopens only a run-scoped failed evaluation and retains its failed attempt', async () => {
  const f = await resumableFixture();
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const reservation = f.store.reserveNext(claim, f.now());
    assert.ok(reservation);
    f.store.settle(claim, reservation.attemptId, { kind: 'failed', code: 'provider_unavailable', message: 'Provider access failed.', scope: 'run' });
    assert.equal(f.store.finish(claim).status, 'failed');

    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    assert.equal(resumed.run.runId, f.runId);
    assert.equal(resumed.run.usedCalls, 1);
    assert.equal(f.store.answers(f.runId).items[0]?.status, 'pending');
    const history = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
    try {
      const attempts = history.prepare('SELECT status, failure_scope FROM attempts WHERE run_id = ?').all(f.runId) as Array<{ status: string; failure_scope: string }>;
      assert.deepEqual(attempts.map(({ status, failure_scope }) => ({ status, failure_scope })), [{ status: 'failed', failure_scope: 'run' }]);
    } finally { history.close(); }
  } finally { await f.close(); }
});

test('resume selects the newest run-scoped failure when attempt timestamps tie', async () => {
  const f = await resumableFixture({ ...input, maxCalls: 4 });
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const olderFailure = f.store.reserveNext(claim, f.now());
    assert.ok(olderFailure);
    f.store.settle(claim, olderFailure.attemptId, { kind: 'failed', code: 'provider_unavailable', message: 'First provider failure.', scope: 'run' });
    assert.equal(f.store.finish(claim).status, 'failed');

    assert.equal(f.store.resume(f.runId, f.now()).started, true);
    const resumedClaim = f.store.claim(f.runId, f.now(), 5678);
    assert.ok(resumedClaim);
    const retry = f.store.reserveNext(resumedClaim, f.now());
    assert.ok(retry);
    f.store.settle(resumedClaim, retry.attemptId, { kind: 'answered', result: savedAnswer });
    const newerFailure = f.store.reserveNext(resumedClaim, f.now());
    assert.ok(newerFailure);
    f.store.settle(resumedClaim, newerFailure.attemptId, { kind: 'failed', code: 'provider_unavailable', message: 'Second provider failure.', scope: 'run' });
    assert.equal(f.store.finish(resumedClaim).status, 'failed');

    const history = new DatabaseSync(path.join(f.root, 'runs.sqlite'));
    try {
      history.exec('PRAGMA foreign_keys = OFF');
      history.prepare('UPDATE attempts SET attempt_id = ? WHERE attempt_id = ?').run('ffffffff-ffff-4fff-8fff-ffffffffffff', olderFailure.attemptId);
      history.prepare('UPDATE attempt_evaluations SET attempt_id = ? WHERE attempt_id = ?').run('ffffffff-ffff-4fff-8fff-ffffffffffff', olderFailure.attemptId);
      history.prepare('UPDATE attempts SET attempt_id = ? WHERE attempt_id = ?').run('00000000-0000-4000-8000-000000000000', newerFailure.attemptId);
      history.prepare('UPDATE attempt_evaluations SET attempt_id = ? WHERE attempt_id = ?').run('00000000-0000-4000-8000-000000000000', newerFailure.attemptId);
    } finally { history.close(); }

    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    assert.deepEqual(f.store.answers(f.runId).items.map(({ status }) => status), ['answered', 'pending']);
    const firstPage = f.store.attempts(f.runId, undefined, 1);
    assert.equal(firstPage.items[0]?.failure?.message, 'First provider failure.');
    assert.ok(firstPage.nextCursor);
    const secondPage = f.store.attempts(f.runId, firstPage.nextCursor, 1);
    assert.equal(secondPage.items[0]?.status, 'answered');
    assert.ok(secondPage.nextCursor);
    const thirdPage = f.store.attempts(f.runId, secondPage.nextCursor, 1);
    assert.equal(thirdPage.items[0]?.failure?.message, 'Second provider failure.');
  } finally { await f.close(); }
});

test('follow-on source resolution reconciles an expired worker lease before freezing source status', async () => {
  const root = await temporaryRoot();
  let nowMs = 10_000;
  const store = openRunStore(root, { now: () => nowMs });
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    const saved = store.getRequest(accepted.run.runId);
    const sourceEvaluation = saved.evaluations[0]!;
    const claim = store.claim(accepted.run.runId, nowMs, 1234);
    assert.ok(claim);
    assert.ok(store.reserveNext(claim, nowMs));
    nowMs += 30_001;

    const request = followOnRunRequestSchema.parse({
      kind: 'follow-on', sourceRunId: accepted.run.runId,
      selection: { references: [{ evaluationId: sourceEvaluation.evaluationId, contextId: sourceEvaluation.contextId }] },
      context: { mode: 'recorded' },
      questions: [{ type: 'choice', id: 'next-question', instructions: 'What would you ask next?', options: { yes: 'Yes', no: 'No' } }],
      provider: input.provider, maxCalls: 1,
    });
    const sources = store.resolveFollowOnSources(request);
    assert.equal(sources.sourceStatus, 'interrupted');
    assert.equal(sources.version.usedCalls, 1);
    assert.equal(sources.version.reservedCalls, 0);
    assert.equal(sources.turns.length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('resume rejects a run-wide failure after the original call budget is exhausted', async () => {
  const f = await resumableFixture();
  try {
    const claim = f.store.claim(f.runId, f.now(), 1234);
    assert.ok(claim);
    const first = f.store.reserveNext(claim, f.now());
    assert.ok(first);
    f.store.settle(claim, first.attemptId, { kind: 'answered', result: savedAnswer });
    const second = f.store.reserveNext(claim, f.now());
    assert.ok(second);
    f.store.settle(claim, second.attemptId, { kind: 'failed', code: 'provider_unavailable', message: 'Provider access failed.', scope: 'run' });
    assert.equal(f.store.finish(claim).status, 'failed');
    const before = f.store.getStatus(f.runId);
    assert.equal(before.usedCalls, before.maxCalls);
    assert.throws(() => f.store.resume(f.runId, f.now()), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_resumable');
    assert.equal(f.store.getStatus(f.runId).status, 'failed');
  } finally { await f.close(); }
});

test('resumed work that misses its launch window becomes interrupted without a read relaunch', async () => {
  const f = await resumableFixture();
  try {
    f.advance(30_001);
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');
    const resumed = f.store.resume(f.runId, f.now());
    assert.equal(resumed.started, true);
    f.advance(30_001);
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');
    assert.equal(f.store.resume(f.runId, f.now()).started, true);
  } finally { await f.close(); }
});

test('a cancellation request prevents resuming after the worker lease expires', async () => {
  const f = await resumableFixture();
  try {
    assert.ok(f.store.claim(f.runId, f.now(), 1234));
    f.store.requestCancel(f.runId);
    f.advance(30_001);
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');
    assert.throws(() => f.store.resume(f.runId, f.now()), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_resumable');
    assert.equal(f.store.getStatus(f.runId).status, 'interrupted');
  } finally { await f.close(); }
});

test('resume rejects live and terminal runs without changing them', async () => {
  for (const target of ['running', 'cancelled', 'completed', 'partial']) {
    const f = await resumableFixture(target === 'partial' ? { ...input, maxCalls: 2 } : input);
    try {
      if (target === 'running') {
        assert.ok(f.store.claim(f.runId, f.now(), 1234));
      } else if (target === 'cancelled') {
        f.store.requestCancel(f.runId);
      } else {
        const claim = f.store.claim(f.runId, f.now(), 1234);
        assert.ok(claim);
        const first = f.store.reserveNext(claim, f.now());
        assert.ok(first);
        f.store.settle(claim, first.attemptId, target === 'completed'
          ? { kind: 'answered', result: savedAnswer }
          : { kind: 'failed', code: 'decision_failed', message: 'Evaluation failed.', scope: 'evaluation' });
        if (target === 'completed') {
          const second = f.store.reserveNext(claim, f.now());
          assert.ok(second);
          f.store.settle(claim, second.attemptId, { kind: 'answered', result: savedAnswer });
        } else {
          const second = f.store.reserveNext(claim, f.now());
          assert.ok(second);
          f.store.settle(claim, second.attemptId, { kind: 'answered', result: savedAnswer });
        }
        assert.equal(f.store.finish(claim).status, target);
      }
      const before = f.store.getStatus(f.runId);
      assert.throws(() => f.store.resume(f.runId, f.now()), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_resumable');
      assert.equal(f.store.getStatus(f.runId).status, before.status);
      assert.equal(f.store.getStatus(f.runId).usedCalls, before.usedCalls);
    } finally { await f.close(); }
  }
});

test('the same submission ID cannot be reused for changed request contents', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const submissionId = randomUUID();
    store.accept(submissionId, await preparedRun());
    const changed = await preparedRun({ ...input, material: [{ id: 'section-three', text: 'Changed authored section' }] });
    assert.throws(() => store.accept(submissionId, changed), (error: unknown) => error instanceof RunStoreError && error.code === 'submission_conflict');
    assert.equal(store.list({}).items.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('accepted JSON remains unchanged after caller objects mutate and the store reopens', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  let closed = false;
  const request = await preparedRun();
  const submissionId = randomUUID();
  try {
    const accepted = store.accept(submissionId, request);
    if (request.request.kind !== 'poll') throw new Error('Fixture request should be a poll.');
    request.request.material[0]!.text = 'mutated after acceptance';
    request.request.respondents[0]!.intent = 'mutated after acceptance';
    store.close();
    closed = true;

    const reopened = openRunStore(root);
    try {
      const saved = reopened.getRequest(accepted.run.runId);
      assert.equal(saved.request.kind, 'poll');
      if (saved.request.kind === 'poll') {
        assert.equal(saved.request.material[0]!.text, 'Exact authored section');
        assert.equal(saved.request.respondents[0]!.intent, 'Understand the product');
      }
      assert.deepEqual(saved.evaluations[0]!.packet.state['encounteredItems'], [{ id: 'section-three', text: 'Exact authored section' }]);
    } finally { reopened.close(); }
  } finally {
    if (!closed) store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('answers paginate in stable evaluation order and identify pending work', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    const first = store.answers(accepted.run.runId, undefined, 1);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]!.status, 'pending');
    assert.ok(first.nextCursor);
    const second = store.answers(accepted.run.runId, first.nextCursor, 1);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0]!.status, 'pending');
    assert.notEqual(second.items[0]!.evaluationId, first.items[0]!.evaluationId);
    assert.equal(second.nextCursor, undefined);
    assert.throws(() => store.answers(accepted.run.runId, 'not-a-cursor', 1), RunStoreError);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed run-list cursor fields return invalid_cursor', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    for (const cursor of [
      { kind: 'runs' },
      { kind: 'runs', createdMs: 'today', runId: 'run-1' },
      { kind: 'runs', createdMs: 1, runId: 4 },
    ]) {
      const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url');
      assert.throws(() => store.list({ cursor: encoded }), (error: unknown) => error instanceof RunStoreError && error.code === 'invalid_cursor');
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('foreign key violations fail without corrupting the accepted run', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    const otherConnection = new DatabaseSync(path.join(root, 'runs.sqlite'));
    otherConnection.exec('PRAGMA foreign_keys = ON');
    try {
      assert.throws(() => otherConnection.prepare("INSERT INTO evaluations (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, packet_json, packet_fingerprint, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), 'missing-run', 0, 'context', 'respondent', 'question', '{}', 'fingerprint', 'pending'));
    } finally { otherConnection.close(); }
    assert.equal(store.getStatus(accepted.run.runId).totalEvaluations, 2);
    assert.equal(store.list({}).items.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale reservation is consumed once and cannot be settled by the former owner', async () => {
  const root = await temporaryRoot();
  let nowMs = 1_000;
  const first = openRunStore(root, { now: () => nowMs });
  const second = openRunStore(root, { now: () => nowMs });
  try {
    const accepted = first.accept(randomUUID(), await preparedRun());
    const claim = first.claim(accepted.run.runId, nowMs, 1234);
    assert.ok(claim);
    assert.equal(second.claim(accepted.run.runId, nowMs, 5678), null);
    const reservation = first.reserveNext(claim, nowMs);
    assert.ok(reservation);
    assert.equal(first.getStatus(accepted.run.runId).usedCalls, 0);
    assert.equal(first.getStatus(accepted.run.runId).reservedCalls, 1);

    nowMs += 31_000;
    const interrupted = second.reconcile(accepted.run.runId, nowMs);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.usedCalls, 1);
    assert.equal(interrupted.reservedCalls, 0);
    assert.equal(second.reconcile(accepted.run.runId, nowMs).usedCalls, 1);
    assert.equal(second.answers(accepted.run.runId, undefined, 1).items[0]!.status, 'pending');
    assert.throws(() => first.settle(claim, reservation.attemptId, { kind: 'failed', code: 'late', message: 'late result', scope: 'evaluation' }), RunStoreError);
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the physical call ceiling bounds reservations and valid answers settle atomically', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    const claim = store.claim(accepted.run.runId, Date.now(), 1234);
    assert.ok(claim);
    const first = store.reserveNext(claim, Date.now());
    assert.ok(first);
    assert.equal(store.reserveNext(claim, Date.now()), null);
    assert.equal(store.getStatus(accepted.run.runId).reservedCalls, 1);
    assert.throws(() => store.finish(claim), (error: unknown) => error instanceof RunStoreError && error.code === 'attempt_in_flight');

    const answer: DecisionResult = { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, leave: 0.2 }, attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 5, usage: {} };
    assert.throws(() => store.settle(claim, first.attemptId, { kind: 'answered', result: { ...answer, choice: 'not-offered' } }), /not offered/i);
    assert.equal(store.getStatus(accepted.run.runId).reservedCalls, 1);
    assert.equal(store.answers(accepted.run.runId, undefined, 1).items[0]!.status, 'pending');

    store.settle(claim, first.attemptId, { kind: 'answered', result: answer });
    assert.equal(store.getStatus(accepted.run.runId).usedCalls, 1);
    const second = store.reserveNext(claim, Date.now());
    assert.ok(second);
    store.settle(claim, second.attemptId, { kind: 'answered', result: answer });
    assert.equal(store.reserveNext(claim, Date.now()), null);
    assert.equal(store.getStatus(accepted.run.runId).usedCalls, 2);
    assert.equal(store.finish(claim).status, 'completed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('run discovery reconciles stale workers before applying status filters', async () => {
  const root = await temporaryRoot();
  let nowMs = 10_000;
  const store = openRunStore(root, { now: () => nowMs });
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    assert.ok(store.claim(accepted.run.runId, nowMs, 1234));
    nowMs += 31_000;
    const page = store.list({ status: 'interrupted' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.runId, accepted.run.runId);
    assert.equal(page.items[0]!.status, 'interrupted');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function completedRun(store: ReturnType<typeof openRunStore>, value: InlineRunRequest = input, answer: (index: number) => DecisionResult = () => savedAnswer, operationNow = Date.now()): Promise<string> {
  const accepted = store.accept(randomUUID(), await preparedRun(value));
  const claim = store.claim(accepted.run.runId, operationNow, 1234);
  assert.ok(claim);
  let index = 0;
  for (;;) {
    const reservation = store.reserveNext(claim, operationNow);
    if (!reservation) break;
    store.settle(claim, reservation.attemptId, { kind: 'answered', result: answer(index++) });
  }
  assert.equal(store.finish(claim).status, 'completed');
  return accepted.run.runId;
}

test('evidence query matches typed answers and material while preserving distributions and denominators', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const runId = await completedRun(store, input, (index) => index === 0
      ? savedAnswer
      : { ...savedAnswer, choice: 'leave', probabilities: { continue: 0.2, leave: 0.8 }, confidence: 0.81 });
    const query = store.queryEvidence({ sourceRunId: runId, criteria: { materialId: 'section-three', answer: { type: 'choice', choiceId: 'leave' } }, limit: 10 });
    assert.equal(query.totalMatches, 1);
    assert.equal(query.sourceComplete, true);
    assert.deepEqual(query.coverage, { totalEvaluations: 2, completedEvaluations: 2, failedEvaluations: 0,
      respondents: { total: 2, active: 0, completed: 2, failed: 0, unreached: 0 } });
    assert.equal(query.items[0]!.respondentId, 'reader-b');
    assert.equal(query.items[0]!.result?.type, 'choice');
    assert.equal(query.items[0]!.result?.type === 'choice' ? query.items[0]!.result.confidence : undefined, 0.81);
    assert.equal(query.items[0]!.provenance.contextFingerprint.length > 0, true);
    const allEvidence = store.queryEvidence({ sourceRunId: runId, criteria: {}, limit: 10 });
    assert.notEqual(allEvidence.items[0]!.provenance.contextFingerprint, allEvidence.items[1]!.provenance.contextFingerprint);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('independent questions over one frozen context share its provenance fingerprint', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  const grouped: InlineRunRequest = {
    ...input,
    respondents: input.respondents.slice(0, 1),
    questions: [
      input.questions[0]!,
      { type: 'noul', id: 'clarity', instructions: 'How clear is the section?' },
    ],
  };
  try {
    const runId = await completedRun(store, grouped, (index) => index === 0 ? savedAnswer : {
      type: 'noul', noul: 0.8, attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 1, usage: {},
    });
    const evidence = store.queryEvidence({ sourceRunId: runId, criteria: {}, limit: 10 });
    assert.equal(evidence.items.length, 2);
    assert.equal(evidence.items[0]!.contextId, evidence.items[1]!.contextId);
    assert.equal(evidence.items[0]!.provenance.contextFingerprint, evidence.items[1]!.provenance.contextFingerprint);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('evidence query resolves a mapped Choice answer to exact source-linked material', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  const text = '  Exact candidate, including its boundary.  ';
  const candidate = { id: 'section-three', text, sourceId: 'article-v1', sourceSha256: 'c'.repeat(64) };
  const mappedInput: InlineRunRequest = {
    ...input,
    material: [candidate],
    questions: [{ type: 'choice', id: 'which-section', instructions: 'Which section lost your interest?', options: { candidate: text, 'no-fit': 'Neither section' }, materialOptions: { candidate: candidate.id } }],
  };
  try {
    const runId = await completedRun(store, mappedInput, () => ({ ...savedAnswer, choice: 'candidate', probabilities: { candidate: 0.9, 'no-fit': 0.1 } }));
    const query = store.queryEvidence({ sourceRunId: runId, criteria: { questionId: 'which-section', answer: { type: 'choice', choiceId: 'candidate' } } });
    assert.deepEqual(query.items[0]!.selectedMaterial, {
      materialId: candidate.id, text, sourceId: candidate.sourceId, sourceSha256: candidate.sourceSha256,
      textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    });

    const unlinkedRunId = await completedRun(store, input);
    const unlinked = store.queryEvidence({ sourceRunId: unlinkedRunId, criteria: { answer: { type: 'choice', choiceId: 'continue' } } });
    assert.equal(unlinked.items[0]!.selectedMaterial, undefined);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('run list finds retained follow-on catalog material that was not encountered in the source turn', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  const candidate = { id: 'section-three', text: 'Later section.', sourceId: 'article-v1', sourceSha256: 'f'.repeat(64) };
  const sourceRequest: InlineJourneyRequest = {
    ...journeyRequest,
    journey: { ...journeyRequest.journey, items: [journeyRequest.journey.items[0]!, candidate] },
  };
  try {
    const sourceAdmission = await prepareRun(sourceRequest, provider);
    assert.ok(sourceAdmission.journey);
    const source = store.acceptJourney(randomUUID(), materializeJourneyRun(sourceAdmission.journey)).run;
    const sourceRecord = store.getJourneyRun(source.runId);
    const sourceEvaluation = sourceRecord.evaluations[0]!;
    assert.deepEqual(sourceEvaluation.packet.state.encounteredItems, [{ id: 'section-one', text: 'Opening section.' }]);

    const followOnRequest = followOnRunRequestSchema.parse({
      kind: 'follow-on', sourceRunId: source.runId,
      selection: { references: [{ evaluationId: sourceEvaluation.evaluationId, contextId: sourceEvaluation.contextId }] },
      context: { mode: 'recorded' },
      questions: [{ type: 'choice', id: 'choose-section', instructions: 'Which section?', options: { candidate: candidate.text, 'no-fit': 'Neither' }, materialOptions: { candidate: candidate.id } }],
      provider: input.provider, maxCalls: 1,
    });
    const sources = store.resolveFollowOnSources(followOnRequest);
    const followOn = await prepareFollowOnRun(followOnRequest, sources, provider);
    assert.equal(followOn.inspection.valid, true, JSON.stringify(followOn.inspection));
    const accepted = store.accept(randomUUID(), followOn.prepared).run;
    const saved = store.getRequest(accepted.runId);
    const encounteredItems = saved.evaluations[0]!.packet.state.encounteredItems as Array<{ id: string; text: string }>;
    assert.equal(encounteredItems.some(({ id }) => id === candidate.id), false);
    assert.equal(saved.lineage?.materialSnapshots.some(({ materials }) => materials.some(({ id }) => id === candidate.id)), true);

    assert.deepEqual(store.list({ materialId: candidate.id }).items.map(({ runId }) => runId).sort(), [source.runId, accepted.runId].sort());
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('follow-on snapshots source material for query and another follow-on after source deletion', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  const text = 'Exact candidate text.';
  const candidate = { id: 'section-three', text, sourceId: 'article-v1', sourceSha256: 'e'.repeat(64) };
  const mappedInput: InlineRunRequest = {
    ...input, material: [candidate],
    questions: [{ type: 'choice', id: 'select-section', instructions: 'Which section?', options: { candidate: text, 'no-fit': 'Neither' }, materialOptions: { candidate: candidate.id } }],
  };
  const selectedAnswer = (): DecisionResult => ({ ...savedAnswer, choice: 'candidate', probabilities: { candidate: 0.9, 'no-fit': 0.1 } });
  const followRequest = (sourceRunId: string, questionId: string, answerQuestionId: string): ParsedFollowOnRunRequest => followOnRunRequestSchema.parse({
    kind: 'follow-on', sourceRunId, selection: { criteria: { questionId: answerQuestionId, answer: { type: 'choice', choiceId: 'candidate' } } },
    context: { mode: 'fresh-material', materialIds: [candidate.id] },
    questions: [{ type: 'choice', id: questionId, instructions: 'Which exact section loses interest?', options: { candidate: text, 'no-fit': 'Neither' }, materialOptions: { candidate: candidate.id } }],
    provider: input.provider, maxCalls: 2,
  });
  try {
    const originalRunId = await completedRun(store, mappedInput, selectedAnswer);
    const firstRequest = followRequest(originalRunId, 'first-follow-up', 'select-section');
    const firstPrepared = await prepareFollowOnRun(firstRequest, store.resolveFollowOnSources(firstRequest), provider);
    const firstRun = store.accept(randomUUID(), firstPrepared.prepared).run;
    const firstClaim = store.claim(firstRun.runId, Date.now(), 1234);
    assert.ok(firstClaim);
    for (;;) {
      const reservation = store.reserveNext(firstClaim, Date.now());
      if (!reservation) break;
      store.settle(firstClaim, reservation.attemptId, { kind: 'answered', result: selectedAnswer() });
    }
    assert.equal(store.finish(firstClaim).status, 'completed');
    store.deleteRuns([originalRunId]);

    const selected = store.queryEvidence({ sourceRunId: firstRun.runId, criteria: { questionId: 'first-follow-up', answer: { type: 'choice', choiceId: 'candidate' } } });
    assert.equal(selected.items[0]!.selectedMaterial?.text, text);
    assert.equal(selected.items[0]!.selectedMaterial?.sourceId, candidate.sourceId);
    assert.equal(selected.items[0]!.selectedMaterial?.sourceSha256, candidate.sourceSha256);

    const secondRequest = followRequest(firstRun.runId, 'second-follow-up', 'first-follow-up');
    const secondSource = store.resolveFollowOnSources(secondRequest);
    assert.equal(secondSource.turns[0]!.materials?.find(({ id }) => id === candidate.id)?.sourceSha256, candidate.sourceSha256);
    const secondPrepared = await prepareFollowOnRun(secondRequest, secondSource, provider);
    assert.equal(secondPrepared.inspection.valid, true);
    const secondRun = store.accept(randomUUID(), secondPrepared.prepared).run;
    assert.equal(secondRun.status, 'prepared');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('follow-on source resolution freezes criteria matches and validates exact evaluation/context references', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const sourceRunId = await completedRun(store, input, (index) => index === 0
      ? savedAnswer
      : { ...savedAnswer, choice: 'leave', probabilities: { continue: 0.2, leave: 0.8 }, confidence: 0.81 });
    const base = {
      kind: 'follow-on' as const, sourceRunId,
      questions: [{ type: 'noul' as const, id: 'why-leave', instructions: 'What caused you to leave?' }],
      provider: input.provider, maxCalls: 1,
    };
    const criteriaRequest = followOnRunRequestSchema.parse({ ...base, selection: { criteria: { materialId: 'section-three', answer: { type: 'choice', choiceId: 'leave' } } }, context: { mode: 'recorded' } });
    const criteria = store.resolveFollowOnSources(criteriaRequest);
    assert.deepEqual(criteria.turns.map(({ respondentId }) => respondentId), ['reader-b']);
    assert.equal(criteria.sourceComplete, true);
    assert.equal(criteria.version.maxOrdinal, 1);
    const selected = criteria.turns[0]!;
    const refsRequest = followOnRunRequestSchema.parse({ ...base, selection: { references: [{ evaluationId: selected.evaluationId, contextId: selected.contextId }] }, context: { mode: 'recorded' } });
    const exact = store.resolveFollowOnSources(refsRequest);
    assert.deepEqual(exact.turns, criteria.turns);
    assert.throws(() => store.resolveFollowOnSources(followOnRunRequestSchema.parse({ ...base, selection: { references: [{ evaluationId: randomUUID(), contextId: randomUUID() }] }, context: { mode: 'recorded' } })),
      (error: unknown) => error instanceof RunStoreError && error.code === 'follow_on_reference_not_found');
    assert.throws(() => store.resolveFollowOnSources(followOnRunRequestSchema.parse({ ...base, selection: { references: [{ evaluationId: selected.evaluationId, contextId: randomUUID() }] }, context: { mode: 'recorded' } })),
      (error: unknown) => error instanceof RunStoreError && error.code === 'follow_on_reference_not_found');
    assert.throws(() => store.resolveFollowOnSources(followOnRunRequestSchema.parse({ ...base, sourceRunId: randomUUID(), selection: { criteria: {} }, context: { mode: 'recorded' } })),
      (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_found');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('follow-on resolves the full supported explicit-reference selection', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const respondents = Array.from({ length: 1001 }, (_, index) => ({ ...input.respondents[0]!, id: `reader-${index}` }));
    const prepared = await prepareRun({ ...input, respondents, maxCalls: respondents.length }, provider);
    assert.ok(prepared.prepared);
    const runId = store.accept(randomUUID(), prepared.prepared).run.runId;
    const request = followOnRunRequestSchema.parse({
      kind: 'follow-on', sourceRunId: runId,
      selection: { references: prepared.prepared.evaluations.map(({ evaluationId, contextId }) => ({ evaluationId, contextId })) },
      context: { mode: 'recorded' }, questions: [{ type: 'noul', id: 'follow-up', instructions: 'Did this answer the question?' }],
      provider: input.provider, maxCalls: respondents.length,
    });
    const sources = store.resolveFollowOnSources(request);
    assert.equal(sources.turns.length, 1001);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('follow-on resolution reuses an exact reached journey packet', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const journey = await preparedJourneyRun();
    const sourceRun = store.acceptJourney(randomUUID(), journey).run;
    const sourceRecord = store.getJourneyRun(sourceRun.runId);
    const sourceEvaluation = sourceRecord.evaluations[0]!;
    const request = followOnRunRequestSchema.parse({
      kind: 'follow-on', sourceRunId: sourceRun.runId,
      selection: { criteria: { respondentId: sourceEvaluation.respondentId } },
      context: { mode: 'recorded' }, questions: [{ type: 'noul', id: 'journey-follow-up', instructions: 'Would you continue?' }],
      provider: journey.request.provider, maxCalls: 1,
    });
    const resolved = store.resolveFollowOnSources(request);
    assert.equal(resolved.turns.length, 1);
    assert.deepEqual(resolved.turns[0]?.packet.state.encounteredItems, sourceEvaluation.packet.state.encounteredItems);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('follow-on acceptance rejects a source that changes after packet fit inspection', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const sourcePrepared = await preparedRun();
    const sourceRun = store.accept(randomUUID(), sourcePrepared).run;
    const request = followOnRunRequestSchema.parse({
      kind: 'follow-on', sourceRunId: sourceRun.runId, selection: { criteria: {} }, context: { mode: 'recorded' },
      questions: [{ type: 'noul', id: 'why', instructions: 'Why?' }], provider: input.provider, maxCalls: 2,
    });
    const source = store.resolveFollowOnSources(request);
    const prepared = await prepareFollowOnRun(request, source, provider);
    assert.equal(prepared.inspection.valid, true);
    assert.equal(prepared.inspection.warnings?.[0]?.code, 'source_incomplete');
    assert.equal(store.getStatus(sourceRun.runId).status, 'prepared');
    const claim = store.claim(sourceRun.runId, Date.now(), 1234);
    assert.ok(claim);
    assert.throws(() => store.accept(randomUUID(), prepared.prepared),
      (error: unknown) => error instanceof RunStoreError && error.code === 'source_changed_during_acceptance');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('evidence query paginates deterministically and invalidates a cursor when its source changes', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const three = { ...input, respondents: [...input.respondents, { ...input.respondents[0]!, id: 'reader-c' }], maxCalls: 3 };
    const runId = await completedRun(store, three);
    const first = store.queryEvidence({ sourceRunId: runId, criteria: {}, limit: 1 });
    assert.equal(first.totalMatches, 3);
    assert.ok(first.nextCursor);
    const second = store.queryEvidence({ sourceRunId: runId, criteria: {}, cursor: first.nextCursor, limit: 1 });
    assert.notEqual(second.items[0]!.evaluationId, first.items[0]!.evaluationId);
    assert.throws(() => store.queryEvidence({ sourceRunId: runId, criteria: { status: 'answered' }, cursor: first.nextCursor, limit: 1 }), /cursor/i);
    const active = store.accept(randomUUID(), await preparedRun());
    const livePage = store.queryEvidence({ sourceRunId: active.run.runId, criteria: {}, limit: 1 });
    assert.ok(livePage.nextCursor);
    const claim = store.claim(active.run.runId, Date.now(), 4321);
    assert.ok(claim);
    const reservation = store.reserveNext(claim, Date.now());
    assert.ok(reservation);
    store.settle(claim, reservation.attemptId, { kind: 'answered', result: savedAnswer });
    assert.throws(() => store.queryEvidence({ sourceRunId: active.run.runId, criteria: {}, cursor: livePage.nextCursor, limit: 1 }),
      (error: unknown) => error instanceof RunStoreError && error.code === 'stale_cursor');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('in-progress evidence reports matches so far and a later query can find new answers', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    const initial = store.queryEvidence({ sourceRunId: accepted.run.runId, criteria: { status: 'pending' } });
    assert.equal(initial.totalMatches, 2);
    assert.equal(initial.sourceStatus, 'prepared');
    assert.equal(initial.sourceComplete, false);
    assert.equal(initial.items.length, 2);
    const claim = store.claim(accepted.run.runId, Date.now(), 1234);
    assert.ok(claim);
    const reservation = store.reserveNext(claim, Date.now());
    assert.ok(reservation);
    store.settle(claim, reservation.attemptId, { kind: 'answered', result: savedAnswer });
    const updated = store.queryEvidence({ sourceRunId: accepted.run.runId, criteria: { status: 'answered' } });
    assert.equal(updated.totalMatches, 1);
    assert.equal(updated.sourceComplete, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('stopped but incomplete run states never claim complete evidence', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  const fixture = new DatabaseSync(path.join(root, 'runs.sqlite'));
  try {
    const accepted = store.accept(randomUUID(), await preparedRun());
    for (const status of ['interrupted', 'failed', 'cancelled', 'partial'] as const) {
      fixture.prepare('UPDATE runs SET status = ? WHERE run_id = ?').run(status, accepted.run.runId);
      const page = store.queryEvidence({ sourceRunId: accepted.run.runId, criteria: {} });
      assert.equal(page.sourceStatus, status);
      assert.equal(page.sourceComplete, false);
    }
  } finally { fixture.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('respondent coverage keeps partially completed polls active', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const value: InlineRunRequest = {
      ...input,
      questions: [input.questions[0]!, { type: 'noul', id: 'interest-loss', instructions: 'Did anything reduce your interest?' }],
      maxCalls: 4,
    };
    const prepared = await prepareRun(value, provider);
    assert.ok(prepared.prepared);
    const runId = store.accept(randomUUID(), prepared.prepared).run.runId;
    const claim = store.claim(runId, Date.now(), 3456);
    assert.ok(claim);
    const first = prepared.prepared.evaluations[0]!;
    const reservation = store.reserveBatch(claim, first.groupId!, [first.evaluationId], Date.now());
    assert.ok(reservation);
    store.settleBatch(claim, reservation.attemptId, { kind: 'answered', result: {
      execution: { attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 1, usage: {} },
      answers: [{ questionId: first.questionId, value: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9, leave: 0.1 } } }],
    } });

    const page = store.queryEvidence({ sourceRunId: runId, criteria: {} });
    assert.deepEqual(page.coverage.respondents, { total: 2, completed: 0, failed: 0, unreached: 0, active: 2 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('evidence query applies numeric Score and Noul criteria without converting their meanings', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const scoreRequest: InlineRunRequest = { ...input, questions: [{ type: 'score', id: 'clarity', instructions: 'How clear is this?', rubric: ['unclear', 'mixed', 'clear'] }] };
    const scoreResult: DecisionResult = { type: 'score', score: 1.5, legend: { '0': 'unclear', '1': 'mixed', '2': 'clear' }, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 }, attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 1, usage: {} };
    const scoreRun = await completedRun(store, scoreRequest, () => scoreResult);
    assert.equal(store.queryEvidence({ sourceRunId: scoreRun, criteria: { answer: { type: 'score', operator: 'gte', value: 1.5 } } }).totalMatches, 2);
    assert.equal(store.queryEvidence({ sourceRunId: scoreRun, criteria: { answer: { type: 'score', operator: 'lt', value: 1.5 } } }).totalMatches, 0);

    const noulRequest: InlineRunRequest = { ...input, questions: [{ type: 'noul', id: 'holds-attention', instructions: 'Does this hold attention?' }] };
    const noulResult: DecisionResult = { type: 'noul', noul: 0.74, attempts: 1, provider: 'laya', model: 'test-model', latencyMs: 1, usage: {} };
    const noulRun = await completedRun(store, noulRequest, () => noulResult);
    assert.equal(store.queryEvidence({ sourceRunId: noulRun, criteria: { answer: { type: 'noul', operator: 'gte', value: 0.7 } } }).totalMatches, 2);
    assert.equal(store.queryEvidence({ sourceRunId: noulRun, criteria: { answer: { type: 'noul', operator: 'lt', value: 0.7 } } }).totalMatches, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('a journey departure outcome does not satisfy a typed lost-interest answer selector', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const accepted = store.acceptJourney(randomUUID(), preparedJourneyRun());
    const departure = store.queryEvidence({ sourceRunId: accepted.run.runId, criteria: { outcome: 'left-lost-interest' } });
    const typedReason = store.queryEvidence({ sourceRunId: accepted.run.runId, criteria: { answer: { type: 'choice', choiceId: 'yes' } } });
    assert.equal(departure.totalMatches, 0);
    assert.equal(typedReason.totalMatches, 0);
    assert.equal(departure.sourceComplete, false);
    assert.equal(departure.coverage.respondents.active, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('run discovery combines date and material criteria with existing status and label filters', async () => {
  const root = await temporaryRoot();
  let now = Date.now();
  const store = openRunStore(root, { now: () => now });
  try {
    const first = await completedRun(store, { ...input, label: 'first' }, () => savedAnswer, now);
    now += 1000;
    const second = await completedRun(store, { ...input, label: 'pilot', material: [{ id: 'chapter-one', text: 'Different exact material.' }] }, () => savedAnswer, now);
    const page = store.list({ status: 'completed', label: 'pilot', createdAfter: new Date(now).toISOString(), createdBefore: new Date(now + 1000).toISOString(), materialId: 'chapter-one' });
    assert.deepEqual(page.items.map(({ runId }) => runId), [second]);
    assert.notEqual(first, second);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('delete preview reports exact selected run counts without deleting evidence', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const runId = await completedRun(store);
    const preview = store.previewDelete([runId]);
    assert.deepEqual(preview, {
      runs: [{ runId, status: 'completed', evaluationCount: 2, attemptCount: 2, blockedByActiveWork: false, retainedFollowOnRunIds: [] }],
      blockedByActiveWork: false,
    });
    assert.equal(store.getStatus(runId).status, 'completed');
    assert.equal(store.answers(runId).items.filter(({ status }) => status === 'answered').length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('delete preview does not reconcile or mutate expired worker state', async () => {
  const root = await temporaryRoot();
  let now = Date.now();
  const store = openRunStore(root, { now: () => now });
  try {
    const prepared = await preparedRun();
    const runId = store.accept(randomUUID(), prepared).run.runId;
    const claim = store.claim(runId, now, 9876);
    assert.ok(claim);
    const evaluation = prepared.evaluations[0]!;
    const reservation = store.reserveBatch(claim, evaluation.groupId!, [evaluation.evaluationId], now);
    assert.ok(reservation);
    now += 31_000;

    const db = new DatabaseSync(path.join(root, 'runs.sqlite'));
    let beforeRun: unknown;
    let beforeAttempt: unknown;
    try {
      beforeRun = db.prepare('SELECT status, used_calls, reserved_calls FROM runs WHERE run_id = ?').get(runId);
      beforeAttempt = db.prepare('SELECT status FROM attempts WHERE attempt_id = ?').get(reservation.attemptId);
    } finally { db.close(); }

    const preview = store.previewDelete([runId]);
    assert.equal(preview.runs[0]?.status, 'interrupted');
    assert.equal(preview.runs[0]?.blockedByActiveWork, false);
    const afterDb = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try {
      assert.deepEqual(afterDb.prepare('SELECT status, used_calls, reserved_calls FROM runs WHERE run_id = ?').get(runId), beforeRun);
      assert.deepEqual(afterDb.prepare('SELECT status FROM attempts WHERE attempt_id = ?').get(reservation.attemptId), beforeAttempt);
    } finally { afterDb.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('delete rejects empty, duplicate, missing, oversized, and active selections without partial deletion', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const completed = await completedRun(store);
    const active = store.accept(randomUUID(), await preparedRun()).run.runId;
    const running = store.accept(randomUUID(), await preparedRun()).run.runId;
    assert.ok(store.claim(running, Date.now(), 2345));
    assert.throws(() => store.previewDelete([]), (error: unknown) => error instanceof RunStoreError && error.code === 'invalid_run_selection');
    assert.throws(() => store.previewDelete([completed, completed]), (error: unknown) => error instanceof RunStoreError && error.code === 'invalid_run_selection');
    assert.throws(() => store.previewDelete(Array.from({ length: 201 }, () => randomUUID())), (error: unknown) => error instanceof RunStoreError && error.code === 'invalid_run_selection');
    assert.throws(() => store.previewDelete([randomUUID()]), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_found');
    assert.throws(() => store.deleteRuns([completed, active]), (error: unknown) => error instanceof RunStoreError && error.code === 'runs_active');
    assert.throws(() => store.deleteRuns([completed, running]), (error: unknown) => error instanceof RunStoreError && error.code === 'runs_active');
    assert.throws(() => store.deleteRuns([completed, randomUUID()]), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_found');
    assert.equal(store.getStatus(completed).status, 'completed');
    assert.equal(store.getStatus(active).status, 'prepared');
    assert.equal(store.getStatus(running).status, 'running');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('delete revalidates state after preview and cascades evaluations and attempts atomically', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const runId = await completedRun(store);
    const preview = store.previewDelete([runId]);
    assert.equal(preview.blockedByActiveWork, false);
    const db = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try { db.prepare("UPDATE runs SET status = 'prepared' WHERE run_id = ?").run(runId); }
    finally { db.close(); }
    assert.throws(() => store.deleteRuns([runId]), (error: unknown) => error instanceof RunStoreError && error.code === 'runs_active');
    assert.equal(store.getStatus(runId).status, 'prepared');

    const terminalDb = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try { terminalDb.prepare("UPDATE runs SET status = 'completed' WHERE run_id = ?").run(runId); }
    finally { terminalDb.close(); }
    const deleted = store.deleteRuns([runId]);
    assert.deepEqual(deleted, { deletedRunIds: [runId], removed: { runs: 1, evaluations: 2, attempts: 2 }, maintenance: { optimization: 'completed' } });
    assert.throws(() => store.getStatus(runId), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_found');
    const verify = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try {
      assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ?').get(runId) as { count: number }).count, 0);
      assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(runId) as { count: number }).count, 0);
    } finally { verify.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('delete reports committed deletion when post-delete optimization fails', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const runId = await completedRun(store);
    store.optimizeStorage = () => { throw new RunStoreError('storage_operation_failed', 'Optimization unavailable.'); };

    const result = store.deleteRuns([runId]);

    assert.deepEqual(result, {
      deletedRunIds: [runId],
      removed: { runs: 1, evaluations: 2, attempts: 2 },
      maintenance: { optimization: 'failed', failureCode: 'storage_operation_failed' },
    });
    assert.throws(() => store.getStatus(runId), (error: unknown) => error instanceof RunStoreError && error.code === 'run_not_found');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('storage inspection reports exact healthy counts and optimization preserves run evidence', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const empty = store.storageInfo();
    assert.equal(empty.integrity, 'ok');
    assert.ok(empty.databaseBytes > 0);
    assert.deepEqual({ runs: empty.runCount, evaluations: empty.evaluationCount, attempts: empty.attemptCount, active: empty.activeRunCount }, { runs: 0, evaluations: 0, attempts: 0, active: 0 });

    const runId = await completedRun(store);
    const request = store.getRequest(runId);
    const answers = store.answers(runId);
    const populated = store.storageInfo();
    assert.equal(populated.integrity, 'ok');
    assert.deepEqual({ runs: populated.runCount, evaluations: populated.evaluationCount, attempts: populated.attemptCount, active: populated.activeRunCount }, { runs: 1, evaluations: 2, attempts: 2, active: 0 });
    store.optimizeStorage();
    assert.deepEqual(store.getRequest(runId), request);
    assert.deepEqual(store.answers(runId), answers);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('storage inspection reports failed integrity without calling corrupt data healthy', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const runId = store.accept(randomUUID(), await preparedRun()).run.runId;
    const db = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try { db.exec('PRAGMA ignore_check_constraints = ON'); db.prepare("UPDATE runs SET status = 'corrupt' WHERE run_id = ?").run(runId); }
    finally { db.close(); }
    assert.equal(store.storageInfo().integrity, 'failed');
    assert.throws(() => store.optimizeStorage(), (error: unknown) => error instanceof RunStoreError && error.code === 'storage_integrity_failed');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('storage inspection reconciles expired workers without restarting them', async () => {
  const root = await temporaryRoot();
  const store = openRunStore(root);
  try {
    const runId = store.accept(randomUUID(), await preparedRun()).run.runId;
    assert.ok(store.claim(runId, Date.now(), 4567));
    const db = new DatabaseSync(path.join(root, 'runs.sqlite'));
    try { db.prepare('UPDATE runs SET lease_expires_ms = 0 WHERE run_id = ?').run(runId); }
    finally { db.close(); }
    const info = store.storageInfo();
    assert.equal(info.activeRunCount, 0);
    assert.equal(store.getStatus(runId).status, 'interrupted');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
