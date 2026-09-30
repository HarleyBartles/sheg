import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
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
  const store = new WindowsCredentialStore({ helperPath, credentialTargets: { typesafe: targetName } });
  const fixture = (value: string) => spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-Operation', 'WriteFixture', '-TargetName', targetName,
  ], { input: `${value}\n`, encoding: 'utf8', windowsHide: true, shell: false });
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    const first = fixture('fixture-key-one-never-print');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(await store.availability('typesafe'), 'available');
    assert.equal(fingerprint(await store.readForAuthentication('typesafe')), fingerprint('fixture-key-one-never-print'));

    const replacement = fixture('fixture-key-two-never-print');
    assert.equal(replacement.status, 0, replacement.stderr);
    assert.equal(fingerprint(await store.readForAuthentication('typesafe')), fingerprint('fixture-key-two-never-print'));

    await store.remove('typesafe');
    assert.equal(await store.availability('typesafe'), 'missing');
  } finally {
    spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
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
