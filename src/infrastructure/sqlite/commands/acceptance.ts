import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { PreparedJourneyRun, PreparedRun } from '../../../domain/run/request.js';
import { evaluations, journeyRespondents, questionGroups, runs } from '../tables.js';

const SQLITE_INSERT_BATCH_SIZE = 250;

type AcceptedRun = {
  runId: string;
  submissionId: string;
  requestFingerprint: string;
  createdAt: string;
  createdMs: number;
};

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export function insertAcceptedRun(database: NodeSQLiteDatabase, identity: AcceptedRun, prepared: PreparedRun | PreparedJourneyRun): void {
  database.insert(runs).values({
    ...identity,
    label: prepared.request.label ?? null,
    status: 'prepared',
    requestJson: JSON.stringify({
      request: prepared.request,
      requestFingerprint: prepared.requestFingerprint,
      compilerFingerprint: prepared.compilerFingerprint,
      ...('lineage' in prepared && prepared.lineage ? { lineage: prepared.lineage } : {}),
    }),
    evaluationCount: prepared.evaluations.length,
    maxCalls: prepared.request.maxCalls,
  }).run();
}

export function insertPreparedRunData(database: NodeSQLiteDatabase, runId: string, prepared: PreparedRun): void {
  const groups = prepared.groups ?? [];
  const groupRows = groups.map((group, ordinal) => ({
    groupId: group.groupId, runId, ordinal, contextId: group.contextId, respondentId: group.respondentId,
    stateJson: JSON.stringify(group.state), questionIdsJson: JSON.stringify(group.questionIds),
  }));
  for (const batch of chunks(groupRows, SQLITE_INSERT_BATCH_SIZE)) database.insert(questionGroups).values(batch).run();
  const evaluationRows = prepared.evaluations.map((evaluation, ordinal) => ({
    evaluationId: evaluation.evaluationId,
    runId,
    ordinal,
    contextId: evaluation.contextId,
    respondentId: evaluation.respondentId,
    questionId: evaluation.questionId,
    groupId: evaluation.groupId!,
    packetJson: JSON.stringify(evaluation.packet),
    packetFingerprint: evaluation.packetFingerprint,
    status: 'pending' as const,
  }));
  for (const batch of chunks(evaluationRows, SQLITE_INSERT_BATCH_SIZE)) database.insert(evaluations).values(batch).run();
}

export function insertPreparedJourneyData(database: NodeSQLiteDatabase, runId: string, prepared: PreparedJourneyRun): void {
  const groups = new Map(prepared.evaluations.map((evaluation) => [evaluation.contextId, {
    groupId: evaluation.contextId,
    runId,
    ordinal: evaluation.ordinal,
    contextId: evaluation.contextId,
    respondentId: evaluation.respondentId,
    stateJson: JSON.stringify(evaluation.packet.state),
    questionIdsJson: JSON.stringify([evaluation.questionId]),
  }]));
  for (const batch of chunks([...groups.values()], SQLITE_INSERT_BATCH_SIZE)) database.insert(questionGroups).values(batch).onConflictDoNothing().run();
  const evaluationRows = prepared.evaluations.map((evaluation) => ({
    evaluationId: evaluation.evaluationId,
    runId,
    ordinal: evaluation.ordinal,
    contextId: evaluation.contextId,
    respondentId: evaluation.respondentId,
    questionId: evaluation.questionId,
    groupId: evaluation.contextId,
    turnId: evaluation.turnId,
    nodeId: evaluation.nodeId,
    pathId: evaluation.pathId,
    occurrence: evaluation.occurrence,
    packetJson: JSON.stringify(evaluation.packet),
    packetFingerprint: evaluation.packetFingerprint,
    status: 'pending' as const,
  }));
  for (const batch of chunks(evaluationRows, SQLITE_INSERT_BATCH_SIZE)) database.insert(evaluations).values(batch).run();
  const respondentRows = prepared.respondents.map((respondent) => ({
    runId,
    respondentId: respondent.respondentId,
    status: respondent.status,
    currentNodeId: respondent.currentNodeId,
    currentTurnId: respondent.currentTurnId,
    currentContextId: respondent.currentContextId,
    revision: respondent.revision,
    eventsJson: JSON.stringify(respondent.events),
    routeJson: JSON.stringify(respondent.route),
    outcome: respondent.outcome ?? null,
  }));
  for (const batch of chunks(respondentRows, SQLITE_INSERT_BATCH_SIZE)) database.insert(journeyRespondents).values(batch).run();
}
