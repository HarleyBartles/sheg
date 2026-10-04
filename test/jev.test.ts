import assert from 'node:assert/strict';
import test from 'node:test';
import { JevCallError, JevProvider, measureJevBatchContext, measureJevContext, type JevConfig } from '../src/providers/jev.js';
import type { DecisionBatchRequest, DecisionRequest } from '../src/domain/decision/decision.js';
import { defaultJevConfig } from '../src/providers/jev/config.js';

const config: JevConfig = defaultJevConfig();
const testKeyEnv = 'SHEG_TEST_OPENROUTER_KEY';
const testCredentialStore = {
  availability: async () => 'available' as const,
  readForAuthentication: async () => 'secret-test-key',
};

function makeJevProvider(fetchRequest: typeof fetch): JevProvider {
  return new JevProvider(config, fetchRequest, { credentialStore: testCredentialStore });
}

const request: DecisionRequest = {
  state: { reader: { profile: 'Interested but time-limited.' }, encounteredItems: [] },
  question: {
    type: 'choice',
    id: 'entry-response',
    instructions: 'Would you continue reading?',
    options: { continue: 'Read the next section.', leave: 'Stop reading.' },
  },
  optionIds: ['continue', 'leave'],
};

function response(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    id: 'gen-dec-test',
    provider: 'TypeSafe',
    model: 'typesafe/jev-1.13-20260917',
    answers: {
      'entry-response': {
        type: 'choice',
        choice: 'continue',
        probabilities: { continue: 0.8, leave: 0.2 },
        confidence: 0.6,
      },
    },
    usage: { input_tokens: 120, output_tokens: 12, cost: 0.00000504 },
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function installTestKey(): () => void {
  const previous = process.env[testKeyEnv];
  process.env[testKeyEnv] = 'secret-test-key';
  return () => {
    if (previous === undefined) delete process.env[testKeyEnv];
    else process.env[testKeyEnv] = previous;
  };
}

test('estimates the exact request with fixed context reserve and refuses unknown model limits', async () => {
  const fit = measureJevContext(request, config.model);
  assert.equal(fit.status, 'fits');
  assert.equal(fit.tokenCount, 'estimated');
  assert.equal(fit.contextLimit, 32_768);
  assert.equal(fit.effectiveLimit, 26_214);
  assert.equal(measureJevContext(request, 'typesafe/jev-latest').status, 'unavailable');
  assert.equal(measureJevBatchContext({ state: request.state, questions: [request.question, { type: 'noul', id: 'trust', instructions: 'Credible?' }] }, config.model).status, 'fits');

  const oversized = { ...request, state: { text: 'x'.repeat(100_000) } };
  assert.equal(measureJevContext(oversized, config.model).status, 'overflow');
  const restore = installTestKey();
  let calls = 0;
  try {
    const provider = makeJevProvider( async () => { calls += 1; throw new Error('must not call'); });
    await assert.rejects(provider.decide(oversized, 1), /estimated-context-over-limit/);
    assert.equal(calls, 0);
  } finally { restore(); }
});

test('native TypeSafe admission applies the full-request estimate and reserve at its published boundary', async () => {
  const native = defaultJevConfig('typesafe');
  const emptyBody = JSON.stringify({
    model: native.model,
    state: { content: '' },
    questions: { [request.question.id]: { type: 'choice', instructions: request.question.instructions, criteria: request.question.options } },
  });
  const bytesAtEffectiveLimit = 25_600 * 3;
  const fill = (byteCount: number) => ({ content: 'x'.repeat(byteCount - Buffer.byteLength(emptyBody, 'utf8')) });
  const edge = measureJevContext({ ...request, state: fill(bytesAtEffectiveLimit) }, native.model, native.route);
  const over = measureJevContext({ ...request, state: fill(bytesAtEffectiveLimit + 1) }, native.model, native.route);

  assert.equal(edge.status, 'fits');
  assert.equal(edge.tokens, 25_600);
  assert.equal(edge.details.serializedUtf8Bytes, 76_800);
  assert.equal(over.status, 'overflow');
  assert.equal(over.tokens, 25_601);
  assert.equal(over.reason, 'estimated-context-over-limit');
  assert.equal(measureJevContext(request, 'unknown-native-model', native.route).status, 'unavailable');

  const longQuestions = ['first', 'second', 'third'].map((id) => ({
    type: 'choice' as const, id, instructions: 'q'.repeat(26_000), options: { yes: 'Yes', no: 'No' },
  }));
  assert.ok(longQuestions.every((question) => measureJevContext({ state: { content: 'shared state' }, question, optionIds: ['yes', 'no'] }, native.model, native.route).status === 'fits'));
  assert.equal(measureJevBatchContext({ state: { content: 'shared state' }, questions: longQuestions }, native.model, native.route).status, 'overflow');

  let credentialReads = 0;
  let requests = 0;
  const provider = new JevProvider(native, fakeFetch(async () => { requests += 1; return response(); }), {
    credentialStore: {
      availability: async () => 'available',
      readForAuthentication: async () => { credentialReads += 1; return 'never-read-for-overflow'; },
    },
  });
  await assert.rejects(provider.decide({ ...request, state: fill(bytesAtEffectiveLimit + 1) }, 1), (error: unknown) =>
    error instanceof JevCallError && error.attempts === 0 && error.contextFit?.status === 'overflow');
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
});

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

test('sends one typed choice and preserves the served model, distribution, usage, cost, and observed latency', async () => {
  const restoreKey = installTestKey();
  try {
    let captured: { url: string; init: RequestInit } | undefined;
    const provider = makeJevProvider( fakeFetch(async (url, init) => {
      captured = { url, init };
      return response();
    }));

    const result = await provider.decide(request, 1);

    assert.equal(captured?.url, config.endpoint);
    assert.equal(captured?.init.redirect, 'error');
    assert.equal((captured?.init.headers as Record<string, string>).Authorization, 'Bearer secret-test-key');
    const body = JSON.parse(String(captured?.init.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      model: config.model,
      state: request.state,
      questions: {
        'entry-response': {
          type: 'choice',
          instructions: request.question.instructions,
          criteria: request.question.options,
        },
      },
    });
    assert.equal(result.type, 'choice');
    if (result.type !== 'choice') return;
    assert.equal(result.choice, 'continue');
    assert.deepEqual(result.probabilities, { continue: 0.8, leave: 0.2 });
    assert.equal(result.confidence, 0.6);
    assert.equal(result.provider, 'jev');
    assert.equal(result.model, 'typesafe/jev-1.13-20260917');
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 12 });
    assert.deepEqual(result.cost, { amountUsd: 0.00000504, basis: 'provider-reported' });
    assert.ok(result.latencyMs >= 0);
  } finally {
    restoreKey();
  }
});

