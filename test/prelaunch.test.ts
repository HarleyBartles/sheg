import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/entrypoints/cli.js';
import { RunManager } from '../src/application/run-manager.js';
import { CheckpointStore } from '../src/infrastructure/checkpoint-store.js';

const missingCredentialStore = {
  availability: async () => 'missing' as const,
  readForAuthentication: async () => { throw new Error('missing'); },
};

test('CLI start rejects a missing Jev key before creating a run', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-missing-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'run.json');
  const outputDirectory = path.join(directory, 'runs');
  await writeFile(configPath, JSON.stringify({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    outputDirectory, maxCalls: 4,
    provider: { kind: 'jev', model: 'test-jev', endpoint: 'https://openrouter.ai/api/alpha/decisions', timeoutMs: 5000 },
  }));
  const errors: string[] = [];
  const exitCode = await runCli(['start', '--config', configPath], { out: () => true, error: (value) => { errors.push(value); return true; } }, new RunManager({ credentialStore: missingCredentialStore }));
  assert.equal(exitCode, 1);
  assert.match(JSON.parse(errors[0] ?? '{}').error, /openrouter secure credential is missing/i);
  assert.deepEqual(await new CheckpointStore(outputDirectory).list(), []);
});
