import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { attemptEvaluations, evaluations, journeyRespondents, runs } from '../tables.js';

export function reopenSharedFailure(database: NodeSQLiteDatabase, runId: string, attemptId: string): void {
  const failedMembers = database.select({ evaluationId: attemptEvaluations.evaluationId }).from(attemptEvaluations)
    .where(eq(attemptEvaluations.attemptId, attemptId));
  database.update(evaluations).set({ status: 'pending', resultJson: null, failureCode: null, failureMessage: null, failureDetailJson: null })
    .where(and(eq(evaluations.runId, runId), eq(evaluations.status, 'failed'), inArray(evaluations.evaluationId, failedMembers))).run();
}

export function reopenFailedQuestions(database: NodeSQLiteDatabase, runId: string): void {
  database.update(evaluations).set({ status: 'pending', resultJson: null, failureCode: null, failureMessage: null, failureDetailJson: null })
    .where(and(eq(evaluations.runId, runId), eq(evaluations.status, 'failed'))).run();
}

export function reopenJourneyEvaluation(database: NodeSQLiteDatabase, runId: string, evaluationId: string, respondentId: string): boolean {
  return database.update(evaluations).set({ status: 'pending', resultJson: null, failureCode: null, failureMessage: null, failureDetailJson: null })
    .where(and(eq(evaluations.runId, runId), eq(evaluations.evaluationId, evaluationId), eq(evaluations.respondentId, respondentId), eq(evaluations.status, 'failed')))
    .returning({ evaluationId: evaluations.evaluationId }).all().length === 1;
}

export function restoreFailedJourneyRespondent(database: NodeSQLiteDatabase, runId: string, respondentId: string, currentNodeId: string, currentTurnId: string, currentContextId: string): boolean {
  return database.update(journeyRespondents).set({
    status: 'active', currentNodeId, currentTurnId, currentContextId,
    revision: sql`${journeyRespondents.revision} + 1`,
  }).where(and(eq(journeyRespondents.runId, runId), eq(journeyRespondents.respondentId, respondentId), eq(journeyRespondents.status, 'failed')))
    .returning({ respondentId: journeyRespondents.respondentId }).all().length === 1;
}

export function prepareResumedRun(database: NodeSQLiteDatabase, runId: string, leaseExpiresMs: number): void {
  database.update(runs).set({
    status: 'prepared', failureScope: null, failureCode: null, failureMessage: null,
    leaseExpiresMs, ownerToken: null, ownerPid: null,
  }).where(and(eq(runs.runId, runId), inArray(runs.status, ['interrupted', 'failed', 'partial']))).run();
}

export function markPendingEvaluationsUnreached(database: NodeSQLiteDatabase, runId: string): void {
  database.update(evaluations).set({ status: 'unreached' })
    .where(and(eq(evaluations.runId, runId), eq(evaluations.status, 'pending'))).run();
}

export function markActiveJourneyRespondentsUnreached(database: NodeSQLiteDatabase, runId: string): void {
  database.update(journeyRespondents).set({
    status: 'unreached', currentNodeId: null, currentTurnId: null, currentContextId: null,
    revision: sql`${journeyRespondents.revision} + 1`,
  }).where(and(eq(journeyRespondents.runId, runId), eq(journeyRespondents.status, 'active'))).run();
}

export function deleteRuns(database: NodeSQLiteDatabase, runIds: string[]): void {
  database.delete(runs).where(inArray(runs.runId, runIds)).run();
}
