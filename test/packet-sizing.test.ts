import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest } from '../src/domain/decision/decision.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import type { RespondentPerspective } from '../src/domain/respondents/profile.js';
import { measurePacketBatch, type PacketSizingInput } from '../src/application/packet-sizing.js';

const tokenizerJsonPath = fileURLToPath(new URL('./fixtures/laya-tokenizer.json', import.meta.url));
const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerJsonPath)).digest('hex');
const jev = {
  kind: 'jev' as const,
  model: 'typesafe/jev-1.13',
  keyEnv: 'SHEG_PACKET_SIZING_TEST_KEY_UNSET',
  endpoint: 'https://example.invalid/api/decisions',
  timeoutMs: 1_000,
};
const laya = {
  kind: 'laya' as const,
  baseUrl: 'http://127.0.0.1:8787',
  checkpoint: 'laya-packet-sizing-test',
  contextLimit: 1_024,
  headLimit: 192,
  tokenizerJsonPath,
  tokenizerSha256,
  timeoutMs: 1_000,
};

const profile = (intent: string, context = 'Reading a short research passage.') : RespondentPerspective => ({
  intent,
  context,
  desired_outcome: 'Understand the main point.',
  engagement_cues: 'Clear examples.',
  friction_cues: 'Unexplained jargon.',
});

const task = (id: string, instructions: string) => ({
  type: 'choice' as const,
  id,
  instructions,
  options: { continue: 'Continue', stop: 'Stop' },
});

const emptyTrajectory = {
  version: 1 as const,
  eventCount: 0,
  exposureCount: 0,
  decisionCount: 0,
  eventRange: null,
  choices: [],
  payloadUtf8Bytes: 0,
};

function input(overrides: Partial<PacketSizingInput> = {}): PacketSizingInput {
  return {
    providers: [jev],
    combination: 'paired',
    respondents: [{ id: 'reader-a', value: profile('Read for practical advice.') }],
    stimuli: [{ id: 'opening', value: [{ id: 'opening', text: 'A short opening passage.' }] }],
    tasks: [{ id: 'task-a', value: task('question-a', 'What should happen next?') }],
    trajectories: [{ id: 'start', value: emptyTrajectory }],
    ...overrides,
  };
}

function fit(provider: 'jev' | 'laya', modelIdentity: string, tokens: number, status: ProviderContextFit['status'] = 'fits'): ProviderContextFit {
  const contextLimit = 100;
  return {
    provider,
    status,
    method: `test-${provider}-measurement`,
    modelIdentity,
    tokenCount: provider === 'jev' ? 'estimated' : 'measured',
    tokens,
    contextLimit,
    headroomTokens: 0,
    effectiveLimit: contextLimit,
    details: {},
    ...(status === 'overflow' ? { reason: 'test-overflow' } : {}),
  };
}

function providerFactory(measure: (request: DecisionRequest, config: PacketSizingInput['providers'][number]) => ProviderContextFit, counters = { measure: 0, decide: 0 }) {
  return {
    counters,
    createProvider: (config: PacketSizingInput['providers'][number]): DecisionProvider => ({
      measure(request) {
        counters.measure += 1;
        return measure(request, config);
      },
      async decide() {
        counters.decide += 1;
        throw new Error('packet sizing must never run inference');
      },
    }),
  };
}

test('measures 30 task variants deterministically and identifies the provider largest case', async () => {
  const tasks = Array.from({ length: 30 }, (_, index) => ({ id: `task-${index + 1}`, value: task(`question-${index + 1}`, `Question ${index + 1}: ${'x'.repeat(index)}`) }));
  const factory = providerFactory((request, config) => fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, request.question.instructions.length));
  const request = input({ tasks });
  const first = await measurePacketBatch(request, { createProvider: factory.createProvider });
  const second = await measurePacketBatch(request, { createProvider: factory.createProvider });

  assert.equal(first.caseCount, 30);
  assert.deepEqual(first.cases.map((item) => item.caseId), second.cases.map((item) => item.caseId));
  assert.equal(new Set(first.cases.map((item) => item.caseId)).size, 30);
  assert.equal(first.providers[0]?.largestCase?.tokens, Math.max(...first.cases.map((item) => item.measurements[0]!.tokens!)));
  assert.equal(first.providers[0]?.largestCase?.caseId, first.cases.at(-1)?.caseId);
});

test('measures every respondent variant against one task in paired mode', async () => {
  const respondents = Array.from({ length: 30 }, (_, index) => ({ id: `reader-${index + 1}`, value: profile(`Perspective ${index + 1}`) }));
  const factory = providerFactory((request, config) => {
    const modelIdentity = config.kind === 'jev' ? config.model : config.checkpoint;
    return fit(config.kind, modelIdentity, request.state.respondent && typeof request.state.respondent === 'object'
      ? String((request.state.respondent as { profile: { intent: string } }).profile.intent).length
      : 0);
  });
  const result = await measurePacketBatch(input({ respondents }), { createProvider: factory.createProvider });

  assert.equal(result.caseCount, 30);
  assert.deepEqual(result.cases.map((item) => item.variantIds.respondent), respondents.map(({ id }) => id));
  assert.deepEqual(result.cases.map((item) => item.measurements[0]!.tokens), respondents.map(({ value }) => value.intent.length));
});

