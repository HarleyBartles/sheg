import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRun } from '../src/application/run-inspection.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import type { DecisionRequest, DecisionResult } from '../src/domain/decision/decision.js';
import type { InlineRunRequest } from '../src/domain/run/request.js';

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
