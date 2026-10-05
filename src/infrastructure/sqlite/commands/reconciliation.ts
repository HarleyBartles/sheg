import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import type { RunStatus } from '../../../domain/run/lifecycle.js';
import { RunStoreError } from '../../../application/run-store.js';
import { asNumber, asText, type DatabaseRow } from '../rows.js';
import type { RunDeletionSnapshot } from '../run-deletion-queries.js';
import { interruptExpiredRun, interruptReservedAttempts, interruptUnclaimedRun } from './lifecycle.js';
import { PREPARED_LAUNCH_WINDOW_MS } from '../work-policy.js';

export function reconcileRun(database: DatabaseSync, orm: NodeSQLiteDatabase, runId: string, nowMs: number, notFound: () => never): void {
  const run = database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
  if (!run) throw notFound();
  const status = asText(run.status, 'run status');
  const launchDeadline = run.lease_expires_ms === null
    ? asNumber(run.created_ms, 'created time') + PREPARED_LAUNCH_WINDOW_MS
    : asNumber(run.lease_expires_ms, 'launch deadline');
  if (status === 'prepared' && nowMs >= launchDeadline) {
    interruptUnclaimedRun(orm, runId);
  } else if (status === 'running' && run.lease_expires_ms !== null && asNumber(run.lease_expires_ms, 'worker lease') <= nowMs) {
    const attempts = database.prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND status = 'reserved'").get(runId) as DatabaseRow;
    const uncertain = asNumber(attempts.count, 'uncertain attempt count');
    if (uncertain !== asNumber(run.reserved_calls, 'reserved calls')) {
      throw new RunStoreError('data_integrity_error', 'Reserved call counters do not match reserved attempts.');
    }
    const updatedUncertainAttempts = interruptReservedAttempts(orm, runId, nowMs);
    if (updatedUncertainAttempts !== uncertain || !interruptExpiredRun(orm, runId, nowMs, uncertain)) {
      throw new RunStoreError('data_integrity_error', 'Expired worker reservations changed during reconciliation.');
    }
  }
}

export function reconcileSelectedRuns(orm: NodeSQLiteDatabase, snapshot: RunDeletionSnapshot, nowMs: number): Map<string, RunStatus> {
  const statuses = new Map<string, RunStatus>();
  for (const run of snapshot.runs) {
    const status = asText(run.status, 'run status') as RunStatus;
    const leaseExpires = run.leaseExpiresMs ?? run.createdMs + PREPARED_LAUNCH_WINDOW_MS;
    if (status === 'prepared' && nowMs >= leaseExpires) {
      interruptUnclaimedRun(orm, run.runId);
      statuses.set(run.runId, 'interrupted');
    } else if (status === 'running' && run.leaseExpiresMs !== null && run.leaseExpiresMs <= nowMs) {
      const uncertain = snapshot.reservedAttemptCounts.get(run.runId) ?? 0;
      if (uncertain !== run.reservedCalls) {
        throw new RunStoreError('data_integrity_error', 'Reserved call counters do not match reserved attempts.');
      }
      const updatedUncertainAttempts = interruptReservedAttempts(orm, run.runId, nowMs);
      if (updatedUncertainAttempts !== uncertain || !interruptExpiredRun(orm, run.runId, nowMs, uncertain)) {
        throw new RunStoreError('data_integrity_error', 'Expired worker reservations changed during reconciliation.');
      }
      statuses.set(run.runId, 'interrupted');
    } else {
      statuses.set(run.runId, status);
    }
  }
  return statuses;
}
