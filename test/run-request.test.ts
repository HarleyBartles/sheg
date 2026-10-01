import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineRunRequestSchema, runRequestSchema, type InlineRunRequest } from '../src/domain/run/request.js';

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

test('the direct request accepts one typed question and preserves exact authored material', () => {
  const input = validRequest();
  const parsed = inlineRunRequestSchema.parse(input);

  assert.equal(parsed.material[0]!.text, input.material[0]!.text);
  assert.deepEqual(parsed.questions, [question]);
  assert.equal(parsed.respondents[0]!.id, 'reader-a');
});

test('the direct request rejects missing, multiple, duplicate-identity and extra fields', () => {
  const input = validRequest();
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, questions: [] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, questions: [question, { ...question, id: 'second' }] }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, respondents: [profile('reader-a', 'First'), profile('reader-a', 'Second')], maxCalls: 2 }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, material: [{ id: 'section-three', text: 'text' }, { id: 'section-three', text: 'text' }], maxCalls: 1 }).success, false);
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, rationale: 'chosen because they left' }).success, false);
});

test('the direct request requires enough physical call allowance for one answer per respondent', () => {
  const input = validRequest();
  assert.equal(inlineRunRequestSchema.safeParse({ ...input, respondents: [profile('a', 'First'), profile('b', 'Second')], maxCalls: 1 }).success, false);
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
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.kind, 'journey');
    assert.equal(parsed.data.journey.presentation.kind, 'graph');
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
