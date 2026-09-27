import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { runCli } from '../src/entrypoints/cli.js';
import { RunManager, checkStudy } from '../src/application/run-manager.js';
import { CheckpointStore, emptyBudgetSnapshot } from '../src/infrastructure/checkpoint-store.js';
import { ProcessLock, ProcessLockError } from '../src/infrastructure/process-lock.js';

const missingKey = 'SHEG_PRELAUNCH_MISSING_KEY';

test('CLI start rejects a missing Jev key before creating a run', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-missing-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'run.json');
  const outputDirectory = path.join(directory, 'runs');
  await writeFile(configPath, JSON.stringify({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    outputDirectory, maxCalls: 4, maxUsd: 0.1, maxPerCallUsd: 0.01,
    provider: { kind: 'jev', model: 'test-jev', keyEnv: missingKey, endpoint: 'https://openrouter.ai/api/alpha/decisions', timeoutMs: 5000 },
  }));
  const errors: string[] = []; const output: string[] = [];
  const exitCode = await runCli(['start', '--config', configPath], { out: (value) => { output.push(value); return true; }, error: (value) => { errors.push(value); return true; } });
  if (exitCode === 0) {
    const runId = JSON.parse(output[0] ?? '{}').runId as string;
    await runCli(['cancel', '--output', outputDirectory, '--run-id', runId], { out: () => true, error: () => true });
  }
  assert.equal(exitCode, 1);
  assert.match(JSON.parse(errors[0] ?? '{}').error, /SHEG_PRELAUNCH_MISSING_KEY.*not set/);
  assert.deepEqual(await new CheckpointStore(outputDirectory).list(), []);
});

test('CLI reconcile clears an uncertain charge and persists its verified amount', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-cli-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, runId } = await createBlockedRun(directory);
  const output: string[] = [];
  const exitCode = await runCli(['reconcile', '--output', directory, '--run-id', runId, '--unpriced-usd', '0.003'], {
    out: (value) => { output.push(value); return true; }, error: (value) => { output.push(value); return true; },
  });
  assert.equal(exitCode, 0, output.join('\n'));
  const reported = JSON.parse(output[0] ?? '{}') as { budget: { blocked: boolean; billedUsd: number; unpricedReservations: number } };
  assert.equal(reported.budget.blocked, false);
  assert.equal(reported.budget.billedUsd, 0.003);
  assert.equal(reported.budget.unpricedReservations, 0);
  assert.deepEqual((await store.read(runId)).budget, reported.budget);
});

test('MCP poll_reconcile clears an uncertain charge in a persisted run', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-mcp-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, runId } = await createBlockedRun(directory);
  const client = new Client({ name: 'sheg-reconcile-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('src/entrypoints/mcp.ts')], cwd: process.cwd() });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const result = await client.callTool({ name: 'poll_reconcile', arguments: { outputDirectory: directory, runId, unpricedUsd: 0.004 } });
  assert.equal(result.isError ?? false, false);
  const checkpoint = await store.read(runId);
  assert.equal(checkpoint.budget.blocked, false);
  assert.equal(checkpoint.budget.billedUsd, 0.004);
  assert.equal(checkpoint.budget.unpricedReservations, 0);
});

test('reconciliation refuses a run that is still marked running', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-running-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, runId } = await createBlockedRun(directory);
  await store.update(runId, (current) => ({ ...current, status: 'running' }));
  await assert.rejects(new RunManager().reconcileRun(directory, runId, 0.004), /stopped partial, failed, or cancelled run/);
  assert.equal((await store.read(runId)).budget.blocked, true);
});

test('a cancelled run can still settle an uncertain provider charge', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-cancelled-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, runId } = await createBlockedRun(directory);
  await store.update(runId, (current) => ({ ...current, status: 'cancelled', cancellationRequested: true }));
  const reconciled = await new RunManager().reconcileRun(directory, runId, 0.002);
  assert.equal(reconciled.status, 'cancelled');
  assert.equal(reconciled.budget.blocked, false);
  assert.equal(reconciled.budget.billedUsd, 0.002);
  assert.equal((await store.read(runId)).budget.unpricedReservations, 0);
});

test('resume rejects a missing Jev key before relaunching a partial run', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-resume-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, runId } = await createBlockedRun(directory);
  await store.update(runId, (current) => ({ ...current, budget: { ...current.budget, reservedUsd: 0, unpricedReservations: 0, blocked: false } }));
  const manager = new RunManager();
  let failure: unknown;
  try { await manager.resumeRun(directory, runId); } catch (error) { failure = error; }
  if (!failure) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const lock = await ProcessLock.acquire(directory, `run-${runId}`);
        await lock.release();
        break;
      } catch (error) {
        if (!(error instanceof ProcessLockError) || attempt === 99) throw error;
        await delay(10);
      }
    }
  }
  assert.match(failure instanceof Error ? failure.message : '', /SHEG_PRELAUNCH_MISSING_KEY.*not set/);
  assert.equal((await store.read(runId)).status, 'partial');
});

async function createBlockedRun(directory: string): Promise<{ store: CheckpointStore; runId: string }> {
  const checked = await checkStudy({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'),
    outputDirectory: directory, maxCalls: 4, maxUsd: 0.1, maxPerCallUsd: 0.01,
    provider: { kind: 'jev', model: 'test-jev', keyEnv: missingKey, endpoint: 'https://openrouter.ai/api/alpha/decisions', timeoutMs: 5000 },
  });
  const store = new CheckpointStore(directory);
  const budget = { ...emptyBudgetSnapshot(4, 0.1), usedCalls: 1, remainingCalls: 3, reservedUsd: 0.01, unpricedReservations: 1, blocked: true };
  const checkpoint = await store.create({
    status: 'partial', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    manifestPath: checked.config.manifestPath, cohortPath: checked.config.cohortPath, outputDirectory: directory,
    provider: checked.config.provider, maxCalls: 4, maxUsd: 0.1, maxPerCallUsd: 0.01, concurrency: 1,
    stimulusFingerprint: checked.stimulusFingerprint, executionFingerprint: checked.executionFingerprint,
    sourceHashes: checked.study.sources.map((source) => source.sha256),
    respondentIds: checked.study.respondents.map((respondent) => respondent.id),
    journeys: [], activeCellIds: [], cancellationRequested: false, budget,
  });
  return { store, runId: checkpoint.runId };
}
