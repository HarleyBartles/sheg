import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { loadStudy } from '../infrastructure/study-loader.js';
import { promptContractHash } from '../domain/decision/prompt.js';
import { CheckpointStore, type RunCheckpoint } from '../infrastructure/checkpoint-store.js';
import { executionFingerprint, stimulusFingerprint } from '../infrastructure/identity.js';

const responseSchema = z.object({ taskId: z.string(), comparisonKey: z.string().nullable(), occurrence: z.number().int().positive(), presentationOccurrence: z.number().int().positive(), requestFingerprint: z.string().regex(/^[a-f\d]{64}$/i), optionIds: z.array(z.string()), choice: z.string(), correct: z.boolean().nullable(), attempts: z.number().int(), latencyMs: z.number().nonnegative(), confidence: z.number().nullable(), chargeUsd: z.number().nonnegative().nullable() }).strict();
export const pollingReportSchema = z.object({
  formatVersion: z.literal(2), runId: z.string().uuid(), status: z.string(), stimulusFingerprint: z.string(), executionFingerprint: z.string(),
  provider: z.object({ kind: z.enum(['jev', 'laya']), model: z.string().nullable(), checkpoint: z.string().nullable() }).strict(),
  cohortSize: z.number().int().nonnegative(),
  arms: z.array(z.object({ id: z.string(), label: z.string(), denominator: z.object({ intended: z.number().int(), started: z.number().int(), completed: z.number().int(), excluded: z.number().int(), excludedByStatus: z.record(z.string(), z.number().int()) }).strict(),
    fingerprint: z.string(),
    sources: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()),
    stimulusItems: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
    tasks: z.array(z.object({ id: z.string(), comparisonKey: z.string().nullable(), instructions: z.string(), options: z.record(z.string(), z.string()) }).strict()),
    taskResponses: z.record(z.string(), z.object({ occurrences: z.array(z.object({ occurrence: z.number().int().positive(), reached: z.number().int(), completed: z.number().int(), incomplete: z.number().int(), notReached: z.number().int(), correct: z.number().int(), incorrect: z.number().int(), unscored: z.number().int(), options: z.record(z.string(), z.object({ count: z.number().int(), proportion: z.number().min(0).max(1) }).strict()) }).strict()) }).strict()),
    journeys: z.array(z.object({ respondentId: z.string(), archetypeId: z.string().nullable(), status: z.string(), outcome: z.string().nullable(), events: z.array(z.unknown()), responses: z.array(responseSchema) }).strict()),
  }).strict()),
  providerEvidence: z.object({ attempts: z.number().int(), billedUsd: z.number().nonnegative(), unknownCharges: z.number().int(), failedCells: z.number().int() }).strict(),
}).strict();
export type PollingReport = z.infer<typeof pollingReportSchema>;

