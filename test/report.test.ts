import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RunCheckpoint } from '../src/infrastructure/checkpoint-store.js';
import { buildReport, compareReports, getReport } from '../src/application/reports.js';
import { CheckpointStore, emptyBudgetSnapshot } from '../src/infrastructure/checkpoint-store.js';

const decision = (choice: string) => ({ choice, probabilities: { continue: choice === 'continue' ? 1 : 0, leave: choice === 'leave' ? 1 : 0, unanswerable: choice === 'unanswerable' ? 1 : 0 }, attempts: 1, provider: 'jev' as const, model: 'jev-latest', latencyMs: 12, usage: {}, chargeStatus: 'billed' as const, chargeUsd: 0.001 });
async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.resolve('test/fixtures/article.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  original.arms[0].tasks[0].comparisonKey = 'entry-choice'; original.arms[0].tasks[0].answerKeyOptionId = 'unanswerable'; original.arms[0].tasks[0].options.unanswerable = 'There is not enough information to decide.'; original.arms[0].presentation = { kind: 'sequence' };
  const revised = structuredClone(original.arms[0]); revised.tasks[0].comparisonKey = 'entry-choice'; revised.tasks[0].answerKeyOptionId = 'continue'; revised.tasks[0].options['clarify'] = 'Ask for a clearer explanation.'; revised.presentation = { kind: 'sequence' }; revised.id = 'revised'; revised.label = 'Revised'; revised.items[0].text += ' Clearer.'; revised.sources = [{ path: 'unused.md', sha256: 'c'.repeat(64) }];
  delete revised.tasks[0].options.unanswerable;
  await writeFile(path.join(directory, 'study.json'), JSON.stringify({ ...original, arms: [original.arms[0], revised] }));
  const checkpoint: RunCheckpoint = {
    formatVersion: 2, runId: '53a0c895-695b-4bb5-a5e5-b9304fc8b2aa', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    manifestPath: path.join(directory, 'study.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), outputDirectory: directory,
    provider: { kind: 'jev', model: 'jev-latest', keyEnv: 'JEV_API_KEY', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
    maxCalls: 10, maxUsd: 1, maxPerCallUsd: 0.1, concurrency: 2, stimulusFingerprint: 'a'.repeat(64), executionFingerprint: 'b'.repeat(64), sourceHashes: [],
    respondentIds: ['curious-outside-reader', 'craft-reader'], journeys: [
      { armId: 'original', respondentId: 'curious-outside-reader', status: 'completed', result: { events: [{ type: 'exposure', sequence: 0, nodeId: 'sequence-expose-symptom', itemId: 'symptom' }, { type: 'choice', sequence: 1, nodeId: 'sequence-ask-entry-response', taskId: 'entry-response', choice: 'unanswerable' }], outcome: 'completed', status: 'completed', decisionCount: 1 }, decisions: [{ decisionId: 'entry-response', requestFingerprint: 'd'.repeat(64), result: decision('unanswerable') }], attemptHistory: [], presentedTaskIds: ['entry-response'] },
      { armId: 'revised', respondentId: 'curious-outside-reader', status: 'completed', result: { events: [{ type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' }, { type: 'choice', sequence: 1, nodeId: 'choose-entry', taskId: 'entry-response', choice: 'leave' }], outcome: 'left-early', status: 'completed', decisionCount: 1 }, decisions: [{ decisionId: 'entry-response', requestFingerprint: 'd'.repeat(64), result: decision('leave') }], attemptHistory: [], presentedTaskIds: ['entry-response'] },
      { armId: 'original', respondentId: 'craft-reader', status: 'partial', decisions: [{ decisionId: 'investigation-response', requestFingerprint: 'e'.repeat(64), result: decision('continue') }], attemptHistory: [], presentedTaskIds: ['entry-response', 'investigation-response'], failureKind: 'provider' },
    ], activeCellIds: [], cancellationRequested: false, budget: { ...emptyBudgetSnapshot(10, 1), usedCalls: 2, remainingCalls: 8, billedUsd: 0.002 },
  };
  return { directory, checkpoint };
}

test('report keeps a per-arm matched denominator and answer-key scoring distinct', async (t) => {
  const { checkpoint } = await setup(t);
  const report = await buildReport(checkpoint);
  assert.equal(report.arms[0]?.denominator.intended, 2);
  assert.equal(report.arms[0]?.denominator.started, 2);
  assert.equal(report.arms[0]?.denominator.completed, 1);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.completed, 1);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.incomplete, 1);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.correct, 1);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.options.unanswerable?.count, 1);
  assert.equal(report.arms[1]?.taskResponses['entry-response']?.incorrect, 1);
  assert.equal(report.arms[1]?.taskResponses['entry-response']?.options.clarify?.count, 0);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.options.unanswerable?.proportion, 1);
  assert.equal(report.arms[1]?.taskResponses['entry-response']?.options.leave?.proportion, 1);
  assert.equal(report.arms[0]?.taskResponses['investigation-response']?.notReached, 1);
  assert.equal(report.arms[0]?.taskResponses['investigation-response']?.unscored, 1);
  assert.equal(report.providerEvidence.billedUsd, 0.002);
});
test('compares two arms within the same run by respondent and comparison key', async (t) => {
  const report = await buildReport((await setup(t)).checkpoint);
  const comparison = compareReports(report, 'original', 'revised');
  assert.equal(comparison.matchedRespondents, 2);
  assert.equal(comparison.matched[0]?.taskComparisons[0]?.agreement, false);
  assert.equal(comparison.comparisonTasks[0]?.leftResponses, 1);
  assert.equal(comparison.comparisonTasks[0]?.rightResponses, 1);
  assert.equal(comparison.comparisonTasks[0]?.unpairedResponses, 1);
  assert.deepEqual(comparison.comparisonTasks[0]?.optionTransitions, {});
  assert.equal(comparison.itemChanges.length, 1);
  assert.deepEqual(comparison.taskChanges[0]?.fields, ['options']);
  assert.throws(() => compareReports(report, 'original', 'missing'), /both arm IDs/i);
});
test('aligns repeated task presentations by occurrence order and counts only shared-option pairs', async (t) => {
  const { checkpoint } = await setup(t);
  for (const armId of ['original', 'revised']) {
    const journey = checkpoint.journeys.find((cell) => cell.armId === armId && cell.respondentId === 'curious-outside-reader')!;
    journey.decisions.push({ decisionId: 'entry-response', requestFingerprint: 'f'.repeat(64), result: decision('leave') });
    journey.presentedTaskIds.push('entry-response');
  }
  const report = await buildReport(checkpoint);
  const summary = compareReports(report, 'original', 'revised').comparisonTasks;
  assert.equal(summary.length, 2);
  assert.equal(summary[0]?.occurrence, 1);
  assert.equal(summary[0]?.unpairedResponses, 1);
  assert.equal(summary[1]?.occurrence, 2);
  assert.deepEqual(summary[1]?.optionTransitions, { leave: { leave: 1 } });
});
test('getReport reads the durable checkpoint through the checkpoint store', async (t) => {
  const { directory, checkpoint } = await setup(t);
  await new CheckpointStore(directory).create(checkpoint);
  assert.equal((await getReport(directory, checkpoint.runId)).runId, checkpoint.runId);
});
