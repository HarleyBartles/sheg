import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceCriteriaSchema, followOnRunRequestSchema, inlineRunRequestSchema, runEvidencePageSchema, runEvidenceQuerySchema, runListQuerySchema, runRequestSchema, type InlineRunRequest } from '../src/domain/run/request.js';

function profile(id: string, intent: string) {
  return {
    id,
    intent,
    context: 'Reading a product page',
    desired_outcome: 'Decide whether it is useful',
    engagement_cues: 'Specific examples',
    friction_cues: 'Unexplained claims',
  };
}

const question = {
  type: 'choice' as const,
  id: 'interest',
  instructions: 'Would you keep reading?',
  options: { continue: 'Continue reading', leave: 'Stop reading' },
};

function validRequest(): InlineRunRequest {
  return {
    kind: 'poll',
    respondents: [profile('reader-a', 'Find a practical solution')],
    material: [{ id: 'section-three', text: '  Exact authored text, including spacing.  ' }],
    questions: [question],
    provider: {
      kind: 'laya',
      baseUrl: 'http://127.0.0.1:7071',
      checkpoint: 'test-model',
      contextLimit: 4096,
      headLimit: 2048,
      tokenizerJsonPath: 'tokenizer.json',
      tokenizerSha256: 'a'.repeat(64),
      timeoutMs: 1000,
    },
    maxCalls: 1,
  };
}

test('the direct request accepts one or more typed questions and preserves exact authored material', () => {
  const input = validRequest();
  const parsed = inlineRunRequestSchema.parse(input);

  assert.equal(parsed.material[0]!.text, input.material[0]!.text);
  assert.deepEqual(parsed.questions, [question]);
  assert.equal(parsed.respondents[0]!.id, 'reader-a');

  const grouped = inlineRunRequestSchema.parse({ ...input, questions: [
    question,
    { type: 'score', id: 'clarity', instructions: 'How clear was the section?', rubric: ['Unclear', 'Clear'] },
    { type: 'noul', id: 'trust', instructions: 'How credible was the section?' },
  ] });
  assert.deepEqual(grouped.questions.map(({ id }) => id), ['interest', 'clarity', 'trust']);
});

test('the direct request rejects empty or duplicate question sets, duplicate identities and extra fields', () => {
  const input = validRequest();
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, questions: [] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, questions: [question, { ...question }] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, respondents: [profile('reader-a', 'First'), profile('reader-a', 'Second')], maxCalls: 2 }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, material: [{ id: 'section-three', text: 'text' }, { id: 'section-three', text: 'text' }], maxCalls: 1 }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, rationale: 'chosen because they left' }).success, false);
});

test('the direct request preserves exact source-linked Choice candidates and permits an unlinked no-fit option', () => {
  const candidate = { id: 'section-three', text: '  Exact authored text.  ', sourceId: 'article-v1', sourceSha256: 'a'.repeat(64) };
  const linkedQuestion = { ...question, options: { sectionThree: candidate.text, noFit: 'Neither candidate' }, materialOptions: { sectionThree: candidate.id } };
  const parsed = inlineRunRequestSchema.safeParse({ ...validRequest(), material: [candidate], questions: [linkedQuestion] });
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  if (parsed.success) {
    assert.deepEqual(parsed.data.material[0], candidate);
    assert.deepEqual(parsed.data.questions[0], linkedQuestion);
  }
});

test('the direct request rejects malformed provenance, missing or duplicate material links, and non-exact labels', () => {
  const candidate = { id: 'section-three', text: 'Exact authored text.', sourceId: 'article-v1', sourceSha256: 'a'.repeat(64) };
  const linked = { ...question, options: { candidate: candidate.text, noFit: 'No fit' }, materialOptions: { candidate: candidate.id } };
  const base = { ...validRequest(), material: [candidate], questions: [linked] };
  assert.equal(inlineRunRequestSchema.safeParse({ ...base, material: [{ ...candidate, sourceSha256: 'not-a-digest' }] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...base, material: [{ ...candidate, sourceId: undefined }] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...base, questions: [{ ...linked, materialOptions: { candidate: 'missing' } }] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...base, questions: [{ ...linked, materialOptions: { candidate: candidate.id, noFit: candidate.id } }] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...base, questions: [{ ...linked, options: { ...linked.options, candidate: 'Edited text' } }] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...base, questions: [{ ...linked, materialOptions: { notOffered: candidate.id } }] }).success, false);
});

test('the request schema leaves provider-aware physical call admission to inspection', () => {
  const input = validRequest();
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, respondents: [profile('a', 'First'), profile('b', 'Second')], maxCalls: 1 }).success, true);
});