test('paired mode joins same-index variants and rejects unequal lengths before measuring', async () => {
  const respondents = [
    { id: 'reader-one', value: profile('First distinct perspective') },
    { id: 'reader-two', value: profile('Second distinct perspective') },
  ];
  const tasks = [
    { id: 'question-one', value: task('ask-one', 'First distinct question?') },
    { id: 'question-two', value: task('ask-two', 'Second distinct question?') },
  ];
  const factory = providerFactory((request, config) => fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, 10));
  const result = await measurePacketBatch(input({ respondents, tasks }), { createProvider: factory.createProvider });

  assert.deepEqual(result.cases.map(({ variantIds }) => [variantIds.respondent, variantIds.task]), [
    ['reader-one', 'question-one'],
    ['reader-two', 'question-two'],
  ]);

  const mismatchCounters = { measure: 0, decide: 0 };
  const mismatchFactory = providerFactory((_request, config) => fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, 1), mismatchCounters);
  await assert.rejects(measurePacketBatch(input({
    respondents: [...respondents, { id: 'reader-three', value: profile('Third perspective') }],
    tasks,
  }), { createProvider: mismatchFactory.createProvider }), /paired.*same length|same length.*paired/i);
  assert.equal(mismatchCounters.measure, 0);
});

test('paired mode broadcasts singleton dimensions and Cartesian mode expands all combinations in input order', async () => {
  const respondents = [
    { id: 'reader-one', value: profile('First perspective') },
    { id: 'reader-two', value: profile('Second perspective') },
  ];
  const singleRespondent = [respondents[0]!];
  const tasks = [1, 2, 3].map((index) => ({ id: `task-${index}`, value: task(`question-${index}`, `Question ${index}?`) }));
  const factory = providerFactory((_request, config) => fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, 10));
  const paired = await measurePacketBatch(input({ tasks, respondents: singleRespondent }), { createProvider: factory.createProvider });
  assert.deepEqual(paired.cases.map(({ variantIds }) => [variantIds.respondent, variantIds.task]), [
    ['reader-one', 'task-1'], ['reader-one', 'task-2'], ['reader-one', 'task-3'],
  ]);

  const cartesian = await measurePacketBatch(input({ combination: 'cartesian', respondents, tasks }), { createProvider: factory.createProvider });
  assert.equal(cartesian.caseCount, 6);
  assert.deepEqual(cartesian.cases.map(({ variantIds }) => [variantIds.respondent, variantIds.task]), [
    ['reader-one', 'task-1'], ['reader-one', 'task-2'], ['reader-one', 'task-3'],
    ['reader-two', 'task-1'], ['reader-two', 'task-2'], ['reader-two', 'task-3'],
  ]);
});

test('projects a validated study task to the inference question without answer-key metadata', async () => {
  const observed: DecisionRequest[] = [];
  const factory = providerFactory((request, config) => {
    observed.push(request);
    return fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, 10);
  });
  const selectedTask = {
    ...task('question-with-key', 'Which choice fits?'),
    comparisonKey: 'matched-question',
    answerKeyOptionId: 'continue',
  };
  await measurePacketBatch(input({ tasks: [{ id: 'draft-with-key', value: selectedTask }] }), { createProvider: factory.createProvider });

  assert.deepEqual(observed[0]?.question, {
    type: 'choice',
    id: selectedTask.id,
    instructions: selectedTask.instructions,
    options: selectedTask.options,
  });
  assert.equal(JSON.stringify(observed[0]).includes('answerKeyOptionId'), false);
  assert.equal(JSON.stringify(observed[0]).includes('matched-question'), false);
});

test('preserves each supplied trajectory history and measures provider-specific maxima deterministically', async () => {
  const trajectories = [
    { id: 'history-a', value: { ...emptyTrajectory, eventCount: 1, decisionCount: 1, eventRange: { firstSequence: 0, lastSequence: 0 }, choices: [{ taskId: 'prior', choiceId: 'left', choiceMeaning: 'Choose left', exposedItemIds: ['opening'] }] } },
    { id: 'history-b', value: { ...emptyTrajectory, eventCount: 1, decisionCount: 1, eventRange: { firstSequence: 0, lastSequence: 0 }, choices: [{ taskId: 'prior', choiceId: 'right', choiceMeaning: 'Choose right', exposedItemIds: ['aside'] }] } },
  ];
  const providers = [jev, laya];
  const observedRequests: DecisionRequest[] = [];
  const factory = providerFactory((request, config) => {
    observedRequests.push(request);
    const history = request.state.trajectory as { choices: Array<{ choiceId: string }> };
    const tokens = config.kind === 'jev' ? (history.choices[0]?.choiceId === 'left' ? 30 : 20) : 40;
    return fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, tokens);
  });
  const result = await measurePacketBatch(input({ providers, trajectories }), { createProvider: factory.createProvider });

  assert.deepEqual(result.cases.map((item) => item.variantIds.trajectory), ['history-a', 'history-b']);
  assert.deepEqual([observedRequests[0], observedRequests[2]].map((request) => (request!.state.trajectory as { choices: Array<{ choiceId: string }> }).choices[0]?.choiceId), ['left', 'right']);
  assert.equal(result.providers[0]?.largestCase?.tokens, 30);
  assert.equal(result.providers[1]?.largestCase?.tokens, 40);
  const allEqualFactory = providerFactory((_request, config) => fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, 50));
  const tied = await measurePacketBatch(input({ providers: [jev], trajectories }), { createProvider: allEqualFactory.createProvider });
  assert.equal(tied.providers[0]?.largestCase?.caseId, [...tied.cases.map(({ caseId }) => caseId)].sort()[0]);
});

