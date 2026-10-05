import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareFollowOnRun, prepareRun } from '../src/application/run-inspection.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import { compileDecisionRequest, emptyTrajectory } from '../src/domain/decision/prompt.js';
import type { DecisionBatchRequest, DecisionRequest, DecisionResult } from '../src/domain/decision/decision.js';
import { followOnRunRequestSchema, type FollowOnSourceSet, type FollowOnSourceTurn, type InlineRunRequest } from '../src/domain/run/request.js';
import { JevProvider } from '../src/providers/jev.js';
import { defaultJevConfig } from '../src/providers/jev/config.js';

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

const pullQuote = { id: 'pull-quote', text: 'A city is a promise people keep making to each other.', sourceId: 'article-v1', sourceSha256: 'a'.repeat(64) };
const paragraph3 = { id: 'paragraph-3', text: 'Exact paragraph three.', sourceId: 'article-v1', sourceSha256: 'b'.repeat(64) };
const paragraph7 = { id: 'paragraph-7', text: 'Exact paragraph seven.', sourceId: 'article-v1', sourceSha256: 'c'.repeat(64) };
const surrounding = { id: 'article-body', text: 'Surrounding article text.', sourceId: 'article-v1', sourceSha256: 'd'.repeat(64) };
const selectionProfile = { intent: 'Learn', context: 'New reader', desired_outcome: 'Understand', engagement_cues: 'Examples', friction_cues: 'Hype' };
const selectionQuestion = {
  type: 'choice' as const, id: 'pick-paragraph', instructions: 'Which paragraph best represents the pull quote?',
  options: { p3: paragraph3.text, p7: paragraph7.text, 'no-fit': 'No paragraph fits the pull quote.' },
  materialOptions: { p3: paragraph3.id, p7: paragraph7.id },
};

function makeSelectionTurn(evaluationId: string, contextId: string, respondentId: string, choice: 'p3' | 'p7' | 'no-fit') {
  const packet = compileDecisionRequest({ respondentProfile: selectionProfile, encounteredItems: [surrounding], trajectory: emptyTrajectory(), question: selectionQuestion });
  const material = choice === 'p3' ? paragraph3 : choice === 'p7' ? paragraph7 : undefined;
  const probabilities = Object.fromEntries(Object.keys(selectionQuestion.options).map((option) => [option, option === choice ? 1 : 0]));
  return {
    evaluationId, contextId, respondentId, status: 'answered' as const, packet,
    result: { type: 'choice' as const, choice, confidence: 1, probabilities },
    materials: [pullQuote, paragraph3, paragraph7, surrounding],
    ...(material ? { selectedMaterial: { materialId: material.id, text: material.text, sourceId: material.sourceId, sourceSha256: material.sourceSha256, textSha256: 'e'.repeat(64) } } : {}),
  } as unknown as FollowOnSourceTurn;
}

function makeScoreSelectionTurn(evaluationId: string, contextId: string, respondentId: string) {
  const packet = compileDecisionRequest({ respondentProfile: selectionProfile, encounteredItems: [surrounding], trajectory: emptyTrajectory(), question: {
    type: 'score', id: 'rate', instructions: 'Rate the paragraph.', rubric: ['Poor', 'Good'],
  } });
  return {
    evaluationId, contextId, respondentId, status: 'answered' as const, packet,
    result: { type: 'score' as const, score: 'Good', confidence: 1, probabilities: { Poor: 0, Good: 1 } },
    materials: [pullQuote, paragraph3, paragraph7, surrounding],
  } as unknown as FollowOnSourceTurn;
}