test('single Jev validation errors retain safe typed failure evidence', async () => {
  const restore = installTestKey();
  try {
    const provider = makeJevProvider(async () => response({ answers: {
      'entry-response': { type: 'choice', choice: 'private-unoffered-value', probabilities: { continue: 0.8, leave: 0.2 } },
    } }));
    await assert.rejects(provider.decide(request, 1), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : '', 'Jev response failed decision validation.');
      assert.deepEqual((error as { validationFailure?: unknown }).validationFailure, {
        code: 'invalid_answer', message: 'The selected option was not offered by this question.',
        detail: { reason: 'unknown_option', field: 'choice', constraint: 'offered_option' },
      });
      assert.equal(JSON.stringify(error).includes('private-unoffered-value'), false);
      return true;
    });
  } finally { restore(); }
});

test('Jev malformed single answers expose only the safe typed-shape failure reason', async () => {
  const restore = installTestKey();
  try {
    const provider = makeJevProvider(async () => response({ answers: { 'entry-response': { type: 'choice', choice: 'private-malformed-value' } } }));
    await assert.rejects(provider.decide(request, 1), (error: unknown) => {
      assert.deepEqual((error as { validationFailure?: unknown }).validationFailure, {
        code: 'invalid_answer', message: 'The answer does not match a supported typed-answer shape.',
        detail: { reason: 'malformed_answer', field: 'answer', constraint: 'typed_answer_shape' },
      });
      assert.equal(JSON.stringify(error).includes('private-malformed-value'), false);
      return true;
    });
  } finally { restore(); }
});

