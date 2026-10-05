import { and, eq, gt, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { decisionBatchResultSchema, decisionFailureDetailForReason, decisionRequestSchema, decisionResultSchema, decisionValueFromResult, decisionValueSchema, type DecisionBatchResult } from '../../../domain/decision/decision.js';
import { validateDecision } from '../../../domain/decision/validate.js';
import { evaluationStatusSchema, type WorkerClaim } from '../../../domain/run/lifecycle.js';
import type { AttemptOutcome, BatchEvaluationOutcome } from '../../../application/run-store.js';
import { RunStoreError } from '../../../application/run-store.js';
import { asText, type DatabaseRow, parseJson, parseStored } from '../rows.js';
import { encodeStoredPayload } from '../payload-codecs.js';
import { evaluationFailureJson, failureEvidenceJson } from '../evidence-records.js';
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

export function settlePollBatch(context: { database: DatabaseSync; orm: NodeSQLiteDatabase; now(): number; ownedRun(claim: WorkerClaim, nowMs: number): DatabaseRow }, claim: WorkerClaim, attemptId: string, outcome: { kind: 'answered'; result: DecisionBatchResult } | Extract<AttemptOutcome, { kind: 'failed' }>): BatchEvaluationOutcome[] {
      const nowMs = context.now(); context.ownedRun(claim, nowMs);
      const attempt = context.database.prepare("SELECT * FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
        .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
      const rows = context.database.prepare(`SELECT e.* FROM attempt_evaluations ae JOIN evaluations e USING (evaluation_id) WHERE ae.attempt_id = ? ORDER BY e.ordinal`).all(attemptId) as DatabaseRow[];
      if (!rows.length) throw new RunStoreError('data_integrity_error', 'The provider attempt has no linked evaluations.');
      const chargedCalls = outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : outcome.result.execution.attempts;
      if (outcome.kind === 'failed') {
        markAttemptFailed(context.orm, attemptId, nowMs, chargedCalls, outcome.code, outcome.message, outcome.scope);
        for (const row of rows) {
          const evaluationId = asText(row.evaluation_id, 'evaluation ID');
          markEvaluationFailed(context.orm, evaluationId, outcome.code, outcome.message, failureEvidenceJson(outcome));
          if (outcome.detail || outcome.providerFailure) saveAttemptEvaluationFailure(context.orm, attemptId, evaluationId,
            evaluationFailureJson({ code: outcome.code, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.providerFailure ? { providerFailure: outcome.providerFailure } : {}) }));
        }
        if (outcome.scope === 'run') markRunFailed(context.orm, claim.runId, outcome.code, outcome.message);
      } else {
        const result = decisionBatchResultSchema.safeParse(outcome.result);
        if (!result.success) throw new RunStoreError('invalid_batch_result', 'The batch result envelope is invalid.');
        const expected = new Map(rows.map((row) => [asText(row.question_id, 'question ID'), row]));
        if (result.data.answers.some(({ questionId }) => !expected.has(questionId))) throw new RunStoreError('invalid_batch_result', 'The batch result contains an unknown question ID.');
        markAttemptAnswered(context.orm, attemptId, nowMs, result.data.execution.attempts, JSON.stringify(result.data.execution));
        for (const [questionId, row] of expected) {
          const answer = result.data.answers.find((item) => item.questionId === questionId);
          const evaluationId = asText(row.evaluation_id, 'evaluation ID');
          if (!answer) {
            markEvaluationFailed(context.orm, evaluationId, 'missing_batch_answer', 'Provider returned no answer for this question.');
            saveAttemptEvaluationFailure(context.orm, attemptId, evaluationId,
              evaluationFailureJson({ code: 'missing_batch_answer', message: 'Provider returned no answer for this question.' }));
          } else if ('failure' in answer) {
            const failure = { code: answer.failure.code, message: answer.failure.message, ...(answer.failure.detail ? { detail: answer.failure.detail } : {}) };
            markEvaluationFailed(context.orm, evaluationId, failure.code, failure.message, failureEvidenceJson(failure));
            saveAttemptEvaluationFailure(context.orm, attemptId, evaluationId, evaluationFailureJson(failure));
          } else {
            const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet'));
            let validated: ReturnType<typeof validateDecision> | undefined;
            try {
              const typed = decisionResultSchema.parse({ ...answer.value, ...result.data.execution });
              validated = validateDecision(packet, typed, { maxAttempts: 1 });
            } catch {
              const failure = { code: 'invalid_decision', message: 'The stored answer did not satisfy this question contract.', detail: decisionFailureDetailForReason('invalid_answer') };
              markEvaluationFailed(context.orm, evaluationId, failure.code, failure.message, failureEvidenceJson(failure));
              saveAttemptEvaluationFailure(context.orm, attemptId, evaluationId, evaluationFailureJson(failure));
            }
            if (validated) {
              markEvaluationAnswered(context.orm, evaluationId, encodeStoredPayload('decision-value', answer.value, decisionValueSchema));
              linkWinningAnswer(context.orm, claim.runId, evaluationId, attemptId);
            }
          }
        }
      }
      if (!chargeReservedAttempt(context.orm, claim.runId, chargedCalls)) {
        throw new RunStoreError('data_integrity_error', 'The run has no reserved physical call to settle.');
      }
      return context.database.prepare(`SELECT e.evaluation_id, e.status FROM attempt_evaluations ae
        JOIN evaluations e USING (evaluation_id) WHERE ae.attempt_id = ? ORDER BY e.ordinal`)
        .all(attemptId).map((row) => ({
          evaluationId: asText((row as DatabaseRow).evaluation_id, 'evaluation ID'),
          status: parseStored(evaluationStatusSchema, (row as DatabaseRow).status, 'evaluation status'),
        }));
}

export function settleSingleAttempt(context: { database: DatabaseSync; orm: NodeSQLiteDatabase; now(): number; ownedRun(claim: WorkerClaim, nowMs: number): DatabaseRow }, claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome): void {
  const nowMs = context.now();
  context.ownedRun(claim, nowMs);
  const attempt = context.database.prepare("SELECT evaluation_id FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
    .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
  if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
  const evaluationId = asText(attempt.evaluation_id, 'evaluation ID');
  const evaluation = context.database.prepare('SELECT packet_json FROM evaluations WHERE evaluation_id = ? AND run_id = ?').get(evaluationId, claim.runId) as DatabaseRow | undefined;
  if (!evaluation) throw new RunStoreError('data_integrity_error', 'The reserved evaluation is missing.');
  const packet = decisionRequestSchema.parse(parseJson(evaluation.packet_json, 'frozen packet'));
  if (outcome.kind === 'answered') {
    const result = validateDecision(packet, outcome.result, { maxAttempts: 1 });
    markAttemptAnswered(context.orm, attemptId, nowMs, result.attempts, JSON.stringify({ attempts: result.attempts, provider: result.provider, model: result.model, ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}), latencyMs: result.latencyMs, usage: result.usage, ...(result.cost ? { cost: result.cost } : {}) }), JSON.stringify(result));
    markEvaluationAnswered(context.orm, evaluationId, encodeStoredPayload('decision-value', decisionValueFromResult(result), decisionValueSchema));
    linkWinningAnswer(context.orm, claim.runId, evaluationId, attemptId);
  } else {
    const chargedCalls = outcome.providerAttempts ?? 1;
    markAttemptFailed(context.orm, attemptId, nowMs, chargedCalls, outcome.code, outcome.message, outcome.scope);
    markEvaluationFailed(context.orm, evaluationId, outcome.code, outcome.message, failureEvidenceJson(outcome));
    const failure = { code: outcome.code, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.providerFailure ? { providerFailure: outcome.providerFailure } : {}) };
    saveAttemptEvaluationFailure(context.orm, attemptId, evaluationId, evaluationFailureJson(failure));
    if (outcome.scope === 'run') markRunFailed(context.orm, claim.runId, outcome.code, outcome.message);
  }
  if (!chargeReservedAttempt(context.orm, claim.runId, outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : outcome.result.attempts)) {
    throw new RunStoreError('data_integrity_error', 'The run has no reserved physical call to settle.');
  }
}
