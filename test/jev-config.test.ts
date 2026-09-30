import assert from 'node:assert/strict';
import test from 'node:test';
import { jevConfigSchema } from '../src/providers/jev/config.js';

test('missing route keeps the existing OpenRouter endpoint and model defaults', () => {
  assert.deepEqual(jevConfigSchema.parse({ kind: 'jev' }), {
    kind: 'jev',
    route: 'openrouter',
    model: 'typesafe/jev-1.13',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    timeoutMs: 30_000,
  });
});

test('native TypeSafe route uses native defaults and preserves explicit settings', () => {
  assert.deepEqual(jevConfigSchema.parse({
    kind: 'jev', route: 'typesafe', model: 'jev-latest',
    endpoint: 'https://example.test/custom', timeoutMs: 9_000,
  }), {
    kind: 'jev', route: 'typesafe', model: 'jev-latest',
    endpoint: 'https://example.test/custom', timeoutMs: 9_000,
  });
});

test('Jev configuration rejects environment credential fields and unknown routes', () => {
  assert.equal(jevConfigSchema.safeParse({ kind: 'jev', keyEnv: 'TYPESAFE_API_KEY' }).success, false);
  assert.equal(jevConfigSchema.safeParse({ kind: 'jev', credentialSource: 'env' }).success, false);
  assert.equal(jevConfigSchema.safeParse({ kind: 'jev', route: 'auto' }).success, false);
});
