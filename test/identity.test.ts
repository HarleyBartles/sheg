import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { loadStudy } from '../src/domain/study/load-study.js';
import { executionFingerprint, stimulusFingerprint } from '../src/infrastructure/identity.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function studyFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixtureDirectory, directory, { recursive: true });
  return loadStudy(path.join(directory, 'article.json'), path.join(directory, 'cohort.json'));
}

test('provider changes preserve stimulus identity and change execution identity', async (t) => {
  const study = await studyFixture(t);
  const stimulus = stimulusFingerprint(study.manifest, study.profiles, 'prompt-v1');
  const jev = executionFingerprint(stimulus, { kind: 'jev', model: 'jev-latest' });
  const laya = executionFingerprint(stimulus, { kind: 'laya', checkpoint: 'typed-decisions', contextLimit: 1024 });
  assert.equal(stimulusFingerprint(study.manifest, study.profiles, 'prompt-v1'), stimulus);
  assert.notEqual(jev, laya);
});

test('cohort order, source hashes, prompt contract, checkpoint, and precision affect the relevant fingerprints', async (t) => {
  const study = await studyFixture(t);
  const base = stimulusFingerprint(study.manifest, study.profiles, 'prompt-v1');
  assert.notEqual(stimulusFingerprint(study.manifest, [...study.profiles].reverse(), 'prompt-v1'), base);
  assert.notEqual(stimulusFingerprint({ ...study.manifest, sources: study.manifest.sources.map((source) => ({ ...source, sha256: 'a'.repeat(64) })) }, study.profiles, 'prompt-v1'), base);
  assert.notEqual(stimulusFingerprint(study.manifest, study.profiles, 'prompt-v2'), base);

  const checkpoint = executionFingerprint(base, { kind: 'laya', checkpoint: 'typed-decisions', contextLimit: 1024 });
  assert.notEqual(executionFingerprint(base, { kind: 'laya', checkpoint: 'multilingual', contextLimit: 1024 }), checkpoint);
  assert.notEqual(executionFingerprint(base, { kind: 'laya', checkpoint: 'typed-decisions', contextLimit: 1024, precision: 'fp16' }), checkpoint);
});

test('execution fingerprint never includes credentials or transport-only settings', async (t) => {
  const study = await studyFixture(t);
  const stimulus = stimulusFingerprint(study.manifest, study.profiles, 'prompt-v1');
  const first = executionFingerprint(stimulus, { kind: 'jev', model: 'jev-latest', keyEnv: 'JEV_API_KEY', endpoint: 'https://api.example' });
  const second = executionFingerprint(stimulus, { kind: 'jev', model: 'jev-latest', keyEnv: 'OTHER_KEY', endpoint: 'https://other.example' });
  assert.equal(first, second);
  assert.doesNotMatch(first, /API_KEY|api\.example/);
});

test('canonical object key order does not change the stimulus fingerprint', async (t) => {
  const study = await studyFixture(t);
  const reordered = { ...study.manifest, study: { purpose: study.manifest.study.purpose, title: study.manifest.study.title } };
  assert.equal(
    stimulusFingerprint(study.manifest, study.profiles, 'prompt-v1'),
    stimulusFingerprint(reordered, study.profiles, 'prompt-v1'),
  );
});
