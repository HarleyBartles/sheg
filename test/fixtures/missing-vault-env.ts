import assert from 'node:assert/strict';
import path from 'node:path';
import { WindowsCredentialStore } from '../../src/infrastructure/credentials/windows.js';
import { JevProvider } from '../../src/providers/jev.js';
import { RunManager } from '../../src/application/run-manager.js';
import { preflightStudy } from '../../src/application/preflight.js';
const store = new WindowsCredentialStore({ credentialTargets: { typesafe: process.argv[2]!, openrouter: process.argv[2]! } });
let calls = 0;
for (const route of ['openrouter', 'typesafe'] as const) {
  const provider = new JevProvider({ kind: 'jev', route }, (async () => { calls++; throw new Error('must not fetch'); }) as typeof fetch, {
    credentialStore: store,
    measureContext: () => ({ provider: 'jev', status: 'fits', method: 'fixture', modelIdentity: 'fixture', tokenCount: 'estimated', tokens: 1, contextLimit: 100, headroomTokens: 0, effectiveLimit: 100, details: {} }),
  });
  await assert.rejects(provider.decide({ state: {}, question: { type: 'noul', id: 'trust', instructions: 'Credible?' } }, 1), /secure credential/);
  const result = await preflightStudy({ manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), providers: [{ kind: 'jev', route }] }, { credentialStore: store });
  assert.equal(result.providers[0]?.configuration, 'incomplete');
  await assert.rejects(new RunManager({ credentialStore: store }).startRun({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), provider: { kind: 'jev', route }, outputDirectory: path.resolve('missing-vault-must-not-create'), maxCalls: 1,
  }), /secure credential is missing/);
}
assert.equal(calls, 0);