test('a direct journey request accepts inline typed route definitions without study files', () => {
  const input = {
    kind: 'journey',
    respondents: [profile('reader-a', 'First')],
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
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' },
    maxCalls: 1,
  };
  const parsed = runRequestSchema.safeParse(input);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  if (parsed.success) {
    assert.equal(parsed.data.kind, 'journey');
    assert.equal(parsed.data.journey.presentation.kind, 'graph');
  }
});

test('a journey can link a Choice option to an exact candidate that is not exposed on its current path', () => {
  const input = {
    kind: 'journey', respondents: [profile('reader-a', 'First')],
    journey: {
      id: 'article', label: 'Article journey',
      items: [
        { id: 'opening', text: '  Exact opening.  ', sourceId: 'article-v1', sourceSha256: 'a'.repeat(64) },
        { id: 'later', text: 'Later candidate.', sourceId: 'article-v1', sourceSha256: 'a'.repeat(64) },
      ],
      tasks: [{ id: 'pick', type: 'choice', instructions: 'Which section?', options: { opening: '  Exact opening.  ', later: 'Later candidate.', 'no-fit': 'Neither' }, materialOptions: { opening: 'opening', later: 'later' } }],
      presentation: { kind: 'graph', entryNodeId: 'ask', maxDecisions: 1, nodes: [
        { id: 'ask', kind: 'ask', taskId: 'pick' }, { id: 'done', kind: 'terminal', outcome: 'complete' },
      ], transitions: [
        { fromNodeId: 'ask', optionId: 'opening', toNodeId: 'done' },
        { fromNodeId: 'ask', optionId: 'later', toNodeId: 'done' },
        { fromNodeId: 'ask', optionId: 'no-fit', toNodeId: 'done' },
      ] },
    },
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1,
  };
  const parsed = runRequestSchema.safeParse(input);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  if (parsed.success && parsed.data.kind === 'journey') {
    assert.equal(parsed.data.journey.items[0]!.text, '  Exact opening.  ');
    const firstTask = parsed.data.journey.tasks[0]!;
    assert.deepEqual('materialOptions' in firstTask ? firstTask.materialOptions : undefined, { opening: 'opening', later: 'later' });
  }
});

test('journey request rejects invalid routes and nonpositive physical call limits', () => {
  const input = {
    kind: 'journey', respondents: [profile('reader-a', 'First')],
    journey: { id: 'article', label: 'Article journey', items: [{ id: 'section-one', text: 'Opening.' }],
      tasks: [{ id: 'continue', type: 'choice', instructions: 'Continue?', options: { continue: 'Continue', leave: 'Leave' } }],
      presentation: { kind: 'graph', entryNodeId: 'entry', maxDecisions: 1, nodes: [
        { id: 'entry', kind: 'ask', taskId: 'continue' }, { id: 'finished', kind: 'terminal', outcome: 'complete' },
      ], transitions: [{ fromNodeId: 'entry', optionId: 'continue', toNodeId: 'finished' }] } },
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1,
  };
  assert.equal(runRequestSchema.safeParse(input).success, false);
  const validRoutes = { ...input, journey: { ...input.journey, presentation: { ...input.journey.presentation, transitions: [
    { fromNodeId: 'entry', optionId: 'continue', toNodeId: 'finished' },
    { fromNodeId: 'entry', optionId: 'leave', toNodeId: 'finished' },
  ] } } };
  assert.equal(runRequestSchema.safeParse({ ...validRoutes, maxCalls: 0 }).success, false);
  assert.equal(runRequestSchema.safeParse({ ...validRoutes, respondents: [profile('reader-a', 'First'), profile('reader-a', 'Duplicate')] }).success, false);
  assert.equal(runRequestSchema.safeParse({ ...validRoutes, journey: { ...validRoutes.journey, extra: true } }).success, false);
});

test('provider inputs normalize Jev defaults and preserve accepted Laya configuration', () => {
  const input = validRequest();
  const jev = inlineRunRequestSchema.parse({ ...input, provider: { kind: 'jev' } });
  assert.deepEqual(jev.provider, {
    kind: 'jev',
    route: 'openrouter',
    model: 'typesafe/jev-1.13',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    timeoutMs: 30_000,
  });
  const laya = inlineRunRequestSchema.parse({ ...input, provider: { ...input.provider, precision: '' } });
  assert.equal(laya.provider.kind, 'laya');
});

