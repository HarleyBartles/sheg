import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { preflightStudy } from '../src/application/preflight.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const tokenizerJsonPath = path.join(fixtures, 'laya-tokenizer.json');
const tokenizerSha256 = createHash('sha256').update(readFileSync(tokenizerJsonPath)).digest('hex');

test('preflight measures every frozen respondent packet for each configured provider without inference', async () => {
  const result = await preflightStudy({
    manifestPath: path.join(fixtures, 'article.json'),
    cohortPath: path.join(fixtures, 'cohort.json'),
    providers: [
      { kind: 'laya', baseUrl: 'http://127.0.0.1:8787', checkpoint: 'fixture', contextLimit: 1024, headLimit: 192, tokenizerJsonPath, tokenizerSha256, timeoutMs: 1000 },
      { kind: 'jev', model: 'typesafe/jev-1.13', keyEnv: 'NO_NETWORK_REQUIRED', endpoint: 'https://example.invalid/decisions', timeoutMs: 1000 },
    ],
  });
  assert.equal(result.provisional, false);
  assert.equal(result.providers.length, 2);
  assert.ok(result.providers.every((provider) => provider.packetCount > 0 && provider.complete));
  assert.equal(result.providers[0]?.status, 'does-not-fit');
  assert.equal(result.providers[0]?.basis, 'frozen-cohort');
  assert.equal(result.providers[0]?.configuration, 'configured');
  assert.equal(result.providers[0]?.availability, 'unverified');
  assert.ok((result.providers[0]?.overflows.length ?? 0) > 0);
  assert.equal(result.providers[1]?.status, 'fit');
  assert.equal(result.providers[0]?.measurementMethod?.startsWith('laya-ts@'), true);
  assert.equal(result.providers[1]?.measurementMethod, 'utf8-bytes-div-3+20%-reserve/v1');
});

test('an unavailable provider measurement or incomplete traversal cannot report fit', async () => {
  const result = await preflightStudy({
    manifestPath: path.join(fixtures, 'article.json'), cohortPath: path.join(fixtures, 'cohort.json'),
    maxPackets: 0,
    providers: [{ kind: 'jev', model: 'typesafe/jev-latest', keyEnv: 'NO_KEY', endpoint: 'https://example.invalid/decisions', timeoutMs: 1000 }],
  });
  assert.equal(result.providers[0]?.status, 'unverified');
  assert.equal(result.providers[0]?.complete, false);
  assert.equal(result.providers[0]?.unavailable.length, 0);
});

test('an unknown Jev context window is unverified even after complete path traversal', async () => {
  const result = await preflightStudy({
    manifestPath: path.join(fixtures, 'article.json'), cohortPath: path.join(fixtures, 'cohort.json'),
    providers: [{ kind: 'jev', model: 'typesafe/jev-latest', keyEnv: 'UNSET', endpoint: 'https://example.invalid/decisions', timeoutMs: 1000 }],
  });
  assert.equal(result.providers[0]?.complete, true);
  assert.equal(result.providers[0]?.status, 'unverified');
  assert.ok((result.providers[0]?.unavailable.length ?? 0) > 0);
});

test('maximum-profile mode exercises the full aggregate prose allowance and labels results provisional', async () => {
  const result = await preflightStudy({
    manifestPath: path.join(fixtures, 'article.json'), mode: 'maximum-profile',
    providers: [{ kind: 'jev', model: 'typesafe/jev-1.13', keyEnv: 'UNSET', endpoint: 'https://example.invalid/decisions', timeoutMs: 1000 }],
  });
  assert.equal(result.provisional, true);
  assert.equal(result.mode, 'maximum-profile');
  assert.equal(result.providers[0]?.status, 'fit');
  assert.equal(result.providers[0]?.basis, 'synthetic-profile');
  assert.equal(result.providers[0]?.packetCount, 3);
});

test('provider context fit stays distinct from missing credentials and unverified reachability', async () => {
  const missingCredential = 'SHEG_PREFLIGHT_TEST_KEY_MISSING';
  delete process.env[missingCredential];
  const result = await preflightStudy({
    manifestPath: path.join(fixtures, 'article.json'), cohortPath: path.join(fixtures, 'cohort.json'),
    providers: [{ kind: 'jev', model: 'typesafe/jev-1.13', keyEnv: missingCredential, endpoint: 'https://example.invalid/decisions', timeoutMs: 1000 }],
  });
  assert.equal(result.providers[0]?.status, 'fit');
  assert.equal(result.providers[0]?.configuration, 'incomplete');
  assert.equal(result.providers[0]?.availability, 'unverified');
});

test('preflight identities change with the respondent basis and provider context settings', async () => {
  const manifestPath = path.join(fixtures, 'article.json');
  const cohortPath = path.join(fixtures, 'cohort.json');
  const provider = { kind: 'laya' as const, baseUrl: 'http://127.0.0.1:8787', checkpoint: 'fixture', contextLimit: 1024, headLimit: 192, tokenizerJsonPath, tokenizerSha256, timeoutMs: 1000 };
  const frozen = await preflightStudy({ manifestPath, cohortPath, providers: [provider] });
  const synthetic = await preflightStudy({ manifestPath, mode: 'maximum-profile', providers: [provider] });
  const differentLimit = await preflightStudy({ manifestPath, cohortPath, providers: [{ ...provider, contextLimit: 1023 }] });

  assert.match(frozen.inputFingerprint, /^[a-f\d]{64}$/);
  assert.match(frozen.compilerFingerprint, /^[a-f\d]{64}$/);
  assert.match(frozen.providers[0]!.executionFingerprint, /^[a-f\d]{64}$/);
  assert.equal(frozen.providers[0]!.tokenizerSha256, tokenizerSha256);
  assert.notEqual(frozen.inputFingerprint, synthetic.inputFingerprint);
  assert.equal(frozen.inputFingerprint, differentLimit.inputFingerprint);
  assert.notEqual(frozen.providers[0]!.executionFingerprint, differentLimit.providers[0]!.executionFingerprint);
});