test('accepts typed response history for packet measurement and counts it as a decision', async () => {
  const trajectory = { ...emptyTrajectory, eventCount: 1, decisionCount: 1, eventRange: { firstSequence: 0, lastSequence: 0 }, responses: [{ type: 'score' as const, taskId: 'prior-score', score: 1.5, meaning: 'balanced', probabilities: { '0': 0.5, '1': 0.5 }, legend: { '0': 'low', '1': 'high' }, exposedItemIds: ['opening'] }] };
  const factory = providerFactory((_request, config) => fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, 12));
  const result = await measurePacketBatch(input({ trajectories: [{ id: 'typed-history', value: trajectory }] }), { createProvider: factory.createProvider });
  assert.equal(result.cases.length, 1);
});

test('rejects case and serialized packet bounds before invoking provider measurement', async () => {
  const counters = { measure: 0, decide: 0 };
  const factory = providerFactory((_request, config) => fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, 1), counters);
  const tooManyTasks = Array.from({ length: 1_001 }, (_, index) => ({ id: `task-${index + 1}`, value: task(`question-${index + 1}`, 'Question?') }));
  await assert.rejects(measurePacketBatch(input({ tasks: tooManyTasks }), { createProvider: factory.createProvider }), /1,000|1000/);
  assert.equal(counters.measure, 0);

  await assert.rejects(measurePacketBatch(input({ tasks: [{ id: 'large', value: task('large-question', 'x'.repeat(17 * 1024 * 1024)) }] }), { createProvider: factory.createProvider }), /16 MiB|serialized.*limit|byte limit/i);
  assert.equal(counters.measure, 0);
});

test('keeps provider fit separate from configuration and never turns unavailable measurements into fit claims', async () => {
  delete process.env[jev.keyEnv];
  const factory = providerFactory((request, config) => {
    const identity = config.kind === 'jev' ? config.model : config.checkpoint;
    return config.kind === 'jev'
      ? { ...fit(config.kind, identity, 42), status: 'unavailable', reason: 'model-context-unknown' }
      : fit(config.kind, identity, 42);
  });
  const result = await measurePacketBatch(input(), { createProvider: factory.createProvider });
  const summary = result.providers[0]!;
  const measurement = result.cases[0]!.measurements[0]!;

  assert.equal(summary.configuration, 'incomplete');
  assert.equal(summary.status, 'unavailable');
  assert.equal(summary.largestCase, null);
  assert.equal(measurement.status, 'unavailable');
  assert.equal(measurement.tokens, null);
  assert.equal(measurement.headroomTokens, null);
});

test('reports positive arithmetic headroom without overriding a provider truncation failure', async () => {
  const layaRequest = input({
    providers: [laya],
    tasks: [{ id: 'long-option', value: { ...task('long-option', 'What should happen?'), options: { continue: 'x'.repeat(60), stop: 'Stop' } } }],
  });
  const result = await measurePacketBatch(layaRequest);
  const measurement = result.cases[0]!.measurements[0]!;

  assert.equal(measurement.status, 'overflow');
  assert.equal(measurement.reason, 'option-would-be-truncated');
  assert.ok(measurement.headroomTokens! > 0);
});

test('uses Jev measurement offline without requiring credentials or invoking fetch', async () => {
  delete process.env[jev.keyEnv];
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected network access');
  };
  let result: Awaited<ReturnType<typeof measurePacketBatch>> | undefined;
  try {
    result = await measurePacketBatch(input());
  } finally {
    globalThis.fetch = originalFetch;
  }
  const summary = result!.providers[0]!;
  const measurement = result!.cases[0]!.measurements[0]!;
  assert.equal(summary.configuration, 'incomplete');
  assert.equal(measurement.status, 'fits');
  assert.equal(measurement.tokenCount, 'estimated');
  assert.equal(measurement.headroomTokens, measurement.effectiveLimit! - measurement.tokens!);
  assert.equal(fetchCalls, 0);
});

test('uses measurement only and never invokes decision or network paths', async () => {
  const counters = { measure: 0, decide: 0 };
  const factory = providerFactory((_request, config) => fit(config.kind, config.kind === 'jev' ? config.model : config.checkpoint, 12), counters);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected network access');
  };
  try {
    await measurePacketBatch(input(), { createProvider: factory.createProvider });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(counters.measure, 1);
  assert.equal(counters.decide, 0);
  assert.equal(fetchCalls, 0);
});
