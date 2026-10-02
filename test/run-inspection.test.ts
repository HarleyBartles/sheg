import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareFollowOnRun, prepareRun } from '../src/application/run-inspection.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import { compileDecisionRequest, emptyTrajectory } from '../src/domain/decision/prompt.js';
import type { DecisionBatchRequest, DecisionRequest, DecisionResult } from '../src/domain/decision/decision.js';
import { followOnRunRequestSchema, type FollowOnSourceSet, type InlineRunRequest } from '../src/domain/run/request.js';

const fit = (status: ProviderContextFit['status'] = 'fits'): ProviderContextFit => ({
  provider: 'laya', status, method: 'test-fixture', modelIdentity: 'test-model',
  tokenCount: 'measured', tokens: 12, contextLimit: 4096,
  headroomTokens: 128, effectiveLimit: 3968, details: {},
  ...(status === 'unavailable' ? { reason: 'test-unavailable' } : {}),
});

function makeProvider(statuses: ProviderContextFit['status'][] = ['fits']) {
  const measured: DecisionRequest[] = [];
  let decisions = 0;
  const provider: DecisionProvider = {
    measure(request) {
      measured.push(request);
      return fit(statuses[measured.length - 1] ?? 'fits');
    },
    async decide(): Promise<DecisionResult> {
      decisions += 1;
      throw new Error('Inspection must not run inference.');
    },
  };
  return { provider, measured, get decisions() { return decisions; } };
}

function request(questions: InlineRunRequest['questions'] = [{
  type: 'choice', id: 'interest', instructions: 'Would you continue?',
  options: { continue: 'Continue', leave: 'Leave' },
}]) : InlineRunRequest {
  return {
    kind: 'poll',
    label: 'temporary research label',
    respondents: [
      { id: 'reader-a', intent: 'Learn the process', context: 'New buyer', desired_outcome: 'Choose a product', engagement_cues: 'Examples', friction_cues: 'Hype' },
      { id: 'reader-b', intent: 'Compare options', context: 'Returning buyer', desired_outcome: 'Save time', engagement_cues: 'Evidence', friction_cues: 'Repetition' },
    ],
    material: [{ id: 'section-three', text: 'Exact text' }],
    questions,
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:7071', checkpoint: 'test-model', contextLimit: 4096, headLimit: 2048, tokenizerJsonPath: 'tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 1000 },
    maxCalls: 2,
  };
}

test('preparation compiles one frozen, metadata-free packet per respondent without decisions', async () => {
  const fixture = makeProvider();
  const result = await prepareRun(request(), fixture.provider);

  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.respondentCount, 2);
  assert.equal(result.prepared!.evaluations.length, 2);
  assert.deepEqual(fixture.measured.map((call) => call.state.respondent), [
    { profile: { intent: 'Learn the process', context: 'New buyer', desired_outcome: 'Choose a product', engagement_cues: 'Examples', friction_cues: 'Hype' } },
    { profile: { intent: 'Compare options', context: 'Returning buyer', desired_outcome: 'Save time', engagement_cues: 'Evidence', friction_cues: 'Repetition' } },
  ]);
  assert.deepEqual(fixture.measured[0]!.state.encounteredItems, [{ id: 'section-three', text: 'Exact text' }]);
  assert.deepEqual(Object.keys(fixture.measured[0]!.state), ['respondent', 'encounteredItems', 'trajectory']);
  assert.equal(JSON.stringify(fixture.measured[0]).includes('temporary research label'), false);
  assert.equal(fixture.measured[0]!.question.type, 'choice');
  assert.ok('optionIds' in fixture.measured[0]!);
  if ('optionIds' in fixture.measured[0]!) assert.deepEqual(fixture.measured[0]!.optionIds, ['continue', 'leave']);
  assert.notEqual(result.prepared!.evaluations[0]!.contextId, result.prepared!.evaluations[1]!.contextId);
  assert.equal(JSON.stringify(result.prepared).includes('selectionRationale'), false);
  assert.equal(fixture.decisions, 0);
});

