import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RunCheckpoint } from '../src/infrastructure/checkpoint-store.js';
import { buildReport, compareReports, compareRunReports, getReport } from '../src/application/reports.js';
import { CheckpointStore, emptyBudgetSnapshot } from '../src/infrastructure/checkpoint-store.js';
import { loadStudy } from '../src/infrastructure/study-loader.js';
import { legacyPromptContractHash, promptContractHash } from '../src/domain/decision/prompt.js';
import { executionFingerprint, legacyChoiceStimulusFingerprint, stimulusFingerprint } from '../src/infrastructure/identity.js';

const decision = (choice: string) => ({ type: 'choice' as const, choice, probabilities: { continue: choice === 'continue' ? 1 : 0, leave: choice === 'leave' ? 1 : 0, unanswerable: choice === 'unanswerable' ? 1 : 0 }, attempts: 1, provider: 'jev' as const, model: 'jev-latest', latencyMs: 12, usage: {}, chargeStatus: 'billed' as const, chargeUsd: 0.001 });
async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceBytes = await readFile(path.resolve('test/fixtures/article-source.md'));
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  await writeFile(path.join(directory, 'article-source.md'), sourceBytes);
  await writeFile(path.join(directory, 'cohort.json'), await readFile(path.resolve('test/fixtures/cohort.json')));
  const manifestPath = path.resolve('test/fixtures/article.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  original.arms[0].tasks[0].comparisonKey = 'entry-choice'; original.arms[0].tasks[0].answerKeyOptionId = 'unanswerable'; original.arms[0].tasks[0].options.unanswerable = 'There is not enough information to decide.'; original.arms[0].presentation = { kind: 'sequence' };
  const revised = structuredClone(original.arms[0]); revised.tasks[0].comparisonKey = 'entry-choice'; revised.tasks[0].answerKeyOptionId = 'continue'; revised.tasks[0].options['clarify'] = 'Ask for a clearer explanation.'; revised.presentation = { kind: 'sequence' }; revised.id = 'revised'; revised.label = 'Revised'; revised.items[0].text += ' Clearer.'; revised.sources = [{ path: 'article-source.md', sha256: sourceHash }];
  delete revised.tasks[0].options.unanswerable;
  await writeFile(path.join(directory, 'study.json'), JSON.stringify({ ...original, arms: [original.arms[0], revised] }));
  const checkpoint: RunCheckpoint = {
    formatVersion: 3, runId: '53a0c895-695b-4bb5-a5e5-b9304fc8b2aa', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    manifestPath: path.join(directory, 'study.json'), cohortPath: path.join(directory, 'cohort.json'), outputDirectory: directory,
    provider: { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
    maxCalls: 10, maxUsd: 1, maxPerCallUsd: 0.1, concurrency: 2, stimulusFingerprint: '', executionFingerprint: '', sourceHashes: [],
    respondentIds: ['curious-outside-reader', 'craft-reader'], journeys: [
      { armId: 'original', respondentId: 'curious-outside-reader', status: 'completed', result: { events: [{ type: 'exposure', sequence: 0, nodeId: 'sequence-expose-symptom', itemId: 'symptom' }, { type: 'choice', sequence: 1, nodeId: 'sequence-ask-entry-response', taskId: 'entry-response', choice: 'unanswerable' }], outcome: 'completed', status: 'completed', decisionCount: 1 }, decisions: [{ decisionId: 'entry-response', requestFingerprint: 'd'.repeat(64), result: decision('unanswerable') }], attemptHistory: [], presentedTaskIds: ['entry-response'] },
      { armId: 'revised', respondentId: 'curious-outside-reader', status: 'completed', result: { events: [{ type: 'exposure', sequence: 0, nodeId: 'show-symptom', itemId: 'symptom' }, { type: 'choice', sequence: 1, nodeId: 'choose-entry', taskId: 'entry-response', choice: 'leave' }], outcome: 'left-early', status: 'completed', decisionCount: 1 }, decisions: [{ decisionId: 'entry-response', requestFingerprint: 'd'.repeat(64), result: decision('leave') }], attemptHistory: [], presentedTaskIds: ['entry-response'] },
      { armId: 'original', respondentId: 'craft-reader', status: 'partial', decisions: [{ decisionId: 'investigation-response', requestFingerprint: 'e'.repeat(64), result: decision('continue') }], attemptHistory: [], presentedTaskIds: ['entry-response', 'investigation-response'], failureKind: 'provider' },
    ], activeCellIds: [], cancellationRequested: false, budget: { ...emptyBudgetSnapshot(10, 1), usedCalls: 2, remainingCalls: 8, billedUsd: 0.002 },
  };
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  checkpoint.stimulusFingerprint = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  checkpoint.executionFingerprint = executionFingerprint(checkpoint.stimulusFingerprint, { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions' });
  checkpoint.sourceHashes = study.sources.map((source) => source.sha256);
  return { directory, checkpoint };
}
async function refreshStudyIdentity(checkpoint: RunCheckpoint): Promise<void> {
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  checkpoint.stimulusFingerprint = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  checkpoint.executionFingerprint = executionFingerprint(checkpoint.stimulusFingerprint, { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions' });
}

test('report keeps a per-arm matched denominator and answer-key scoring distinct', async (t) => {
  const { checkpoint } = await setup(t);
  const report = await buildReport(checkpoint);
  assert.equal(report.arms[0]?.denominator.intended, 2);
  assert.equal(report.arms[0]?.denominator.started, 2);
  assert.equal(report.arms[0]?.denominator.completed, 1);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.occurrences[0]?.completed, 1);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.occurrences[0]?.incomplete, 1);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.occurrences[0]?.correct, 1);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.occurrences[0]?.options.unanswerable?.count, 1);
  assert.equal(report.arms[1]?.taskResponses['entry-response']?.occurrences[0]?.incorrect, 1);
  assert.equal(report.arms[1]?.taskResponses['entry-response']?.occurrences[0]?.options.clarify?.count, 0);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.occurrences[0]?.options.unanswerable?.proportion, 1);
  assert.equal(report.arms[1]?.taskResponses['entry-response']?.occurrences[0]?.options.leave?.proportion, 1);
  assert.equal(report.arms[0]?.taskResponses['investigation-response']?.occurrences[0]?.notReached, 1);
  assert.equal(report.arms[0]?.taskResponses['investigation-response']?.occurrences[0]?.unscored, 1);
  assert.equal(report.providerEvidence.billedUsd, 0.002);
});

