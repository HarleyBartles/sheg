import { eq, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { attemptEvaluations, attempts, runs } from '../tables.js';

type ReservedAttempt = {
  attemptId: string;
  runId: string;
  groupId: string;
  anchorEvaluationId: string;
  packetFingerprint: string;
  ownerToken: string;
  startedMs: number;
  evaluationIds: string[];
};

export function reservePhysicalAttempt(database: NodeSQLiteDatabase, attempt: ReservedAttempt): void {
  database.insert(attempts).values({
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    groupId: attempt.groupId,
    evaluationId: attempt.anchorEvaluationId,
    packetFingerprint: attempt.packetFingerprint,
    ownerToken: attempt.ownerToken,
    status: 'reserved',
    startedMs: attempt.startedMs,
  }).run();
  database.insert(attemptEvaluations).values(attempt.evaluationIds.map((evaluationId) => ({
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    evaluationId,
  }))).run();
  database.update(runs).set({ reservedCalls: sql`${runs.reservedCalls} + 1` })
    .where(eq(runs.runId, attempt.runId)).run();
}
