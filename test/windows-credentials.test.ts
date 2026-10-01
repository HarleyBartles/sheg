import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import path from 'node:path';
import { preflightStudy } from '../src/application/preflight.js';
import { JevProvider } from '../src/providers/jev.js';
import { defaultJevConfig } from '../src/providers/jev/config.js';
import type { DecisionRequest } from '../src/domain/decision/decision.js';
import { WindowsCredentialStore } from '../src/infrastructure/credentials/windows.js';

test('credential requests keep secrets off helper arguments and report only availability', async () => {
  const calls: string[][] = [];
  const store = new WindowsCredentialStore({
    helperPath: 'fixture-helper.ps1',
    credentialTargets: { typesafe: 'Sheg/Test/fixture' },
    run: async (args) => { calls.push([...args]); return { code: 0, stdout: 'AVAILABLE\n', stderr: '' }; },
  });

  assert.equal(await store.availability('typesafe'), 'available');
  assert.deepEqual(calls, [['-Operation', 'Status', '-TargetName', 'Sheg/Test/fixture']]);
  await store.setup('typesafe');
  assert.deepEqual(calls[1], ['-Operation', 'Setup', '-TargetName', 'Sheg/Test/fixture']);
  assert.equal(JSON.stringify(calls).includes('fixture-secret'), false);
});

test('credential status distinguishes a missing entry from an unavailable secure store', async () => {
  const missing = new WindowsCredentialStore({
    helperPath: 'fixture-helper.ps1',
    run: async () => ({ code: 3, stdout: 'MISSING\n', stderr: '' }),
  });
  const unavailable = new WindowsCredentialStore({
    helperPath: 'fixture-helper.ps1',
    run: async () => { throw new Error('helper failed'); },
  });

  assert.equal(await missing.availability('openrouter'), 'missing');
  assert.equal(await unavailable.availability('openrouter'), 'unavailable');
});

test('Windows vault reads, replaces, and removes a unique isolated fixture credential', { skip: process.platform !== 'win32' }, async () => {
  const targetName = `Sheg/Test/${randomUUID()}`;
  const helperPath = fileURLToPath(new URL('./fixtures/windows-credential-fixture.ps1', import.meta.url));
  const store = new WindowsCredentialStore({ credentialTargets: { typesafe: targetName, openrouter: targetName } });
  const fixture = (value: string) => spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-TargetName', targetName,
  ], { input: `${value}\n`, encoding: 'utf8', windowsHide: true, shell: false });
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    const first = fixture('fixture-key-one-never-print-\u9f8d');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(await store.availability('typesafe'), 'available');
    assert.equal(fingerprint(await store.readForAuthentication('typesafe')), fingerprint('fixture-key-one-never-print-\u9f8d'));

    const replacement = fixture('fixture-key-two-never-print');
    assert.equal(replacement.status, 0, replacement.stderr);
    assert.equal(fingerprint(await store.readForAuthentication('typesafe')), fingerprint('fixture-key-two-never-print'));

    const rejected = fixture('x'.repeat(2_000));
    assert.notEqual(rejected.status, 0);
    assert.equal(fingerprint(await store.readForAuthentication('typesafe')), fingerprint('fixture-key-two-never-print'));
    const nativeConfig = defaultJevConfig('typesafe');
    const preflight = () => preflightStudy({
      manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), providers: [nativeConfig],
    }, { credentialStore: store });
    assert.equal((await preflight()).providers[0]?.configuration, 'configured');
    const request: DecisionRequest = { state: { text: 'fixture' }, question: { type: 'noul', id: 'trust', instructions: 'Credible?' } };
    let fetches = 0;
    const provider = new JevProvider(nativeConfig, (async (_url, init) => {
      fetches++;
      assert.equal(fingerprint((init?.headers as Record<string, string>).Authorization ?? ''), fingerprint('Bearer fixture-key-two-never-print'));
      return new Response(JSON.stringify({ model: 'jev-latest', answers: { trust: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 10, output_tokens: 1 } }));
    }) as typeof fetch, {
      credentialStore: store,
      measureContext: () => ({ provider: 'jev', status: 'fits', method: 'fixture', modelIdentity: nativeConfig.model, tokenCount: 'estimated', tokens: 1, contextLimit: 100, headroomTokens: 0, effectiveLimit: 100, details: {} }),
    });
    assert.equal((await provider.decide(request, 1)).type, 'noul');
    await store.remove('typesafe');
    assert.equal((await preflight()).providers[0]?.configuration, 'incomplete');
    await assert.rejects(provider.decide(request, 1), /secure credential/);
    assert.equal(fetches, 1);
    const environmentOnly = spawnSync(process.execPath, ['--import', 'tsx', 'test/fixtures/missing-vault-env.ts', targetName], {
      encoding: 'utf8', windowsHide: true, shell: false,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, OPENROUTER_API_KEY: 'fake-env-key', TYPESAFE_API_KEY: 'fake-native-env-key' },
    });
    assert.equal(environmentOnly.status, 0, environmentOnly.stderr);
    assert.equal(await store.availability('typesafe'), 'missing');
  } finally {
    spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../src/infrastructure/credentials/windows-credential.ps1', import.meta.url)),
      '-Operation', 'Remove', '-TargetName', targetName,
    ], { encoding: 'utf8', windowsHide: true, shell: false });
  }
});

test('credential reads reject helper errors without including their output', async () => {
  const store = new WindowsCredentialStore({
    helperPath: 'fixture-helper.ps1',
    run: async () => ({ code: 1, stdout: 'fixture-secret', stderr: 'native fixture-secret failure' }),
  });

  await assert.rejects(store.readForAuthentication('typesafe'), (error: Error) => {
    assert.match(error.message, /secure credential/);
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
});
