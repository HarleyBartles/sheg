import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayaProvider, checkLayaFit, type FitMeasurer, type LayaConfig } from '../src/providers/laya.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';

const config: LayaConfig = {
  kind: 'laya',
  baseUrl: 'http://127.0.0.1:8787',
  checkpoint: 'laya-typed-decisions',
  contextLimit: 1024,
  timeoutMs: 1000,
};

const request: DecisionRequest = {
  state: { reader: { profile: 'Curious reader' }, encounteredItems: [{ id: 'opening', text: 'A short passage.' }], choiceHistory: [] },
  question: { id: 'continue', instructions: 'What should happen?', options: { continue: 'Continue reading', stop: 'Stop reading' } },
  optionIds: ['continue', 'stop'],
};

test('fit check refuses unmeasurable context without calling Laya', async () => {
  assert.deepEqual(await checkLayaFit(request, config), { status: 'unsupported-input', reason: 'context-unmeasurable' });
});

test('fit check reports overflow and exact fit from a checkpoint measurer', async () => {
  const measure: FitMeasurer = async () => ({ checkpoint: config.checkpoint, tokens: 1025, limit: 1024 });
  assert.deepEqual(await checkLayaFit(request, config, measure), {
    status: 'unsupported-input', reason: 'context-over-limit', tokens: 1025, limit: 1024,
  });

  const exact: FitMeasurer = async () => ({ checkpoint: config.checkpoint, tokens: 1024, limit: 1024 });
  assert.deepEqual(await checkLayaFit(request, config, exact), { status: 'fits', tokens: 1024, limit: 1024 });
});

test('fit check rejects measurement from another checkpoint', async () => {
  const measure: FitMeasurer = async () => ({ checkpoint: 'laya', tokens: 10, limit: 1024 });
  assert.deepEqual(await checkLayaFit(request, config, measure), {
    status: 'unsupported-input', reason: 'checkpoint-mismatch',
  });
});

test('provider makes zero inference requests when context cannot be measured', async () => {
  let calls = 0;
  const provider = new LayaProvider(config, { fetchRequest: async () => { calls += 1; throw new Error('unexpected request'); } });
  await assert.rejects(provider.decide(request, 1), /context-unmeasurable/);
  assert.equal(calls, 0);
});

test('provider accepts the routed checkpoint while preserving Laya confidence semantics', async () => {
  const fit: FitMeasurer = async () => ({ checkpoint: config.checkpoint, tokens: 20, limit: 1024 });
  const provider = new LayaProvider(config, {
    measureFit: fit,
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
  assert.equal(result.model, 'laya-rl-agent');
  assert.equal(result.checkpoint, config.checkpoint);
  assert.equal(result.confidence, 0.6);
  assert.equal(result.chargeStatus, 'not_billed');
});

test('provider rejects missing or mismatched routed checkpoint and malformed probabilities', async () => {
  const fit: FitMeasurer = async () => ({ checkpoint: config.checkpoint, tokens: 20, limit: 1024 });
  for (const payload of [
    { model: 'laya-rl-agent', answers: {}, usage: {}, routing: {} },
    { model: 'laya-rl-agent', answers: {}, usage: {}, routing: { model: 'laya' } },
    { model: 'laya-rl-agent', answers: { continue: { type: 'choice', choice: 'continue', probabilities: { continue: 0.8, stop: 0.3 } } }, usage: {}, routing: { model: config.checkpoint } },
  ]) {
    const provider = new LayaProvider(config, { measureFit: fit, fetchRequest: async () => Response.json(payload) });
    await assert.rejects(provider.decide(request, 1));
  }
});

test('provider reports an unavailable local service without fallback', async () => {
  const fit: FitMeasurer = async () => ({ checkpoint: config.checkpoint, tokens: 20, limit: 1024 });
  const provider = new LayaProvider(config, { measureFit: fit, fetchRequest: async () => { throw new Error('offline'); } });
  await assert.rejects(provider.decide(request, 1), /local service/);
});
