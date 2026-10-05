import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { loadStudy } from '../../infrastructure/study-loader.js';
import { LegacyRunArchiveReader, contextFailureSchema, interruptionEvidenceSchema, runCheckpointSchema, type RunCheckpoint } from '../../infrastructure/legacy/run-archive.js';
import { executionFingerprint, respondentCohortFingerprint, stimulusFingerprint } from '../../infrastructure/identity.js';
import { decisionValueSchema, decisionValueFromResult } from '../../domain/decision/decision.js';
import { journeyTransitionForResponse } from '../../domain/journey/topology.js';
import { promptContractHash } from '../../domain/decision/prompt.js';
import type { StudyArm } from '../../domain/study/arm.js';

const responseSchema = z.object({ taskId: z.string(), comparisonKey: z.string().nullable(), occurrence: z.number().int().positive(), presentationOccurrence: z.number().int().positive(), requestFingerprint: z.string().regex(/^[a-f\d]{64}$/i), answer: decisionValueSchema, optionIds: z.array(z.string()), choice: z.string().optional(), correct: z.boolean().nullable(), attempts: z.number().int(), latencyMs: z.number().nonnegative(), confidence: z.number().nullable(), cost: z.object({ amountUsd: z.number().nonnegative(), basis: z.enum(['provider-reported', 'published-rate-estimate']) }).strict().nullable() }).strict();
type ComparisonAnswer = PollingReport['arms'][number]['journeys'][number]['responses'][number]['answer'];
type AnswerComparisonTotals = { choiceTransitions: Record<string, Record<string, number>>; scoreDifferences: number[]; noulDifferences: number[] };
type ReportArm = PollingReport['arms'][number];
type ReportResponse = ReportArm['journeys'][number]['responses'][number];
export const pollingReportSchema = z.object({
  formatVersion: z.literal(4), runId: z.string().uuid(), status: z.string(), stimulusFingerprint: z.string(), executionFingerprint: z.string(), cohortFingerprint: z.string().regex(/^[a-f\d]{64}$/i),
  provider: z.object({ kind: z.enum(['jev', 'laya']), model: z.string().nullable(), checkpoint: z.string().nullable(), route: z.enum(['openrouter', 'typesafe']).nullable(), endpoint: z.string().url().nullable() }).strict(),
  cohortSize: z.number().int().nonnegative(),
  arms: z.array(z.object({ id: z.string(), label: z.string(), denominator: z.object({ intended: z.number().int(), started: z.number().int(), completed: z.number().int(), excluded: z.number().int(), excludedByStatus: z.record(z.string(), z.number().int()) }).strict(),
    fingerprint: z.string(), presentation: z.unknown(),
    sources: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()),
    stimulusItems: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
    tasks: z.array(z.object({ id: z.string(), type: z.enum(['choice', 'score', 'noul']).optional(), comparisonKey: z.string().nullable(), instructions: z.string(), options: z.record(z.string(), z.string()).optional(), rubric: z.array(z.string()).optional(), criteria: z.object({ true: z.string().optional(), false: z.string().optional() }).nullable().optional(), responseHistory: z.enum(['include', 'omit']).optional() }).strict()),
    taskResponses: z.record(z.string(), z.object({ occurrences: z.array(z.object({ occurrence: z.number().int().positive(), type: z.enum(['choice', 'score', 'noul']).optional(), reached: z.number().int(), completed: z.number().int(), incomplete: z.number().int(), notReached: z.number().int(), correct: z.number().int(), incorrect: z.number().int(), unscored: z.number().int(), options: z.record(z.string(), z.object({ count: z.number().int(), proportion: z.number().min(0).max(1) }).strict()), meanScore: z.number().finite().optional(), rubricProbabilities: z.record(z.string(), z.number().min(0).max(1)).optional(), meanProbabilityTrue: z.number().min(0).max(1).optional() }).strict()) }).strict()),
    journeys: z.array(z.object({ respondentId: z.string(), archetypeId: z.string().nullable(), variation: z.record(z.string(), z.string()).optional(), status: z.string(), outcome: z.string().nullable(), presentedTaskIds: z.array(z.string()), events: z.array(z.unknown()), responses: z.array(responseSchema), failedAttempts: z.number().int().nonnegative(), failureEvidence: contextFailureSchema.optional() }).strict()),
  }).strict()),
  providerEvidence: z.object({ interruptions: z.array(interruptionEvidenceSchema), attempts: z.number().int(), maxCalls: z.number().int().positive(), reservedCalls: z.number().int().nonnegative(), remainingCalls: z.number().int().nonnegative(), failedCells: z.number().int() }).strict(),
}).strict();
export type PollingReport = z.infer<typeof pollingReportSchema>;

