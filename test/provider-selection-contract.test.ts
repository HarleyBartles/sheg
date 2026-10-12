import assert from 'node:assert/strict';
import test from 'node:test';
import * as providerContracts from '../src/providers/config.js';
import { runRequestSchema } from '../src/domain/run/request.js';
import { z } from 'zod';

const laya = {
  kind: 'laya',
  baseUrl: 'http://127.0.0.1:7071',
  checkpoint: 'local-reader',
  contextLimit: 16_000,
  headLimit: 4_000,
  tokenizerJsonPath: 'C:/models/tokenizer.json',
  tokenizerSha256: 'a'.repeat(64),
  timeoutMs: 30_000,
};
const jev = { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' };
const clef = { kind: 'clef', accountId: '0123456789abcdef0123456789abcdef', model: 'clef' };

function entry(id: string, provider: typeof laya | typeof jev | typeof clef, extra: Record<string, unknown> = {}) {
  const local = provider.kind === 'laya';
  const visual = provider.kind === 'clef';
  return {
    id,
    enabled: true,
    provider,
    execution: local ? 'local' : 'hosted',
    capabilities: visual ? ['text', 'pixels'] : ['text'],
    questionTypes: ['choice', 'score', 'noul'],
    pricing: local
      ? { kind: 'no-provider-invoice' }
      : provider.kind === 'jev'
        ? { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.08, source: 'https://provider.example/rates', observedAt: '2026-10-13' }
        : { kind: 'unknown' },
    ...extra,
  };
}

function availableSchema(name: string): z.ZodType | undefined {
  const exported = providerContracts as unknown as Record<string, unknown>;
  const value = exported[name];
  return value && typeof value === 'object' && 'safeParse' in value ? value as z.ZodType : undefined;
}

function respondent(id = 'reader-a') {
  return { id, intent: 'Understand the article', context: 'Interested reader', desired_outcome: 'Decide whether to continue', engagement_cues: 'Concrete examples', friction_cues: 'Distraction' };
}

function autoPoll() {
  return {
    kind: 'poll',
    respondents: [respondent()],
    material: [{ id: 'section-one', text: 'The opening section.' }],
    questions: [{ type: 'choice', id: 'continue', instructions: 'Would you continue?', options: { yes: 'Continue', no: 'Stop' } }],
    providerSelection: {},
    maxCalls: 1,
  };
}

test('provider catalogue accepts explicit local, Jev, and Clef configurations with distinct declared capabilities', () => {
  const schema = availableSchema('providerCatalogueSchema');
  assert.ok(schema, 'providerCatalogueSchema must be exported from the provider contract owner');
  if (!schema) return;
  const parsed = schema.safeParse({ revision: 4, entries: [entry('local-reader', laya), entry('hosted-text', jev), entry('native-vision', clef)] });
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});

test('provider catalogue rejects duplicate IDs, duplicate canonical configurations, and secret fields', () => {
  const schema = availableSchema('providerCatalogueSchema');
  assert.ok(schema, 'providerCatalogueSchema must be exported from the provider contract owner');
  if (!schema) return;
  assert.equal(schema.safeParse({ revision: 0, entries: [entry('same-id', jev), entry('same-id', clef)] }).success, false);
  assert.equal(schema.safeParse({ revision: 0, entries: [entry('first-name', jev), entry('second-name', jev)] }).success, false);
  assert.equal(schema.safeParse({ revision: 0, entries: [entry('expanded', jev), entry('default-alias', { kind: 'jev', route: 'openrouter' } as typeof jev)] }).success, false);
  assert.equal(schema.safeParse({ revision: 0, entries: [entry('secret-bearing', { ...jev, apiKey: 'must-not-be-stored' } as typeof jev)] }).success, false);
});

test('provider catalogue rejects unknown capabilities and invalid price evidence', () => {
  const schema = availableSchema('providerCatalogueSchema');
  assert.ok(schema, 'providerCatalogueSchema must be exported from the provider contract owner');
  if (!schema) return;
  assert.equal(schema.safeParse({ revision: 0, entries: [entry('unknown-capability', jev, { capabilities: ['text', 'arbitrary'] })] }).success, false);
  assert.equal(schema.safeParse({ revision: 0, entries: [entry('invalid-price', jev, { pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: -1, source: 'https://provider.example/rates', observedAt: '2026-10-13' } })] }).success, false);
  assert.equal(schema.safeParse({ revision: 0, entries: [entry('unproven-price', jev, { pricing: { kind: 'published-rate', currency: 'USD', unit: 'million-input-tokens', amount: 0.08 } })] }).success, false);
});

test('automatic direct requests use catalogue references and retain per-unit, comparison, and batching controls', () => {
  const request = {
    ...autoPoll(),
    providerSelection: {
      preferredOrder: ['local-reader', 'hosted-text'],
      requiredCapabilities: ['text'],
      unitOverrides: { continue: 'local-reader' },
      comparisonLocks: [{ id: 'opening-response', members: ['reader-a/continue', 'reader-b/continue'], equality: { provider: 'same', model: 'same' } }],
      batching: 'singleton',
    },
    expectedSelectionFingerprint: 'f'.repeat(64),
  };
  const parsed = runRequestSchema.safeParse(request);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  if (parsed.success) {
    assert.equal(parsed.data.kind, 'poll');
    assert.equal(parsed.data.providerSelection?.batching, 'singleton');
    assert.deepEqual(parsed.data.providerSelection?.unitOverrides, { continue: 'local-reader' });
    assert.equal(parsed.data.expectedSelectionFingerprint, 'f'.repeat(64));
  }
});

test('automatic selection does not accept an embedded provider configuration as an enabled catalogue entry', () => {
  const request = { ...autoPoll(), providerSelection: { provider: clef } };
  assert.equal(runRequestSchema.safeParse(request).success, false);
});

test('legacy explicit provider requests remain valid without a catalogue or selection block', () => {
  const request = {
    kind: 'poll',
    respondents: [respondent()],
    material: [{ id: 'section-one', text: 'The opening section.' }],
    questions: [{ type: 'choice', id: 'continue', instructions: 'Would you continue?', options: { yes: 'Continue', no: 'Stop' } }],
    provider: jev,
    maxCalls: 1,
  };
  assert.equal(runRequestSchema.safeParse(request).success, true);
});

test('an explicit selection fingerprint is optional but must be a bounded SHA-256 digest', () => {
  assert.equal(runRequestSchema.safeParse(autoPoll()).success, true);
  assert.equal(runRequestSchema.safeParse({ ...autoPoll(), expectedSelectionFingerprint: 'a'.repeat(64) }).success, true);
  assert.equal(runRequestSchema.safeParse({ ...autoPoll(), expectedSelectionFingerprint: 'a'.repeat(65) }).success, false);
  assert.equal(runRequestSchema.safeParse({ ...autoPoll(), expectedSelectionFingerprint: 'not-a-digest' }).success, false);
});
