import assert from 'node:assert/strict';
import test from 'node:test';
import { selectProvider } from '../src/application/provider-selection.js';
import { providerCatalogueSchema } from '../src/providers/config.js';
import type { ProviderContextFit } from '../src/domain/decision/provider.js';

test('selection evidence is deterministic and contains no credentials', () => {
  const catalogue = providerCatalogueSchema.parse({ revision: 7, entries: [
    { id: 'local-reader', enabled: true, provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:7071', checkpoint: 'reader', contextLimit: 8192, headLimit: 2048,
      tokenizerJsonPath: 'C:/models/tokenizer.json', tokenizerSha256: 'a'.repeat(64), timeoutMs: 30_000 }, execution: 'local', capabilities: ['text'],
      questionTypes: ['choice'], pricing: { kind: 'no-provider-invoice' } },
  ] });
  const fit: ProviderContextFit = { provider: 'laya', status: 'fits', method: 'bounded-tokenizer', modelIdentity: 'reader', tokenCount: 'measured',
    tokens: 250, contextLimit: 8192, headroomTokens: 512, effectiveLimit: 7680, details: { serializedBytes: 1532 } };
  const input = { catalogue, preferences: { preferredOrder: [] }, unitId: 'reader-a/continue', requiredCapabilities: ['text'], questionType: 'choice',
    candidates: [{ id: 'local-reader', fit, ready: true, plannedCalls: 1 }], remainingCalls: 1 };
  const first = selectProvider(input);
  const second = selectProvider(input);
  assert.deepEqual(first, second);
  const encoded = JSON.stringify(first);
  assert.equal(encoded.includes('apiKey'), false);
  assert.equal(encoded.includes('credential'), false);
  assert.equal(encoded.includes('tokenizerJsonPath'), true);
  assert.equal(first instanceof Promise, false);
});