test('preparation supports all existing typed question meanings', async () => {
  for (const typedQuestion of [
    { type: 'choice' as const, id: 'choice', instructions: 'Choose', options: { a: 'A' } },
    { type: 'score' as const, id: 'score', instructions: 'Rate it', rubric: ['low', 'high'] },
    { type: 'noul' as const, id: 'noul', instructions: 'Is it clear?' },
  ]) {
    const fixture = makeProvider();
    const result = await prepareRun(request([typedQuestion]), fixture.provider);
    assert.equal(result.inspection.valid, true, typedQuestion.type);
    assert.equal(fixture.measured[0]!.question.type, typedQuestion.type);
    assert.equal(fixture.decisions, 0);
  }
});

test('journey admission preserves a catalog-only candidate link without adding it to respondent state', async () => {
  const candidate = { id: 'later-section', text: 'Exact later section.', sourceId: 'article-v1', sourceSha256: 'b'.repeat(64) };
  const input = {
    kind: 'journey',
    respondents: [request().respondents[0]!],
    journey: {
      id: 'article', label: 'Article journey', items: [candidate],
      tasks: [{ id: 'choose-section', type: 'choice', instructions: 'Which part?', options: { later: candidate.text, 'no-fit': 'Neither' }, materialOptions: { later: candidate.id } }],
      presentation: { kind: 'graph', entryNodeId: 'ask', maxDecisions: 1, nodes: [
        { id: 'ask', kind: 'ask', taskId: 'choose-section' }, { id: 'done', kind: 'terminal', outcome: 'complete' },
      ], transitions: [
        { fromNodeId: 'ask', optionId: 'later', toNodeId: 'done' },
        { fromNodeId: 'ask', optionId: 'no-fit', toNodeId: 'done' },
      ] },
    },
    provider: request().provider, maxCalls: 1,
  };
  const fixture = makeProvider();
  const result = await prepareRun(input, fixture.provider);
  assert.equal(result.inspection.valid, true);
  assert.deepEqual(fixture.measured[0]!.state.encounteredItems, []);
  assert.deepEqual(fixture.measured[0]!.question.type === 'choice' ? fixture.measured[0]!.question.materialOptions : undefined, { later: 'later-section' });
  assert.equal(JSON.stringify(fixture.measured[0]!.state).includes(candidate.sourceSha256), false);
  assert.equal(fixture.decisions, 0);
});

test('overflow and unavailable fits reject before any inference call', async () => {
  for (const status of ['overflow', 'unavailable'] as const) {
    const fixture = makeProvider([status, 'fits']);
    const result = await prepareRun(request(), fixture.provider);
    assert.equal(result.inspection.valid, false, status);
    assert.equal(result.prepared, undefined, status);
    assert.equal(result.inspection.problems.some((problem) => problem.respondentId === 'reader-a'), true);
    assert.equal(fixture.decisions, 0);
  }
});

test('invalid direct request reports structured inspection problems without calling inference', async () => {
  const fixture = makeProvider();
  const result = await prepareRun({ ...request(), questions: [] }, fixture.provider);
  assert.equal(result.inspection.valid, false);
  assert.equal(result.inspection.problems[0]!.code, 'invalid_request');
  assert.equal(fixture.measured.length, 0);
  assert.equal(fixture.decisions, 0);
});

test('a provider without a context measurement cannot claim fit', async () => {
  let decisions = 0;
  const provider: DecisionProvider = {
    async decide(): Promise<DecisionResult> {
      decisions += 1;
      throw new Error('Inspection must not run inference.');
    },
  };
  const result = await prepareRun(request(), provider);
  assert.equal(result.inspection.valid, false);
  assert.equal(result.inspection.fits[0]!.fit.status, 'unavailable');
  assert.equal(result.inspection.fits[0]!.fit.provider, 'laya');
  assert.equal(result.prepared, undefined);
  assert.equal(decisions, 0);
});

