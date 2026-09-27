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
  question: { id: 'continue', instructions: 'What should happen?', options: { continue: 'Continue reading', stop: 'Stop reading' } },
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
  assert.equal(result.model, 'laya-rl-agent');
  assert.equal(result.checkpoint, config.checkpoint);
  assert.equal(result.confidence, 0.6);
  assert.equal(result.chargeStatus, 'not_billed');
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
