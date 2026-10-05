import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import type { DeleteResult } from '../../../application/run-store.js';
import type { RunStatus } from '../../../domain/run/lifecycle.js';
import { RunStoreError } from '../../../application/run-store.js';
import type { RunDeletionSnapshot } from '../run-deletion-queries.js';
import { loadRunDeletionSnapshot } from '../run-deletion-queries.js';
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

export function deleteRunSelection(context: {
  database: DatabaseSync;
  orm: NodeSQLiteDatabase;
  transaction<T>(operation: () => T): T;
  now(): number;
  reconcile(snapshot: RunDeletionSnapshot, nowMs: number): Map<string, RunStatus>;
  notFound(): never;
  optimize(): void;
}, runIds: string[]): DeleteResult {
  const result = context.transaction(() => {
    const snapshot = loadRunDeletionSnapshot(context.orm, runIds, { includeReservedAttemptCounts: true });
    if (snapshot.runs.length !== runIds.length) throw context.notFound();
    const statuses = context.reconcile(snapshot, context.now());
    const counts = runIds.map((runId) => {
      const status = statuses.get(runId)!;
      if (status === 'prepared' || status === 'running') {
        throw new RunStoreError('runs_active', 'Active runs cannot be deleted. Cancel each run, wait until it reaches a terminal state, then submit the explicit selection again.');
      }
      return { evaluations: snapshot.evaluationCounts.get(runId) ?? 0, attempts: snapshot.attemptCounts.get(runId) ?? 0 };
    });
    deleteRuns(context.orm, runIds);
    const violations = context.database.prepare('PRAGMA foreign_key_check').all();
    const integrity = context.database.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: unknown }>;
    if (violations.length > 0 || integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new RunStoreError('storage_integrity_failed', 'The datastore integrity check failed; no runs were deleted.');
    }
    return { deletedRunIds: [...runIds], removed: {
      runs: counts.length,
      evaluations: counts.reduce((sum, item) => sum + item.evaluations, 0),
      attempts: counts.reduce((sum, item) => sum + item.attempts, 0),
    } };
  });
  let maintenance: DeleteResult['maintenance'];
  try {
    context.optimize();
    maintenance = { optimization: 'completed' };
  } catch (error) {
    maintenance = { optimization: 'failed', failureCode: error instanceof RunStoreError ? error.code : 'storage_operation_failed' };
  }
  return { ...result, maintenance };
}