test('Jev receives linked candidate text as Choice options without Sheg material identifiers', async () => {
  const restoreKey = installTestKey();
  try {
    let body: Record<string, unknown> | undefined;
    const linkedRequest: DecisionRequest = { ...request, question: { ...request.question, materialOptions: { continue: 'section-three' } } };
    const provider = makeJevProvider(fakeFetch(async (_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return response();
    }));
    await provider.decide(linkedRequest, 1);
    const wireQuestions = body?.questions as Record<string, Record<string, unknown>>;
    assert.deepEqual(wireQuestions['entry-response'], { type: 'choice', instructions: request.question.instructions, criteria: request.question.options });
    assert.equal(JSON.stringify(body).includes('section-three'), false);
  } finally { restoreKey(); }
});

test('sends mixed independent questions in one Jev request with one shared execution record', async () => {
  const batch: DecisionBatchRequest = {
    state: request.state,
    questions: [
      request.question,
      { type: 'score', id: 'clarity', instructions: 'How clear?', rubric: ['unclear', 'clear'] },
      { type: 'noul', id: 'trust', instructions: 'Is it credible?' },
    ],
  };
  const restoreKey = installTestKey();
  try {
    let calls = 0;
    let body: Record<string, unknown> | undefined;
    const provider = makeJevProvider(fakeFetch(async (_url, init) => {
      calls += 1;
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return response({ answers: {
        'entry-response': { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, leave: 0.2 } },
        clarity: { type: 'score', score: 1, legend: { '0': 'unclear', '1': 'clear' }, probabilities: { '0': 0.2, '1': 0.8 } },
        trust: { type: 'noul', noul: 0.74 },
      } });
    }));

    const result = await provider.decideBatch(batch, 1);
    assert.equal(calls, 1);
    assert.deepEqual(body, {
      model: config.model, state: batch.state,
      questions: {
        'entry-response': { type: 'choice', instructions: request.question.instructions, criteria: request.question.options },
        clarity: { type: 'score', instructions: 'How clear?', criteria: ['unclear', 'clear'] },
        trust: { type: 'noul', instructions: 'Is it credible?' },
      },
    });
    assert.deepEqual(result.answers.map((answer) => [answer.questionId, 'value' in answer ? answer.value.type : answer.failure.code]), [
      ['entry-response', 'choice'], ['clarity', 'score'], ['trust', 'noul'],
    ]);
    assert.equal(result.execution.attempts, 1);
    assert.deepEqual(result.execution.usage, { inputTokens: 120, outputTokens: 12 });
    assert.deepEqual(result.execution.cost, { amountUsd: 0.00000504, basis: 'provider-reported' });
    assert.ok(result.answers.every((answer) => !('execution' in answer)));
  } finally { restoreKey(); }
});

test('batch Jev failures stay question-scoped except malformed envelopes and route-wide authorization', async () => {
  const batch: DecisionBatchRequest = {
    state: request.state,
    questions: [request.question, { type: 'noul', id: 'trust', instructions: 'Is it credible?' }],
  };
  const restoreKey = installTestKey();
  try {
    for (const [answers, expected] of [
      [{ 'entry-response': { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, leave: 0.2 } } }, 'missing_answer'],
      [{ 'entry-response': { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, leave: 0.2 } }, trust: { type: 'choice', choice: 'continue' } }, 'answer_type_mismatch'],
    ] as const) {
      const provider = makeJevProvider(fakeFetch(async () => response({ answers })));
      const result = await provider.decideBatch(batch, 1);
      assert.equal('value' in result.answers[0]!, true);
      assert.deepEqual(result.answers[1], { questionId: 'trust', failure: expected === 'missing_answer'
        ? { code: expected, message: 'The provider did not return an answer for this question.' }
        : { code: expected, message: 'The answer type does not match the question type.', detail: { reason: expected, field: 'type', constraint: 'match_question_type' } } });
      assert.equal(result.execution.attempts, 1);
    }
    const malformed = makeJevProvider(fakeFetch(async () => Response.json({ answers: {}, usage: {} })));
    await assert.rejects(malformed.decideBatch(batch, 1), (error: unknown) => error instanceof JevCallError && error.failureScope === 'evaluation');
    const unauthorized = makeJevProvider(fakeFetch(async () => new Response('credential rejected', { status: 401 })));
    await assert.rejects(unauthorized.decideBatch(batch, 1), (error: unknown) => error instanceof JevCallError && error.failureScope === 'run' && !error.message.includes('secret-test-key'));
  } finally { restoreKey(); }
});

