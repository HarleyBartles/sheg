import assert from 'node:assert/strict';
import test from 'node:test';
import { JevCallError, JevProvider, type JevConfig } from '../src/providers/jev.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';

const config: JevConfig = {
  kind: 'jev',
  model: 'typesafe/jev-1.13',
  keyEnv: 'SHEG_TEST_OPENROUTER_KEY',
  endpoint: 'https://openrouter.ai/api/alpha/decisions',
  timeoutMs: 2_000,
};

const request: DecisionRequest = {
  state: { reader: { profile: 'Interested but time-limited.' }, encounteredItems: [] },
  question: {
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
  const previous = process.env[config.keyEnv];
  process.env[config.keyEnv] = 'secret-test-key';
  return () => {
    if (previous === undefined) delete process.env[config.keyEnv];
    else process.env[config.keyEnv] = previous;
  };
}

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

test('sends one typed choice and preserves the served model, distribution, usage, cost, and observed latency', async () => {
  const restoreKey = installTestKey();
  try {
    let captured: { url: string; init: RequestInit } | undefined;
    const provider = new JevProvider(config, fakeFetch(async (url, init) => {
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

test('retries a retryable HTTP response and counts each physical request', async () => {
  const restoreKey = installTestKey();
  try {
    let calls = 0;
    const provider = new JevProvider(config, fakeFetch(async () => {
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
    const provider = new JevProvider(config, fakeFetch(async () => {
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
    const provider = new JevProvider(config, fakeFetch(async () => {
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
    const provider = new JevProvider(config, fakeFetch(async () => {
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
    const provider = new JevProvider(config, fakeFetch(async () => invalid));

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
  const previous = process.env[config.keyEnv];
  delete process.env[config.keyEnv];
  try {
    const provider = new JevProvider(config, fakeFetch(async () => {
      throw new Error('transport must not be called');
    }));
    await assert.rejects(provider.decide(request, 1), (error: unknown) => {
      assert.ok(error instanceof JevCallError);
      assert.equal(error.attempts, 0);
      assert.equal(error.chargeStatus, 'not_billed');
      return true;
    });
  } finally {
    if (previous !== undefined) process.env[config.keyEnv] = previous;
  }
});
