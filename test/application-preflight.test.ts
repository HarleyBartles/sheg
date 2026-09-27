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

test('maximum-profile mode exercises the full aggregate prose allowance and labels results provisional', async () => {
  const result = await preflightStudy({
    manifestPath: path.join(fixtures, 'article.json'), mode: 'maximum-profile',
    providers: [{ kind: 'jev', model: 'typesafe/jev-1.13', keyEnv: 'UNSET', endpoint: 'https://example.invalid/decisions', timeoutMs: 1000 }],
  });
  assert.equal(result.provisional, true);
  assert.equal(result.mode, 'maximum-profile');
  assert.equal(result.providers[0]?.status, 'fit');
  assert.equal(result.providers[0]?.packetCount, 3);
});
