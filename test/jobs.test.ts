import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir as makeDirectory, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { CheckpointStore, emptyBudgetSnapshot, type RunCheckpoint } from '../src/infrastructure/checkpoint-store.js';
import { ProcessLock, ProcessLockError } from '../src/infrastructure/process-lock.js';
import { RunManager, checkStudy } from '../src/application/jobs.js';
import type { DecisionProvider } from '../src/domain/decision/contract.js';

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
    provider: { kind: 'jev', model: 'jev-latest', keyEnv: 'JEV_API_KEY', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
    maxCalls: 10, maxUsd: 1, maxPerCallUsd: 0.05, concurrency: 2,
    stimulusFingerprint: 'a'.repeat(64), executionFingerprint: 'b'.repeat(64),
    sourceHashes: ['c'.repeat(64)], readerIds: ['reader-a', 'reader-b'], journeys: [], activeReaderIds: [],
    cancellationRequested: false, budget: emptyBudgetSnapshot(10, 1),
    ...overrides,
  };
}

test('checkpoint store writes an atomic versioned record without source text or credentials', async (t) => {
  const directory = await tempDirectory(t);
  const store = new CheckpointStore(directory);
  const created = await store.create(checkpoint(directory));
  const loaded = await store.read(created.runId);
  assert.equal(loaded.formatVersion, 1);
  assert.equal(loaded.runId, created.runId);
  assert.deepEqual(await store.list(), [loaded]);
  const raw = await readFile(path.join(directory, `run-${created.runId}.json`), 'utf8');
  assert.doesNotMatch(raw, /JEV_API_KEY=.secret|source prose that should not persist/);
  assert.match(raw, /"keyEnv": "JEV_API_KEY"/);
  await assert.rejects(store.create(checkpoint(directory, { runId: created.runId })), /already exists/);
});

test('checkpoint rejects unrecognized fields and malformed provider provenance', async (t) => {
  const directory = await tempDirectory(t);
  const store = new CheckpointStore(directory);
  await assert.rejects(store.create({ ...checkpoint(directory), credential: 'do-not-store' } as never));
  await assert.rejects(store.create(checkpoint(directory, {
    provider: { kind: 'jev', model: 'jev-latest', keyEnv: 'JEV_API_KEY', endpoint: 'not-a-url', timeoutMs: 5000 },
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
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, timeoutMs: 5000 },
    outputDirectory: directory, maxCalls: 10,
  });
  assert.equal(checked.study.profiles.length, 2);
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
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, timeoutMs: 5000 },
    outputDirectory: path.join(directory, 'runs'), maxCalls: 10,
  }), /source/i);
  assert.deepEqual(await new CheckpointStore(path.join(directory, 'runs')).list(), []);
});

test('managed run checkpoints sequential provider decisions and reaches completed', async (t) => {
  const directory = await tempDirectory(t);
  const choices = ['continue', 'continue', 'continue', 'continue'];
  let calls = 0;
  const provider: DecisionProvider = { async decide(request) {
    const choice = choices[calls++];
    assert.ok(choice);
    const labels = Object.keys(request.question.criteria);
    const probabilities = Object.fromEntries(labels.map((label) => [label, label === choice ? 1 : 0]));
    return { choice, probabilities, attempts: 1, provider: 'laya', model: 'fake-local', checkpoint: 'local-test', latencyMs: 1, usage: {}, chargeStatus: 'not_billed' };
  } };
  const manager = new RunManager({ providerFactory: () => provider });
  const started = await manager.startRun({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-test', contextLimit: 4096, timeoutMs: 5000 },
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