function reconstructPartialEvents(arm: StudyArm, stored: RunCheckpoint['journeys'][number]): unknown[] {
  const events: unknown[] = [];
  const used = new Set<number>();
  let sequence = 0;
  const responseFor = (taskId: string, nodeId: string): RunCheckpoint['journeys'][number]['decisions'][number] | null => {
    const decisionIndex = stored.decisions.findIndex((decision, index) => !used.has(index) && decision.decisionId === taskId);
    if (decisionIndex < 0) {
      events.push({ type: 'pending-response', sequence: sequence++, nodeId, taskId });
      return null;
    }
    used.add(decisionIndex);
    const result = stored.decisions[decisionIndex]!.result;
    const value = decisionValueFromResult(result);
    events.push({ type: 'response', sequence: sequence++, nodeId, taskId, result: value });
    return stored.decisions[decisionIndex]!;
  };
  const expose = (itemId: string, nodeId: string): void => { events.push({ type: 'exposure', sequence: sequence++, nodeId, itemId }); };

  if (arm.presentation.kind === 'sequence') {
    for (const item of arm.items) expose(item.id, `sequence-expose-${item.id}`);
    for (const taskId of stored.presentedTaskIds) {
      if (!responseFor(taskId, `sequence-ask-${taskId}`)) break;
    }
    return events;
  }

  const graph = arm.presentation;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const presented = stored.presentedTaskIds;
  let presentedIndex = 0;
  let current = graph.entryNodeId;
  for (let steps = 0; steps < graph.nodes.length * 2 && presentedIndex < presented.length; steps += 1) {
    const node = nodes.get(current);
    if (!node || node.kind === 'terminal') break;
    if (node.kind === 'expose') {
      expose(node.itemId, node.id);
      current = graph.transitions.find((edge) => edge.fromNodeId === node.id)?.toNodeId ?? '';
      continue;
    }
    if (presented[presentedIndex] !== node.taskId) break;
    presentedIndex += 1;
    const decision = responseFor(node.taskId, node.id);
    if (!decision) {
      const nextTaskId = presented[presentedIndex];
      if (!nextTaskId) break;
      const findPaths = (start: string, visited = new Set<string>()): string[][] => {
        if (visited.has(start)) return [];
        const candidate = nodes.get(start);
        if (!candidate) return [];
        if (candidate.kind === 'ask') return candidate.taskId === nextTaskId ? [[start]] : [];
        if (candidate.kind === 'terminal') return [];
        const nextVisited = new Set(visited).add(start);
        const paths: string[][] = [];
        for (const edge of graph.transitions.filter((item) => item.fromNodeId === start)) {
          for (const found of findPaths(edge.toNodeId, nextVisited)) {
            paths.push(candidate.kind === 'expose' ? [start, ...found] : found);
            if (paths.length > 1) return paths;
          }
        }
        return paths;
      };
      const candidateEdges = graph.transitions.filter((edge) => edge.fromNodeId === node.id && findPaths(edge.toNodeId).length === 1);
      if (candidateEdges.length !== 1) break;
      current = candidateEdges[0]!.toNodeId;
      continue;
    }
    const edge = journeyTransitionForResponse(graph, node.id, decisionValueFromResult(decision.result));
    if (!edge) break;
    current = edge.toNodeId;
  }
  return events;
}

