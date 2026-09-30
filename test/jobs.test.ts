import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir as makeDirectory, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { CheckpointStore, emptyAttemptSnapshot, type RunCheckpoint } from '../src/infrastructure/checkpoint-store.js';
import { ProcessLock, ProcessLockError } from '../src/infrastructure/process-lock.js';
import { RunManager, checkStudy } from '../src/application/run-manager.js';
import { getReport } from '../src/application/reports.js';
import type { DecisionProvider } from '../src/domain/decision/provider.js';
import { LayaProvider } from '../src/providers/laya.js';
import { compileDecisionPacket, legacyPromptContractHash, promptContractHash } from '../src/domain/decision/prompt.js';
import { legacyChoiceRequestFingerprint } from '../src/application/worker.js';
import { legacyChoiceStimulusFingerprint, legacyExecutionFingerprint, stimulusFingerprint } from '../src/infrastructure/identity.js';
import { loadStudy } from '../src/infrastructure/study-loader.js';

async function tempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function checkpoint(directory: string, overrides: Partial<RunCheckpoint> = {}): Omit<RunCheckpoint, 'formatVersion' | 'runId'> & { runId?: string } {
  const now = new Date().toISOString();
  return {
    status: 'prepared', createdAt: now, updatedAt: now,
    manifestPath: path.join(directory, 'study.json'), cohortPath: path.join(directory, 'cohort.json'),
    outputDirectory: directory,
    provider: { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
    maxCalls: 10, concurrency: 2,
    stimulusFingerprint: 'a'.repeat(64), executionFingerprint: 'b'.repeat(64),
    sourceHashes: ['c'.repeat(64)], respondentIds: ['reader-a', 'reader-b'], journeys: [], activeCellIds: [],
    cancellationRequested: false, budget: emptyAttemptSnapshot(10),
    ...overrides,
  };
}

test('checkpoint store writes an atomic versioned record without source text or credentials', async (t) => {
  const directory = await tempDirectory(t);
  const store = new CheckpointStore(directory);
  const created = await store.create(checkpoint(directory));
  const loaded = await store.read(created.runId);
  assert.equal(loaded.formatVersion, 4);
  assert.equal(loaded.runId, created.runId);
  assert.deepEqual(await store.list(), [loaded]);
  const raw = await readFile(path.join(directory, `run-${created.runId}.json`), 'utf8');
  assert.doesNotMatch(raw, /JEV_API_KEY=.secret|source prose that should not persist/);
  assert.match(raw, /"route": "typesafe"/);
  await assert.rejects(store.create(checkpoint(directory, { runId: created.runId })), /already exists/);
});

test('migrates version-2 checkpoints, conserving interrupted calls and normalizing Choice evidence', async (t) => {
  const directory = await tempDirectory(t);
  const study = await loadStudy(path.resolve('test/fixtures/article.json'), path.resolve('test/fixtures/cohort.json'));
  const store = new CheckpointStore(directory);
  const legacyStimulus = legacyChoiceStimulusFingerprint(study.manifest, study.cohort, legacyPromptContractHash);
  const provider = { kind: 'jev' as const, model: 'jev-1', endpoint: 'https://openrouter.ai/api/v1/chat/completions', timeoutMs: 5000 };
  const created = await store.create({
    ...checkpoint(directory, { manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
      provider: { ...provider, route: 'openrouter' }, stimulusFingerprint: legacyStimulus,
      executionFingerprint: legacyExecutionFingerprint(legacyStimulus, provider), sourceHashes: study.sources.map((source) => source.sha256),
      respondentIds: study.respondents.map((respondent) => respondent.id), maxCalls: 4, budget: emptyAttemptSnapshot(4) }),
  });
  const raw = JSON.parse(await readFile(path.join(directory, `run-${created.runId}.json`), 'utf8')) as Record<string, unknown>;
  raw.formatVersion = 2;
  raw.provider = { ...provider, keyEnv: 'JEV_API_KEY' };
  raw.maxUsd = 1;
  raw.maxPerCallUsd = 0.1;
  raw.budget = { maxCalls: 4, maxUsd: 1, usedCalls: 1, reservedCalls: 1, remainingCalls: 2,
    billedUsd: 0.001, reservedUsd: 0.1, unpricedReservations: 0, overspendUsd: 0, blocked: false };
  raw.journeys = [{ armId: study.manifest.arms[0]!.id, respondentId: study.respondents[0]!.id, status: 'completed',
    result: { events: [
      { type: 'exposure', sequence: 0, nodeId: 'show', itemId: 'opening' },
      { type: 'choice', sequence: 1, nodeId: 'ask', taskId: 'entry', choice: 'continue' },
    ], outcome: 'completed', status: 'completed', decisionCount: 1 },
    decisions: [{ decisionId: 'entry', requestFingerprint: 'd'.repeat(64), result: { type: 'choice', choice: 'continue', probabilities: { continue: 1 }, attempts: 1, provider: 'jev', model: 'jev-1', latencyMs: 1, usage: {}, chargeStatus: 'billed', chargeUsd: 0.001 } }],
    attemptHistory: [], presentedTaskIds: ['entry'] }];
  await writeFile(path.join(directory, `run-${created.runId}.json`), JSON.stringify(raw));

  const loaded = await store.read(created.runId);
  assert.equal(loaded.formatVersion, 4);
  assert.equal(loaded.migratedFromFormatVersion, 2);
  assert.equal(loaded.budget.usedCalls, 2);
  assert.equal(loaded.budget.reservedCalls, 0);
  assert.equal(loaded.journeys[0]?.decisions[0]?.result.type, 'choice');
  assert.deepEqual(loaded.journeys[0]?.decisions[0]?.result.cost, { amountUsd: 0.001, basis: 'provider-reported' });
  assert.equal(loaded.journeys[0]?.result?.events[1]?.type, 'response');
  assert.deepEqual(await store.read(created.runId), loaded);
});

test('migrates version-3 checkpoints without resetting their call usage', async (t) => {
  const directory = await tempDirectory(t);
  const manifestPath = path.resolve('test/fixtures/article.json');
  const cohortPath = path.resolve('test/fixtures/cohort.json');
  const study = await loadStudy(manifestPath, cohortPath);
  const currentStimulus = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  const provider = { kind: 'jev' as const, model: 'typesafe/jev-1.13', endpoint: 'https://openrouter.ai/api/alpha/decisions', timeoutMs: 5000 };
  const store = new CheckpointStore(directory);
  const created = await store.create(checkpoint(directory, {
    manifestPath, cohortPath, provider: { ...provider, route: 'openrouter' }, stimulusFingerprint: currentStimulus,
    executionFingerprint: legacyExecutionFingerprint(currentStimulus, provider), sourceHashes: study.sources.map((source) => source.sha256),
    respondentIds: study.respondents.map((respondent) => respondent.id), maxCalls: 10,
    budget: { maxCalls: 10, usedCalls: 3, reservedCalls: 0, remainingCalls: 7 },
  }));
  const filename = path.join(directory, `run-${created.runId}.json`);
  const raw = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
  raw.formatVersion = 3;
  raw.budget = { maxCalls: 10, maxUsd: 1, usedCalls: 3, reservedCalls: 0, remainingCalls: 7,
    billedUsd: 0.02, reservedUsd: 0, unpricedReservations: 0, overspendUsd: 0, blocked: false };
  await writeFile(filename, JSON.stringify(raw));

  const migrated = await store.read(created.runId);
  assert.equal(migrated.formatVersion, 4);
  assert.equal(migrated.migratedFromFormatVersion, 3);
  assert.deepEqual(migrated.budget, { maxCalls: 10, usedCalls: 3, reservedCalls: 0, remainingCalls: 7 });
});

test('checkpoint rejects unrecognized fields and malformed provider provenance', async (t) => {
  const directory = await tempDirectory(t);
  const store = new CheckpointStore(directory);
  await assert.rejects(store.create({ ...checkpoint(directory), credential: 'do-not-store' } as never));
  await assert.rejects(store.create(checkpoint(directory, {
    provider: { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'not-a-url', timeoutMs: 5000 },
  } as never)));
});

test('checkpoint replacement survives repeated Windows file replacement and recovers its backup', async (t) => {
  const directory = await tempDirectory(t);
  const store = new CheckpointStore(directory);
  const created = await store.create(checkpoint(directory));
  for (let index = 0; index < 20; index += 1) {
    await store.update(created.runId, (current) => ({ ...current, updatedAt: new Date(Date.now() + index + 1).toISOString() }));
  }
  const persisted = await store.read(created.runId);
  assert.notEqual(persisted.updatedAt, created.updatedAt);
  await copyFile(path.join(directory, `run-${created.runId}.json`), path.join(directory, `run-${created.runId}.json.bak`));
  await rm(path.join(directory, `run-${created.runId}.json`));
  assert.equal((await store.read(created.runId)).runId, created.runId);
});

test('process lock rejects a second owner and releases only its own lock', async (t) => {
  const directory = await tempDirectory(t);
  const lock = await ProcessLock.acquire(directory, 'run-123');
  await assert.rejects(ProcessLock.acquire(directory, 'run-123'), ProcessLockError);
  await lock.release();
  const replacement = await ProcessLock.acquire(directory, 'run-123');
  await replacement.release();
});

test('a killed child process leaves reclaimable stale ownership', async (t) => {
  const directory = await tempDirectory(t);
  const moduleUrl = pathToFileURL(path.resolve('src/infrastructure/process-lock.ts')).href;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    'const { ProcessLock } = await import(process.env.POLL_LOCK_MODULE); await ProcessLock.acquire(process.env.POLL_LOCK_DIR, "run-child"); console.log("READY"); await new Promise(() => {});',
  ], { cwd: process.cwd(), env: { ...process.env, POLL_LOCK_MODULE: moduleUrl, POLL_LOCK_DIR: directory }, stdio: ['ignore', 'pipe', 'inherit'] });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child lock owner did not start.')), 5000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (chunk.includes('READY')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const recovered = await ProcessLock.acquire(directory, 'run-child');
  await recovered.release();
});

