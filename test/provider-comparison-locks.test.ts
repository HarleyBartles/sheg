import assert from 'node:assert/strict';
import test from 'node:test';
import * as selectionModule from '../src/application/provider-selection.js';
import { inlineRunRequestSchema } from '../src/domain/run/request.js';
import { providerCatalogueSchema } from '../src/providers/config.js';
import type { ProviderContextFit } from '../src/domain/decision/provider.js';
import type { ProviderSelectionInput } from '../src/application/provider-selection.js';

const laya = { kind: 'laya' as const, baseUrl: 'http://127.0.0.1:7071', checkpoint: 'local-reader', contextLimit: 16000, headLimit: 4000,
  tokenizerJsonPath: 'C:/models/tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 30000 };
const jev = { kind: 'jev' as const, route: 'openrouter' as const, model: 'typesafe/jev-1.13' };
const clef = { kind: 'clef' as const, accountId: '0123456789abcdef0123456789abcdef', model: 'clef' as const };
const catalogue = providerCatalogueSchema.parse({ revision: 4, entries: [
  { id: 'local', enabled: true, provider: laya, execution: 'local', capabilities: ['text'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'no-provider-invoice' } },
  { id: 'hosted', enabled: true, provider: jev, execution: 'hosted', capabilities: ['text'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.2, source: 'https://rates.example/jev', observedAt: '2026-10-13' } },
  { id: 'vision', enabled: true, provider: clef, execution: 'hosted', capabilities: ['text', 'pixels'], questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'unknown' } },
] });
function fit(provider: ProviderContextFit['provider'], tokens = 100): ProviderContextFit {
  return { provider, status: 'fits', method: 'test-measurement', modelIdentity: 'test-model', tokenCount: 'measured', tokens, contextLimit: 16000,
    headroomTokens: 1000, effectiveLimit: 15000, details: { inputTokens: tokens } };
}
function member(unitId: string, requiredCapabilities: string[]): ProviderSelectionInput {
  return { catalogue, preferences: { preferredOrder: [] }, unitId, requiredCapabilities, questionType: 'choice', remainingCalls: 12, candidates: [
    { id: 'local', ready: true, fit: fit('laya'), plannedCalls: 1 }, { id: 'hosted', ready: true, fit: fit('jev'), plannedCalls: 1 },
    { id: 'vision', ready: true, fit: fit('clef'), plannedCalls: 1 },
  ] };
}
const selectLock = (selectionModule as unknown as { selectProviderComparisonLock?: (input: Record<string, unknown>) => Record<string, unknown> }).selectProviderComparisonLock;

test('comparison lock members are authored by stable respondent and question references', () => {
  const base = {
    kind: 'poll' as const, respondents: [{ id: 'reader-a', intent: 'Read', context: 'A page', desired_outcome: 'Decide', engagement_cues: 'Specific', friction_cues: 'Confusing' }],
    material: [{ id: 'article', text: 'The article.' }], questions: [
      { type: 'choice' as const, id: 'with-image', instructions: 'Does the image help?', options: { yes: 'Yes', no: 'No' } },
      { type: 'choice' as const, id: 'without-image', instructions: 'Does the section work without its image?', options: { yes: 'Yes', no: 'No' } },
    ],
    maxCalls: 4,
  };
  const parsed = inlineRunRequestSchema.safeParse({ ...base, providerSelection: { comparisonLocks: [{ id: 'visual-a-b', members: [
    { respondentId: 'reader-a', questionId: 'with-image' }, { respondentId: 'reader-a', questionId: 'without-image' },
  ], equality: { provider: 'same', model: 'same' } }] } });
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  assert.equal(inlineRunRequestSchema.safeParse({ ...base, providerSelection: { comparisonLocks: [{ id: 'bad-member', members: [
    { respondentId: 'reader-a', questionId: 'with-image' }, { respondentId: 'reader-a', questionId: 'missing-question' },
  ], equality: { provider: 'same', model: 'same' } }] } }).success, false);
  const crossRespondent = inlineRunRequestSchema.safeParse({ ...base, respondents: [
    ...base.respondents,
    { id: 'reader-b', intent: 'Read', context: 'A page', desired_outcome: 'Decide', engagement_cues: 'Specific', friction_cues: 'Confusing' },
  ], providerSelection: { comparisonLocks: [{ id: 'cross-respondent', members: [
    { respondentId: 'reader-a', questionId: 'with-image' }, { respondentId: 'reader-b', questionId: 'without-image' },
  ], equality: { provider: 'same', model: 'same' } }] } });
  assert.equal(crossRespondent.success, true, crossRespondent.success ? undefined : JSON.stringify(crossRespondent.error.issues));
  const defaultEquality = inlineRunRequestSchema.safeParse({ ...base, providerSelection: { comparisonLocks: [{ id: 'default-lock', members: [
    { respondentId: 'reader-a', questionId: 'with-image' }, { respondentId: 'reader-a', questionId: 'without-image' },
  ] }] } });
  assert.equal(defaultEquality.success, true, defaultEquality.success ? undefined : JSON.stringify(defaultEquality.error.issues));
  if (defaultEquality.success) assert.deepEqual(defaultEquality.data.providerSelection?.comparisonLocks?.[0]?.equality, { provider: 'same', model: 'same' });
  assert.equal(inlineRunRequestSchema.safeParse({ ...base, providerSelection: { comparisonLocks: [
    { id: 'first-lock', members: [{ respondentId: 'reader-a', questionId: 'with-image' }, { respondentId: 'reader-a', questionId: 'without-image' }], equality: { provider: 'same', model: 'same' } },
    { id: 'overlapping-lock', members: [{ respondentId: 'reader-a', questionId: 'with-image' }, { respondentId: 'reader-a', questionId: 'without-image' }], equality: { provider: 'vary', model: 'same' } },
  ] } }).success, false, 'an authored unit cannot silently join two comparison locks');
});