test('encodes Score and Noul criteria and preserves their typed evidence', async () => {
  const restoreKey = installTestKey();
  try {
    const requests: Record<string, unknown>[] = [];
    const answers = [
      { type: 'score', score: 1.25, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' }, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 } },
      { type: 'noul', noul: 0.74 },
    ];
    const provider = makeJevProvider( fakeFetch(async (_url, init) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const answer = answers[requests.length - 1]!;
      return response({ answers: { 'typed-question': answer } });
    }));
    const scoreRequest = { state: request.state, question: { type: 'score' as const, id: 'typed-question', instructions: 'How professional?', rubric: ['casual', 'balanced', 'professional'] } } as DecisionRequest;
    const score = await provider.decide(scoreRequest, 1);
    assert.equal(score.type, 'score');
    assert.equal(score.score, 1.25);
    assert.deepEqual((requests[0]!.questions as Record<string, unknown>)['typed-question'], {
      type: 'score', instructions: 'How professional?', criteria: ['casual', 'balanced', 'professional'],
    });

    const noulRequest = { state: request.state, question: { type: 'noul' as const, id: 'typed-question', instructions: 'Does this feel credible?', criteria: { true: 'credible', false: 'not credible' } } } as DecisionRequest;
    const noul = await provider.decide(noulRequest, 1);
    assert.equal(noul.type, 'noul');
    assert.equal(noul.noul, 0.74);
    assert.deepEqual((requests[1]!.questions as Record<string, unknown>)['typed-question'], {
      type: 'noul', instructions: 'Does this feel credible?', criteria: { true: 'credible', false: 'not credible' },
    });
  } finally { restoreKey(); }
});

test('retries a retryable HTTP response and counts each physical request', async () => {
  const restoreKey = installTestKey();
  try {
    let calls = 0;
    const provider = makeJevProvider( fakeFetch(async () => {
      calls += 1;
      return calls === 1 ? new Response('rate limited', { status: 429 }) : response();
    }));

    const result = await provider.decide(request, 2);
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
  } finally {
    restoreKey();
  }
});

test('retries a connection failure within the supplied physical-attempt cap', async () => {
  const restoreKey = installTestKey();
  try {
    let calls = 0;
    const provider = makeJevProvider( fakeFetch(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('socket disconnected');
      return response();
    }));

    const result = await provider.decide(request, 2);
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
  } finally {
    restoreKey();
  }
});

test('does not retry authentication failures or leak the key in errors', async () => {
  const restoreKey = installTestKey();
  try {
    let calls = 0;
    const provider = makeJevProvider( fakeFetch(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'secret-test-key rejected' } }), { status: 401 });
    }));

    await assert.rejects(provider.decide(request, 4), (error: unknown) => {
      assert.ok(error instanceof JevCallError);
      assert.equal(error.attempts, 1);
      assert.equal(error.attempts, 1);
      assert.equal(error.message.includes('secret-test-key'), false);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    restoreKey();
  }
});

test('stops after the hard physical-attempt limit and reports observed attempts', async () => {
  const restoreKey = installTestKey();
  try {
    let calls = 0;
    const provider = makeJevProvider( fakeFetch(async () => {
      calls += 1;
      return new Response('temporarily unavailable', { status: 503 });
    }));

    await assert.rejects(provider.decide(request, 2), (error: unknown) => {
      assert.ok(error instanceof JevCallError);
      assert.equal(error.attempts, 2);
      return true;
    });
    assert.equal(calls, 2);
  } finally {
    restoreKey();
  }
});

