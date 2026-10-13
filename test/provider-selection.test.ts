import assert from 'node:assert/strict';
import test from 'node:test';
import * as selectionModule from '../src/application/provider-selection.js';
import { providerCatalogueSchema, type ProviderCatalogue } from '../src/providers/config.js';
import type { ProviderContextFit } from '../src/domain/decision/provider.js';

const laya = { kind: 'laya', baseUrl: 'http://127.0.0.1:7071', checkpoint: 'local-reader', contextLimit: 16_000, headLimit: 4_000,
  tokenizerJsonPath: 'C:/models/tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 30_000 };
const jev = { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' };
const clef = { kind: 'clef', accountId: '0123456789abcdef0123456789abcdef', model: 'clef' };
function entry(id: string, provider: typeof laya | typeof jev | typeof clef, pricing: Record<string, unknown>, capabilities = ['text']) {
  return { id, enabled: true, provider, execution: provider.kind === 'laya' ? 'local' : 'hosted', capabilities,
    questionTypes: ['choice', 'score', 'noul'], pricing };
}
const catalogue = providerCatalogueSchema.parse({ revision: 1, entries: [
  entry('local', laya, { kind: 'no-provider-invoice' }),
  entry('hosted-a', { ...jev, model: 'model-a' }, { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.2, source: 'https://provider.example/a', observedAt: '2026-10-13' }),
  entry('hosted-b', { ...jev, model: 'model-b' }, { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.1, source: 'https://provider.example/b', observedAt: '2026-10-13' }),
  entry('vision', clef, { kind: 'unknown' }, ['text', 'pixels']),
] }) as ProviderCatalogue;
const fitProviders: Array<[string, ProviderContextFit['provider']]> = [
  ['local', 'laya'], ['hosted-a', 'jev'], ['hosted-b', 'jev'], ['vision', 'clef'],
];
const fits: Record<string, ProviderContextFit> = Object.fromEntries(fitProviders.map(([id, provider]) => [id, { provider, status: 'fits', method: 'test-measurement', modelIdentity: id, tokenCount: 'measured', tokens: 100, contextLimit: 16_000, headroomTokens: 1000, effectiveLimit: 15_000, details: { exactTokens: 100 } }]));
const candidateAssessment = (id: string, overrides: Record<string, unknown> = {}) => ({ id, fit: fits[id] ?? fits['hosted-a']!, ready: true, plannedCalls: 1, ...overrides });
const select = (selectionModule as unknown as { selectProvider?: (input: Record<string, unknown>) => { selected?: unknown; candidates: Array<Record<string, unknown>>; decisionReason: string } }).selectProvider;
function invoke(extra: Record<string, unknown> = {}) {
  assert.equal(typeof select, 'function', 'selectProvider must expose the pure provider policy');
  if (!select) throw new Error('selectProvider is not implemented');
  return select({ catalogue, preferences: { preferredOrder: [] }, unitId: 'reader-a/continue', requiredCapabilities: ['text'], questionType: 'choice',
    candidates: ['local', 'hosted-a', 'hosted-b', 'vision'].map((id) => candidateAssessment(id)), remainingCalls: 4, ...extra });
}

test('text-only selection prefers eligible local execution over hosted candidates', () => {
  const result = invoke();
  assert.equal((result.selected as { id: string }).id, 'local');
  assert.equal((result.selected as { cost: { kind: string } }).cost.kind, 'no-provider-invoice');
});

test('pixel capability excludes local and text-only hosted providers before preference or economy', () => {
  const result = invoke({ requiredCapabilities: ['text', 'pixels'] });
  assert.equal((result.selected as { id: string }).id, 'vision');
  assert.deepEqual(result.candidates.filter(({ id }) => id !== 'vision').map(({ exclusion }) => (exclusion as { code: string }).code), ['missing_capability', 'missing_capability', 'missing_capability']);
});

test('provider fit overflow excludes Clef and unsupported question types exclude candidates', () => {
  const overflow = { ...fits.vision!, status: 'overflow' as const, reason: 'image and prompt exceed budget' };
  const result = invoke({ requiredCapabilities: ['text', 'pixels'], candidates: [candidateAssessment('vision', { fit: overflow })] });
  assert.equal(result.selected, undefined);
  assert.equal((result.candidates[0]!.exclusion as { code: string }).code, 'provider_overflow');
  const unsupported = invoke({ questionType: 'ranking', candidates: [candidateAssessment('local')] });
  assert.equal((unsupported.candidates[0]!.exclusion as { code: string }).code, 'unsupported_question_type');
});

test('a binding unit pin fails without fallback when its provider is ineligible', () => {
  const result = invoke({ unitOverrides: { 'reader-a/continue': 'local' }, requiredCapabilities: ['text', 'pixels'] });
  assert.equal(result.selected, undefined);
  assert.equal(result.decisionReason, 'binding_unit_override_ineligible');
  assert.equal(result.candidates.filter(({ selected }) => selected === true).length, 0);
});

test('a candidate whose full call plan exceeds the remaining allowance is excluded before economy', () => {
  const result = invoke({ candidates: [candidateAssessment('local', { plannedCalls: 3 }), candidateAssessment('hosted-a')], remainingCalls: 2 });
  assert.equal((result.selected as { id: string }).id, 'hosted-a');
  assert.equal(result.candidates.find(({ id }) => id === 'local')?.eligible, false);
  assert.equal((result.candidates.find(({ id }) => id === 'local')?.exclusion as { code: string }).code, 'call_allowance_exceeded');
});

test('a candidate with unknown readiness is excluded until the runtime observes provider availability', () => {
  const result = invoke({ candidates: [candidateAssessment('local', { ready: undefined }), candidateAssessment('hosted-a')] });
  assert.equal((result.selected as { id: string }).id, 'hosted-a');
  assert.equal((result.candidates.find(({ id }) => id === 'local')?.exclusion as { code: string }).code, 'provider_readiness_unverified');
});

test('unknown hosted prices preserve stable catalogue order and are never described as cheapest', () => {
  const unknownCatalogue = providerCatalogueSchema.parse({ revision: 1, entries: [
    entry('first', { ...jev, model: 'model-a' }, { kind: 'unknown' }), entry('second', { ...jev, model: 'model-b' }, { kind: 'unknown' }),
  ] });
  const result = invoke({ catalogue: unknownCatalogue, candidates: [candidateAssessment('second'), candidateAssessment('first')] });
  assert.equal((result.selected as { id: string }).id, 'first');
  assert.notEqual(result.decisionReason, 'cheapest');
  assert.equal((result.selected as { cost: { basis: string } }).cost.basis, 'unverified');
});

test('request order outranks saved preferences and economy, while saved preferences outrank economy', () => {
  const requestPreferred = invoke({ preferredOrder: ['hosted-a'], preferences: { preferredOrder: ['hosted-b'] } });
  assert.equal((requestPreferred.selected as { id: string }).id, 'hosted-a');
  assert.equal(requestPreferred.decisionReason, 'request_preference');
  const userPreferred = invoke({ preferences: { preferredOrder: ['hosted-a'] } });
  assert.equal((userPreferred.selected as { id: string }).id, 'hosted-a');
  assert.equal(userPreferred.decisionReason, 'saved_user_preference');
});

test('published hosted estimates use the lowest comparable packet cost after local execution is unavailable', () => {
  const result = invoke({ candidates: [candidateAssessment('hosted-a'), candidateAssessment('hosted-b')] });
  assert.equal((result.selected as { id: string }).id, 'hosted-b');
  assert.equal(result.decisionReason, 'lowest_comparable_published_rate_estimate');
  assert.deepEqual((result.selected as { cost: unknown }).cost, {
    kind: 'estimate', amount: 0.00001, currency: 'USD', basis: 'published-rate estimate', source: 'https://provider.example/b', observedAt: '2026-10-13',
  });
});

test('an impossible request preference remains excluded by hard provider eligibility', () => {
  const result = invoke({ preferredOrder: ['local'], requiredCapabilities: ['text', 'pixels'] });
  assert.equal((result.selected as { id: string }).id, 'vision');
  assert.equal(result.decisionReason, 'stable_catalogue_order_cost_unverified');
  assert.equal(result.candidates.find(({ id }) => id === 'local')?.eligible, false);
});
