import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { emptyAttemptSnapshot, LegacyRunArchiveReader, runCheckpointSchema, type RunCheckpoint } from '../src/infrastructure/legacy/run-archive.js';
import { loadStudy } from '../src/infrastructure/study-loader.js';
import { legacyChoiceStimulusFingerprint, legacyExecutionFingerprint, stimulusFingerprint } from '../src/infrastructure/identity.js';
import { legacyPromptContractHash, promptContractHash } from '../src/domain/decision/prompt.js';

async function tempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-legacy-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function checkpoint(directory: string): Promise<RunCheckpoint> {
  const manifestPath = path.resolve('test/fixtures/article.json');
  const cohortPath = path.resolve('test/fixtures/cohort.json');
  const study = await loadStudy(manifestPath, cohortPath);
  const provider = { kind: 'jev' as const, route: 'openrouter' as const, model: 'jev-1', endpoint: 'https://openrouter.ai/api/v1/chat/completions', timeoutMs: 5000 };
  const fingerprint = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  return runCheckpointSchema.parse({
    formatVersion: 4, runId: randomUUID(), status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    manifestPath, cohortPath, outputDirectory: directory, provider, maxCalls: 4, concurrency: 1,
    stimulusFingerprint: fingerprint, executionFingerprint: legacyExecutionFingerprint(fingerprint, provider),
    sourceHashes: study.sources.map((source) => source.sha256), respondentIds: study.respondents.map((respondent) => respondent.id), journeys: [],
    activeCellIds: [], cancellationRequested: false, budget: emptyAttemptSnapshot(4),
  });
}

test('historical archive reads and lists without changing stored evidence', async (t) => {
  const directory = await tempDirectory(t);
  const original = await checkpoint(directory);
  const bytes = `${JSON.stringify(original)}\n`;
  await writeFile(path.join(directory, `run-${original.runId}.json`), bytes);
  const reader = new LegacyRunArchiveReader(directory);
  assert.deepEqual(await reader.read(original.runId), original);
  assert.deepEqual(await reader.list(), [original]);
  assert.equal(await readFile(path.join(directory, `run-${original.runId}.json`), 'utf8'), bytes);
});

test('historical versions 2 and 3 can be viewed through in-memory upcasting only', async (t) => {
  const directory = await tempDirectory(t);
  const current = await checkpoint(directory);
  const study = await loadStudy(current.manifestPath, current.cohortPath);
  const provider = { kind: 'jev' as const, route: 'openrouter' as const, model: 'jev-1', endpoint: 'https://openrouter.ai/api/v1/chat/completions', timeoutMs: 5000 };
  for (const version of [2, 3] as const) {
    const legacyFingerprint = version === 2
      ? legacyChoiceStimulusFingerprint(study.manifest, study.cohort, legacyPromptContractHash)
      : current.stimulusFingerprint;
    const legacy = {
      ...current,
      formatVersion: version,
      stimulusFingerprint: legacyFingerprint,
      executionFingerprint: legacyExecutionFingerprint(legacyFingerprint, provider),
      maxUsd: 1,
      maxPerCallUsd: 0.1,
      budget: { maxCalls: 4, maxUsd: 1, usedCalls: 1, reservedCalls: 1, remainingCalls: 2, billedUsd: 0.001, reservedUsd: 0.1, unpricedReservations: 0, overspendUsd: 0, blocked: false },
    };
    const filename = path.join(directory, `run-${current.runId}.json`);
    const originalBytes = `${JSON.stringify(legacy)}\n`;
    await writeFile(filename, originalBytes);
    const upcast = await new LegacyRunArchiveReader(directory).read(current.runId);
    assert.equal(upcast.migratedFromFormatVersion, version);
    assert.deepEqual(upcast.budget, { maxCalls: 4, usedCalls: 2, reservedCalls: 0, remainingCalls: 2 });
    assert.equal(await readFile(filename, 'utf8'), originalBytes);
  }
});

test('unknown historical formats are rejected without rewriting evidence', async (t) => {
  const directory = await tempDirectory(t);
  const current = await checkpoint(directory);
  const future = { ...current, formatVersion: 99 };
  const bytes = `${JSON.stringify(future)}\n`;
  const filename = path.join(directory, `run-${current.runId}.json`);
  await writeFile(filename, bytes);
  await assert.rejects(new LegacyRunArchiveReader(directory).read(current.runId), /failed validation/);
  assert.equal(await readFile(filename, 'utf8'), bytes);
});