test('evidence criteria combine typed response, question, material, respondent, and route facts', () => {
  const parsed = evidenceCriteriaSchema.parse({
    respondentId: 'reader-a', status: 'answered', questionId: 'lost-interest', materialId: 'section-three',
    answer: { type: 'choice', choiceId: 'yes' }, outcome: 'left-lost-interest',
  });
  assert.equal(parsed.answer?.type, 'choice');
  assert.equal(evidenceCriteriaSchema.safeParse({ answer: { type: 'score', operator: 'gte', value: 4 } }).success, true);
  assert.equal(evidenceCriteriaSchema.safeParse({ answer: { type: 'noul', operator: 'lt', value: 0.4 } }).success, true);
  assert.equal(evidenceCriteriaSchema.safeParse({ answer: { type: 'choice', operator: 'gte', value: 4 } }).success, false);
  assert.equal(evidenceCriteriaSchema.safeParse({ answer: { type: 'score', operator: 'eq', value: Number.NaN } }).success, false);
  assert.equal(evidenceCriteriaSchema.safeParse({ departure: 'lost-interest' }).success, false);
});

test('follow-on requests select criteria or exact evaluation/context references and declare context intent', () => {
  const base = {
    kind: 'follow-on', sourceRunId: '123e4567-e89b-42d3-a456-426614174000',
    questions: [{ ...question, id: 'what-lost-interest' }, { type: 'score', id: 'severity', instructions: 'How strongly?', rubric: ['Low', 'High'] }],
    provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1,
  };
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { criteria: { questionId: 'lost-interest', answer: { type: 'choice', choiceId: 'yes' } } }, context: { mode: 'recorded' } }).success, true);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { references: [{ evaluationId: '123e4567-e89b-42d3-a456-426614174001', contextId: '123e4567-e89b-42d3-a456-426614174002' }] }, context: { mode: 'fresh-material' }, material: [{ id: 'section-three', text: 'Exact text.' }] }).success, true);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { criteria: {} }, context: { mode: 'omit-history', materialIds: ['section-three'] } }).success, true);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { criteria: {} }, context: { mode: 'omit-history' } }).success, false);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { criteria: {} }, context: { mode: 'recorded' }, material: [{ id: 'changed', text: 'Not recorded.' }] }).success, false);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { criteria: {} }, context: { mode: 'fresh-material', materialIds: ['section-three'] }, material: [{ id: 'section-three', text: 'Duplicate.' }] }).success, false);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { criteria: {} }, context: { mode: 'recorded' } }).success, true);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { references: [{ evaluationId: '123e4567-e89b-42d3-a456-426614174001', contextId: '123e4567-e89b-42d3-a456-426614174002' }, { evaluationId: '123e4567-e89b-42d3-a456-426614174003', contextId: '123e4567-e89b-42d3-a456-426614174002' }] }, context: { mode: 'recorded' } }).success, true);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, questions: [], selection: { criteria: {} }, context: { mode: 'recorded' } }).success, false);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, questions: [base.questions[0], { ...base.questions[0], id: 'what-lost-interest' }], selection: { criteria: {} }, context: { mode: 'recorded' } }).success, false);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { references: [] }, context: { mode: 'recorded' } }).success, false);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { criteria: {} }, context: { mode: 'fresh-material' } }).success, false);
  assert.equal(followOnRunRequestSchema.safeParse({ ...base, selection: { criteria: {} }, context: { mode: 'recorded' }, rationale: 'They lost interest.' }).success, false);
});

test('evidence page reports query-page exhaustion separately from source completion', () => {
  const page = {
    items: [], totalMatches: 12, sourceRunId: '123e4567-e89b-42d3-a456-426614174000', sourceStatus: 'running', sourceComplete: false,
    coverage: { totalEvaluations: 80, completedEvaluations: 12, failedEvaluations: 0, respondents: { total: 80, active: 68, completed: 12, failed: 0, unreached: 0 } },
    nextCursor: 'cursor-token',
  };
  assert.equal(runEvidencePageSchema.parse(page).sourceComplete, false);
  assert.equal(runEvidencePageSchema.safeParse({ ...page, sourceComplete: true, nextCursor: undefined }).success, true);
  assert.deepEqual(runEvidenceQuerySchema.parse({ sourceRunId: page.sourceRunId }), { sourceRunId: page.sourceRunId, criteria: {} });
  assert.equal(runEvidenceQuerySchema.safeParse({ sourceRunId: 'not-a-run', criteria: {}, limit: 201 }).success, false);
});

test('run discovery validates time and material criteria alongside status and label', () => {
  assert.equal(runListQuerySchema.safeParse({ createdAfter: '2026-01-01T00:00:00.000Z', createdBefore: '2026-02-01T00:00:00.000Z', materialId: 'section-three', status: 'completed', label: 'pilot' }).success, true);
  assert.equal(runListQuerySchema.safeParse({ createdAfter: 'yesterday', createdBefore: '2026-01-01T00:00:00.000Z' }).success, false);
  assert.equal(runListQuerySchema.safeParse({ materialId: 'bad id' }).success, false);
});
