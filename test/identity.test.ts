import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { loadStudy } from '../src/infrastructure/study-loader.js';
import { executionFingerprint, legacyChoiceStimulusFingerprint, respondentCohortFingerprint, stimulusFingerprint } from '../src/infrastructure/identity.js';
import { legacyPromptContractHash } from '../src/domain/decision/prompt.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function studyFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixtureDirectory, directory, { recursive: true });
  return loadStudy(path.join(directory, 'article.json'), path.join(directory, 'cohort.json'));
}

test('provider changes preserve stimulus identity and change execution identity', async (t) => {
  const study = await studyFixture(t);
  const stimulus = stimulusFingerprint(study.manifest, study.cohort, 'prompt-v1');
  const jev = executionFingerprint(stimulus, { kind: 'jev', model: 'jev-latest' });
  const laya = executionFingerprint(stimulus, { kind: 'laya', checkpoint: 'typed-decisions', contextLimit: 1024, headLimit: 192, tokenizerSha256: 'a'.repeat(64) });
  assert.equal(stimulusFingerprint(study.manifest, study.cohort, 'prompt-v1'), stimulus);
  assert.notEqual(jev, laya);
});

test('cohort order, source hashes, prompt contract, checkpoint, and precision affect the relevant fingerprints', async (t) => {
  const study = await studyFixture(t);
  const base = stimulusFingerprint(study.manifest, study.cohort, 'prompt-v1');
  assert.notEqual(stimulusFingerprint(study.manifest, { ...study.cohort, respondents: [...study.respondents].reverse() }, 'prompt-v1'), base);
  assert.notEqual(stimulusFingerprint(study.manifest, { ...study.cohort, respondents: [{ ...study.respondents[0]!, context: 'Has substantial hands-on experience.' }, study.respondents[1]!] }, 'prompt-v1'), base);
  assert.notEqual(stimulusFingerprint(study.manifest, { ...study.cohort, archetypes: study.cohort.archetypes.map((archetype, index) => index === 0 ? { ...archetype, invariants: ['A changed invariant.', ...archetype.invariants.slice(1)] } : archetype) }, 'prompt-v1'), base);
  assert.notEqual(stimulusFingerprint({ ...study.manifest, arms: study.manifest.arms.map((arm) => ({ ...arm, sources: arm.sources.map((source) => ({ ...source, sha256: 'a'.repeat(64) })) })) }, study.cohort, 'prompt-v1'), base);
  assert.notEqual(stimulusFingerprint(study.manifest, study.cohort, 'prompt-v2'), base);

  const checkpoint = executionFingerprint(base, { kind: 'laya', checkpoint: 'typed-decisions', contextLimit: 1024, headLimit: 192, tokenizerSha256: 'a'.repeat(64) });
  assert.notEqual(executionFingerprint(base, { kind: 'laya', checkpoint: 'multilingual', contextLimit: 1024, headLimit: 192, tokenizerSha256: 'a'.repeat(64) }), checkpoint);
  assert.notEqual(executionFingerprint(base, { kind: 'laya', checkpoint: 'typed-decisions', contextLimit: 1024, headLimit: 192, tokenizerSha256: 'a'.repeat(64), precision: 'fp16' }), checkpoint);
});

test('cohort identity includes frozen archetype snapshots as well as respondent profiles', async (t) => {
  const { cohort } = await studyFixture(t);
  const baseline = respondentCohortFingerprint(cohort);
  assert.notEqual(respondentCohortFingerprint({ ...cohort, archetypes: cohort.archetypes.map((item, index) => index === 0 ? { ...item, invariants: ['Changed snapshot', ...item.invariants.slice(1)] } : item) }), baseline);
  assert.notEqual(respondentCohortFingerprint({ ...cohort, respondents: [...cohort.respondents].reverse() }), baseline);
});

test('legacy Choice identity ignores only the new discriminator and detects changed history semantics', async (t) => {
  const study = await studyFixture(t);
  const legacy = legacyChoiceStimulusFingerprint(study.manifest, study.cohort, legacyPromptContractHash);
  const changed = { ...study.manifest, arms: study.manifest.arms.map((arm) => ({ ...arm, tasks: arm.tasks.map((task, index) => index ? task : { ...task, responseHistory: 'omit' as const }) })) };
  assert.notEqual(legacyChoiceStimulusFingerprint(changed, study.cohort, legacyPromptContractHash), legacy);
});

test('execution fingerprint never includes credentials or transport-only settings', async (t) => {
  const study = await studyFixture(t);
  const stimulus = stimulusFingerprint(study.manifest, study.cohort, 'prompt-v1');
  const first = executionFingerprint(stimulus, { kind: 'jev', model: 'jev-latest', keyEnv: 'JEV_API_KEY', endpoint: 'https://api.example' });
  const second = executionFingerprint(stimulus, { kind: 'jev', model: 'jev-latest', keyEnv: 'OTHER_KEY', endpoint: 'https://other.example' });
  assert.equal(first, second);
  assert.doesNotMatch(first, /API_KEY|api\.example/);
});

test('canonical object key order does not change the stimulus fingerprint', async (t) => {
  const study = await studyFixture(t);
  const reordered = { ...study.manifest, study: { purpose: study.manifest.study.purpose, title: study.manifest.study.title } };
  assert.equal(
    stimulusFingerprint(study.manifest, study.cohort, 'prompt-v1'),
    stimulusFingerprint(reordered, study.cohort, 'prompt-v1'),
  );
});