test('a live second process retains exclusive run ownership', async (t) => {
  const directory = await tempDirectory(t);
  const moduleUrl = pathToFileURL(path.resolve('src/infrastructure/process-lock.ts')).href;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    'const { ProcessLock } = await import(process.env.POLL_LOCK_MODULE); await ProcessLock.acquire(process.env.POLL_LOCK_DIR, "run-live"); console.log("READY"); setInterval(() => {}, 1000);',
  ], { cwd: process.cwd(), env: { ...process.env, POLL_LOCK_MODULE: moduleUrl, POLL_LOCK_DIR: directory }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child lock owner did not start.')), 5000);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (chunk.includes('READY')) { clearTimeout(timeout); resolve(); }
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    await assert.rejects(ProcessLock.acquire(directory, 'run-live'), ProcessLockError);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
});

test('check validates and fingerprints a study without creating a provider or run', async (t) => {
  const directory = await tempDirectory(t);
  let providerCreated = false;
  const manager = new RunManager({ providerFactory: () => { providerCreated = true; throw new Error('provider must not be created for check'); } });
  const checked = await checkStudy({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, headLimit: 192, tokenizerJsonPath: path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerSha256: 'a'.repeat(64), timeoutMs: 5000 },
    outputDirectory: directory, maxCalls: 10,
  });
  assert.equal(checked.study.respondents.length, 2);
  assert.match(checked.executionFingerprint, /^[a-f\d]{64}$/);
  assert.equal(providerCreated, false);
  assert.deepEqual(await new CheckpointStore(directory).list(), []);
  assert.ok(manager);
});

