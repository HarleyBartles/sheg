import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayaProvider, checkLayaFit, type FitMeasurer, type LayaConfig } from '../src/providers/laya.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tokenizerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/laya-tokenizer.json');
const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerPath)).digest('hex');

const config: LayaConfig = {
  kind: 'laya',
  baseUrl: 'http://127.0.0.1:8787',
  checkpoint: 'laya-typed-decisions',
  contextLimit: 1024,
  headLimit: 192,
  tokenizerJsonPath: tokenizerPath,
  tokenizerSha256,
  timeoutMs: 1000,
};

const request: DecisionRequest = {
  state: { reader: { profile: 'Curious reader' }, encounteredItems: [{ id: 'opening', text: 'A short passage.' }], choiceHistory: [] },
  question: { type: 'choice', id: 'continue', instructions: 'What should happen?', options: { continue: 'Continue reading', stop: 'Stop reading' } },
  optionIds: ['continue', 'stop'],
};

test('fit check measures context with the pinned tokenizer by default', async () => {
  const measured = await checkLayaFit(request, config);
  assert.equal(measured.provider, 'laya');
  assert.equal(measured.tokenCount, 'measured');
  assert.equal(measured.details.tokenizerSha256, tokenizerSha256);
});

function fit(tokens: number, status: 'fits' | 'overflow' = 'fits') {
  return { provider: 'laya' as const, status, method: 'test', modelIdentity: config.checkpoint, tokenCount: 'measured' as const, tokens, contextLimit: config.contextLimit, headroomTokens: 0, effectiveLimit: config.contextLimit, details: { tokenizerSha256 } };
}

test('fit check reports overflow and exact fit from a checkpoint measurer', async () => {
  const measure: FitMeasurer = async () => fit(1025, 'overflow');
  assert.equal((await checkLayaFit(request, config, measure)).status, 'overflow');

  const exact: FitMeasurer = async () => fit(1024);
  assert.equal((await checkLayaFit(request, config, exact)).status, 'fits');
});

test('fit check rejects measurement from another checkpoint', async () => {
  const measure: FitMeasurer = async () => ({ ...fit(10), modelIdentity: 'laya' });
  assert.equal((await checkLayaFit(request, config, measure)).reason, 'checkpoint-or-tokenizer-mismatch');
});

test('provider makes zero inference requests when context cannot be measured', async () => {
  let calls = 0;
  const provider = new LayaProvider(config, { measureFit: async () => { throw new Error('tokenizer unavailable'); }, fetchRequest: async () => { calls += 1; throw new Error('unexpected request'); } });
  await assert.rejects(provider.decide(request, 1), /context-unmeasurable/);
  assert.equal(calls, 0);
});

test('provider accepts the routed checkpoint while preserving Laya confidence semantics', async () => {
  const measure: FitMeasurer = async () => fit(20);
  const provider = new LayaProvider(config, {
    measureFit: measure,
    fetchRequest: async (_url, init) => {
      assert.equal(init?.method, 'POST');
      return Response.json({
        model: 'laya-rl-agent',
        answers: { continue: { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, stop: 0.2 }, confidence: 0.6 } },
        usage: { input_tokens: 20, output_tokens: 0 },
        routing: { model: config.checkpoint },
      });
    },
  });
  const result = await provider.decide(request, 1);
  assert.equal(result.type, 'choice');
  if (result.type !== 'choice') return;
  assert.equal(result.model, 'laya-rl-agent');
  assert.equal(result.checkpoint, config.checkpoint);
  assert.equal(result.confidence, 0.6);
  assert.equal(result.cost, undefined);
});

test('Laya validation errors carry safe typed failure evidence without echoing the answer', async () => {
  const provider = new LayaProvider(config, {
    measureFit: async () => fit(20),
    fetchRequest: async () => Response.json({
      model: 'laya-rl-agent',
      answers: { continue: { type: 'choice', choice: 'private-unoffered-value', probabilities: { continue: 0.8, stop: 0.2 } } },
      usage: {}, routing: { model: config.checkpoint },
    }),
  });
  await assert.rejects(provider.decide(request, 1), (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : '', 'Laya response failed decision validation.');
    assert.deepEqual((error as { validationFailure?: unknown }).validationFailure, {
      code: 'invalid_answer', message: 'The selected option was not offered by this question.',
      detail: { reason: 'unknown_option', field: 'choice', constraint: 'offered_option' },
    });
    assert.equal(JSON.stringify(error).includes('private-unoffered-value'), false);
    return true;
  });
});

test('Laya receives linked candidate text as Choice options without Sheg material identifiers', async () => {
  let body: Record<string, unknown> | undefined;
  const linkedRequest: DecisionRequest = { ...request, question: { ...request.question, materialOptions: { continue: 'section-three' } } };
  const provider = new LayaProvider(config, {
    measureFit: async () => fit(20),
    fetchRequest: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ model: 'laya-rl-agent', answers: { continue: { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, stop: 0.2 } } }, usage: {}, routing: { model: config.checkpoint } });
    },
  });
  await provider.decide(linkedRequest, 1);
  const wireQuestions = body?.questions as Record<string, Record<string, unknown>>;
  assert.deepEqual(wireQuestions.continue, { type: 'choice', instructions: request.question.instructions, criteria: request.question.options });
  assert.equal(JSON.stringify(body).includes('section-three'), false);
});

