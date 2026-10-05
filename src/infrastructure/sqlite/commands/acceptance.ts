import { randomUUID } from 'node:crypto';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import type { RunStatusView } from '../../../domain/run/lifecycle.js';
import type { PreparedJourneyRun, PreparedRun } from '../../../domain/run/request.js';
import { RunStoreError } from '../../../application/run-store.js';
import { asNumber, asText, type DatabaseRow } from '../rows.js';
import { hasAllFollowOnSelections } from '../run-identity-queries.js';
import { validatePrepared, validatePreparedJourney } from './prepared-validation.js';
import { evaluations, journeyRespondents, questionGroups, runs } from '../tables.js';

const SQLITE_INSERT_BATCH_SIZE = 250;

type AcceptedRun = {
  runId: string;
  submissionId: string;
  requestFingerprint: string;
  createdAt: string;
  createdMs: number;
};

type AcceptanceContext = {
  database: DatabaseSync;
  orm: NodeSQLiteDatabase;
  now(): number;
  transaction<T>(operation: () => T): T;
  statusInside(runId: string): RunStatusView;
  reconcileInside(runId: string, nowMs: number): void;
  notFound(): never;
};

export function acceptPreparedRun(context: AcceptanceContext, submissionId: string, preparedInput: PreparedRun): { created: boolean; run: RunStatusView } {
  if (!submissionId.trim()) throw new RunStoreError('invalid_submission_id', 'A submission ID is required.');
  const prepared = validatePrepared(preparedInput);
  return context.transaction(() => {
    const prior = context.database.prepare('SELECT run_id, request_fingerprint FROM runs WHERE submission_id = ?').get(submissionId) as DatabaseRow | undefined;
    if (prior) {
      if (asText(prior.request_fingerprint, 'request fingerprint') !== prepared.requestFingerprint) {
        throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
      }
      const runId = asText(prior.run_id, 'run ID');
      context.reconcileInside(runId, context.now());
      return { created: false, run: context.statusInside(runId) };
    }

    if (prepared.request.kind === 'follow-on') {
      const lineage = prepared.lineage;
      if (!lineage) throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on lineage is missing.');
      const sourceId = lineage.sourceRunId;
      const source = context.database.prepare('SELECT status, used_calls, reserved_calls FROM runs WHERE run_id = ?').get(sourceId) as DatabaseRow | undefined;
      if (!source) throw context.notFound();
      const maxOrdinal = asNumber((context.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?').get(sourceId) as DatabaseRow).maximum, 'maximum evaluation ordinal');
      const version = lineage.sourceVersion;
      if (asText(source.status, 'source run status') !== version.status || asNumber(source.used_calls, 'source used calls') !== version.usedCalls ||
          asNumber(source.reserved_calls, 'source reserved calls') !== version.reservedCalls || maxOrdinal !== version.maxOrdinal) {
        throw new RunStoreError('source_changed_during_acceptance', 'The source run changed after follow-on inspection. Inspect the request again to use its current evidence.');
      }
      if (!hasAllFollowOnSelections(context.database, sourceId, lineage.selections)) {
        throw new RunStoreError('source_changed_during_acceptance', 'A selected source evaluation changed after follow-on inspection. Inspect the request again.');
      }
    }

    const runId = randomUUID();
    const nowMs = context.now();
    insertAcceptedRun(context.orm, { runId, submissionId, requestFingerprint: prepared.requestFingerprint, createdAt: new Date(nowMs).toISOString(), createdMs: nowMs }, prepared);
    insertPreparedRunData(context.orm, runId, prepared);
    return { created: true, run: context.statusInside(runId) };
  });
}

export function acceptPreparedJourney(context: AcceptanceContext, submissionId: string, preparedInput: PreparedJourneyRun): { created: boolean; run: RunStatusView } {
  if (!submissionId.trim()) throw new RunStoreError('invalid_submission_id', 'A submission ID is required.');
  const prepared = validatePreparedJourney(preparedInput);
  return context.transaction(() => {
    const prior = context.database.prepare('SELECT run_id, request_fingerprint FROM runs WHERE submission_id = ?').get(submissionId) as DatabaseRow | undefined;
    if (prior) {
      if (asText(prior.request_fingerprint, 'request fingerprint') !== prepared.requestFingerprint) {
        throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
      }
      const runId = asText(prior.run_id, 'run ID');
      context.reconcileInside(runId, context.now());
      return { created: false, run: context.statusInside(runId) };
    }
    const runId = randomUUID();
    const nowMs = context.now();
    insertAcceptedRun(context.orm, { runId, submissionId, requestFingerprint: prepared.requestFingerprint, createdAt: new Date(nowMs).toISOString(), createdMs: nowMs }, prepared);
    insertPreparedJourneyData(context.orm, runId, prepared);
    return { created: true, run: context.statusInside(runId) };
  });
}

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