export async function buildReport(checkpoint: RunCheckpoint): Promise<PollingReport> {
  checkpoint = runCheckpointSchema.parse(checkpoint);
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
        const choiceTask = task && 'options' in task ? task : undefined;
        const answer = decisionValueFromResult(result);
        return { taskId: decisionId, comparisonKey: task?.comparisonKey ?? null, occurrence, presentationOccurrence, requestFingerprint: checkpointDecision.requestFingerprint, answer, optionIds: choiceTask ? Object.keys(choiceTask.options) : [], ...(result.type === 'choice' ? { choice: result.choice } : {}),
          correct: result.type === 'choice' && choiceTask?.answerKeyOptionId ? result.choice === choiceTask.answerKeyOptionId : null, attempts: result.attempts, latencyMs: result.latencyMs,
          confidence: 'confidence' in result ? result.confidence ?? null : null, cost: result.cost ?? null };
      });
      return { respondentId: respondent.id, failedAttempts: stored?.failedAttempts ?? 0, archetypeId: respondent.archetypeId ?? null, ...(respondent.variation === undefined ? {} : { variation: respondent.variation }), status: stored?.status ?? 'not-started', outcome: stored?.result?.outcome ?? null, presentedTaskIds: stored?.presentedTaskIds ?? [], events: stored?.result?.events ?? (stored ? reconstructPartialEvents(arm, stored) : []), responses,
        ...(stored?.failureEvidence === undefined ? {} : { failureEvidence: stored.failureEvidence }) };
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
        const choiceTask = 'options' in task ? task : undefined;
        const scoreTask = 'rubric' in task ? task : undefined;
        const taskType = choiceTask ? 'choice' as const : scoreTask ? 'score' as const : 'noul' as const;
        const counts: Record<string, number> = {};
        for (const response of responses) if (response.answer.type === 'choice') counts[response.answer.choice] = (counts[response.answer.choice] ?? 0) + 1;
        const options = Object.fromEntries(Object.keys(choiceTask?.options ?? {}).map((optionId) => {
          const count = counts[optionId] ?? 0;
          return [optionId, { count, proportion: responses.length ? count / responses.length : 0 }];
        }));
        const scoreResponses = responses.filter((response) => response.answer.type === 'score');
        const noulResponses = responses.filter((response) => response.answer.type === 'noul');
        const rubricProbabilities = scoreTask ? Object.fromEntries(scoreTask.rubric.map((_meaning, index) => {
          const levelId = String(index);
          const average = scoreResponses.length ? scoreResponses.reduce((total, response) => total + (response.answer.type === 'score' ? response.answer.probabilities[levelId] ?? 0 : 0), 0) / scoreResponses.length : 0;
          return [levelId, average];
        })) : undefined;
        return { occurrence, type: taskType, reached: reachedJourneys.length, completed: responses.length, incomplete: reachedJourneys.length - responses.length, notReached: cohort.respondents.length - reachedJourneys.length,
          correct: responses.filter((response) => response.correct === true).length, incorrect: responses.filter((response) => response.correct === false).length,
          unscored: responses.filter((response) => response.correct === null).length, options,
          ...(scoreResponses.length ? { meanScore: scoreResponses.reduce((total, response) => total + (response.answer.type === 'score' ? response.answer.score : 0), 0) / scoreResponses.length, rubricProbabilities } : {}),
          ...(noulResponses.length ? { meanProbabilityTrue: noulResponses.reduce((total, response) => total + (response.answer.type === 'noul' ? response.answer.noul : 0), 0) / noulResponses.length } : {}),
        };
      });
      taskResponses[task.id] = { occurrences };
    }
    const completed = journeys.filter((journey) => journey.status === 'completed').length;
    const started = checkpoint.journeys.filter((journey) => journey.armId === arm.id).length;
    const snapshot = { sources: arm.sources, items: arm.items, tasks: arm.tasks, presentation: arm.presentation };
    const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    return { id: arm.id, label: arm.label, fingerprint, presentation: arm.presentation, sources: arm.sources, stimulusItems: arm.items, tasks: arm.tasks.map((task) => ({
      id: task.id, type: 'options' in task ? 'choice' as const : 'rubric' in task ? 'score' as const : 'noul' as const,
      comparisonKey: task.comparisonKey ?? null, instructions: task.instructions,
      ...('options' in task ? { options: task.options } : {}),
      ...('rubric' in task ? { rubric: task.rubric } : {}),
      ...('criteria' in task ? { criteria: task.criteria ?? null } : {}),
      responseHistory: task.responseHistory === 'omit' ? 'omit' as const : 'include' as const,
    })), denominator: { intended: cohort.respondents.length, started, completed, excluded: cohort.respondents.length - completed, excludedByStatus }, taskResponses, journeys };
  });
  const rawProvider = checkpoint.provider;
  return pollingReportSchema.parse({ formatVersion: 4, runId: checkpoint.runId, status: checkpoint.status, stimulusFingerprint: checkpoint.stimulusFingerprint, executionFingerprint: checkpoint.executionFingerprint, cohortFingerprint: respondentCohortFingerprint(cohort),
    provider: { kind: rawProvider.kind, model: rawProvider.kind === 'jev' ? rawProvider.model : null, checkpoint: rawProvider.kind === 'laya' ? rawProvider.checkpoint : null, route: rawProvider.kind === 'jev' ? rawProvider.route : null, endpoint: rawProvider.kind === 'jev' ? rawProvider.endpoint : null }, cohortSize: profiles.size, arms,
    providerEvidence: { interruptions: checkpoint.interruptions ?? [], attempts: checkpoint.budget.usedCalls, maxCalls: checkpoint.budget.maxCalls, reservedCalls: checkpoint.budget.reservedCalls, remainingCalls: checkpoint.budget.remainingCalls,
      failedCells: checkpoint.journeys.filter((journey) => journey.status === 'failed').length } });
}
export async function getLegacyReport(outputDirectory: string, runId: string): Promise<PollingReport> { return buildReport(await new LegacyRunArchiveReader(path.resolve(outputDirectory)).read(runId)); }

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
      const comparable = equivalentTasks(left, right, response.comparisonKey!) && response.answer.type === counterpart.answer.type;
      const answersMatch = comparable && (response.answer.type === 'choice' && counterpart.answer.type === 'choice'
        ? response.answer.choice === counterpart.answer.choice
        : JSON.stringify(response.answer) === JSON.stringify(counterpart.answer));
      return [{ comparisonKey: response.comparisonKey, occurrence: response.occurrence, leftAnswer: response.answer, rightAnswer: counterpart.answer, ...(response.answer.type === 'choice' && counterpart.answer.type === 'choice' ? { leftChoice: response.answer.choice, rightChoice: counterpart.answer.choice, agreement: answersMatch } : {}), comparable }];
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
    const pairedScoreDifferences: number[] = [];
    const pairedNoulDifferences: number[] = [];
    let leftResponses = 0; let rightResponses = 0; let pairedResponses = 0; let comparableResponses = 0;
    for (const respondentId of comparisonRespondentIds) {
      const cellKey = `${respondentId}\0${comparisonKey}\0${occurrence}`;
      const leftResponse = leftResponseByCell.get(cellKey);
      const rightResponse = rightResponseByCell.get(cellKey);
      if (leftResponse) leftResponses += 1;
      if (rightResponse) rightResponses += 1;
      if (!leftResponse || !rightResponse) continue;
      pairedResponses += 1;
      if (!equivalentTasks(left, right, comparisonKey) || leftResponse.answer.type !== rightResponse.answer.type) continue;
      comparableResponses += 1;
      accumulateAnswerComparison({ choiceTransitions: optionTransitions, scoreDifferences: pairedScoreDifferences, noulDifferences: pairedNoulDifferences }, leftResponse.answer, rightResponse.answer);
    }
    return { comparisonKey, occurrence, leftResponses, rightResponses, pairedResponses, comparableResponses, unpairedResponses: pairedResponses - comparableResponses, leftOnlyResponses: Math.max(0, leftResponses - pairedResponses), rightOnlyResponses: Math.max(0, rightResponses - pairedResponses), optionTransitions,
      ...(pairedScoreDifferences.length ? { meanScoreDifference: pairedScoreDifferences.reduce((sum, value) => sum + value, 0) / pairedScoreDifferences.length } : {}),
      ...(pairedNoulDifferences.length ? { meanProbabilityTrueDifference: pairedNoulDifferences.reduce((sum, value) => sum + value, 0) / pairedNoulDifferences.length } : {}),
    };
  });
  const leftByItem = new Map(left.stimulusItems.map((item) => [item.id, item.text]));
  const rightByItem = new Map(right.stimulusItems.map((item) => [item.id, item.text]));
  const itemChanges = [...new Set([...leftByItem.keys(), ...rightByItem.keys()])].flatMap((id) => leftByItem.get(id) === rightByItem.get(id) ? [] : [{ id, leftText: leftByItem.get(id) ?? null, rightText: rightByItem.get(id) ?? null }]);
  const leftSources = new Map(left.sources.map((source) => [source.path, source.sha256]));
  const rightSources = new Map(right.sources.map((source) => [source.path, source.sha256]));
  const sourceChanges = [...new Set([...leftSources.keys(), ...rightSources.keys()])].flatMap((sourcePath) => leftSources.get(sourcePath) === rightSources.get(sourcePath) ? [] : [{ path: sourcePath, leftSha256: leftSources.get(sourcePath) ?? null, rightSha256: rightSources.get(sourcePath) ?? null }]);
  const taskChanges = taskChangesBetween(left, right);
  return { runId: report.runId, leftArmId, rightArmId, leftFingerprint: left.fingerprint, rightFingerprint: right.fingerprint, sourceChanges, itemChanges, taskChanges, matchedRespondents: matched.length, comparisonTasks, matched };
}