test('does not describe costs in errors when a response fails decision validation', async () => {
  const restoreKey = installTestKey();
  try {
    const invalid = response({
      answers: {
        'entry-response': {
          type: 'choice',
          choice: 'continue',
          probabilities: { continue: 0.2, leave: 0.2 },
        },
      },
    });
    const provider = makeJevProvider( fakeFetch(async () => invalid));

    await assert.rejects(provider.decide(request, 1), (error: unknown) => {
      assert.ok(error instanceof JevCallError);
      assert.equal(error.attempts, 1);
      assert.equal(error.message.toLowerCase().includes('charge'), false);
      assert.equal(error.message.toLowerCase().includes('billing'), false);
      return true;
    });
  } finally {
    restoreKey();
  }
});

test('rejects a missing key before attempting a request', async () => {
  const previous = process.env[testKeyEnv];
  process.env[testKeyEnv] = 'environment-key-must-not-authenticate';
  try {
    const provider = new JevProvider(config, fakeFetch(async () => {
      throw new Error('transport must not be called');
    }), { credentialStore: { availability: async () => 'missing', readForAuthentication: async () => { throw new Error('missing'); } } });
    await assert.rejects(provider.decide(request, 1), (error: unknown) => {
      assert.ok(error instanceof JevCallError);
      assert.equal(error.attempts, 0);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env[testKeyEnv];
    else process.env[testKeyEnv] = previous;
  }
});

test('native route uses its own vault entry and endpoint for each typed request', async () => {
  const nativeConfig = defaultJevConfig('typesafe');
  const typedRequests: DecisionRequest[] = [request,
    { state: request.state, question: { type: 'score', id: 'native-score', instructions: 'How clear is this?', rubric: ['unclear', 'clear'] } } as DecisionRequest,
    { state: request.state, question: { type: 'noul', id: 'native-noul', instructions: 'Does this feel trustworthy?', criteria: { true: 'trustworthy', false: 'not trustworthy' } } } as DecisionRequest,
  ];
  const typedAnswers = [
    { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, leave: 0.2 }, confidence: 0.6 },
    { type: 'score', score: 1, legend: { '0': 'unclear', '1': 'clear' }, probabilities: { '0': 0.2, '1': 0.8 } },
    { type: 'noul', noul: 0.8 },
  ];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let lookups = 0;
  let physicalCalls = 0;
  const provider = new JevProvider(nativeConfig, fakeFetch(async (url, init) => {
    physicalCalls += 1;
    requests.push({ url, init });
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const id = Object.keys(body.questions)[0]!;
    return response({ model: 'jev-1.13.0', answers: { [id]: typedAnswers[physicalCalls - 1] } });
  }), {
    credentialStore: {
      availability: async () => 'available',
      readForAuthentication: async (route) => { assert.equal(route, 'typesafe'); lookups += 1; return 'fixture-native-key'; },
    },
  });
  const results = [];
  for (const typedRequest of typedRequests) results.push(await provider.decide(typedRequest, 1));

  assert.equal(physicalCalls, typedRequests.length);
  assert.equal(lookups, typedRequests.length);
  for (const [index, { url, init }] of requests.entries()) {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer fixture-native-key');
    const body = JSON.parse(String(init.body)) as { model: string; state: unknown; questions: Record<string, unknown> };
    assert.equal(body.model, nativeConfig.model);
    assert.deepEqual(body.state, typedRequests[index]!.state);
    assert.deepEqual(Object.keys(body.questions), [typedRequests[index]!.question.id]);
  }
  for (const [index, result] of results.entries()) {
    assert.equal(result.type, typedRequests[index]!.question.type);
    assert.equal(result.provider, 'jev');
    assert.equal(result.model, 'jev-1.13.0');
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 12 });
  }
});