test('encodes Score and Noul criteria and preserves their typed evidence', async () => {
  const measure: FitMeasurer = async () => fit(20);
  const bodies: Record<string, unknown>[] = [];
  const answers = [
    { type: 'score', score: 1.25, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' }, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 } },
    { type: 'noul', noul: 0.74 },
  ];
  const provider = new LayaProvider(config, {
    measureFit: measure,
    fetchRequest: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ model: 'laya-rl-agent', answers: { 'typed-question': answers[bodies.length - 1] }, usage: {}, routing: { model: config.checkpoint } });
    },
  });
  const scoreRequest = { state: request.state, question: { type: 'score' as const, id: 'typed-question', instructions: 'How professional?', rubric: ['casual', 'balanced', 'professional'] } } as DecisionRequest;
  const score = await provider.decide(scoreRequest, 1);
  assert.equal(score.type, 'score');
  assert.equal(score.score, 1.25);
  assert.deepEqual((bodies[0]!.questions as Record<string, unknown>)['typed-question'], {
    type: 'score', instructions: 'How professional?', criteria: ['casual', 'balanced', 'professional'],
  });

  const noulRequest = { state: request.state, question: { type: 'noul' as const, id: 'typed-question', instructions: 'Does this feel credible?', criteria: { true: 'credible', false: 'not credible' } } } as DecisionRequest;
  const noul = await provider.decide(noulRequest, 1);
  assert.equal(noul.type, 'noul');
  assert.equal(noul.noul, 0.74);
  assert.deepEqual((bodies[1]!.questions as Record<string, unknown>)['typed-question'], {
    type: 'noul', instructions: 'Does this feel credible?', criteria: { true: 'credible', false: 'not credible' },
  });
});

test('local question groups are split into singleton calls with the same state and exact question', async () => {
  const measured: DecisionRequest[] = [];
  const bodies: Record<string, unknown>[] = [];
  const questions: DecisionRequest['question'][] = [
    { type: 'choice', id: 'interest', instructions: 'Continue?', options: { yes: 'Yes', no: 'No' } },
    { type: 'noul', id: 'trust', instructions: 'Is it credible?' },
  ];
  const provider = new LayaProvider(config, {
    measureFit: async (packet) => { measured.push(packet); return fit(20); },
    fetchRequest: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const id = Object.keys(body.questions as Record<string, unknown>)[0]!;
      const answer = id === 'interest'
        ? { type: 'choice', choice: 'yes', probabilities: { yes: 0.8, no: 0.2 } }
        : { type: 'noul', noul: 0.7 };
      return Response.json({ model: 'laya-rl-agent', answers: { [id]: answer }, usage: {}, routing: { model: config.checkpoint } });
    },
  });

  for (const question of questions) {
    const packet = { state: request.state, question, ...(question.type === 'choice' ? { optionIds: Object.keys(question.options) } : {}) } as DecisionRequest;
    await provider.decide(packet, 1);
  }
  assert.deepEqual(measured.map(({ question }) => question.id), ['interest', 'trust']);
  assert.deepEqual(bodies.map(({ questions: requested }) => Object.keys(requested as object)), [['interest'], ['trust']]);
  assert.ok(bodies.every(({ state }) => JSON.stringify(state) === JSON.stringify(request.state)));
});

test('reports over-limit Score rubrics during measurement and rejects before inference', async () => {
  let measured = 0; let requested = 0;
  const provider = new LayaProvider(config, {
    measureFit: async () => { measured += 1; return fit(20); },
    fetchRequest: async () => { requested += 1; return Response.json({}); },
  });
  const overLimit = { state: request.state, question: { type: 'score' as const, id: 'too-many', instructions: 'Rate this', rubric: Array.from({ length: 33 }, (_, index) => `Level ${index}`) } } as DecisionRequest;
  assert.equal((await provider.measure(overLimit)).status, 'overflow');
  await assert.rejects(provider.decide(overLimit, 1), /score-rubric-exceeds-32-levels/);
  assert.equal(measured, 0);
  assert.equal(requested, 0);
});

test('provider rejects missing or mismatched routed checkpoint and malformed probabilities', async () => {
  const measure: FitMeasurer = async () => fit(20);
  for (const payload of [
    { model: 'laya-rl-agent', answers: {}, usage: {}, routing: {} },
    { model: 'laya-rl-agent', answers: {}, usage: {}, routing: { model: 'laya' } },
    { model: 'laya-rl-agent', answers: { continue: { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, stop: 0.3 } } }, usage: {}, routing: { model: config.checkpoint } },
  ]) {
    const provider = new LayaProvider(config, { measureFit: measure, fetchRequest: async () => Response.json(payload) });
    await assert.rejects(provider.decide(request, 1));
  }
});

test('provider reports an unavailable local service without fallback', async () => {
  const measure: FitMeasurer = async () => fit(20);
  const provider = new LayaProvider(config, { measureFit: measure, fetchRequest: async () => { throw new Error('offline'); } });
  await assert.rejects(provider.decide(request, 1), /local service/);
});

test('provider classifies authorization responses as run-wide failures', async () => {
  const measure: FitMeasurer = async () => fit(20);
  for (const status of [401, 403]) {
    const provider = new LayaProvider(config, { measureFit: measure, fetchRequest: async () => new Response(null, { status }) });
    await assert.rejects(provider.decide(request, 1), (error: unknown) => {
      assert.equal((error as { failureScope?: string }).failureScope, 'run');
      return true;
    });
  }
});