test('start rehashes source files and refuses drift before creating a checkpoint', async (t) => {
  const directory = await tempDirectory(t);
  const fixtures = path.join(directory, 'study');
  await makeDirectory(fixtures);
  for (const file of ['article.json', 'cohort.json', 'article-source.md']) await copyFile(path.resolve('test/fixtures', file), path.join(fixtures, file));
  await writeFile(path.join(fixtures, 'article-source.md'), 'changed after the manifest fingerprint was authored', 'utf8');
  const manager = new RunManager();
  await assert.rejects(manager.startRun({
    manifestPath: path.join(fixtures, 'article.json'), cohortPath: path.join(fixtures, 'cohort.json'),
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, headLimit: 192, tokenizerJsonPath: path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerSha256: 'a'.repeat(64), timeoutMs: 5000 },
    outputDirectory: path.join(directory, 'runs'), maxCalls: 10,
  }), /source/i);
  assert.deepEqual(await new CheckpointStore(path.join(directory, 'runs')).list(), []);
});

test('managed run checkpoints sequential provider decisions and reaches completed', async (t) => {
  const directory = await tempDirectory(t);
  const choices = ['continue', 'continue', 'continue', 'continue'];
  let calls = 0;
  const provider: DecisionProvider = { async decide(request) {
    if (request.question.type !== 'choice') throw new Error('Expected Choice question.');
    const choice = choices[calls++];
    assert.ok(choice);
    const labels = Object.keys(request.question.options);
    const probabilities = Object.fromEntries(labels.map((label) => [label, label === choice ? 1 : 0]));
    return { type: 'choice', choice, probabilities, attempts: 1, provider: 'laya', model: 'fake-local', checkpoint: 'local-test', latencyMs: 1, usage: {} };
  } };
  const manager = new RunManager({ providerFactory: () => provider });
  const started = await manager.startRun({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, headLimit: 192, tokenizerJsonPath: path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerSha256: 'a'.repeat(64), timeoutMs: 5000 },
    outputDirectory: directory, maxCalls: 10, concurrency: 1,
  });
  let current = started;
  for (let attempt = 0; attempt < 100 && current.status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await manager.runStatus(directory, started.runId);
  }
  assert.equal(current.status, 'completed', JSON.stringify(current));
  assert.equal(calls, 4);
  assert.equal(current.journeys[0]?.status, 'completed');
  assert.equal(current.budget.usedCalls, 4);
});