test('native authorization failure records one physical call and hides credentials and provider text', async () => {
  const nativeConfig = defaultJevConfig('typesafe');
  const token = 'fixture-native-secret';
  let physicalCalls = 0;
  const provider = new JevProvider(nativeConfig, fakeFetch(async () => {
    physicalCalls += 1;
    return new Response('private-provider-body', { status: 401 });
  }), {
    credentialStore: { availability: async () => 'available', readForAuthentication: async () => token },
  });
  await assert.rejects(provider.decide(request, 1), (error: unknown) => {
    assert.ok(error instanceof JevCallError);
    assert.equal(error.attempts, 1);
    assert.equal(error.failureScope, 'run');
    assert.doesNotMatch(error.message, new RegExp(`${token}|private-provider-body`));
    return true;
  });
  assert.equal(physicalCalls, 1);
});

test('native responses without complete token usage fail safely after one physical request', async () => {
  const nativeConfig = defaultJevConfig('typesafe');
  const missingUsage = [
    { output_tokens: 12 },
    { input_tokens: 120 },
  ];
  for (const usage of missingUsage) {
    let physicalCalls = 0;
    const provider = new JevProvider(nativeConfig, fakeFetch(async () => {
      physicalCalls += 1;
      return response({ usage });
    }), { credentialStore: testCredentialStore });
    await assert.rejects(provider.decide(request, 1), (error: unknown) => {
      assert.ok(error instanceof JevCallError);
      assert.equal(error.attempts, 1);
      assert.equal(error.message, 'Jev response is missing required identity or usage fields.');
      assert.equal(JSON.stringify(error).includes('secret-test-key'), false);
      return true;
    });
    assert.equal(physicalCalls, 1);
  }

  const batch: DecisionBatchRequest = { state: request.state, questions: [request.question, { type: 'noul', id: 'trust', instructions: 'Is it credible?' }] };
  let batchCalls = 0;
  const batchProvider = new JevProvider(nativeConfig, fakeFetch(async () => {
    batchCalls += 1;
    return response({ usage: {} });
  }), { credentialStore: testCredentialStore });
  await assert.rejects(batchProvider.decideBatch(batch, 1), (error: unknown) =>
    error instanceof JevCallError && error.attempts === 1 && error.message === 'Jev response is missing required identity or usage fields.');
  assert.equal(batchCalls, 1);
});


test('optional cost evidence uses only known served-model rates and complete token counts', async () => {
  const native = defaultJevConfig('typesafe');
  for (const [servedModel, usage, expected] of [
    ['jev-latest', { input_tokens: 120, output_tokens: 12 }, { amountUsd: 0.00000504, basis: 'published-rate-estimate' }],
    ['unknown-served-model', { input_tokens: 120, output_tokens: 12 }, undefined],
  ] as const) {
    const provider = new JevProvider(native, fakeFetch(async () => response({ model: servedModel, usage })), {
      credentialStore: testCredentialStore,
      measureContext: () => ({ provider: 'jev', status: 'fits', method: 'fixture', modelIdentity: native.model, tokenCount: 'estimated', tokens: 1, contextLimit: 100, headroomTokens: 0, effectiveLimit: 100, details: {} }),
    });
    const result = await provider.decide(request, 1);
    assert.deepEqual(result.cost, expected);
    assert.equal(result.type, 'choice');
    assert.equal(result.model, servedModel);
  }
  for (const [usage, expected] of [
    [{ input_tokens: 120 }, undefined],
    [{}, undefined],
    [{ cost: 0 }, { amountUsd: 0, basis: 'provider-reported' }],
  ] as const) {
    const openrouter = makeJevProvider(fakeFetch(async () => response({ model: config.model, usage })));
    assert.deepEqual((await openrouter.decide(request, 1)).cost, expected);
  }
  const openrouter = makeJevProvider(fakeFetch(async () => response({ model: config.model, usage: { input_tokens: 120, output_tokens: 12 } })));
  assert.deepEqual((await openrouter.decide(request, 1)).cost, { amountUsd: 0.00000504, basis: 'published-rate-estimate' });
});