export async function buildReport(checkpoint: RunCheckpoint): Promise<PollingReport> {
  const study = await loadStudy(checkpoint.manifestPath, checkpoint.cohortPath);
  const stimulus = stimulusFingerprint(study.manifest, study.cohort, promptContractHash());
  const identityProvider = checkpoint.provider.kind === 'laya'
    ? { kind: 'laya' as const, checkpoint: checkpoint.provider.checkpoint, contextLimit: checkpoint.provider.contextLimit, headLimit: checkpoint.provider.headLimit, tokenizerSha256: checkpoint.provider.tokenizerSha256, ...(checkpoint.provider.precision === undefined ? {} : { precision: checkpoint.provider.precision }) }
    : checkpoint.provider;
  if (stimulus !== checkpoint.stimulusFingerprint || executionFingerprint(stimulus, identityProvider) !== checkpoint.executionFingerprint ||
      study.sources.some((source, index) => source.sha256 !== checkpoint.sourceHashes[index]) || study.sources.length !== checkpoint.sourceHashes.length) {
    throw new Error('Study inputs or provider settings changed since this run was prepared; the report cannot be reproduced.');
  }
  const { cohort, manifest } = study;
  const profiles = new Map(cohort.respondents.map((respondent) => [respondent.id, respondent]));
  const arms = manifest.arms.map((arm) => {
    const taskMap = new Map(arm.tasks.map((task) => [task.id, task]));
    const journeys = cohort.respondents.map((respondent) => {
      const stored = checkpoint.journeys.find((journey) => journey.armId === arm.id && journey.respondentId === respondent.id);
      const decisions = stored?.decisions ?? [];
      const occurrenceByKey = new Map<string, number>();
      const presentationOccurrenceByTask = new Map<string, number>();
      const responses = decisions.map((checkpointDecision) => {
        const { decisionId, result } = checkpointDecision;
        const task = taskMap.get(decisionId);
        const key = task?.comparisonKey ?? '';
        const occurrence = (occurrenceByKey.get(key) ?? 0) + 1;
        occurrenceByKey.set(key, occurrence);
        const presentationOccurrence = (presentationOccurrenceByTask.get(decisionId) ?? 0) + 1;
        presentationOccurrenceByTask.set(decisionId, presentationOccurrence);
        return { taskId: decisionId, comparisonKey: task?.comparisonKey ?? null, occurrence, presentationOccurrence, requestFingerprint: checkpointDecision.requestFingerprint, optionIds: Object.keys(task?.options ?? {}), choice: result.choice,
          correct: task?.answerKeyOptionId ? result.choice === task.answerKeyOptionId : null, attempts: result.attempts, latencyMs: result.latencyMs,
          confidence: result.confidence ?? null, chargeUsd: result.chargeUsd ?? null };
      });
      return { respondentId: respondent.id, archetypeId: respondent.archetypeId ?? null, status: stored?.status ?? 'not-started', outcome: stored?.result?.outcome ?? null, events: stored?.result?.events ?? [], responses };
    });
    const excludedByStatus: Record<string, number> = {};
    for (const journey of journeys) if (journey.status !== 'completed') excludedByStatus[journey.status] = (excludedByStatus[journey.status] ?? 0) + 1;
    const taskResponses: PollingReport['arms'][number]['taskResponses'] = {};
    for (const task of arm.tasks) {
      const occurrenceCount = Math.max(1, ...journeys.map((journey) => journey.responses.filter((response) => response.taskId === task.id).length), ...checkpoint.journeys.filter((journey) => journey.armId === arm.id).map((journey) => journey.presentedTaskIds.filter((taskId) => taskId === task.id).length));
      const occurrences = Array.from({ length: occurrenceCount }, (_, index) => {
        const occurrence = index + 1;
        const reachedJourneys = journeys.filter((journey) => journey.responses.some((response) => response.taskId === task.id && response.presentationOccurrence === occurrence) ||
          (checkpoint.journeys.find((cell) => cell.armId === arm.id && cell.respondentId === journey.respondentId)?.presentedTaskIds.filter((taskId) => taskId === task.id).length ?? 0) >= occurrence);
        const responses = reachedJourneys.flatMap((journey) => journey.responses.filter((response) => response.taskId === task.id && response.presentationOccurrence === occurrence));
        const counts: Record<string, number> = {};
        for (const response of responses) counts[response.choice] = (counts[response.choice] ?? 0) + 1;
        const options = Object.fromEntries(Object.keys(task.options).map((optionId) => {
          const count = counts[optionId] ?? 0;
          return [optionId, { count, proportion: responses.length ? count / responses.length : 0 }];
        }));
        return { occurrence, reached: reachedJourneys.length, completed: responses.length, incomplete: reachedJourneys.length - responses.length, notReached: cohort.respondents.length - reachedJourneys.length,
          correct: responses.filter((response) => response.correct === true).length, incorrect: responses.filter((response) => response.correct === false).length,
          unscored: responses.filter((response) => response.correct === null).length, options };
      });
      taskResponses[task.id] = { occurrences };
    }
    const completed = journeys.filter((journey) => journey.status === 'completed').length;
    const started = checkpoint.journeys.filter((journey) => journey.armId === arm.id).length;
    const snapshot = { sources: arm.sources, items: arm.items, tasks: arm.tasks };
    const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    return { id: arm.id, label: arm.label, fingerprint, sources: arm.sources, stimulusItems: arm.items, tasks: arm.tasks.map((task) => ({ id: task.id, comparisonKey: task.comparisonKey ?? null, instructions: task.instructions, options: task.options })), denominator: { intended: cohort.respondents.length, started, completed, excluded: cohort.respondents.length - completed, excludedByStatus }, taskResponses, journeys };
  });
  const rawProvider = checkpoint.provider;
  return pollingReportSchema.parse({ formatVersion: 2, runId: checkpoint.runId, status: checkpoint.status, stimulusFingerprint: checkpoint.stimulusFingerprint, executionFingerprint: checkpoint.executionFingerprint,
    provider: { kind: rawProvider.kind, model: rawProvider.kind === 'jev' ? rawProvider.model : null, checkpoint: rawProvider.kind === 'laya' ? rawProvider.checkpoint : null }, cohortSize: profiles.size, arms,
    providerEvidence: { attempts: checkpoint.budget.usedCalls, billedUsd: checkpoint.budget.billedUsd,
      unknownCharges: checkpoint.budget.unpricedReservations, failedCells: checkpoint.journeys.filter((journey) => journey.status === 'failed').length } });
}
export async function getReport(outputDirectory: string, runId: string): Promise<PollingReport> { return buildReport(await new CheckpointStore(path.resolve(outputDirectory)).read(runId)); }