function makeUnansweredSelectionTurn(evaluationId: string, contextId: string, respondentId: string, status: 'pending' | 'failed' | 'unreached'): FollowOnSourceTurn {
  const turn = makeSelectionTurn(evaluationId, contextId, respondentId, 'p3');
  delete turn.result;
  delete turn.selectedMaterial;
  turn.status = status;
  return turn;
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

test('native TypeSafe direct inspection reports context fit without reading credentials or inferring', async () => {
  const provider = new JevProvider(defaultJevConfig('typesafe'));
  const input = { ...request(), provider: { kind: 'jev' as const, route: 'typesafe' as const } };
  const result = await prepareRun(input, provider);

  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.fits.length, 2);
  assert.ok(result.inspection.fits.every(({ fit: measured }) => measured.status === 'fits' && measured.effectiveLimit === 25_600));
});

test('direct poll keeps source provenance in the run catalog but removes it from respondent provider state', async () => {
  const candidate = { id: 'section-three', text: 'Third section.', sourceId: 'article-section-3', sourceSha256: 'c'.repeat(64) };
  const fixture = makeProvider();
  const input = { ...request([{ type: 'choice' as const, id: 'select-section', instructions: 'Which section?', options: { candidate: candidate.text, 'no-fit': 'Neither section' }, materialOptions: { candidate: candidate.id } }]), material: [candidate] };
  const result = await prepareRun(input, fixture.provider);

  assert.equal(result.inspection.valid, true);
  assert.deepEqual(result.prepared!.request.kind === 'poll' ? result.prepared!.request.material[0] : undefined, candidate);
  assert.deepEqual(fixture.measured[0]!.state.encounteredItems, [{ id: candidate.id, text: candidate.text }]);
  assert.equal(JSON.stringify(fixture.measured[0]!.state).includes(candidate.sourceId), false);
  assert.equal(JSON.stringify(fixture.measured[0]!.state).includes(candidate.sourceSha256), false);
  assert.deepEqual(fixture.measured[0]!.question.type === 'choice' ? fixture.measured[0]!.question.materialOptions : undefined, { candidate: candidate.id });
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
    async decideBatch() { throw new Error('Inspection must not run inference.'); },
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
    async decideBatch() { throw new Error('Inspection must not run inference.'); },
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
      async decideBatch() { throw new Error('Inspection must not run inference.'); },
    };
    const result = await prepareRun({ ...request(questions), respondents: [request(questions).respondents[0]!], maxCalls: 2 }, provider);
    assert.equal(result.inspection.valid, false, resultStatus);
    assert.equal(result.prepared, undefined, resultStatus);
    assert.equal(result.inspection.fits.some(({ fit: item }) => item.status === resultStatus), true, resultStatus);
  }
});

test('providers without batch measurement receive singleton questions over each respondent state', async () => {
  const fixture = makeProvider();
  const questions = ['first', 'second'].map((id) => ({ type: 'noul' as const, id, instructions: `Is ${id} important?` }));
  const result = await prepareRun({ ...request(questions), maxCalls: 4 }, fixture.provider);
  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.minimumCalls, 4);
  assert.deepEqual(fixture.measured.map(({ question }) => question.id), ['first', 'second', 'first', 'second']);
  assert.deepEqual(result.inspection.fits.map(({ questionIds }) => questionIds), [['first'], ['second'], ['first'], ['second']]);
});