test('batch admission measures ordered mixed questions over one exact context per respondent', async () => {
  const measured: DecisionBatchRequest[] = [];
  const provider: DecisionProvider = {
    measureBatch(batch) { measured.push(batch); return fit(); },
    async decide() { throw new Error('Inspection must not run inference.'); },
  };
  const questions = [
    { type: 'choice' as const, id: 'interest', instructions: 'Continue?', options: { yes: 'Yes', no: 'No' } },
    { type: 'score' as const, id: 'clarity', instructions: 'How clear?', rubric: ['unclear', 'clear'] },
    { type: 'noul' as const, id: 'trust', instructions: 'Is it credible?' },
  ];
  const result = await prepareRun(request(questions), provider);

  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.minimumCalls, 2);
  assert.deepEqual(measured.map(({ questions: grouped }) => grouped.map(({ id }) => id)), [
    ['interest'], ['interest', 'clarity'], ['interest', 'clarity', 'trust'],
    ['interest'], ['interest', 'clarity'], ['interest', 'clarity', 'trust'],
  ]);
  assert.deepEqual(result.inspection.fits.map(({ questionIds }) => questionIds), [
    ['interest', 'clarity', 'trust'], ['interest', 'clarity', 'trust'],
  ]);
  assert.deepEqual(result.prepared!.evaluations.map(({ respondentId, questionId }) => [respondentId, questionId]), [
    ['reader-a', 'interest'], ['reader-a', 'clarity'], ['reader-a', 'trust'],
    ['reader-b', 'interest'], ['reader-b', 'clarity'], ['reader-b', 'trust'],
  ]);
  assert.equal(new Set(result.prepared!.evaluations.slice(0, 3).map(({ contextId }) => contextId)).size, 1);
  assert.equal(new Set(result.prepared!.evaluations.slice(3).map(({ contextId }) => contextId)).size, 1);
  assert.equal(new Set(result.prepared!.evaluations.slice(0, 3).map(({ packet }) => JSON.stringify(packet.state))).size, 1);
  assert.equal(new Set(result.prepared!.evaluations.slice(3).map(({ packet }) => JSON.stringify(packet.state))).size, 1);
  assert.notEqual(result.prepared!.evaluations[0]!.contextId, result.prepared!.evaluations[3]!.contextId);
  assert.ok(measured.every(({ state }) => JSON.stringify(state).includes('Exact text')));
});

test('batch admission greedily splits overflow into the largest fitting ordered prefixes and checks physical maxCalls', async () => {
  const measured: DecisionBatchRequest[] = [];
  const provider: DecisionProvider = {
    measureBatch(batch) {
      measured.push(batch);
      return fit(batch.questions.length <= 2 ? 'fits' : 'overflow');
    },
    async decide() { throw new Error('Inspection must not run inference.'); },
  };
  const questions = ['q1', 'q2', 'q3'].map((id) => ({ type: 'noul' as const, id, instructions: `Question ${id}?` }));
  const input = { ...request(questions), respondents: [request(questions).respondents[0]!], maxCalls: 2 };
  const result = await prepareRun(input, provider);

  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.minimumCalls, 2);
  assert.deepEqual(result.inspection.fits.map(({ questionIds }) => questionIds), [['q1', 'q2'], ['q3']]);
  assert.deepEqual(measured.map(({ questions: grouped }) => grouped.map(({ id }) => id)), [['q1'], ['q1', 'q2'], ['q1', 'q2', 'q3'], ['q3']]);

  const underfunded = await prepareRun({ ...input, maxCalls: 1 }, provider);
  assert.equal(underfunded.inspection.valid, false);
  assert.equal(underfunded.inspection.minimumCalls, 2);
  assert.equal(underfunded.inspection.problems.some(({ code }) => code === 'insufficient_call_limit'), true);
});

