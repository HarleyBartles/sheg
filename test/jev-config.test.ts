import assert from 'node:assert/strict';
import test from 'node:test';
import { jevConfigSchema } from '../src/providers/jev/config.js';
import { providerConfigSchema } from '../src/providers/config.js';
import { assertProviderReady } from '../src/providers/factory.js';
import { CredentialStoreError } from '../src/infrastructure/credentials/windows.js';

test('Clef accepts only a valid Cloudflare account and the two native models', () => {
  const base = { kind: 'clef', accountId: '3327878972ea82e6b454069bba62f3d9' };
  assert.deepEqual(providerConfigSchema.parse(base), { ...base, model: 'clef', timeoutMs: 30_000 });
  assert.deepEqual(providerConfigSchema.parse({ ...base, model: 'clef-flash', timeoutMs: 9_000 }), { ...base, model: 'clef-flash', timeoutMs: 9_000 });
  for (const invalid of [
    { ...base, accountId: 'short' },
    { ...base, accountId: '3327878972ea82e6b454069bba62f3dG' },
    { ...base, model: 'other-model' },
    { ...base, endpoint: 'https://attacker.example' },
    { ...base, credential: 'secret' },
  ]) assert.equal(providerConfigSchema.safeParse(invalid).success, false);
});

test('Clef readiness consults only the dedicated credential route and reports bounded failures', async () => {
  const config = providerConfigSchema.parse({ kind: 'clef', accountId: '3327878972ea82e6b454069bba62f3d9' });
  const routes: string[] = [];
  await assertProviderReady(config, { async availability(route) { routes.push(route); return 'available'; } });
  assert.deepEqual(routes, ['clef']);
  for (const state of ['missing', 'malformed', 'unavailable'] as const) await assert.rejects(
    assertProviderReady(config, { async availability(route) { assert.equal(route, 'clef'); return state; } }),
    (error: unknown) => error instanceof CredentialStoreError && error.code === `credential_${state}` && error.route === 'clef' && /Cloudflare Clef/.test(error.message));
});

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
    endpoint: 'https://api.typesafe.ai/v1/custom', timeoutMs: 9_000,
  }), {
    kind: 'jev', route: 'typesafe', model: 'jev-latest',
    endpoint: 'https://api.typesafe.ai/v1/custom', timeoutMs: 9_000,
  });
});

test('Jev configuration rejects environment credential fields and unknown routes', () => {
  assert.equal(jevConfigSchema.safeParse({ kind: 'jev', keyEnv: 'TYPESAFE_API_KEY' }).success, false);
  assert.equal(jevConfigSchema.safeParse({ kind: 'jev', credentialSource: 'env' }).success, false);
  assert.equal(jevConfigSchema.safeParse({ kind: 'jev', route: 'auto' }).success, false);
});


test('Jev routes reject endpoints that can disclose the selected vault credential', () => {
  for (const endpoint of [
    'http://openrouter.ai/api/alpha/decisions',
    'https://attacker.example/collect',
    'https://openrouter.ai.attacker.example/collect',
    'https://openrouter.ai:8443/api/alpha/decisions',
    'https://user:password@openrouter.ai/api/alpha/decisions',
    'https://api.typesafe.ai/v1/systemone',
  ]) assert.equal(jevConfigSchema.safeParse({ kind: 'jev', endpoint }).success, false);
  assert.equal(jevConfigSchema.safeParse({ kind: 'jev', route: 'typesafe', endpoint: 'https://openrouter.ai/api/alpha/decisions' }).success, false);
  assert.equal(jevConfigSchema.parse({ kind: 'jev', endpoint: 'https://openrouter.ai/api/v1/decisions' }).endpoint, 'https://openrouter.ai/api/v1/decisions');
});
