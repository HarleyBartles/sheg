import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { asNumber, asText } from './rows.js';
import { attempts, evaluations, runs } from './tables.js';

export type RunDeletionRow = {
  runId: string;
  status: string;
  createdMs: number;
  leaseExpiresMs: number | null;
  reservedCalls: number;
};

export type RunDeletionSnapshot = {
  runs: RunDeletionRow[];
  evaluationCounts: Map<string, number>;
  attemptCounts: Map<string, number>;
  reservedAttemptCounts: Map<string, number>;
  dependentRunIds: Map<string, string[]>;
};

function countsByRun(rows: Array<{ runId: string; count: number }>): Map<string, number> {
  return new Map(rows.map((row) => [asText(row.runId, 'run ID'), asNumber(row.count, 'selected row count')]));
}

export function loadRunDeletionSnapshot(database: NodeSQLiteDatabase, runIds: string[], options: { includeReservedAttemptCounts?: boolean } = {}): RunDeletionSnapshot {
  const runRows = database.select({
    runId: runs.runId,
    status: runs.status,
    createdMs: runs.createdMs,
    leaseExpiresMs: runs.leaseExpiresMs,
    reservedCalls: runs.reservedCalls,
  }).from(runs).where(inArray(runs.runId, runIds)).all();
  const evaluationCounts = countsByRun(database.select({ runId: evaluations.runId, count: count() }).from(evaluations)
    .where(inArray(evaluations.runId, runIds)).groupBy(evaluations.runId).all());
  const attemptCounts = countsByRun(database.select({ runId: attempts.runId, count: count() }).from(attempts)
    .where(inArray(attempts.runId, runIds)).groupBy(attempts.runId).all());
  const reservedAttemptCounts = options.includeReservedAttemptCounts
    ? countsByRun(database.select({ runId: attempts.runId, count: count() }).from(attempts)
      .where(and(inArray(attempts.runId, runIds), eq(attempts.status, 'reserved'))).groupBy(attempts.runId).all())
    : new Map<string, number>();
  const sourceRunId = sql<string | null>`json_extract(${runs.requestJson}, '$.lineage.sourceRunId')`;
  const dependentRows = database.select({ runId: runs.runId, createdMs: runs.createdMs, sourceRunId }).from(runs)
    .where(inArray(sourceRunId, runIds)).orderBy(asc(runs.createdMs), asc(runs.runId)).all();
  const dependentRunIds = new Map<string, string[]>();
  for (const row of dependentRows) {
    if (row.sourceRunId === null) continue;
    const dependents = dependentRunIds.get(row.sourceRunId) ?? [];
    dependents.push(asText(row.runId, 'dependent run ID'));
    dependentRunIds.set(row.sourceRunId, dependents);
  }
  return {
    runs: runRows.map((row) => ({
      runId: asText(row.runId, 'run ID'),
      status: asText(row.status, 'run status'),
      createdMs: asNumber(row.createdMs, 'run creation time'),
      leaseExpiresMs: row.leaseExpiresMs === null ? null : asNumber(row.leaseExpiresMs, 'run lease expiry'),
      reservedCalls: asNumber(row.reservedCalls, 'reserved calls'),
    })),
    evaluationCounts,
    attemptCounts,
    reservedAttemptCounts,
    dependentRunIds,
  };
}