function indexResponses(journeys: ReportArm['journeys']): Map<string, ReportResponse> {
  const indexed = new Map<string, ReportResponse>();
  for (const journey of journeys) {
    for (const response of journey.responses) {
      if (!response.comparisonKey) continue;
      indexed.set(`${journey.respondentId}\0${response.comparisonKey}\0${response.occurrence}`, response);
    }
  }
  return indexed;
}

export function compareRunReports(leftReport: PollingReport, leftArmId: string, rightReport: PollingReport, rightArmId: string) {
  if (leftReport.runId === rightReport.runId) throw new Error('Cross-run comparison requires two distinct run IDs.');
  if (leftReport.cohortFingerprint !== rightReport.cohortFingerprint) throw new Error('Cross-run comparison requires the exact same frozen respondent cohort.');
  const left = leftReport.arms.find((arm) => arm.id === leftArmId);
  const right = rightReport.arms.find((arm) => arm.id === rightArmId);
  if (!left || !right) throw new Error('Both arm IDs must exist in their respective reports.');
  const leftCells = indexResponses(left.journeys);
  const rightCells = indexResponses(right.journeys);
  const respondentIds = [...new Set([...left.journeys, ...right.journeys].map((journey) => journey.respondentId))].sort();
  const groups = new Map<string, Set<string>>([['all', new Set(respondentIds)]]);
  for (const journey of left.journeys) {
    if (journey.archetypeId) addGroupMember(groups, `archetype:${journey.archetypeId}`, journey.respondentId);
    for (const [axis, value] of Object.entries(journey.variation ?? {})) {
      const key = `variation:${axis}=${value}`;
      addGroupMember(groups, key, journey.respondentId);
    }
  }
  const keys = new Set([
    ...[...left.journeys, ...right.journeys].flatMap((journey) => journey.responses.flatMap((response) => response.comparisonKey ? [`${response.comparisonKey}:${response.occurrence}`] : [])),
    ...[left, right].flatMap((arm) => arm.tasks.flatMap((task) => task.comparisonKey ? (arm.taskResponses[task.id]?.occurrences ?? []).map((entry) => `${task.comparisonKey}:${entry.occurrence}`) : [])),
  ]);
  const comparisonTasks = [...keys].sort().map((key) => {
    const [comparisonKey = '', occurrenceText = '1'] = key.split(':');
    const occurrence = Number(occurrenceText);
    const choiceTransitions: Record<string, Record<string, number>> = {};
    const scoreDifferences: number[] = [];
    const noulDifferences: number[] = [];
    let leftResponses = 0;
    let rightResponses = 0;
    let pairedResponses = 0;
    let comparableResponses = 0;
    for (const respondentId of respondentIds) {
      const cell = `${respondentId}\0${comparisonKey}\0${occurrence}`;
      const a = leftCells.get(cell); const b = rightCells.get(cell);
      if (a) leftResponses += 1;
      if (b) rightResponses += 1;
      if (!a || !b) continue;
      pairedResponses += 1;
      if (!equivalentTasks(left, right, comparisonKey) || a.answer.type !== b.answer.type) continue;
      comparableResponses += 1;
      accumulateAnswerComparison({ choiceTransitions, scoreDifferences, noulDifferences }, a.answer, b.answer);
    }
    const profileGroups = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, members]) => {
      const transitions: Record<string, Record<string, number>> = {};
      const scores: number[] = [];
      const nouls: number[] = [];
      let groupLeft = 0;
      let groupRight = 0;
      let groupPaired = 0;
      let groupComparable = 0;
      for (const respondentId of members) {
        const cell = `${respondentId}\0${comparisonKey}\0${occurrence}`;
        const a = leftCells.get(cell);
        const b = rightCells.get(cell);
        if (a) groupLeft += 1;
        if (b) groupRight += 1;
        if (!a || !b) continue;
        groupPaired += 1;
        if (!equivalentTasks(left, right, comparisonKey) || a.answer.type !== b.answer.type) continue;
        groupComparable += 1;
        accumulateAnswerComparison({ choiceTransitions: transitions, scoreDifferences: scores, noulDifferences: nouls }, a.answer, b.answer);
      }
      return { group, denominator: members.size, leftResponses: groupLeft, rightResponses: groupRight, pairedResponses: groupPaired, comparableResponses: groupComparable, nonComparableResponses: groupPaired - groupComparable, choiceTransitions: transitions,
        ...(scores.length ? { meanScoreDifference: scores.reduce((sum, value) => sum + value, 0) / scores.length } : {}),
        ...(nouls.length ? { meanProbabilityTrueDifference: nouls.reduce((sum, value) => sum + value, 0) / nouls.length } : {}),
      };
    });
    return { comparisonKey, occurrence, leftResponses, rightResponses, pairedResponses, comparableResponses, nonComparableResponses: pairedResponses - comparableResponses,
      leftOnlyResponses: Math.max(0, leftResponses - pairedResponses), rightOnlyResponses: Math.max(0, rightResponses - pairedResponses), choiceTransitions,
      ...(scoreDifferences.length ? { meanScoreDifference: scoreDifferences.reduce((sum, value) => sum + value, 0) / scoreDifferences.length } : {}),
      ...(noulDifferences.length ? { meanProbabilityTrueDifference: noulDifferences.reduce((sum, value) => sum + value, 0) / noulDifferences.length } : {}),
      profileGroups,
    };
  });
  const matched = respondentIds.map((respondentId) => ({ respondentId,
    leftJourneyPath: { presentedTaskIds: left.journeys.find((journey) => journey.respondentId === respondentId)?.presentedTaskIds ?? [], events: left.journeys.find((journey) => journey.respondentId === respondentId)?.events ?? [] },
    rightJourneyPath: { presentedTaskIds: right.journeys.find((journey) => journey.respondentId === respondentId)?.presentedTaskIds ?? [], events: right.journeys.find((journey) => journey.respondentId === respondentId)?.events ?? [] }, taskComparisons: [...keys].sort().map((key) => {
    const [comparisonKey = '', occurrenceText = '1'] = key.split(':'); const occurrence = Number(occurrenceText);
    const cell = `${respondentId}\0${comparisonKey}\0${occurrence}`; const a = leftCells.get(cell); const b = rightCells.get(cell);
    const leftJourney = left.journeys.find((journey) => journey.respondentId === respondentId);
    const rightJourney = right.journeys.find((journey) => journey.respondentId === respondentId);
    const taskIds = (arm: typeof left) => arm.tasks.filter((task) => task.comparisonKey === comparisonKey).map((task) => task.id);
    const reached = (arm: typeof left, journey: typeof leftJourney) => !!journey && taskIds(arm).some((taskId) => journey.presentedTaskIds.filter((id) => id === taskId).length >= occurrence);
    const outcome = (response: typeof a, wasReached: boolean) => response ? 'completed' : wasReached ? 'incomplete' : 'not-reached';
    const leftReached = reached(left, leftJourney); const rightReached = reached(right, rightJourney);
    return { comparisonKey, occurrence, leftAnswer: a?.answer ?? null, rightAnswer: b?.answer ?? null, leftOutcome: outcome(a, leftReached), rightOutcome: outcome(b, rightReached), comparable: !!a && !!b && equivalentTasks(left, right, comparisonKey) && a.answer.type === b.answer.type };
  }) }));
  const leftSources = new Map(left.sources.map((source) => [source.path, source.sha256]));
  const rightSources = new Map(right.sources.map((source) => [source.path, source.sha256]));
  const sourceChanges = [...new Set([...leftSources.keys(), ...rightSources.keys()])].flatMap((sourcePath) => leftSources.get(sourcePath) === rightSources.get(sourcePath) ? [] : [{ path: sourcePath, leftSha256: leftSources.get(sourcePath) ?? null, rightSha256: rightSources.get(sourcePath) ?? null }]);
  const leftItems = new Map(left.stimulusItems.map((item) => [item.id, item.text]));
  const rightItems = new Map(right.stimulusItems.map((item) => [item.id, item.text]));
  const stimulusChanges = [...new Set([...leftItems.keys(), ...rightItems.keys()])].flatMap((id) => leftItems.get(id) === rightItems.get(id) ? [] : [{ id, leftText: leftItems.get(id) ?? null, rightText: rightItems.get(id) ?? null }]);
  const taskChanges = taskChangesBetween(left, right);
  const providerChanges = JSON.stringify(leftReport.provider) === JSON.stringify(rightReport.provider) ? null : { left: leftReport.provider, right: rightReport.provider };
  const presentationChanges = JSON.stringify(left.presentation) === JSON.stringify(right.presentation) ? null : { left: left.presentation, right: right.presentation };
  return { leftRunId: leftReport.runId, rightRunId: rightReport.runId, leftArmId, rightArmId, cohortFingerprint: leftReport.cohortFingerprint,
    leftFingerprint: left.fingerprint, rightFingerprint: right.fingerprint, matchedRespondents: respondentIds.length, comparisonTasks, matched,
    differences: { sources: sourceChanges, stimulusItems: stimulusChanges, tasks: taskChanges, presentation: presentationChanges, provider: providerChanges,
      runStatus: leftReport.status === rightReport.status ? null : { left: leftReport.status, right: rightReport.status },
      completion: { left: left.denominator, right: right.denominator } },
  };
}

