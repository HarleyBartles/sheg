import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/entrypoints/cli.js';
import { createRunService } from '../src/application/run-service.js';
import { openRunStore } from '../src/infrastructure/run-store.js';
import { CredentialStoreError } from '../src/infrastructure/credentials/windows.js';

const request = { kind: 'poll', respondents: [{ id: 'reader', intent: 'Learn', context: 'New', desired_outcome: 'Choose', engagement_cues: 'Examples', friction_cues: 'Hype' }], material: [{ id: 'opening', text: 'Exact text' }], questions: [{ type: 'choice', id: 'fit', instructions: 'Does it fit?', options: { yes: 'Yes' } }], provider: { kind: 'jev', route: 'openrouter', model: 'typesafe/jev-1.13' }, maxCalls: 1 };

for (const code of ['credential_missing', 'credential_malformed'] as const) {
  test(`CLI start surfaces safe ${code} guidance before durable acceptance`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-cli-credential-'));
    const store = openRunStore(directory);
    t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
    const provider = { measure: () => ({ provider: 'jev' as const, status: 'fits' as const, method: 'test', modelIdentity: 'typesafe/jev-1.13', tokenCount: 'estimated' as const, tokens: 1, contextLimit: 1000, headroomTokens: 100, effectiveLimit: 900, details: {} }), async decide() { throw new Error('No inference expected.'); } };
    const service = createRunService(store, directory, () => provider, { async launch() { throw new Error('No launch expected.'); } }, { async assertProviderReady() { throw new CredentialStoreError(code, 'openrouter'); } });
    const requestPath = path.join(directory, 'request.json');
    await writeFile(requestPath, JSON.stringify(request));
    const errors: string[] = [];
    const status = await runCli(['start', '--request', requestPath, '--submission-id', randomUUID()], { out: () => true, error: (value) => { errors.push(value); return true; } }, service);
    assert.equal(status, 1);
    assert.match(JSON.parse(errors[0] ?? '{}').error, code === 'credential_missing' ? /secure credential is missing/i : /unsupported encoding/i);
    assert.equal(store.list({}).items.length, 0);
  });
}