test('an unavailable group or overflowing singleton never becomes admitted through splitting', async () => {
  const questions = ['q1', 'q2'].map((id) => ({ type: 'noul' as const, id, instructions: `Question ${id}?` }));
  for (const resultStatus of ['unavailable', 'overflow'] as const) {
    const provider: DecisionProvider = {
      measureBatch: () => fit(resultStatus),
      async decide() { throw new Error('Inspection must not run inference.'); },
    };
    const result = await prepareRun({ ...request(questions), respondents: [request(questions).respondents[0]!], maxCalls: 2 }, provider);
    assert.equal(result.inspection.valid, false, resultStatus);
    assert.equal(result.prepared, undefined, resultStatus);
    assert.equal(result.inspection.fits.some(({ fit: item }) => item.status === resultStatus), true, resultStatus);
  }
});

test('providers without batch measurement receive singleton questions over each respondent state', async () => {
  const fixture = makeProvider();
  const questions = ['first', 'second'].map((id) => ({ type: 'noul' as const, id, instructions: `Question ${id}?` }));
  const result = await prepareRun({ ...request(questions), maxCalls: 4 }, fixture.provider);
  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.minimumCalls, 4);
  assert.deepEqual(fixture.measured.map(({ question }) => question.id), ['first', 'second', 'first', 'second']);
  assert.deepEqual(result.inspection.fits.map(({ questionIds }) => questionIds), [['first'], ['second'], ['first'], ['second']]);
});