test('a measurement-only batch capability falls back to singleton admission', async () => {
  let batchMeasurements = 0;
  let singleMeasurements = 0;
  const provider: DecisionProvider = {
    measure() { singleMeasurements += 1; return fit(); },
    measureBatch() { batchMeasurements += 1; return fit(); },
    async decide() { throw new Error('Inspection must not run inference.'); },
  };
  const questions = ['first', 'second'].map((id) => ({ type: 'noul' as const, id, instructions: `Is ${id} important?` }));
  const result = await prepareRun({ ...request(questions), respondents: [request(questions).respondents[0]!], maxCalls: 2 }, provider);
  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.minimumCalls, 2);
  assert.equal(batchMeasurements, 0);
  assert.equal(singleMeasurements, 2);
  assert.deepEqual(result.inspection.fits.map(({ questionIds }) => questionIds), [['first'], ['second']]);
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
  const previousQuestion = { type: 'noul' as const, id: 'interest', instructions: 'Was the respondent interested?' };
  const sourcePacket = (text: string) => compileDecisionRequest({ respondentProfile: profile, encounteredItems: [{ id: 'section-three', text }], trajectory: emptyTrajectory(), question: previousQuestion });
  const source: FollowOnSourceSet = {
    sourceRunId: followOn.sourceRunId, sourceStatus: 'running', sourceComplete: false,
    version: { status: 'running', usedCalls: 2, reservedCalls: 0, maxOrdinal: 3 },
    turns: [
      { evaluationId: '11111111-1111-4111-8111-111111111111', contextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', respondentId: 'reader-a', status: 'answered', packet: sourcePacket('First source context') },
      { evaluationId: '22222222-2222-4222-8222-222222222222', contextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', respondentId: 'reader-a', status: 'answered', packet: sourcePacket('First source context') },
      { evaluationId: '33333333-3333-4333-8333-333333333333', contextId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', respondentId: 'reader-a', status: 'answered', packet: sourcePacket('Second source context') },
    ],
  };
  const measured: DecisionBatchRequest[] = [];
  const provider: DecisionProvider = {
    measureBatch(batch) { measured.push(batch); return fit(); },
    async decide() { throw new Error('Inspection must not run inference.'); },
    async decideBatch() { throw new Error('Inspection must not run inference.'); },
  };
  const admission = await prepareFollowOnRun(followOn, source, provider);

  assert.equal(admission.inspection.valid, true);
  assert.deepEqual(admission.prepared.lineage?.excludedSelections, []);
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
    async decideBatch() { throw new Error('Inspection must not run inference.'); },
  };
  const continued = await prepareFollowOnRun({ ...followOn, context: { mode: 'continue' }, maxCalls: 3 }, { ...source, turns: continuationTurns }, continuationProvider);
  assert.equal(continued.inspection.valid, true);
  assert.equal(continued.inspection.respondentCount, 3);
  assert.equal(continued.inspection.minimumCalls, 3);
  assert.equal(continued.prepared.evaluations.length, 6);
  assert.equal(new Set(continued.prepared.evaluations.map(({ contextId }) => contextId)).size, 3);
  assert.deepEqual(continuationProviderCalls.map(({ state }) => (state.trajectory as { responses: Array<{ noul: number }> }).responses.at(-1)?.noul), [0, 0, 0.5, 0.5, 1, 1]);
});

test('selected-material follow-on gives each mapped answer its own isolated packet and reports no-fit coverage', async () => {
  const sourceTurns = [
    makeSelectionTurn('11111111-1111-4111-8111-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'reader-a', 'p3'),
    makeSelectionTurn('11111111-1111-4111-8111-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', 'reader-b', 'p3'),
    makeSelectionTurn('11111111-1111-4111-8111-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003', 'reader-c', 'p7'),
    makeSelectionTurn('11111111-1111-4111-8111-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004', 'reader-d', 'no-fit'),
  ];
  const followOn = followOnRunRequestSchema.parse({
    kind: 'follow-on', sourceRunId: '123e4567-e89b-42d3-a456-426614174000',
    selection: { criteria: { questionId: 'pick-paragraph' } },
    context: { mode: 'fresh-material', includeSelectedMaterial: true, materialIds: ['pull-quote'] },
    questions: [{ type: 'noul', id: 'expresses-quote', instructions: 'Does this paragraph express the pull quote?' }],
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 3,
  });
  const source: FollowOnSourceSet = {
    sourceRunId: followOn.sourceRunId, sourceStatus: 'completed', sourceComplete: true,
    version: { status: 'completed', usedCalls: 4, reservedCalls: 0, maxOrdinal: 3 }, turns: sourceTurns,
  };
  const measured: DecisionBatchRequest[] = [];
  const provider: DecisionProvider = {
    measureBatch(batch) { measured.push(batch); return fit(); },
    async decide() { throw new Error('Inspection must not run inference.'); },
    async decideBatch() { throw new Error('Inspection must not run inference.'); },
  };

  const admission = await prepareFollowOnRun(followOn, source, provider);

  assert.equal(admission.inspection.valid, true);
  assert.equal(admission.inspection.respondentCount, 3);
  assert.deepEqual(admission.inspection.selectionCoverage, {
    matched: 4, eligible: 3,
    excluded: { pending: 0, failed: 0, unreached: 0, nonChoice: 0, unmappedChoice: 1 },
  });
  assert.deepEqual(admission.inspection.selectionExclusions, [{
    sourceEvaluationId: sourceTurns[3]!.evaluationId,
    sourceContextId: sourceTurns[3]!.contextId,
    respondentId: 'reader-d', status: 'answered', reason: 'unmappedChoice',
    choiceId: 'no-fit', choiceMeaning: 'No paragraph fits the pull quote.',
  }]);
  assert.equal(admission.prepared.evaluations.length, 3);
  for (const evaluation of admission.prepared.evaluations) {
    const paragraph = evaluation.respondentId === 'reader-c' ? paragraph7 : paragraph3;
    assert.deepEqual(evaluation.packet.state.encounteredItems, [pullQuote, paragraph].map(({ id, text }) => ({ id, text })));
    assert.deepEqual((evaluation.packet.state.trajectory as { responses: unknown[] }).responses, []);
    assert.equal(JSON.stringify(evaluation.packet.state).includes('surrounding article'), false);
    assert.equal(JSON.stringify(evaluation.packet.state).includes(evaluation.respondentId === 'reader-c' ? paragraph3.text : paragraph7.text), false);
  }
  assert.deepEqual(measured.map(({ state }) => state.encounteredItems), admission.prepared.evaluations.map(({ packet }) => packet.state.encounteredItems));
  assert.deepEqual(admission.prepared.lineage?.selectionCoverage, admission.inspection.selectionCoverage);
  assert.deepEqual(admission.prepared.lineage?.excludedSelections, admission.inspection.selectionExclusions);
});

test('selected-material coverage identifies non-Choice, failed, pending, and unreached source handles', async () => {
  const eligible = makeSelectionTurn('21111111-1111-4111-8111-000000000001', 'baaaaaaa-aaaa-4aaa-8aaa-000000000001', 'reader-a', 'p3');
  const noFit = makeSelectionTurn('21111111-1111-4111-8111-000000000002', 'baaaaaaa-aaaa-4aaa-8aaa-000000000002', 'reader-b', 'no-fit');
  const pending = makeUnansweredSelectionTurn('21111111-1111-4111-8111-000000000003', 'baaaaaaa-aaaa-4aaa-8aaa-000000000003', 'reader-c', 'pending');
  const failed = makeUnansweredSelectionTurn('21111111-1111-4111-8111-000000000004', 'baaaaaaa-aaaa-4aaa-8aaa-000000000004', 'reader-d', 'failed');
  const unreached = makeUnansweredSelectionTurn('21111111-1111-4111-8111-000000000005', 'baaaaaaa-aaaa-4aaa-8aaa-000000000005', 'reader-e', 'unreached');
  const nonChoice = makeScoreSelectionTurn('21111111-1111-4111-8111-000000000006', 'baaaaaaa-aaaa-4aaa-8aaa-000000000006', 'reader-f');
  const sourceRunId = '123e4567-e89b-42d3-a456-426614174000';
  const turns = [eligible, noFit, pending, failed, unreached, nonChoice];
  const followOn = followOnRunRequestSchema.parse({
    kind: 'follow-on', sourceRunId,
    selection: { references: turns.map(({ evaluationId, contextId }) => ({ evaluationId, contextId })) },
    context: { mode: 'fresh-material', includeSelectedMaterial: true },
    questions: [{ type: 'noul', id: 'expresses-quote', instructions: 'Does this express the pull quote?' }],
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1,
  });
  const source: FollowOnSourceSet = {
    sourceRunId, sourceStatus: 'partial', sourceComplete: false,
    version: { status: 'partial', usedCalls: 4, reservedCalls: 0, maxOrdinal: 5 }, turns,
  };
  const admission = await prepareFollowOnRun(followOn, source, makeProvider().provider);

  assert.equal(admission.inspection.valid, true);
  assert.deepEqual(admission.inspection.selectionCoverage, {
    matched: 6, eligible: 1,
    excluded: { pending: 1, failed: 1, unreached: 1, nonChoice: 1, unmappedChoice: 1 },
  });
  assert.deepEqual(admission.inspection.selectionExclusions?.map(({ sourceEvaluationId, status, reason }) => [sourceEvaluationId, status, reason]), [
    [noFit.evaluationId, 'answered', 'unmappedChoice'],
    [pending.evaluationId, 'pending', 'pending'],
    [failed.evaluationId, 'failed', 'failed'],
    [unreached.evaluationId, 'unreached', 'unreached'],
    [nonChoice.evaluationId, 'answered', 'nonChoice'],
  ]);
  assert.deepEqual(admission.prepared.lineage?.excludedSelections, admission.inspection.selectionExclusions);
});

test('distinct selected answers from one respondent do not share a material-specific follow-on context', async () => {
  const sourceTurns = [
    makeSelectionTurn('31111111-1111-4111-8111-000000000001', 'caaaaaaa-aaaa-4aaa-8aaa-000000000001', 'reader-a', 'p3'),
    makeSelectionTurn('31111111-1111-4111-8111-000000000002', 'caaaaaaa-aaaa-4aaa-8aaa-000000000001', 'reader-a', 'p7'),
  ];
  const followOn = followOnRunRequestSchema.parse({
    kind: 'follow-on', sourceRunId: '123e4567-e89b-42d3-a456-426614174000',
    selection: { references: sourceTurns.map(({ evaluationId, contextId }) => ({ evaluationId, contextId })) },
    context: { mode: 'fresh-material', includeSelectedMaterial: true, materialIds: ['pull-quote'] },
    questions: [
      { type: 'noul', id: 'clear', instructions: 'Is it clear?' },
      { type: 'score', id: 'fit', instructions: 'How well does it fit?', rubric: ['Poor', 'Good'] },
    ],
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 2,
  });
  const source: FollowOnSourceSet = {
    sourceRunId: followOn.sourceRunId, sourceStatus: 'completed', sourceComplete: true,
    version: { status: 'completed', usedCalls: 2, reservedCalls: 0, maxOrdinal: 1 }, turns: sourceTurns,
  };
  const admission = await prepareFollowOnRun(followOn, source, makeProvider().provider);

  assert.equal(admission.inspection.respondentCount, 2);
  assert.equal(admission.prepared.evaluations.length, 4);
  const [p3Context, p7Context] = [...new Set(admission.prepared.evaluations.map(({ contextId }) => contextId))];
  assert.ok(p3Context && p7Context && p3Context !== p7Context);
  assert.deepEqual(admission.prepared.evaluations.filter(({ contextId }) => contextId === p3Context).map(({ packet }) => packet.state.encounteredItems), [2, 2].map(() => [pullQuote, paragraph3].map(({ id, text }) => ({ id, text }))));
  assert.deepEqual(admission.prepared.evaluations.filter(({ contextId }) => contextId === p7Context).map(({ packet }) => packet.state.encounteredItems), [2, 2].map(() => [pullQuote, paragraph7].map(({ id, text }) => ({ id, text }))));
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

test('journey admission measures initial contexts and reports reached-turn fit checks without inference', async () => {
  const fixture = makeProvider();
  const result = await prepareRun(journeyRequest(), fixture.provider);
  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.respondentCount, 1);
  assert.equal(result.inspection.minimumCalls, 1);
  assert.equal(result.inspection.maximumCalls, 2);
  assert.equal(result.inspection.warnings?.some(({ code }) => code === 'call_limit_may_stop_journey'), true);
  assert.equal(result.inspection.fits.length, 1);
  assert.equal(fixture.measured.length, 1);
  assert.deepEqual(fixture.measured.map(({ question }) => question.id), ['continue']);
  assert.deepEqual(fixture.measured[0]!.state.encounteredItems, []);
  assert.equal(result.inspection.warnings?.some(({ code }) => code === 'reached_turn_fit_check'), true);
  assert.equal(fixture.decisions, 0);
});

test('journey admission rejects a terminal entry that cannot materialize an initial ask', async () => {
  const base = journeyRequest();
  const input = {
    ...base,
    journey: {
      ...base.journey,
      presentation: {
        kind: 'graph',
        entryNodeId: 'finished',
        maxDecisions: 1,
        nodes: [{ id: 'finished', kind: 'terminal', outcome: 'complete' }],
        transitions: [],
      },
    },
  };
  const fixture = makeProvider();
  const result = await prepareRun(input, fixture.provider);

  assert.equal(result.inspection.valid, false);
  assert.equal(result.inspection.problems.some(({ code }) => code === 'invalid_journey'), true);
  assert.equal(result.journey, undefined);
  assert.equal(fixture.measured.length, 0);
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
  assert.deepEqual(fixture.measured.map(({ question }) => question.id), ['continue']);
  assert.equal(result.inspection.fits.length, 1);
  assert.equal(fixture.decisions, 0);
});

test('a large adaptive sequence admits each initial packet and reserves reached-turn fit checks for dispatch', async () => {
  const base = journeyRequest(48, 2);
  const respondents = Array.from({ length: 4 }, (_, index) => ({ ...base.respondents[0]!, id: `reader-${index + 1}`, ...(index >= 2 ? { context: 'Returning reader' } : {}) }));
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    id: `question-${index + 1}`,
    type: 'choice' as const,
    instructions: `Question ${index + 1}?`,
    options: { yes: 'Yes', no: 'No' },
  }));
  const input = {
    ...base,
    respondents,
    maxCalls: respondents.length * tasks.length,
    journey: { ...base.journey, tasks, presentation: { kind: 'sequence' as const } },
  };
  const fixture = makeProvider();
  const result = await prepareRun(input, fixture.provider);

  assert.equal(result.inspection.valid, true);
  assert.equal(result.inspection.minimumCalls, 48);
  assert.equal(result.inspection.maximumCalls, 48);
  assert.equal(fixture.measured.length, 2);
  assert.deepEqual(fixture.measured.map(({ question }) => question.id), ['question-1', 'question-1']);
  assert.equal(result.journey?.packets.length, respondents.length);
  assert.equal(result.inspection.fits.length, respondents.length);
  assert.equal(result.inspection.warnings?.some(({ code }) => code === 'reached_turn_fit_check'), true);
  assert.equal(fixture.decisions, 0);
});

test('journey admission rejects an unfit initial packet and a cap below every possible minimum path', async () => {
  const overflowFixture = makeProvider(['overflow']);
  const overflow = await prepareRun(journeyRequest(), overflowFixture.provider);
  assert.equal(overflow.inspection.valid, false);
  assert.equal(overflow.inspection.problems.some(({ code }) => code === 'context_overflow'), true);
  assert.equal(overflow.inspection.warnings?.some(({ code, message }) => code === 'reached_turn_fit_check' && /initial packets passed/i.test(message)), false);
  assert.equal(overflow.inspection.warnings?.some(({ code }) => code === 'reached_turn_fit_check'), true);
  assert.equal(overflowFixture.decisions, 0);

  const lowCap = await prepareRun(journeyRequest(1, 2), makeProvider().provider);
  assert.equal(lowCap.inspection.valid, false);
  assert.equal(lowCap.inspection.problems.some(({ code }) => code === 'insufficient_call_limit'), true);
});
