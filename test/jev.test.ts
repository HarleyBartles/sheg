import assert from 'node:assert/strict';
import test from 'node:test';
import { JevCallError, JevProvider, measureJevContext, type JevConfig } from '../src/providers/jev.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';
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
  const nativeFit = measureJevContext(request, 'jev-latest', 'typesafe');
  assert.equal(nativeFit.status, 'unavailable');
  assert.equal(nativeFit.contextLimit, null);
  assert.equal(nativeFit.effectiveLimit, null);

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
    assert.equal(result.chargeStatus, 'billed');
    assert.equal(result.chargeUsd, 0.00000504);
    assert.ok(result.latencyMs >= 0);
  } finally {
    restoreKey();
  }
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
      assert.equal(error.chargeStatus, 'unknown');
      assert.equal(error.message.includes('secret-test-key'), false);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    restoreKey();
  }
});

test('stops after the hard attempt limit and marks an uncertain charge unknown', async () => {
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
      assert.equal(error.chargeStatus, 'unknown');
      return true;
    });
    assert.equal(calls, 2);
  } finally {
    restoreKey();
  }
});

test('retains known cost evidence when a billed response fails decision validation', async () => {
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
      assert.equal(error.chargeStatus, 'billed');
      assert.equal(error.chargeUsd, 0.00000504);
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
      assert.equal(error.chargeStatus, 'not_billed');
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env[testKeyEnv];
    else process.env[testKeyEnv] = previous;
  }
});

test('native route uses its own vault entry and endpoint even when both provider environment keys are set', async () => {
  const nativeConfig = defaultJevConfig('typesafe');
  let capturedUrl = '';
  let authorization = '';
  let lookedUpRoute = '';
  const provider = new JevProvider(nativeConfig, fakeFetch(async (url, init) => {
    capturedUrl = url;
    authorization = (init.headers as Record<string, string>).Authorization ?? '';
    return response();
  }), {
    credentialStore: {
      availability: async () => 'available',
      readForAuthentication: async (route) => { lookedUpRoute = route; return 'fixture-native-key'; },
    },
    measureContext: () => ({ provider: 'jev', status: 'fits', method: 'fixture', modelIdentity: nativeConfig.model, tokenCount: 'estimated', tokens: 1, contextLimit: 1_000, headroomTokens: 0, effectiveLimit: 1_000, details: {} }),
  });
  const previousNative = process.env.TYPESAFE_API_KEY;
  const previousRouter = process.env.OPENROUTER_API_KEY;
  process.env.TYPESAFE_API_KEY = 'must-not-be-read';
  process.env.OPENROUTER_API_KEY = 'must-not-be-read-either';
  try {
    await provider.decide(request, 1);
    assert.equal(capturedUrl, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(authorization, 'Bearer fixture-native-key');
    assert.equal(lookedUpRoute, 'typesafe');

    const typedRequests: DecisionRequest[] = [
      { state: request.state, question: { type: 'score', id: 'native-score', instructions: 'How clear is this?', rubric: ['unclear', 'clear'] } } as DecisionRequest,
      { state: request.state, question: { type: 'noul', id: 'native-noul', instructions: 'Does this feel trustworthy?', criteria: { true: 'trustworthy', false: 'not trustworthy' } } } as DecisionRequest,
    ];
    const typedAnswers = [
      { type: 'score', score: 1, legend: { '0': 'unclear', '1': 'clear' }, probabilities: { '0': 0.2, '1': 0.8 } },
      { type: 'noul', noul: 0.8 },
    ];
    for (const [index, typedRequest] of typedRequests.entries()) {
      const typedProvider = new JevProvider(nativeConfig, fakeFetch(async () => response({
        answers: { [typedRequest.question.id]: typedAnswers[index] },
      })), {
        credentialStore: {
          availability: async () => 'available',
          readForAuthentication: async (route) => { if (route !== 'typesafe') throw new Error('wrong route'); return 'fixture-native-key'; },
        },
        measureContext: () => ({ provider: 'jev', status: 'fits', method: 'fixture', modelIdentity: nativeConfig.model, tokenCount: 'estimated', tokens: 1, contextLimit: 1_000, headroomTokens: 0, effectiveLimit: 1_000, details: {} }),
      });
      const typedResult = await typedProvider.decide(typedRequest, 1);
      assert.equal(typedResult.type, typedRequest.question.type);
    }
  } finally {
    if (previousNative === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousNative;
    if (previousRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousRouter;
  }
});
