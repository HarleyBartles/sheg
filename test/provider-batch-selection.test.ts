import assert from 'node:assert/strict';
import test from 'node:test';
import * as batchModule from '../src/application/provider-batch-planning.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import { decisionRequestSchema, decisionQuestionSchema, type DecisionBatchRequest, type DecisionRequest } from '../src/domain/decision/decision.js';
import { decisionVisualMaterialSchema } from '../src/domain/decision/decision.js';

const state = { profile: { intent: 'Read', context: 'Curious', desired_outcome: 'Decide' }, material: [{ id: 'section-one', text: 'The first section.' }], history: [{ question: 'continue', choice: 'yes' }] };
const image = decisionVisualMaterialSchema.parse({ id: 'cover', altText: 'A yellow flower in an orange pot.', asset: { assetId: `sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), format: 'png', width: 100, height: 100, bytes: 2048 } });
const visualQuestion = decisionQuestionSchema.parse({ type: 'choice', id: 'image-fit', instructions: 'Does this picture fit?', options: { yes: 'Yes', no: 'No' }, visual: { mode: 'pixels', materialIds: ['cover'] } });
const textQuestion = decisionQuestionSchema.parse({ type: 'score', id: 'clarity', instructions: 'How clear is the passage?', rubric: ['unclear', 'clear'] });
const questions = [visualQuestion, textQuestion];
const packets: DecisionRequest[] = [
  decisionRequestSchema.parse({ state, question: visualQuestion, optionIds: ['yes', 'no'], visualMaterials: [image] }),
  decisionRequestSchema.parse({ state, question: textQuestion }),
];
const group = { groupId: 'group-a', contextId: 'context-a', respondentId: 'reader-a', state, questions, packets };
function fit(provider: 'jev' | 'laya' | 'clef', status: ProviderContextFit['status'] = 'fits', tokens = 100): ProviderContextFit {
  return { provider, status, method: 'test-full-packet', modelIdentity: 'model', tokenCount: 'measured', tokens, contextLimit: 8192,
    headroomTokens: 512, effectiveLimit: 7680, details: { serializedBytes: tokens * 4 }, ...(status === 'overflow' ? { reason: 'packet limit' } : {}) };
}
const assess = (batchModule as unknown as { assessProviderBatchPlan?: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }).assessProviderBatchPlan;
async function run(extra: Record<string, unknown> = {}) {
  assert.equal(typeof assess, 'function', 'assessProviderBatchPlan must measure exact provider batches for selection');
  if (!assess) throw new Error('Provider batch planner is not implemented');
  return assess({ group, provider: { measureBatch: (batch: DecisionBatchRequest) => {
    assert.deepEqual(batch.state, state);
    return fit('jev', 'fits', 100 + batch.questions.length);
  }, async decide() { throw new Error('Admission must not run inference.'); }, async decideBatch() { throw new Error('Admission must not run inference.'); } } satisfies DecisionProvider,
    providerKind: 'jev', modelIdentity: 'test-model', batching: 'automatic', remainingCalls: 4, ...extra });
}

test('candidate batch assessment measures complete shared state with only each exact batch visual binding', async () => {
  const measured: Array<{ state: object; questions: Array<{ id: string }>; visualMaterials?: unknown[] }> = [];
  const result = await run({ provider: { measureBatch(batch: typeof measured[number]) { measured.push(batch); return fit('jev'); },
    async decide() { throw new Error('Admission must not run inference.'); }, async decideBatch() { throw new Error('Admission must not run inference.'); } } });
  assert.equal(result.minimumCalls, 1);
  assert.deepEqual(result.questionIdsByBatch, [['image-fit', 'clarity']]);
  assert.deepEqual(measured.at(-1)!.questions.map(({ id }) => id), ['image-fit', 'clarity']);
  assert.deepEqual(measured.at(-1)!.visualMaterials, [image]);
  assert.deepEqual(measured.at(-1)!.state, state);
});

test('automatic batching plans fitting prefixes, estimates repeated input cost, and excludes over-budget candidate plans', async () => {
  const provider: DecisionProvider = {
    measureBatch(batch) { return fit('jev', batch.questions.length > 1 ? 'overflow' : 'fits', 200); },
    async decide() { throw new Error('Admission must not run inference.'); }, async decideBatch() { throw new Error('Admission must not run inference.'); },
  };
  const result = await run({ provider, remainingCalls: 1, pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.1, source: 'https://rates.example/jev', observedAt: '2026-10-13' } });
  assert.equal(result.minimumCalls, 2);
  assert.deepEqual(result.questionIdsByBatch, [['image-fit'], ['clarity']]);
  assert.equal((result.cost as { amount?: number }).amount, 0.00004);
  assert.equal(result.exceedsRemainingCalls, true);
});

test('singleton mode and providers without batch support retain one question per physical request', async () => {
  const singleton = await run({ batching: 'singleton' });
  assert.equal(singleton.minimumCalls, 2);
  assert.deepEqual(singleton.questionIdsByBatch, [['image-fit'], ['clarity']]);
  let singleMeasurements = 0;
  const noBatch: DecisionProvider = { measure() { singleMeasurements += 1; return fit('laya'); }, async decide() { throw new Error('Admission must not run inference.'); } };
  const withoutBatchSupport = await run({ provider: noBatch, providerKind: 'laya' });
  assert.equal(withoutBatchSupport.minimumCalls, 2);
  assert.equal(singleMeasurements, 2);
});

test('provider selection uses the complete batch cost and remaining call plan', async () => {
  const selectBatches = (batchModule as unknown as { assessAndSelectProviderBatches?: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }).assessAndSelectProviderBatches;
  assert.equal(typeof selectBatches, 'function', 'automatic selection must consume complete candidate batch plans');
  if (!selectBatches) throw new Error('Candidate batch assessment is not integrated with provider selection');
  const catalogue = {
    revision: 1,
    entries: [
      { id: 'singleton', enabled: true, provider: { kind: 'jev', route: 'openrouter', model: 'model-single' }, execution: 'hosted', capabilities: ['text', 'pixels'],
        questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.01, source: 'https://rates.example/single', observedAt: '2026-10-13' } },
      { id: 'grouped', enabled: true, provider: { kind: 'jev', route: 'openrouter', model: 'model-grouped' }, execution: 'hosted', capabilities: ['text', 'pixels'],
        questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.02, source: 'https://rates.example/grouped', observedAt: '2026-10-13' } },
    ],
  };
  const result = await selectBatches({ group, catalogue, preferences: { preferredOrder: [] }, unitId: 'reader-a/article-check', requiredCapabilities: ['text', 'pixels'],
    questionType: 'choice', remainingCalls: 1, batching: 'automatic', candidates: [
      { id: 'singleton', providerKind: 'jev', modelIdentity: 'model-single', ready: true,
        provider: { measure: () => fit('jev', 'fits', 200), async decide() { throw new Error('Selection must not infer.'); } } },
      { id: 'grouped', providerKind: 'jev', modelIdentity: 'model-grouped', ready: true,
        provider: { measureBatch: (batch: DecisionBatchRequest) => fit('jev', 'fits', 101 + batch.questions.length), async decide() { throw new Error('Selection must not infer.'); }, async decideBatch() { throw new Error('Selection must not infer.'); } } },
    ] });
  assert.equal((result.selection as { selected?: { id: string } }).selected?.id, 'grouped');
  assert.equal((result.plans as Record<string, { minimumCalls: number }>).singleton!.minimumCalls, 2);
  assert.equal((result.plans as Record<string, { minimumCalls: number }>).grouped!.minimumCalls, 1);
  assert.equal((result.selection as { candidates: Array<{ id: string; eligible: boolean }> }).candidates.find(({ id }) => id === 'singleton')?.eligible, false);
});