test('reports legacy version-2 Choice checkpoints with their original prompt and stimulus identity', async (t) => {
  const { checkpoint } = await setup(t);
  checkpoint.formatVersion = 2;
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  checkpoint.stimulusFingerprint = legacyChoiceStimulusFingerprint(study.manifest, study.cohort, legacyPromptContractHash);
  checkpoint.executionFingerprint = executionFingerprint(checkpoint.stimulusFingerprint, { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions' });
  const report = await buildReport(checkpoint);
  assert.equal(report.arms[0]?.taskResponses['entry-response']?.occurrences[0]?.completed, 1);
});

test('reports Score and Noul evidence with typed cohort summaries', async (t) => {
  const { checkpoint } = await setup(t);
  const manifest = JSON.parse(await readFile(checkpoint.manifestPath, 'utf8')) as { arms: Array<Record<string, unknown>> };
  const arm = manifest.arms[0]!;
  arm.tasks = [
    { id: 'tone', type: 'score', instructions: 'How professional?', rubric: ['casual', 'balanced', 'professional'], comparisonKey: 'tone' },
    { id: 'credibility', type: 'noul', instructions: 'Does the article feel credible?', criteria: { true: 'credible', false: 'not credible' }, comparisonKey: 'credibility' },
  ];
  arm.presentation = { kind: 'sequence' };
  await writeFile(checkpoint.manifestPath, JSON.stringify(manifest));
  const scoreResults = [1.25, 0.75];
  const noulResults = [0.8, 0.6];
  checkpoint.journeys = checkpoint.respondentIds.map((respondentId, index) => {
    const score = scoreResults[index]!;
    const low = Math.floor(score); const high = Math.ceil(score);
    const probabilities = { '0': 0, '1': 0, '2': 0 };
    if (low === high) probabilities[String(low) as keyof typeof probabilities] = 1;
    else { probabilities[String(low) as keyof typeof probabilities] = high - score; probabilities[String(high) as keyof typeof probabilities] = score - low; }
    const scoreResult = { type: 'score' as const, score, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' }, probabilities,
      attempts: 1, provider: 'jev' as const, model: 'jev-latest', latencyMs: 10, usage: {}, chargeStatus: 'billed' as const, chargeUsd: 0.001 };
    const noulResult = { type: 'noul' as const, noul: noulResults[index]!, attempts: 1, provider: 'jev' as const, model: 'jev-latest', latencyMs: 10, usage: {}, chargeStatus: 'billed' as const, chargeUsd: 0.001 };
    return { armId: 'original', respondentId, status: 'completed' as const,
      result: { events: [
        { type: 'response' as const, sequence: 0, nodeId: 'tone', taskId: 'tone', result: { type: 'score' as const, score, legend: scoreResult.legend, probabilities } },
        { type: 'response' as const, sequence: 1, nodeId: 'credibility', taskId: 'credibility', result: { type: 'noul' as const, noul: noulResult.noul } },
      ], outcome: 'completed', status: 'completed' as const, decisionCount: 2 },
      decisions: [
        { decisionId: 'tone', requestFingerprint: 'a'.repeat(64), result: scoreResult },
        { decisionId: 'credibility', requestFingerprint: 'b'.repeat(64), result: noulResult },
      ], attemptHistory: [], presentedTaskIds: ['tone', 'credibility'] };
  });
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  checkpoint.stimulusFingerprint = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  checkpoint.executionFingerprint = executionFingerprint(checkpoint.stimulusFingerprint, { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions' });
  checkpoint.sourceHashes = study.sources.map((source) => source.sha256);

  const report = await buildReport(checkpoint);
  const armReport = report.arms[0]!;
  assert.equal(armReport.taskResponses.tone?.occurrences[0]?.type, 'score');
  assert.equal(armReport.taskResponses.tone?.occurrences[0]?.meanScore, 1);
  assert.deepEqual(armReport.taskResponses.tone?.occurrences[0]?.rubricProbabilities, { '0': 0.125, '1': 0.75, '2': 0.125 });
  assert.equal(armReport.taskResponses.credibility?.occurrences[0]?.meanProbabilityTrue, 0.7);
  assert.equal(armReport.journeys[0]?.responses[0]?.answer.type, 'score');
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

test('Choice agreement compares selected options rather than confidence evidence', async (t) => {
  const { checkpoint } = await setup(t);
  const manifest = JSON.parse(await readFile(checkpoint.manifestPath, 'utf8')) as { arms: Array<{ tasks: Array<{ options: Record<string, string> }> }> };
  manifest.arms[1]!.tasks[0]!.options = structuredClone(manifest.arms[0]!.tasks[0]!.options);
  await writeFile(checkpoint.manifestPath, JSON.stringify(manifest));
  await refreshStudyIdentity(checkpoint);
  const left = checkpoint.journeys.find((cell) => cell.armId === 'original' && cell.respondentId === 'curious-outside-reader')!;
  const right = checkpoint.journeys.find((cell) => cell.armId === 'revised' && cell.respondentId === 'curious-outside-reader')!;
  left.decisions[0]!.result = { ...decision('unanswerable'), probabilities: { unanswerable: 0.7, continue: 0.2, leave: 0.1 }, confidence: 0.7 };
  right.decisions[0]!.result = { ...decision('leave'), probabilities: { leave: 0.6, continue: 0.3, clarify: 0.1 }, confidence: 0.6 };
  const comparison = compareReports(await buildReport(checkpoint), 'original', 'revised');
  assert.equal(comparison.matched.find((item) => item.respondentId === 'curious-outside-reader')?.taskComparisons[0]?.agreement, false);
  right.decisions[0]!.result = { ...decision('unanswerable'), probabilities: { unanswerable: 0.6, continue: 0.3, leave: 0.1 }, confidence: 0.6 };
  const sameChoice = compareReports(await buildReport(checkpoint), 'original', 'revised');
  assert.equal(sameChoice.matched.find((item) => item.respondentId === 'curious-outside-reader')?.taskComparisons[0]?.agreement, true);
});

test('reconstructs partial journey event paths from durable presentations and decisions', async (t) => {
  const { checkpoint } = await setup(t);
  const manifest = JSON.parse(await readFile(checkpoint.manifestPath, 'utf8')) as { arms: Array<{ presentation: unknown }> };
  manifest.arms[0]!.presentation = { kind: 'sequence' };
  await writeFile(checkpoint.manifestPath, JSON.stringify(manifest));
  await refreshStudyIdentity(checkpoint);
  const partialCell = checkpoint.journeys.find((cell) => cell.armId === 'original' && cell.respondentId === 'craft-reader')!;
  partialCell.decisions = [{ decisionId: 'entry-response', requestFingerprint: 'f'.repeat(64), result: decision('continue') }];
  partialCell.presentedTaskIds = ['entry-response', 'investigation-response'];
  const report = await buildReport(checkpoint);
  const partial = report.arms[0]?.journeys.find((journey) => journey.respondentId === 'craft-reader');
  assert.deepEqual(partial?.events.map((event) => (event as { type?: string }).type), ['exposure', 'exposure', 'exposure', 'exposure', 'response', 'pending-response']);
  const otherRun = structuredClone(report);
  otherRun.runId = 'a0ba155b-9465-4a43-b77b-369e783bdd42';
  const comparedPartial = compareRunReports(report, 'original', otherRun, 'original').matched.find((item) => item.respondentId === 'craft-reader');
  assert.deepEqual(comparedPartial?.leftJourneyPath.events, comparedPartial?.rightJourneyPath.events);
});

test('reconstructs only graph exposures supported by the next durably presented task', async (t) => {
  const { checkpoint } = await setup(t);
  const fixture = JSON.parse(await readFile(path.resolve('test/fixtures/article.json'), 'utf8')) as { arms: Array<{ presentation: { transitions: Array<Record<string, string>> } }> };
  const manifest = JSON.parse(await readFile(checkpoint.manifestPath, 'utf8')) as { arms: Array<{ presentation: unknown }> };
  manifest.arms[0]!.presentation = fixture.arms[0]!.presentation;
  (manifest.arms[0]!.presentation as { transitions: Array<Record<string, string>> }).transitions.push({ fromNodeId: 'choose-entry', optionId: 'unanswerable', toNodeId: 'left' });
  await writeFile(checkpoint.manifestPath, JSON.stringify(manifest));
  await refreshStudyIdentity(checkpoint);
  const report = await buildReport(checkpoint);
  const partial = report.arms[0]?.journeys.find((journey) => journey.respondentId === 'craft-reader');
  assert.deepEqual(partial?.events.map((event) => (event as { type?: string }).type), ['exposure', 'pending-response', 'exposure', 'response']);
  assert.deepEqual(partial?.events.filter((event) => (event as { type?: string }).type === 'exposure').map((event) => (event as { itemId: string }).itemId), ['symptom', 'investigation']);
});

test('routes repeated task nodes using the decision stored for that occurrence', async (t) => {
  const { checkpoint } = await setup(t);
  const manifest = JSON.parse(await readFile(checkpoint.manifestPath, 'utf8')) as { arms: Array<{ presentation: unknown }> };
  manifest.arms[0]!.presentation = {
    kind: 'graph', entryNodeId: 'show-start', maxDecisions: 3,
    nodes: [
      { id: 'show-start', kind: 'expose', itemId: 'symptom' }, { id: 'ask-one', kind: 'ask', taskId: 'entry-response' },
      { id: 'show-first-a', kind: 'expose', itemId: 'investigation' }, { id: 'show-first-b', kind: 'expose', itemId: 'repair' }, { id: 'show-first-c', kind: 'expose', itemId: 'test-notes' },
      { id: 'ask-two', kind: 'ask', taskId: 'entry-response' },
      { id: 'show-second-a', kind: 'expose', itemId: 'repair' }, { id: 'show-second-b', kind: 'expose', itemId: 'test-notes' }, { id: 'show-second-c', kind: 'expose', itemId: 'symptom' },
      { id: 'ask-three', kind: 'ask', taskId: 'investigation-response' }, { id: 'done', kind: 'terminal', outcome: 'done' },
    ],
    transitions: [
      { fromNodeId: 'show-start', toNodeId: 'ask-one' },
      { fromNodeId: 'ask-one', optionId: 'continue', toNodeId: 'show-first-a' }, { fromNodeId: 'ask-one', optionId: 'leave', toNodeId: 'show-first-b' }, { fromNodeId: 'ask-one', optionId: 'unanswerable', toNodeId: 'show-first-c' },
      { fromNodeId: 'show-first-a', toNodeId: 'ask-two' }, { fromNodeId: 'show-first-b', toNodeId: 'ask-two' }, { fromNodeId: 'show-first-c', toNodeId: 'ask-two' },
      { fromNodeId: 'ask-two', optionId: 'continue', toNodeId: 'show-second-a' }, { fromNodeId: 'ask-two', optionId: 'leave', toNodeId: 'show-second-b' }, { fromNodeId: 'ask-two', optionId: 'unanswerable', toNodeId: 'show-second-c' },
      { fromNodeId: 'show-second-a', toNodeId: 'ask-three' }, { fromNodeId: 'show-second-b', toNodeId: 'ask-three' }, { fromNodeId: 'show-second-c', toNodeId: 'ask-three' },
      { fromNodeId: 'ask-three', optionId: 'continue', toNodeId: 'done' }, { fromNodeId: 'ask-three', optionId: 'leave', toNodeId: 'done' }, { fromNodeId: 'ask-three', optionId: 'open-notes', toNodeId: 'done' },
    ],
  };
  await writeFile(checkpoint.manifestPath, JSON.stringify(manifest));
  await refreshStudyIdentity(checkpoint);
  const partialCell = checkpoint.journeys.find((cell) => cell.armId === 'original' && cell.respondentId === 'craft-reader')!;
  partialCell.decisions = [
    { decisionId: 'entry-response', requestFingerprint: '1'.repeat(64), result: decision('continue') },
    { decisionId: 'entry-response', requestFingerprint: '2'.repeat(64), result: decision('leave') },
  ];
  partialCell.presentedTaskIds = ['entry-response', 'entry-response', 'investigation-response'];
  const report = await buildReport(checkpoint);
  const events = report.arms[0]?.journeys.find((journey) => journey.respondentId === 'craft-reader')?.events as Array<{ type: string; itemId?: string; result?: { choice?: string } }>;
  assert.deepEqual(events.filter((event) => event.type === 'exposure').map((event) => event.itemId), ['symptom', 'investigation', 'test-notes']);
  assert.deepEqual(events.filter((event) => event.type === 'response').map((event) => event.result?.choice), ['continue', 'leave']);
  assert.equal(events.at(-1)?.type, 'pending-response');
});
test('does not pool repeated Choice outcomes when option meanings changed', async (t) => {
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
  assert.equal(summary[1]?.comparableResponses, 0);
  assert.equal(summary[1]?.unpairedResponses, 1);
  assert.deepEqual(summary[1]?.optionTransitions, {});
  const originalTask = report.arms[0]?.taskResponses['entry-response']?.occurrences;
  assert.equal(originalTask?.[0]?.reached, 2);
  assert.equal(originalTask?.[0]?.completed, 1);
  assert.equal(originalTask?.[0]?.incomplete, 1);
  assert.equal(originalTask?.[0]?.notReached, 0);
  assert.equal(originalTask?.[1]?.reached, 1);
  assert.equal(originalTask?.[1]?.completed, 1);
  assert.equal(originalTask?.[1]?.notReached, 1);
});
test('compares independent runs only for an identical cohort and equivalent typed task meaning', async (t) => {
  const report = await buildReport((await setup(t)).checkpoint);
  const secondRun = structuredClone(report);
  secondRun.runId = 'a0ba155b-9465-4a43-b77b-369e783bdd42';
  const comparison = compareRunReports(report, 'original', secondRun, 'revised');
  assert.equal(comparison.matchedRespondents, 2);
  assert.equal(comparison.comparisonTasks[0]?.pairedResponses, 1);
  assert.equal(comparison.comparisonTasks[0]?.comparableResponses, 0);
  assert.equal(comparison.comparisonTasks[0]?.nonComparableResponses, 1);
  assert.deepEqual(comparison.comparisonTasks[0]?.choiceTransitions, {});
  assert.equal(comparison.differences.stimulusItems.length, 1);
  assert.deepEqual(comparison.differences.presentation, null);
  assert.deepEqual(comparison.differences.tasks[0]?.fields, ['options']);
  assert.equal(comparison.comparisonTasks[0]?.profileGroups.find((group) => group.group === 'all')?.denominator, 2);
  assert.ok(comparison.comparisonTasks[0]?.profileGroups.some((group) => group.group.startsWith('archetype:')));
  secondRun.provider.model = 'different-model'; secondRun.status = 'partial';
  const withRunDifferences = compareRunReports(report, 'original', secondRun, 'revised');
  assert.notEqual(withRunDifferences.differences.provider, null);
  assert.deepEqual(withRunDifferences.differences.runStatus, { left: report.status, right: 'partial' });
  assert.ok(withRunDifferences.differences.completion.left.intended > 0);
  assert.throws(() => compareRunReports(report, 'original', report, 'revised'), /distinct run IDs/i);
  assert.throws(() => compareRunReports(report, 'original', { ...secondRun, cohortFingerprint: 'f'.repeat(64) }, 'revised'), /same frozen respondent cohort/i);
  const changedJourney = structuredClone(secondRun);
  changedJourney.arms[1]!.presentation = { kind: 'sequence', itemOrder: ['symptom'] };
  changedJourney.arms[1]!.journeys[0]!.presentedTaskIds = [];
  changedJourney.arms[1]!.journeys[0]!.responses = [];
  const journeyComparison = compareRunReports(report, 'original', changedJourney, 'revised');
  assert.notEqual(journeyComparison.differences.presentation, null);
  const curiousReader = journeyComparison.matched.find((item) => item.respondentId === 'curious-outside-reader');
  const oneSided = curiousReader?.taskComparisons.find((item) => item.comparisonKey === 'entry-choice');
  assert.equal(oneSided?.leftOutcome, 'completed');
  assert.equal(oneSided?.rightOutcome, 'not-reached');
  assert.ok(curiousReader?.leftJourneyPath.events.length);
});
test('cross-run comparison preserves comparable Score and Noul deltas', async (t) => {
  const report = await buildReport((await setup(t)).checkpoint);
  const secondRun = structuredClone(report);
  secondRun.runId = 'a0ba155b-9465-4a43-b77b-369e783bdd42';
  for (const arm of [report.arms[0]!, secondRun.arms[0]!]) {
    arm.tasks[0] = { id: 'tone', type: 'score', comparisonKey: 'typed-result', instructions: 'How professional?', rubric: ['casual', 'balanced', 'professional'] };
    const response = arm.journeys[0]!.responses[0]!;
    response.comparisonKey = 'typed-result'; response.taskId = 'tone'; response.occurrence = 1;
    response.answer = { type: 'score', score: arm === report.arms[0] ? 1.25 : 1.75, legend: { '0': 'casual', '1': 'balanced', '2': 'professional' }, probabilities: { '0': 0, '1': 0.25, '2': 0.75 } };
  }
  const score = compareRunReports(report, 'original', secondRun, 'original');
  assert.equal(score.comparisonTasks[0]?.meanScoreDifference, 0.5);
  for (const arm of [report.arms[0]!, secondRun.arms[0]!]) {
    arm.tasks[0] = { id: 'truth', type: 'noul', comparisonKey: 'typed-result', instructions: 'Is it credible?', criteria: { true: 'credible', false: 'not credible' } };
    const response = arm.journeys[0]!.responses[0]!;
    response.taskId = 'truth'; response.answer = { type: 'noul', noul: arm === report.arms[0] ? 0.4 : 0.8 };
  }
  const noul = compareRunReports(report, 'original', secondRun, 'original');
  assert.ok(Math.abs((noul.comparisonTasks[0]?.meanProbabilityTrueDifference ?? 0) - 0.4) < 1e-8);
});
test('rejects reports when the manifest changes after the run', async (t) => {
  const { checkpoint } = await setup(t);
  const manifest = JSON.parse(await readFile(checkpoint.manifestPath, 'utf8'));
  manifest.arms[0].tasks[0].options.continue = 'Changed after execution.';
  await writeFile(checkpoint.manifestPath, JSON.stringify(manifest));
  await assert.rejects(buildReport(checkpoint), /inputs or provider settings changed/i);
});
test('includes a declared comparison task when neither arm produced a response', async (t) => {
  const { checkpoint } = await setup(t);
  for (const journey of checkpoint.journeys) { journey.decisions = []; journey.presentedTaskIds = []; }
  for (const armId of ['original', 'revised']) {
    const journey = checkpoint.journeys.find((cell) => cell.armId === armId && cell.respondentId === 'curious-outside-reader')!;
    journey.presentedTaskIds = ['entry-response', 'entry-response'];
  }
  const report = await buildReport(checkpoint);
  const comparison = compareReports(report, 'original', 'revised');
  assert.equal(comparison.comparisonTasks.length, 2);
  assert.equal(comparison.comparisonTasks[0]?.leftResponses, 0);
  assert.equal(comparison.comparisonTasks[0]?.rightResponses, 0);
  assert.equal(comparison.comparisonTasks[1]?.occurrence, 2);
  assert.equal(comparison.comparisonTasks[1]?.leftResponses, 0);
  assert.equal(comparison.comparisonTasks[1]?.rightResponses, 0);
});
test('getReport reads the durable checkpoint through the checkpoint store', async (t) => {
  const { directory, checkpoint } = await setup(t);
  await new CheckpointStore(directory).create(checkpoint);
  assert.equal((await getReport(directory, checkpoint.runId)).runId, checkpoint.runId);
});
