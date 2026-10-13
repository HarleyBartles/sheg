import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareAutomaticallySelectedJourney, prepareAutomaticallySelectedPoll } from '../src/application/run-inspection.js';
import type { ProviderContextFit } from '../src/domain/decision/provider.js';
import type { DecisionProvider } from '../src/domain/decision/provider.js';
import { providerCatalogueSchema } from '../src/providers/config.js';
import { inlineJourneyRequestSchema, inlineRunRequestSchema } from '../src/domain/run/request.js';

const local = { kind: 'laya' as const, baseUrl: 'http://127.0.0.1:7071', checkpoint: 'local-reader', contextLimit: 16000, headLimit: 4000,
  tokenizerJsonPath: 'C:/models/tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 30000 };
const jev = { kind: 'jev' as const, route: 'openrouter' as const, model: 'typesafe/jev-1.13' };
const clef = { kind: 'clef' as const, accountId: '0123456789abcdef0123456789abcdef', model: 'clef' as const };
const catalogue = providerCatalogueSchema.parse({ revision: 6, entries: [
  { id: 'local', enabled: true, provider: local, execution: 'local', capabilities: ['text'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'no-provider-invoice' } },
  { id: 'hosted', enabled: true, provider: jev, execution: 'hosted', capabilities: ['text'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.2, source: 'https://rates.example/jev', observedAt: '2026-10-13' } },
  { id: 'vision', enabled: true, provider: clef, execution: 'hosted', capabilities: ['text', 'pixels'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'unknown' } },
] });
const measured: ProviderContextFit[] = [];
function provider(kind: ProviderContextFit['provider'], modelIdentity: string): DecisionProvider {
  return { measure: () => {
    const fit: ProviderContextFit = { provider: kind, status: 'fits', method: 'automatic-test-measurement', modelIdentity, tokenCount: 'measured', tokens: 120,
      contextLimit: 16000, headroomTokens: 1000, effectiveLimit: 15000, details: { inputTokens: 120 } };
    measured.push(fit);
    return fit;
  }, async decide() { throw new Error('Provider selection must not infer.'); } };
}

test('automatic poll inspection selects one pixel-capable configuration for every declared lock member without inference', async () => {
  measured.length = 0;
  const request = inlineRunRequestSchema.parse({
    kind: 'poll' as const,
    respondents: [
      { id: 'reader-a', intent: 'Read the article', context: 'Interested in the topic', desired_outcome: 'Decide whether to continue', engagement_cues: 'Specific examples', friction_cues: 'Distracting images' },
      { id: 'reader-b', intent: 'Read the article', context: 'Interested in the topic', desired_outcome: 'Decide whether to continue', engagement_cues: 'Specific examples', friction_cues: 'Distracting images' },
    ],
    material: [{ id: 'article', text: 'The article section.' }],
    questions: [{ type: 'choice' as const, id: 'image-fit', instructions: 'Does the image contribute?', options: { yes: 'Yes', no: 'No' } }],
    providerSelection: { requiredCapabilities: ['pixels' as const], comparisonLocks: [{ id: 'same-visual-model', members: [
      { respondentId: 'reader-a', questionId: 'image-fit' }, { respondentId: 'reader-b', questionId: 'image-fit' },
    ] }] },
    maxCalls: 2,
  });
  if (request.kind !== 'poll') throw new Error('Expected poll request.');
  const result = await prepareAutomaticallySelectedPoll(request, { catalogue, preferences: { preferredOrder: [] } }, [
    { id: 'local', provider: provider('laya', 'local-reader'), providerKind: 'laya', modelIdentity: 'local-reader', ready: true },
    { id: 'hosted', provider: provider('jev', 'typesafe/jev-1.13'), providerKind: 'jev', modelIdentity: 'typesafe/jev-1.13', ready: true },
    { id: 'vision', provider: provider('clef', 'clef'), providerKind: 'clef', modelIdentity: 'clef', ready: true },
  ]);
  assert.equal(result.inspection.valid, true, JSON.stringify(result.inspection.problems));
  assert.equal(result.inspection.minimumCalls, 2);
  assert.equal(result.inspection.initialChoices?.length, 2);
  assert.ok(result.inspection.initialChoices?.every(({ providerId, comparisonLockId }) => providerId === 'vision' && comparisonLockId === 'same-visual-model'));
  assert.ok(result.inspection.initialChoices?.every(({ candidates }) => candidates.find(({ id }) => id === 'vision')?.selected));
  assert.ok(result.inspection.initialChoices?.every(({ candidates }) => candidates.filter(({ selected }) => selected).length === 1));
  assert.ok(measured.length > 0);
  assert.ok(result.prepared);
});

test('automatic journey inspection resolves and freezes each initial ask under a shared comparison lock', async () => {
  measured.length = 0;
  const request = inlineJourneyRequestSchema.parse({
    kind: 'journey',
    respondents: [
      { id: 'reader-a', intent: 'Read', context: 'Interested', desired_outcome: 'Decide', engagement_cues: 'Examples', friction_cues: 'Distraction' },
      { id: 'reader-b', intent: 'Read', context: 'Interested', desired_outcome: 'Decide', engagement_cues: 'Examples', friction_cues: 'Distraction' },
    ],
    journey: { id: 'article', label: 'Article', items: [{ id: 'section-one', text: 'The article opening.' }], tasks: [
      { id: 'continue', type: 'choice', instructions: 'Would you continue?', options: { yes: 'Continue', no: 'Stop' } },
    ], presentation: { kind: 'graph', entryNodeId: 'ask', maxDecisions: 1, nodes: [
      { id: 'ask', kind: 'ask', taskId: 'continue' }, { id: 'done', kind: 'terminal', outcome: 'complete' },
    ], transitions: [
      { fromNodeId: 'ask', optionId: 'yes', toNodeId: 'done' }, { fromNodeId: 'ask', optionId: 'no', toNodeId: 'done' },
    ] } },
    providerSelection: { comparisonLocks: [{ id: 'initial-response-model', members: [
      { respondentId: 'reader-a', questionId: 'continue' }, { respondentId: 'reader-b', questionId: 'continue' },
    ] }] },
    maxCalls: 2,
  });
  const result = await prepareAutomaticallySelectedJourney(request, { catalogue, preferences: { preferredOrder: [] } }, [
    { id: 'local', provider: provider('laya', 'local-reader'), providerKind: 'laya', modelIdentity: 'local-reader', ready: true },
    { id: 'hosted', provider: provider('jev', 'typesafe/jev-1.13'), providerKind: 'jev', modelIdentity: 'typesafe/jev-1.13', ready: true },
    { id: 'vision', provider: provider('clef', 'clef'), providerKind: 'clef', modelIdentity: 'clef', ready: true },
  ]);
  assert.equal(result.inspection.valid, true, JSON.stringify(result.inspection.problems));
  assert.equal(result.inspection.minimumCalls, 2);
  assert.ok(result.inspection.initialChoices?.every(({ providerId, comparisonLockId }) => providerId === 'local' && comparisonLockId === 'initial-response-model'));
  assert.equal(result.journey?.packets.length, 2);
});