export function compareReports(report: PollingReport, leftArmId: string, rightArmId: string) {
  if (leftArmId === rightArmId) throw new Error('Choose two distinct arms from the same run.');
  const left = report.arms.find((arm) => arm.id === leftArmId);
  const right = report.arms.find((arm) => arm.id === rightArmId);
  if (!left || !right) throw new Error('Both arm IDs must exist in the same report.');
  const rightByRespondent = new Map(right.journeys.map((journey) => [journey.respondentId, journey]));
  const matched = left.journeys.flatMap((journey) => {
    const other = rightByRespondent.get(journey.respondentId);
    if (!other) return [];
    const otherResponses = new Map(other.responses.filter((response) => response.comparisonKey).map((response) => [`${response.comparisonKey}:${response.occurrence}`, response]));
    const taskComparisons = journey.responses.filter((response) => response.comparisonKey).flatMap((response) => {
      const counterpart = otherResponses.get(`${response.comparisonKey}:${response.occurrence}`);
      if (!counterpart) return [];
      const commonOptionIds = response.optionIds.filter((id) => counterpart.optionIds.includes(id));
      return [{ comparisonKey: response.comparisonKey, occurrence: response.occurrence, leftChoice: response.choice, rightChoice: counterpart.choice, comparable: commonOptionIds.includes(response.choice) && commonOptionIds.includes(counterpart.choice), agreement: response.choice === counterpart.choice }];
    });
    return [{ respondentId: journey.respondentId, taskComparisons }];
  });
  const comparisonKeys = new Set([
    ...[...left.journeys, ...right.journeys].flatMap((journey) => journey.responses.filter((response) => response.comparisonKey).map((response) => `${response.comparisonKey}:${response.occurrence}`)),
    ...[left, right].flatMap((arm) => arm.tasks.flatMap((task) => task.comparisonKey
      ? (arm.taskResponses[task.id]?.occurrences ?? []).map((occurrence) => `${task.comparisonKey}:${occurrence.occurrence}`)
      : [])),
  ]);
  const leftResponseByCell = indexResponses(left.journeys);
  const rightResponseByCell = indexResponses(right.journeys);
  const comparisonRespondentIds = new Set([...left.journeys, ...right.journeys].map((journey) => journey.respondentId));
  const comparisonTasks = [...comparisonKeys].sort().map((key) => {
    const [comparisonKey = '', occurrenceText = '1'] = key.split(':');
    const occurrence = Number(occurrenceText);
    const optionTransitions: Record<string, Record<string, number>> = {};
    let leftResponses = 0; let rightResponses = 0; let pairedResponses = 0; let comparableResponses = 0;
    for (const respondentId of comparisonRespondentIds) {
      const cellKey = `${respondentId}\0${comparisonKey}\0${occurrence}`;
      const leftResponse = leftResponseByCell.get(cellKey);
      const rightResponse = rightResponseByCell.get(cellKey);
      if (leftResponse) leftResponses += 1;
      if (rightResponse) rightResponses += 1;
      if (!leftResponse || !rightResponse) continue;
      pairedResponses += 1;
      const commonOptionIds = leftResponse.optionIds.filter((id) => rightResponse.optionIds.includes(id));
      if (!commonOptionIds.includes(leftResponse.choice) || !commonOptionIds.includes(rightResponse.choice)) continue;
      comparableResponses += 1;
      const row = optionTransitions[leftResponse.choice] ??= {};
      row[rightResponse.choice] = (row[rightResponse.choice] ?? 0) + 1;
    }
    return { comparisonKey, occurrence, leftResponses, rightResponses, pairedResponses, comparableResponses, unpairedResponses: pairedResponses - comparableResponses, leftOnlyResponses: Math.max(0, leftResponses - pairedResponses), rightOnlyResponses: Math.max(0, rightResponses - pairedResponses), optionTransitions };
  });
  const leftByItem = new Map(left.stimulusItems.map((item) => [item.id, item.text]));
  const rightByItem = new Map(right.stimulusItems.map((item) => [item.id, item.text]));
  const itemChanges = [...new Set([...leftByItem.keys(), ...rightByItem.keys()])].flatMap((id) => leftByItem.get(id) === rightByItem.get(id) ? [] : [{ id, leftText: leftByItem.get(id) ?? null, rightText: rightByItem.get(id) ?? null }]);
  const leftSources = new Map(left.sources.map((source) => [source.path, source.sha256]));
  const rightSources = new Map(right.sources.map((source) => [source.path, source.sha256]));
  const sourceChanges = [...new Set([...leftSources.keys(), ...rightSources.keys()])].flatMap((sourcePath) => leftSources.get(sourcePath) === rightSources.get(sourcePath) ? [] : [{ path: sourcePath, leftSha256: leftSources.get(sourcePath) ?? null, rightSha256: rightSources.get(sourcePath) ?? null }]);
  const leftTasks = new Map(left.tasks.map((task) => [task.comparisonKey ?? task.id, task]));
  const rightTasks = new Map(right.tasks.map((task) => [task.comparisonKey ?? task.id, task]));
  const taskChanges = [...new Set([...leftTasks.keys(), ...rightTasks.keys()])].flatMap((key) => {
    const leftTask = leftTasks.get(key); const rightTask = rightTasks.get(key);
    if (!leftTask || !rightTask) return [{ comparisonKey: key, fields: ['task-presence'] }];
    const fields = (['instructions', 'options'] as const).filter((field) => JSON.stringify(leftTask[field]) !== JSON.stringify(rightTask[field]));
    return fields.length ? [{ comparisonKey: key, fields }] : [];
  });
  return { runId: report.runId, leftArmId, rightArmId, leftFingerprint: left.fingerprint, rightFingerprint: right.fingerprint, sourceChanges, itemChanges, taskChanges, matchedRespondents: matched.length, comparisonTasks, matched };
}

function indexResponses(journeys: PollingReport['arms'][number]['journeys']): Map<string, PollingReport['arms'][number]['journeys'][number]['responses'][number]> {
  const indexed = new Map<string, PollingReport['arms'][number]['journeys'][number]['responses'][number]>();
  for (const journey of journeys) {
    for (const response of journey.responses) {
      if (!response.comparisonKey) continue;
      indexed.set(`${journey.respondentId}\0${response.comparisonKey}\0${response.occurrence}`, response);
    }
  }
  return indexed;
}