test('a declared image comparison locks across members while adjacent unlocked units remain independently selectable', () => {
  assert.equal(typeof selectLock, 'function', 'declared comparisons need a common provider/model selector');
  if (!selectLock) throw new Error('Comparison lock selection is not implemented');
  const visual = member('reader-a/with-image', ['text', 'pixels']);
  const textOnly = member('reader-b/without-image', ['text']);
  const locked = selectLock({ id: 'visual-a-b', equality: { provider: 'same', model: 'same' }, members: [visual, textOnly] });
  assert.equal((locked.selected as { id: string }).id, 'vision');
  assert.deepEqual(locked.memberIds, ['reader-a/with-image', 'reader-b/without-image']);
  const independent = selectionModule.selectProvider(visual).selected;
  const adjacent = selectionModule.selectProvider(textOnly).selected;
  assert.equal(independent?.id, 'vision');
  assert.equal(adjacent?.id, 'local');
});

test('an explicit provider comparison reports model variation as a treatment dimension', () => {
  assert.equal(typeof selectLock, 'function', 'comparison treatment dimensions need inspectable lock evidence');
  if (!selectLock) throw new Error('Comparison lock selection is not implemented');
  const result = selectLock({ id: 'provider-treatment', equality: { provider: 'vary', model: 'same' }, members: [member('reader-a/first', ['text']), member('reader-b/second', ['text'])] });
  assert.deepEqual(result.treatmentDimensions, ['provider']);
  assert.equal((result.members as unknown[]).length, 2);
});

test('a provider-same model-varying comparison still constrains every member to one provider', () => {
  assert.equal(typeof selectLock, 'function');
  if (!selectLock) throw new Error('Comparison lock selection is not implemented');
  const extendedCatalogue = providerCatalogueSchema.parse({ revision: 4, entries: [
    ...catalogue.entries,
    { id: 'hosted-alt', enabled: true, provider: { ...jev, model: 'typesafe/jev-1.14' }, execution: 'hosted', capabilities: ['text'],
      questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.2,
        source: 'https://rates.example/jev', observedAt: '2026-10-13' } },
  ] });
  const first = { ...member('reader-a/first', ['text']), catalogue: extendedCatalogue, preferredOrder: ['hosted'] };
  const second = { ...member('reader-b/second', ['text']), catalogue: extendedCatalogue, preferredOrder: ['hosted-alt'] };
  const result = selectLock({ id: 'model-treatment', equality: { provider: 'same', model: 'vary' }, members: [first, second] });
  const selections = result.members as Array<{ selection: { selected?: { provider?: string } } }>;
  assert.equal(selections.length, 2);
  assert.ok(selections.every(({ selection }) => selection.selected?.provider === selections[0]?.selection.selected?.provider));
});

test('a provider-varying model-same comparison still constrains every member to one model identity', () => {
  assert.equal(typeof selectLock, 'function');
  if (!selectLock) throw new Error('Comparison lock selection is not implemented');
  const secondModelCatalogue = providerCatalogueSchema.parse({ revision: 4, entries: [
    ...catalogue.entries,
    { id: 'hosted-typesafe', enabled: true, provider: { ...jev, route: 'typesafe' }, execution: 'hosted', capabilities: ['text'],
      questionTypes: ['choice', 'score', 'noul'], pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.2,
        source: 'https://rates.example/jev', observedAt: '2026-10-13' } },
  ] });
  const first = { ...member('reader-a/first', ['text']), preferredOrder: ['hosted'], catalogue: secondModelCatalogue,
    candidates: [...member('reader-a/first', ['text']).candidates, { id: 'hosted-typesafe', ready: true, fit: fit('jev'), plannedCalls: 1 }] };
  const second = { ...member('reader-b/second', ['text']), preferredOrder: ['hosted-typesafe'], catalogue: secondModelCatalogue,
    candidates: [...member('reader-b/second', ['text']).candidates, { id: 'hosted-typesafe', ready: true, fit: fit('jev'), plannedCalls: 1 }] };
  const result = selectLock({ id: 'provider-treatment', equality: { provider: 'vary', model: 'same' }, members: [first, second] });
  const selections = result.members as Array<{ selection: { selected?: { id: string } } }>;
  assert.equal(selections.length, 2);
  assert.deepEqual(selections.map(({ selection }) => selection.selected?.id), ['hosted', 'hosted-typesafe']);
});
