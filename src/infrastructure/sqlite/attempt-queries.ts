import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { providerExecutionEvidenceSchema } from '../../domain/decision/decision.js';
import type { Page, RunAttempt } from '../../domain/run/lifecycle.js';
import { asNumber, asText, parseJson } from './rows.js';
import { RunStoreError } from '../../application/run-store.js';
import { decodeCursor, encodeCursor, pageSize, type AttemptCursorPayload } from './cursors.js';
import { evaluationFailureFromJson } from './evidence-records.js';
import { attempts, attemptEvaluations, evaluations } from './tables.js';
import { z } from 'zod';

const attemptCursorSchema = z.object({ kind: z.literal('attempts'), runId: z.string().min(1), sequence: z.number().int().positive() }).strict();

export function loadAttempts(database: NodeSQLiteDatabase, runId: string, cursorText: string | undefined, requestedLimit: number | undefined, ensureRun: () => void): Page<RunAttempt> {
  ensureRun();
  const limit = pageSize(requestedLimit);
  let cursor: AttemptCursorPayload | undefined;
  if (cursorText) {
    cursor = decodeCursor(cursorText, 'attempts', attemptCursorSchema);
    if (cursor.kind !== 'attempts' || cursor.runId !== runId || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1) {
      throw new RunStoreError('invalid_cursor', 'The attempt cursor does not match this run.');
    }
  }
  const where = cursor
    ? and(eq(attempts.runId, runId), gt(attempts.attemptSequence, cursor.sequence))
    : eq(attempts.runId, runId);
  const rows = database.select({
    attemptId: attempts.attemptId,
    attemptSequence: attempts.attemptSequence,
    groupId: attempts.groupId,
    status: attempts.status,
    startedMs: attempts.startedMs,
    settledMs: attempts.settledMs,
    failureCode: attempts.failureCode,
    failureMessage: attempts.failureMessage,
    failureScope: attempts.failureScope,
    executionJson: attempts.executionJson,
  }).from(attempts).where(where).orderBy(asc(attempts.attemptSequence)).limit(limit + 1).all();
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const attemptIds = pageRows.map(({ attemptId }) => attemptId);
  const memberships = attemptIds.length === 0 ? [] : database.select({
    attemptId: attemptEvaluations.attemptId,
    evaluationId: attemptEvaluations.evaluationId,
    questionId: evaluations.questionId,
    failureJson: attemptEvaluations.failureJson,
  }).from(attemptEvaluations).innerJoin(evaluations, and(
    eq(evaluations.runId, attemptEvaluations.runId),
    eq(evaluations.evaluationId, attemptEvaluations.evaluationId),
  )).where(and(eq(attemptEvaluations.runId, runId), inArray(attemptEvaluations.attemptId, attemptIds)))
    .orderBy(asc(evaluations.ordinal)).all();
  const membershipsByAttempt = new Map<string, string[]>();
  const failuresByAttempt = new Map<string, RunAttempt['evaluationFailures']>();
  for (const membership of memberships) {
    const ids = membershipsByAttempt.get(membership.attemptId) ?? [];
    ids.push(membership.evaluationId);
    membershipsByAttempt.set(membership.attemptId, ids);
    const failure = evaluationFailureFromJson(membership.failureJson);
    if (failure) {
      const failures = failuresByAttempt.get(membership.attemptId) ?? [];
      failures.push({ evaluationId: membership.evaluationId, questionId: membership.questionId, failure });
      failuresByAttempt.set(membership.attemptId, failures);
    }
  }
  const items = pageRows.map((row): RunAttempt => {
    const evaluationFailures = failuresByAttempt.get(row.attemptId) ?? [];
    const attempt: RunAttempt = {
      attemptId: asText(row.attemptId, 'attempt ID'),
      groupId: asText(row.groupId, 'question group ID'),
      evaluationIds: membershipsByAttempt.get(row.attemptId) ?? [],
      status: asText(row.status, 'attempt status') as RunAttempt['status'],
      startedAt: new Date(asNumber(row.startedMs, 'attempt start time')).toISOString(),
      ...(row.settledMs === null ? {} : { settledAt: new Date(asNumber(row.settledMs, 'attempt settlement time')).toISOString() }),
      ...(row.failureCode === null ? {} : { failure: {
        code: asText(row.failureCode, 'attempt failure code'),
        message: asText(row.failureMessage, 'attempt failure message'),
        ...(row.failureScope === null ? {} : { scope: asText(row.failureScope, 'attempt failure scope') as 'evaluation' | 'run' }),
      } }),
      ...(evaluationFailures.length === 0 ? {} : { evaluationFailures }),
      ...(row.executionJson === null ? {} : { execution: providerExecutionEvidenceSchema.parse(parseJson(row.executionJson, 'attempt execution')) }),
    };
    return attempt;
  });
  const last = pageRows.at(-1);
  return { items, ...(hasMore && last ? { nextCursor: encodeCursor({
    kind: 'attempts', runId, sequence: asNumber(last.attemptSequence, 'attempt sequence'),
  } satisfies AttemptCursorPayload) } : {}) };
}
