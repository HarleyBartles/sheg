import { and, eq, gt, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { attemptEvaluations, attempts, evaluationAnswerAttempts, evaluations, runs } from '../tables.js';

export function chargeReservedAttempt(database: NodeSQLiteDatabase, runId: string, chargedCalls: number): boolean {
  return database.update(runs).set({
    usedCalls: sql`${runs.usedCalls} + ${chargedCalls}`,
    reservedCalls: sql`${runs.reservedCalls} - 1`,
  }).where(and(eq(runs.runId, runId), gt(runs.reservedCalls, 0)))
    .returning({ runId: runs.runId }).all().length === 1;
}

export function markAttemptAnswered(database: NodeSQLiteDatabase, attemptId: string, settledMs: number, chargedCalls: number, executionJson: string, resultJson?: string): void {
  database.update(attempts).set({ status: 'answered', settledMs, chargedCalls, executionJson, resultJson: resultJson ?? null })
    .where(eq(attempts.attemptId, attemptId)).run();
}

export function markAttemptFailed(database: NodeSQLiteDatabase, attemptId: string, settledMs: number, chargedCalls: number, code: string, message: string, scope?: 'evaluation' | 'run'): void {
  database.update(attempts).set({ status: 'failed', settledMs, chargedCalls, failureCode: code, failureMessage: message, failureScope: scope ?? null })
    .where(eq(attempts.attemptId, attemptId)).run();
}

export function markAttemptUncertain(database: NodeSQLiteDatabase, attemptId: string, settledMs: number, message: string): void {
  database.update(attempts).set({ status: 'uncertain', settledMs, chargedCalls: 1, failureCode: 'worker_interrupted', failureMessage: message })
    .where(eq(attempts.attemptId, attemptId)).run();
}

export function markEvaluationFailed(database: NodeSQLiteDatabase, evaluationId: string, code: string, message: string, detailJson?: string | null): void {
  database.update(evaluations).set({ status: 'failed', failureCode: code, failureMessage: message, failureDetailJson: detailJson ?? null })
    .where(eq(evaluations.evaluationId, evaluationId)).run();
}

export function saveAttemptEvaluationFailure(database: NodeSQLiteDatabase, attemptId: string, evaluationId: string, failureJson: string): void {
  database.update(attemptEvaluations).set({ failureJson })
    .where(and(eq(attemptEvaluations.attemptId, attemptId), eq(attemptEvaluations.evaluationId, evaluationId))).run();
}

export function markEvaluationAnswered(database: NodeSQLiteDatabase, evaluationId: string, resultJson: string): void {
  database.update(evaluations).set({ status: 'answered', resultJson, failureCode: null, failureMessage: null, failureDetailJson: null })
    .where(eq(evaluations.evaluationId, evaluationId)).run();
}

export function linkWinningAnswer(database: NodeSQLiteDatabase, runId: string, evaluationId: string, attemptId: string): void {
  database.insert(evaluationAnswerAttempts).values({ runId, evaluationId, attemptId }).run();
}

export function markRunFailed(database: NodeSQLiteDatabase, runId: string, code: string, message: string): void {
  database.update(runs).set({ failureScope: 'run', failureCode: code, failureMessage: message })
    .where(eq(runs.runId, runId)).run();
}