test('a partial study stops at its run-wide physical-attempt limit', async (t) => {
  const directory = await tempDirectory(t);
  let calls = 0;
  const provider: DecisionProvider = { async decide(request) {
    assert.equal(request.question.type, 'choice');
    calls += 1;
    const choice = 'continue';
    return { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(request.question.options).map((id) => [id, id === choice ? 1 : 0])), attempts: 1, provider: 'laya', model: 'fake-local', checkpoint: 'local-test', latencyMs: 1, usage: {} };
  } };
  const manager = new RunManager({ providerFactory: () => provider });
  const started = await manager.startRun({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, headLimit: 192, tokenizerJsonPath: path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerSha256: 'a'.repeat(64), timeoutMs: 5000 },
    outputDirectory: directory, maxCalls: 2, concurrency: 1,
  });
  let current = started;
  for (let attempt = 0; attempt < 100 && current.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await manager.runStatus(directory, started.runId);
  }
  assert.equal(current.status, 'partial');
  assert.equal(calls, 2);
  assert.deepEqual(current.budget, { maxCalls: 2, usedCalls: 2, reservedCalls: 0, remainingCalls: 0 });
});

test('runtime context rejection records actionable admission evidence in checkpoint and report', async (t) => {
  const directory = await tempDirectory(t);
  const providerConfig = { kind: 'laya' as const, baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 1024, headLimit: 192,
    tokenizerJsonPath: path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerSha256: 'a'.repeat(64), timeoutMs: 5000 };
  let calls = 0;
  const manager = new RunManager({ providerFactory: () => new LayaProvider(providerConfig, {
    measureFit: async () => ({ provider: 'laya', status: 'overflow', method: 'test-laya-tokenizer', modelIdentity: providerConfig.checkpoint,
      tokenCount: 'measured', tokens: 1035, contextLimit: 1024, headroomTokens: 0, effectiveLimit: 1024,
      details: { tokenizerSha256: providerConfig.tokenizerSha256 }, reason: 'state-would-be-truncated' }),
    fetchRequest: async () => { calls += 1; throw new Error('inference should not be called'); },
  }) });
  const started = await manager.startRun({ manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    provider: providerConfig, outputDirectory: directory, maxCalls: 10, concurrency: 1 });
  let current = started;
  for (let attempt = 0; attempt < 100 && current.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await manager.runStatus(directory, started.runId);
  }
  assert.equal(calls, 0);
  assert.equal(current.status, 'partial');
  assert.equal(current.journeys[0]?.status, 'failed');
  assert.deepEqual(current.journeys[0]?.failureEvidence, {
    decisionId: 'entry-response', nodeId: 'choose-entry', reason: 'state-would-be-truncated', tokens: 1035, effectiveLimit: 1024,
    measurementMethod: 'test-laya-tokenizer',
  });
  const report = await getReport(directory, started.runId);
  assert.deepEqual(report.arms[0]?.journeys[0]?.failureEvidence, current.journeys[0]?.failureEvidence);
});

test('matched run executes one cell for every frozen respondent in every arm', async (t) => {
  const directory = await tempDirectory(t);
  const manifest = JSON.parse(await readFile(path.resolve('test/fixtures/article.json'), 'utf8'));
  const revised = structuredClone(manifest.arms[0]); revised.id = 'revised'; revised.label = 'Revised'; revised.sources = [{ ...revised.sources[0] }];
  manifest.arms.push(revised);
  const manifestPath = path.join(directory, 'matched.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await copyFile(path.resolve('test/fixtures/cohort.json'), path.join(directory, 'cohort.json'));
  await copyFile(path.resolve('test/fixtures/article-source.md'), path.join(directory, 'article-source.md'));
  let calls = 0;
  const provider: DecisionProvider = { async decide(request) {
    if (request.question.type !== 'choice') throw new Error('Expected Choice question.');
    calls += 1;
    const choice = 'continue';
    return { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(request.question.options).map((id) => [id, id === choice ? 1 : 0])), attempts: 1, provider: 'laya', model: 'fake-local', checkpoint: 'local-test', latencyMs: 1, usage: {} };
  } };
  const manager = new RunManager({ providerFactory: () => provider });
  const started = await manager.startRun({ manifestPath, cohortPath: path.join(directory, 'cohort.json'), provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, headLimit: 192, tokenizerJsonPath: path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerSha256: 'a'.repeat(64), timeoutMs: 5000 }, outputDirectory: path.join(directory, 'runs'), maxCalls: 10, concurrency: 1 });
  let current = started;
  for (let attempt = 0; attempt < 100 && current.status === 'running'; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); current = await manager.runStatus(path.join(directory, 'runs'), started.runId); }
  assert.equal(current.status, 'completed', JSON.stringify(current.journeys));
  assert.equal(current.journeys.length, 4);
  assert.equal(calls, 8);
  assert.equal(new Set(current.journeys.map((journey) => `${journey.armId}/${journey.respondentId}`)).size, 4);
});

