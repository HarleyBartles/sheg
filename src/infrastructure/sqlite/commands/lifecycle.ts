import { and, eq, gt } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { WorkerClaim } from '../../../domain/run/lifecycle.js';
import { runs } from '../tables.js';

export function requestRunCancellation(database: NodeSQLiteDatabase, runId: string, status: string): void {
  if (status === 'prepared') {
    database.update(runs).set({ status: 'cancelled', cancelRequested: true })
      .where(and(eq(runs.runId, runId), eq(runs.status, 'prepared'))).run();
  } else if (status === 'running') {
    database.update(runs).set({ cancelRequested: true }).where(eq(runs.runId, runId)).run();
  }
}

export function claimPreparedRun(database: NodeSQLiteDatabase, runId: string, ownerToken: string, workerPid: number, leaseExpiresMs: number): boolean {
  return database.update(runs).set({ status: 'running', ownerToken, ownerPid: workerPid, leaseExpiresMs })
    .where(and(eq(runs.runId, runId), eq(runs.status, 'prepared')))
    .returning({ runId: runs.runId }).all().length === 1;
}

export function refreshWorkerLease(database: NodeSQLiteDatabase, claim: WorkerClaim, nowMs: number, leaseMs: number): boolean {
  return database.update(runs).set({ leaseExpiresMs: nowMs + leaseMs })
    .where(and(
      eq(runs.runId, claim.runId),
      eq(runs.status, 'running'),
      eq(runs.ownerToken, claim.ownerToken),
      gt(runs.leaseExpiresMs, nowMs),
    )).returning({ runId: runs.runId }).all().length === 1;
}
