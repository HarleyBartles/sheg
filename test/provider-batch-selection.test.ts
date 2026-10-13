import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as batchModule from '../src/application/provider-batch-planning.js';
import type { DecisionProvider, ProviderContextFit } from '../src/domain/decision/provider.js';
import { decisionRequestSchema, decisionQuestionSchema, type DecisionBatchRequest, type DecisionQuestion, type DecisionRequest } from '../src/domain/decision/decision.js';
import { decisionVisualMaterialSchema } from '../src/domain/decision/decision.js';
import { compileClefRequest } from '../src/providers/clef/compiler.js';

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
const assess = batchModule.assessProviderBatchPlan;
const candidateImageBytes = await readFile(new URL('./fixtures/images/four-corners-transparent.png', import.meta.url));
const candidateSha256 = createHash('sha256').update(candidateImageBytes).digest('hex');
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

test('six-design pairwise questions stay isolated in two-image Clef calls and retain reversed pair order', async () => {
  const candidateIds = ['A', 'B', 'C', 'D', 'E', 'F'];
  const candidateAsset = { assetId: `sha256:${candidateSha256}`, sha256: candidateSha256, format: 'png' as const, width: 80, height: 40, bytes: candidateImageBytes.byteLength };
  const candidates = new Map(candidateIds.map((id) => [`portrait-${id}`, decisionVisualMaterialSchema.parse({
    id: `portrait-${id}`, altText: 'A supplied character portrait.', asset: candidateAsset,
  })]));
  const pairs = candidateIds.flatMap((first, index) => candidateIds.slice(index + 1).map((second) => [first, second] as const));
  const pairQuestion = (first: string, second: string, id: string): Extract<DecisionQuestion, { type: 'choice' }> => decisionQuestionSchema.parse({
    type: 'choice', id, instructions: 'Which portrait is a closer match to the fixed brief? Select no clear preference if tied.',
    options: { first: 'The first presented portrait', second: 'The second presented portrait', tie: 'No clear preference' },
    materialOptions: { first: `portrait-${first}`, second: `portrait-${second}` },
    visual: { mode: 'pixels', materialIds: [`portrait-${first}`, `portrait-${second}`] },
  }) as Extract<DecisionQuestion, { type: 'choice' }>;
  const pairQuestions = pairs.map(([first, second]) => pairQuestion(first, second, `pair-${first}-${second}`));
  const sixState = { ...state, materialOrder: candidateIds.map((id) => `portrait-${id}`) };
  const pairPackets = pairQuestions.map((question) => {
    const linked = question.visual!.materialIds.map((id) => candidates.get(id)!);
    return decisionRequestSchema.parse({ state: sixState, question, optionIds: Object.keys(question.options), visualMaterials: linked });
  });
  const resolver = { resolve(assetId: string) { assert.equal(assetId, candidateAsset.assetId); return { metadata: candidateAsset, bytes: candidateImageBytes }; } };
  const config = { kind: 'clef' as const, accountId: '3327878972ea82e6b454069bba62f3d9', model: 'clef' as const, timeoutMs: 5_000 };
  const provider: DecisionProvider = {
    measure(request) {
      assert.equal(request.question.visual?.materialIds.length, 2);
      assert.equal(request.visualMaterials?.length, 2);
      return fit('clef');
    },
    measureBatch(batch) {
      const count = new Set(batch.questions.flatMap((question) => question.visual?.materialIds ?? [])).size;
      return fit('clef', count > 4 ? 'overflow' : 'fits', 100 + count);
    },
    async decide() { throw new Error('Inspection must not dispatch inference.'); },
    async decideBatch() { throw new Error('Inspection must not dispatch inference.'); },
  };
  const result = await assess!({ group: { groupId: 'six-designs', contextId: 'fixed-context', respondentId: 'visual-reviewer', state: sixState,
    questions: pairQuestions, packets: pairPackets }, provider, providerKind: 'clef', modelIdentity: 'clef', batching: 'singleton' });

  assert.equal(result.minimumCalls, 15);
  assert.equal(result.exceedsRemainingCalls, false);
  assert.deepEqual(result.questionIdsByBatch, pairQuestions.map(({ id }) => [id]));
  for (const [index, batch] of result.batches.entries()) {
    const expected = pairs[index]!.map(([id]) => `portrait-${id}`);
    assert.deepEqual(batch.visualMaterials?.map(({ id }) => id), expected);
    const compiled = compileClefRequest(batch, config, resolver);
    const body = JSON.parse(compiled.body) as { images: string[]; state: { visualMaterials: Array<{ materialId: string; imageIndex: number }> } & Record<string, unknown> };
    assert.equal(body.images.length, 2);
    assert.deepEqual(body.state.visualMaterials.map(({ materialId }) => materialId), expected);
    assert.deepEqual(body.state.visualMaterials.map(({ imageIndex }) => imageIndex), [0, 1]);
    const projectedState = Object.fromEntries(Object.entries(body.state).filter(([key]) => key !== 'visualMaterials'));
    assert.deepEqual(projectedState, sixState);
  }

  const reversed = pairs[0]!.toReversed();
  const reversedQuestion = pairQuestion(reversed[0]!, reversed[1]!, 'pair-A-B-reversed');
  const reversedPacket = decisionRequestSchema.parse({ state: sixState, question: reversedQuestion, optionIds: Object.keys(reversedQuestion.options),
    visualMaterials: reversedQuestion.visual!.materialIds.map((id) => candidates.get(id)!) });
  const reversePlan = await assess!({ group: { groupId: 'reverse-order', contextId: 'fixed-context', respondentId: 'visual-reviewer', state: sixState,
    questions: [reversedQuestion], packets: [reversedPacket] }, provider, providerKind: 'clef', modelIdentity: 'clef', batching: 'singleton' });
  const reverseBody = JSON.parse(compileClefRequest(reversePlan.batches[0]!, config, resolver).body) as { images: string[]; state: { visualMaterials: Array<{ materialId: string; imageIndex: number }> } };
  assert.deepEqual(reverseBody.state.visualMaterials.map(({ materialId }) => materialId), ['portrait-B', 'portrait-A']);
  assert.deepEqual(reverseBody.state.visualMaterials.map(({ imageIndex }) => imageIndex), [0, 1]);

  const automatic = await assess!({ group: { groupId: 'auto-six-designs', contextId: 'fixed-context', respondentId: 'visual-reviewer', state: sixState,
    questions: pairQuestions, packets: pairPackets }, provider, providerKind: 'clef', modelIdentity: 'clef', batching: 'automatic' });
  assert.ok(automatic.batches.some((batch) => batch.questions.length > 1 && new Set(batch.questions.flatMap((question) => question.visual?.materialIds ?? [])).size > 2),
    'automatic fitting may attach sibling-pair images together, so it is not the independent-pair design');
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