function addGroupMember(groups: Map<string, Set<string>>, key: string, respondentId: string): void {
  let members = groups.get(key);
  if (!members) {
    members = new Set<string>();
    groups.set(key, members);
  }
  members.add(respondentId);
}

function taskChangesBetween(left: PollingReport['arms'][number], right: PollingReport['arms'][number]) {
  const leftTasks = new Map(left.tasks.map((task) => [task.comparisonKey ?? task.id, task]));
  const rightTasks = new Map(right.tasks.map((task) => [task.comparisonKey ?? task.id, task]));
  return [...new Set([...leftTasks.keys(), ...rightTasks.keys()])].flatMap((comparisonKey) => {
    const a = leftTasks.get(comparisonKey); const b = rightTasks.get(comparisonKey);
    if (!a || !b) return [{ comparisonKey, fields: ['task-presence'] }];
    const fields = (['type', 'instructions', 'options', 'rubric', 'criteria', 'responseHistory'] as const)
      .filter((field) => JSON.stringify(a[field] ?? null) !== JSON.stringify(b[field] ?? null));
    return fields.length ? [{ comparisonKey, fields }] : [];
  });
}

function equivalentTasks(left: PollingReport['arms'][number], right: PollingReport['arms'][number], comparisonKey: string): boolean {
  const leftTask = left.tasks.find((task) => task.comparisonKey === comparisonKey);
  const rightTask = right.tasks.find((task) => task.comparisonKey === comparisonKey);
  if (!leftTask || !rightTask || leftTask.type !== rightTask.type) return false;
  if (leftTask.instructions !== rightTask.instructions) return false;
  if (leftTask.type === 'choice') return JSON.stringify(leftTask.options) === JSON.stringify(rightTask.options);
  if (leftTask.type === 'score') return JSON.stringify(leftTask.rubric) === JSON.stringify(rightTask.rubric);
  return JSON.stringify(leftTask.criteria ?? null) === JSON.stringify(rightTask.criteria ?? null);
}

function accumulateAnswerComparison(totals: AnswerComparisonTotals, left: ComparisonAnswer, right: ComparisonAnswer): void {
  if (left.type === 'choice' && right.type === 'choice') {
    const row = totals.choiceTransitions[left.choice] ??= {};
    row[right.choice] = (row[right.choice] ?? 0) + 1;
  } else if (left.type === 'score' && right.type === 'score') totals.scoreDifferences.push(right.score - left.score);
  else if (left.type === 'noul' && right.type === 'noul') totals.noulDifferences.push(right.noul - left.noul);
}
