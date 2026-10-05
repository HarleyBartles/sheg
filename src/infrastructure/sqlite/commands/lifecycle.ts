import { and, eq, gte, gt, lte, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { RunStatus, WorkerClaim } from '../../../domain/run/lifecycle.js';
import { attempts, runs } from '../tables.js';

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

export function finishRun(database: NodeSQLiteDatabase, runId: string, status: RunStatus): void {
  database.update(runs).set({ status, ownerToken: null, ownerPid: null, leaseExpiresMs: null })
    .where(eq(runs.runId, runId)).run();
}

export function failPreparedLaunch(database: NodeSQLiteDatabase, runId: string, code: string): boolean {
  return database.update(runs).set({ status: 'failed', failureScope: 'run', failureCode: code, failureMessage: 'Worker could not be launched' })
    .where(and(eq(runs.runId, runId), eq(runs.status, 'prepared')))
    .returning({ runId: runs.runId }).all().length === 1;
}

export function failOwnedRun(database: NodeSQLiteDatabase, runId: string, ownerToken: string, code: string, message: string): boolean {
  return database.update(runs).set({
    status: 'failed', failureScope: 'run', failureCode: code, failureMessage: message,
    ownerToken: null, ownerPid: null, leaseExpiresMs: null,
  }).where(and(eq(runs.runId, runId), eq(runs.ownerToken, ownerToken)))
    .returning({ runId: runs.runId }).all().length === 1;
}

export function interruptUnclaimedRun(database: NodeSQLiteDatabase, runId: string): void {
  database.update(runs).set({
    status: 'interrupted', failureScope: 'run', failureCode: 'worker_not_claimed',
    failureMessage: 'No worker claimed the accepted run before its launch window expired',
  }).where(and(eq(runs.runId, runId), eq(runs.status, 'prepared'))).run();
}

export function interruptReservedAttempts(database: NodeSQLiteDatabase, runId: string, nowMs: number): number {
  return database.update(attempts).set({
    status: 'uncertain', settledMs: nowMs, chargedCalls: 1,
    failureCode: 'worker_interrupted', failureMessage: 'Provider completion is unknown',
  }).where(and(eq(attempts.runId, runId), eq(attempts.status, 'reserved')))
    .returning({ attemptId: attempts.attemptId }).all().length;
}

export function interruptExpiredRun(database: NodeSQLiteDatabase, runId: string, nowMs: number, uncertainCalls: number): boolean {
  return database.update(runs).set({
    status: 'interrupted',
    usedCalls: sql`${runs.usedCalls} + ${uncertainCalls}`,
    reservedCalls: sql`${runs.reservedCalls} - ${uncertainCalls}`,
    ownerToken: null, ownerPid: null, leaseExpiresMs: null,
    failureScope: 'run', failureCode: 'worker_interrupted',
    failureMessage: 'Worker ownership expired; unfinished work requires explicit resume',
  }).where(and(
    eq(runs.runId, runId), eq(runs.status, 'running'), lte(runs.leaseExpiresMs, nowMs),
    gte(runs.reservedCalls, uncertainCalls),
  )).returning({ runId: runs.runId }).all().length === 1;
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