test('resume replays completed responses without charging the same respondent-task cell twice', async (t) => {
  const directory = await tempDirectory(t);
  let failedOnce = false;
  let expectLegacyPacket = false;
  let legacyPacketHadTypedResponses = false;
  let entryCalls = 0;
  let laterCalls = 0;
  const provider: DecisionProvider = { async decide(request) {
    if (expectLegacyPacket && request.question.id === 'investigation-response') {
      legacyPacketHadTypedResponses ||= 'responses' in (request.state.trajectory as object);
    }
    if (request.question.type !== 'choice') throw new Error('Expected Choice question.');
    if (request.question.id === 'entry-response') entryCalls += 1; else laterCalls += 1;
    if (request.question.id === 'investigation-response' && !failedOnce) { failedOnce = true; throw Object.assign(new Error('temporary failure'), { attempts: 0 }); }
    const choice = 'continue';
    return { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(request.question.options).map((id) => [id, id === choice ? 1 : 0])), attempts: 1, provider: 'laya', model: 'fake-local', checkpoint: 'local-test', latencyMs: 1, usage: {} };
  } };
  const manager = new RunManager({ providerFactory: () => provider });
  const started = await manager.startRun({ manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, headLimit: 192, tokenizerJsonPath: path.resolve('test/fixtures/laya-tokenizer.json'), tokenizerSha256: 'a'.repeat(64), timeoutMs: 5000 }, outputDirectory: directory, maxCalls: 10, concurrency: 1 });
  let current = started;
  for (let attempt = 0; attempt < 100 && current.status === 'running'; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); current = await manager.runStatus(directory, started.runId); }
  assert.equal(current.status, 'partial');
  const study = await loadStudy(path.resolve('test/fixtures/article.json'), path.resolve('test/fixtures/cohort.json'));
  const legacyStimulus = legacyChoiceStimulusFingerprint(study.manifest, study.cohort, legacyPromptContractHash);
  const legacyRequest = compileDecisionPacket(study.manifest.arms[0]!, study.respondents[0]!, study.manifest.arms[0]!.tasks[0]!.id,
    [{ type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' }]);
  const store = new CheckpointStore(directory);
  const v2Checkpoint = await store.read(started.runId);
  v2Checkpoint.formatVersion = 2 as never;
  v2Checkpoint.stimulusFingerprint = legacyStimulus;
  const legacyLayaIdentity = { kind: 'laya' as const, checkpoint: 'local-test', contextLimit: 4096, headLimit: 192, tokenizerSha256: 'a'.repeat(64) };
  v2Checkpoint.executionFingerprint = legacyExecutionFingerprint(legacyStimulus, legacyLayaIdentity);
  const firstDecision = v2Checkpoint.journeys.find((journey) => journey.decisions.length)?.decisions[0];
  assert.ok(firstDecision);
  firstDecision.requestFingerprint = legacyChoiceRequestFingerprint(legacyRequest);
  const rawCheckpoint = JSON.parse(JSON.stringify(v2Checkpoint)) as Record<string, unknown>;
  rawCheckpoint.budget = { maxCalls: 10, usedCalls: v2Checkpoint.budget.usedCalls, reservedCalls: 0,
    remainingCalls: 10 - v2Checkpoint.budget.usedCalls, billedUsd: 0, reservedUsd: 0,
    unpricedReservations: 0, overspendUsd: 0, blocked: false };
  await writeFile(path.join(directory, `run-${started.runId}.json`), JSON.stringify(rawCheckpoint));
  expectLegacyPacket = true;
  await manager.resumeRun(directory, started.runId);
  for (let attempt = 0; attempt < 100; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); current = await manager.runStatus(directory, started.runId); if (current.status !== 'running') break; }
  assert.equal(current.status, 'completed', JSON.stringify(current.journeys));
  assert.equal(entryCalls, 2);
  assert.equal(laterCalls, 3);
  assert.equal(legacyPacketHadTypedResponses, false);
});
