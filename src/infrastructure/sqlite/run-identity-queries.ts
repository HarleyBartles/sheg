import { asc, eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { evaluations, questionGroups, runs } from './tables.js';

export function findRunBySubmission(database: NodeSQLiteDatabase, submissionId: string) {
  return database.select({ runId: runs.runId, requestFingerprint: runs.requestFingerprint })
    .from(runs).where(eq(runs.submissionId, submissionId)).limit(1).all()[0];
}

export function loadEvaluationStatuses(database: NodeSQLiteDatabase, runId: string) {
  return database.select({ evaluationId: evaluations.evaluationId, status: evaluations.status })
    .from(evaluations).where(eq(evaluations.runId, runId)).orderBy(asc(evaluations.ordinal)).all();
}

export function runExists(database: NodeSQLiteDatabase, runId: string): boolean {
  return database.select({ runId: runs.runId }).from(runs).where(eq(runs.runId, runId)).limit(1).all().length > 0;
}

export function hasAllFollowOnSelections(database: DatabaseSync, runId: string, selections: readonly { sourceEvaluationId: string; sourceContextId: string }[]): boolean {
  const missing = database.prepare(`SELECT 1 AS missing
    FROM json_each(?) AS selected
    LEFT JOIN evaluations AS e ON e.run_id = ?
      AND e.evaluation_id = json_extract(selected.value, '$.sourceEvaluationId')
      AND e.context_id = json_extract(selected.value, '$.sourceContextId')
    WHERE e.evaluation_id IS NULL
    LIMIT 1`).get(JSON.stringify(selections), runId);
  return missing === undefined;
}

export function loadAcceptedRequest(database: NodeSQLiteDatabase, runId: string) {
  return database.select({ requestJson: runs.requestJson, requestFingerprint: runs.requestFingerprint })
    .from(runs).where(eq(runs.runId, runId)).limit(1).all()[0];
}

export function loadPreparedEvaluations(database: NodeSQLiteDatabase, runId: string) {
  return database.select({
    evaluationId: evaluations.evaluationId,
    groupId: evaluations.groupId,
    contextId: evaluations.contextId,
    respondentId: evaluations.respondentId,
    questionId: evaluations.questionId,
    packetJson: evaluations.packetJson,
    packetFingerprint: evaluations.packetFingerprint,
  }).from(evaluations).where(eq(evaluations.runId, runId)).orderBy(asc(evaluations.ordinal)).all();
}

export function loadQuestionGroups(database: NodeSQLiteDatabase, runId: string) {
  return database.select({
    groupId: questionGroups.groupId,
    contextId: questionGroups.contextId,
    respondentId: questionGroups.respondentId,
    stateJson: questionGroups.stateJson,
    questionIdsJson: questionGroups.questionIdsJson,
  }).from(questionGroups).where(eq(questionGroups.runId, runId)).orderBy(asc(questionGroups.ordinal)).all();
}