test('follow-on batching groups distinct source contexts and never includes selection metadata in model state', async () => {
  const questions = [
    { type: 'choice' as const, id: 'why', instructions: 'Which part?', options: { opening: 'Opening', proof: 'Proof' } },
    { type: 'noul' as const, id: 'severity', instructions: 'Was it frustrating?' },
  ];
  const followOn = followOnRunRequestSchema.parse({
    kind: 'follow-on', sourceRunId: '123e4567-e89b-42d3-a456-426614174000',
    selection: { criteria: { questionId: 'interest', answer: { type: 'choice', choiceId: 'leave' } } },
    context: { mode: 'recorded' }, questions,
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 2,
  });
  const profile = { intent: 'Learn', context: 'New reader', desired_outcome: 'Understand', engagement_cues: 'Examples', friction_cues: 'Hype' };
  const previousQuestion = { type: 'noul' as const, id: 'interest', instructions: 'Interested?' };
  const sourcePacket = (text: string) => compileDecisionRequest({ respondentProfile: profile, encounteredItems: [{ id: 'section-three', text }], trajectory: emptyTrajectory(), question: previousQuestion });
  const source: FollowOnSourceSet = {
    sourceRunId: followOn.sourceRunId, sourceStatus: 'running', sourceComplete: false,
    version: { status: 'running', usedCalls: 2, reservedCalls: 0, maxOrdinal: 3 },
    turns: [
      { evaluationId: '11111111-1111-4111-8111-111111111111', contextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', respondentId: 'reader-a', packet: sourcePacket('First source context') },
      { evaluationId: '22222222-2222-4222-8222-222222222222', contextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', respondentId: 'reader-a', packet: sourcePacket('First source context') },
      { evaluationId: '33333333-3333-4333-8333-333333333333', contextId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', respondentId: 'reader-a', packet: sourcePacket('Second source context') },
    ],
  };
  const measured: DecisionBatchRequest[] = [];
  const provider: DecisionProvider = {
    measureBatch(batch) { measured.push(batch); return fit(); },
    async decide() { throw new Error('Inspection must not run inference.'); },
  };
  const admission = await prepareFollowOnRun(followOn, source, provider);

  assert.equal(admission.inspection.valid, true);
  assert.equal(admission.inspection.respondentCount, 2);
  assert.equal(admission.inspection.minimumCalls, 2);
  assert.deepEqual(measured.map(({ questions: grouped }) => grouped.map(({ id }) => id)), [
    ['why'], ['why', 'severity'], ['why'], ['why', 'severity'],
  ]);
  assert.deepEqual(measured.map(({ state }) => state.encounteredItems), [
    [{ id: 'section-three', text: 'First source context' }],
    [{ id: 'section-three', text: 'First source context' }],
    [{ id: 'section-three', text: 'Second source context' }],
    [{ id: 'section-three', text: 'Second source context' }],
  ]);
  assert.equal(JSON.stringify(measured).includes(followOn.sourceRunId), false);
  assert.equal(JSON.stringify(measured).includes('selection'), false);
  assert.equal(admission.prepared.evaluations.length, 4);
  assert.equal(new Set(admission.prepared.evaluations.slice(0, 2).map(({ contextId }) => contextId)).size, 1);
  assert.notEqual(admission.prepared.evaluations[0]!.contextId, admission.prepared.evaluations[2]!.contextId);

  const continuationTurns = source.turns.map((turn, index) => ({
    ...turn,
    result: { type: 'noul' as const, noul: index / 2, attempts: 1, provider: 'jev' as const, model: 'typesafe/jev-1.13', latencyMs: 1, usage: {} },
  }));
  const continuationProviderCalls: DecisionBatchRequest[] = [];
  const continuationProvider: DecisionProvider = {
    measureBatch(batch) { continuationProviderCalls.push(batch); return fit(); },
    async decide() { throw new Error('Inspection must not run inference.'); },
  };
  const continued = await prepareFollowOnRun({ ...followOn, context: { mode: 'continue' }, maxCalls: 3 }, { ...source, turns: continuationTurns }, continuationProvider);
  assert.equal(continued.inspection.valid, true);
  assert.equal(continued.inspection.respondentCount, 3);
  assert.equal(continued.inspection.minimumCalls, 3);
  assert.equal(continued.prepared.evaluations.length, 6);
  assert.equal(new Set(continued.prepared.evaluations.map(({ contextId }) => contextId)).size, 3);
  assert.deepEqual(continuationProviderCalls.map(({ state }) => (state.trajectory as { responses: Array<{ noul: number }> }).responses.at(-1)?.noul), [0, 0, 0.5, 0.5, 1, 1]);
});

test('follow-on can select an offered catalog candidate that was not encountered', async () => {
  const candidate = { id: 'later-section', text: 'Exact later section.', sourceId: 'article-v1', sourceSha256: 'd'.repeat(64) };
  const profile = { intent: 'Learn', context: 'New reader', desired_outcome: 'Understand', engagement_cues: 'Examples', friction_cues: 'Hype' };
  const sourcePacket = compileDecisionRequest({ respondentProfile: profile, encounteredItems: [], trajectory: emptyTrajectory(), question: {
    type: 'choice', id: 'pick', instructions: 'Which section?', options: { later: candidate.text, 'no-fit': 'Neither' }, materialOptions: { later: candidate.id },
  } });
  const source = {
    sourceRunId: '123e4567-e89b-42d3-a456-426614174000', sourceStatus: 'completed' as const, sourceComplete: true,
    version: { status: 'completed' as const, usedCalls: 1, reservedCalls: 0, maxOrdinal: 0 },
    turns: [{ evaluationId: '11111111-1111-4111-8111-111111111111', contextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', respondentId: 'reader-a', packet: sourcePacket, materials: [candidate] }],
  } as unknown as FollowOnSourceSet;
  const followOn = followOnRunRequestSchema.parse({
    kind: 'follow-on', sourceRunId: source.sourceRunId,
    selection: { criteria: {} }, context: { mode: 'fresh-material', materialIds: [candidate.id] },
    questions: [{ type: 'choice', id: 'ask-why', instructions: 'What loses your interest?', options: { candidate: candidate.text, 'no-fit': 'No fit' }, materialOptions: { candidate: candidate.id } }],
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1,
  });
  const result = await prepareFollowOnRun(followOn, source, makeProvider().provider);
  assert.equal(result.inspection.valid, true);
  assert.deepEqual(result.prepared.evaluations[0]!.packet.state.encounteredItems, [{ id: candidate.id, text: candidate.text }]);
  assert.equal(JSON.stringify(result.prepared.evaluations[0]!.packet.state).includes(candidate.sourceSha256), false);
});

function journeyRequest(maxCalls = 1, respondentCount = 1) {
  const respondent = { id: 'reader-a', intent: 'Understand', context: 'New reader', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' };
  return {
    kind: 'journey',
    respondents: respondentCount === 1 ? [respondent] : [respondent, { ...respondent, id: 'reader-b' }],
    journey: {
      id: 'article', label: 'Article journey',
      items: [{ id: 'section-one', text: 'Opening section.' }, { id: 'section-three', text: 'Later section.' }],
      tasks: [
        { id: 'continue', type: 'choice', instructions: 'Would you continue?', options: { continue: 'Continue', leave: 'Leave' } },
        { id: 'interest', type: 'choice', instructions: 'Did interest fade?', options: { yes: 'Yes', no: 'No' } },
      ],
      presentation: { kind: 'graph', entryNodeId: 'entry', maxDecisions: 2, nodes: [
        { id: 'entry', kind: 'ask', taskId: 'continue' },
        { id: 'expose-section-three', kind: 'expose', itemId: 'section-three' },
        { id: 'lost-interest', kind: 'ask', taskId: 'interest' },
        { id: 'finished', kind: 'terminal', outcome: 'complete' },
      ], transitions: [
        { fromNodeId: 'entry', optionId: 'continue', toNodeId: 'expose-section-three' },
        { fromNodeId: 'entry', optionId: 'leave', toNodeId: 'finished' },
        { fromNodeId: 'expose-section-three', toNodeId: 'lost-interest' },
        { fromNodeId: 'lost-interest', optionId: 'yes', toNodeId: 'finished' },
        { fromNodeId: 'lost-interest', optionId: 'no', toNodeId: 'finished' },
      ] },
    },
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:7071', checkpoint: 'test-model', contextLimit: 4096, headLimit: 2048, tokenizerJsonPath: 'tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 1000 },
    maxCalls,
  };
}

test('journey admission measures each reachable context and reports bounded call outcomes without inference', async () => {
  const fixture = makeProvider();
  const result = await prepareRun(journeyRequest(), fixture.provider);
  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.respondentCount, 1);
  assert.equal(result.inspection.minimumCalls, 1);
  assert.equal(result.inspection.maximumCalls, 2);
  assert.equal(result.inspection.warnings?.some(({ code }) => code === 'call_limit_may_stop_journey'), true);
  assert.equal(result.inspection.fits.length, 2);
  assert.equal(fixture.measured.length, 2);
  assert.deepEqual(fixture.measured.map(({ question }) => question.id), ['continue', 'interest']);
  assert.deepEqual(fixture.measured[1]!.state.encounteredItems, [{ id: 'section-three', text: 'Later section.' }]);
  const history = fixture.measured[1]!.state.trajectory as { responses: Array<{ type: string }> };
  assert.equal(history.responses[0]?.type, 'choice');
  assert.equal(fixture.decisions, 0);
});

test('sequence admission measures each authored ask in order and applies the finite call bound', async () => {
  const base = journeyRequest(2);
  const request = { ...base, journey: { ...base.journey, presentation: { kind: 'sequence' } } };
  const fixture = makeProvider();
  const result = await prepareRun(request, fixture.provider);
  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.minimumCalls, 2);
  assert.equal(result.inspection.maximumCalls, 2);
  assert.deepEqual(fixture.measured.map(({ question }) => question.id), ['continue', 'interest', 'interest']);
  assert.equal(fixture.decisions, 0);
});

test('journey admission rejects an overflowing branch and a cap below every possible minimum path', async () => {
  const overflowFixture = makeProvider(['fits', 'overflow']);
  const overflow = await prepareRun(journeyRequest(), overflowFixture.provider);
  assert.equal(overflow.inspection.valid, false);
  assert.equal(overflow.inspection.problems.some(({ code }) => code === 'context_overflow'), true);
  assert.equal(overflowFixture.decisions, 0);

  const lowCap = await prepareRun(journeyRequest(1, 2), makeProvider().provider);
  assert.equal(lowCap.inspection.valid, false);
  assert.equal(lowCap.inspection.problems.some(({ code }) => code === 'insufficient_call_limit'), true);
});
