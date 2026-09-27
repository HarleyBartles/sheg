import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { RunCheckpoint } from '../src/infrastructure/checkpoint-store.js';
import { buildReport, compareReports, getReport } from '../src/application/reports.js';
import { CheckpointStore, emptyBudgetSnapshot } from '../src/infrastructure/checkpoint-store.js';

const result = (choice: string, confidence?: number, cost?: number) => ({
  choice, probabilities: { continue: choice === 'continue' ? 1 : 0, leave: choice === 'leave' ? 1 : 0 },
  ...(confidence === undefined ? {} : { confidence }), attempts: 2, provider: 'jev' as const, model: 'jev-latest', latencyMs: 12,
  usage: { inputTokens: 100, outputTokens: 10 }, chargeStatus: cost === undefined ? 'unknown' as const : 'billed' as const,
  ...(cost === undefined ? {} : { chargeUsd: cost }),
});

function makeCheckpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  const now = new Date().toISOString();
  return {
    formatVersion: 1, runId: '53a0c895-695b-4bb5-a5e5-b9304fc8b2aa', status: 'partial', createdAt: now, updatedAt: now,
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), outputDirectory: path.resolve('test/fixtures'),
    provider: { kind: 'jev', model: 'jev-latest', keyEnv: 'JEV_API_KEY', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
    maxCalls: 10, maxUsd: 1, maxPerCallUsd: 0.1, concurrency: 2,
    stimulusFingerprint: 'a'.repeat(64), executionFingerprint: 'b'.repeat(64), sourceHashes: ['c'.repeat(64)],
    readerIds: ['curious-outside-reader', 'craft-reader'],
    journeys: [
      { readerId: 'curious-outside-reader', status: 'completed', result: { events: [
        { type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' },
        { type: 'choice', sequence: 1, nodeId: 'choose-entry', decisionId: 'entry-response', choice: 'continue' },
      ], outcome: 'completed', status: 'completed', decisionCount: 1 }, decisions: [
        { decisionId: 'entry-response', result: result('continue', 0.8, 0.02) },
      ], attemptHistory: [] },
      { readerId: 'craft-reader', status: 'failed', decisions: [
        { decisionId: 'entry-response', result: result('leave') },
      ], attemptHistory: [], failureKind: 'unsupported-input' },
    ], activeReaderIds: [], cancellationRequested: false, budget: emptyBudgetSnapshot(10, 1),
    ...overrides,
  };
}

test('report keeps intended and completed denominators, outcome, archetype, stimulus, and provider evidence separate', async () => {
  const report = await buildReport(makeCheckpoint());
  assert.deepEqual(report.denominator, { intended: 2, completed: 1, excluded: 1, excludedByStatus: { failed: 1 } });
  assert.equal(report.outcomes.completed, 1);
  assert.equal(report.archetypes['curious-outsider']?.completed, 1);
  assert.equal(report.archetypes['craft-admirer']?.intended, 1);
  assert.deepEqual(report.items.symptom, { exposures: 1, readers: 1 });
  assert.equal(report.journeys[0]?.events.length, 2);
  assert.equal(report.providerEvidence.attempts, 4);
  assert.equal(report.providerEvidence.meanLatencyMs, 12);
  assert.equal(report.providerEvidence.inputTokens, 200);
  assert.equal(report.providerEvidence.confidence.mean, 0.8);
  assert.equal(report.providerEvidence.billedUsd, 0.02);
  assert.equal(report.providerEvidence.unknownCharges, 1);
  assert.equal(report.providerEvidence.unsupportedJourneys, 1);
  assert.doesNotMatch(JSON.stringify(report), /accuracy|calibration|publication score/);
});

test('local report identifies checkpoint while preserving unknown model revision', async () => {
  const local = makeCheckpoint({ provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'unknown-revision', contextLimit: 4096, timeoutMs: 5000 } });
  const report = await buildReport(local);
  assert.deepEqual(report.provider, { kind: 'laya', model: null, checkpoint: 'unknown-revision' });
  assert.deepEqual(report.providerEvidence.confidence, { count: 1, mean: 0.8 });
});

test('comparison requires matched stimulus and aligns completed readers only', async () => {
  const left = await buildReport(makeCheckpoint());
  const right = await buildReport(makeCheckpoint({ runId: '99c7803a-445d-4ad2-a6dd-23761eb804bd', provider: { kind: 'laya', baseUrl: 'http://127.0.0.1:8000', checkpoint: 'local-rev', contextLimit: 4096, timeoutMs: 5000 } }));
  const comparison = compareReports(left, right);
  assert.equal(comparison.matchedCompletedReaders, 1);
  assert.equal(comparison.readers[0]?.choiceAgreements, 1);
  assert.equal(comparison.readers[0]?.outcomeAgreement, true);
  assert.throws(() => compareReports(left, { ...right, stimulusFingerprint: 'd'.repeat(64) }), /different stimulus/);
});

test('getReport reads durable checkpoint through the checkpoint store', async (t) => {
  const directory = await mkdtemp(path.join(process.cwd(), 'test-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkpoint = makeCheckpoint({ outputDirectory: directory });
  await new CheckpointStore(directory).create(checkpoint);
  const report = await getReport(directory, checkpoint.runId);
  assert.equal(report.runId, checkpoint.runId);
  assert.equal(report.denominator.intended, 2);
});
