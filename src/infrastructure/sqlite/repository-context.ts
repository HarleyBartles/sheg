import { decisionRequestSchema } from '../../domain/decision/decision.js';
import type { FrozenEvaluation } from '../../domain/run/request.js';
import type { RunStatusView, WorkerClaim } from '../../domain/run/lifecycle.js';
import { RunStoreError } from '../../application/run-store.js';
import { asNumber, asText, parseJson, type DatabaseRow } from './rows.js';
import { readStatusViews } from './reads/status.js';
import { reconcileRun } from './commands/reconciliation.js';
import type { SqliteConnection } from './connection.js';
import { readTransaction, writeTransaction } from './connection.js';
import { SCHEMA_VERSION } from './schema.js';

export type SqliteRepositoryContext = ReturnType<typeof createSqliteRepositoryContext>;

export function createSqliteRepositoryContext(connection: SqliteConnection, databasePath: string, now: () => number) {
  const database = connection.client;
  let isClosed = false;

  function ensureOpen(): void {
    if (isClosed) throw new RunStoreError('store_closed', 'This run store connection is closed.');
    const version = database.prepare('PRAGMA user_version').get() as { user_version: unknown };
    if (asNumber(version.user_version, 'schema version') !== SCHEMA_VERSION) {
      throw new RunStoreError('datastore_schema_changed', 'The datastore schema changed while this process was open. Close and reopen Sheg before continuing.');
    }
  }

  function transaction<T>(operation: () => T): T {
    return writeTransaction(database, operation);
  }

  function readSnapshot<T>(operation: () => T): T {
    return readTransaction(database, operation);
  }

  function notFound(): never {
    throw new RunStoreError('run_not_found', 'The requested run does not exist in this datastore.');
  }

  function statusesInside(runIds: string[]): RunStatusView[] {
    return readStatusViews(database, runIds);
  }

  function statusInside(runId: string): RunStatusView {
    const result = statusesInside([runId])[0];
    if (!result) throw notFound();
    return result;
  }

  function evaluationFromRow(row: DatabaseRow): FrozenEvaluation {
    return {
      evaluationId: asText(row.evaluation_id, 'evaluation ID'),
      contextId: asText(row.context_id, 'context ID'),
      respondentId: asText(row.respondent_id, 'respondent ID'),
      questionId: asText(row.question_id, 'question ID'),
      packet: decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet')),
      packetFingerprint: asText(row.packet_fingerprint, 'packet fingerprint'),
    };
  }

  function ownedRun(claim: WorkerClaim, nowMs: number): DatabaseRow {
    const run = database.prepare("SELECT * FROM runs WHERE run_id = ? AND status = 'running' AND owner_token = ? AND lease_expires_ms > ?")
      .get(claim.runId, claim.ownerToken, nowMs) as DatabaseRow | undefined;
    if (!run) throw new RunStoreError('worker_ownership_lost', 'This worker no longer owns the run.');
    return run;
  }

  function reconcileInside(runId: string, nowMs: number): void {
    reconcileRun(database, connection.orm, runId, nowMs, notFound);
  }

  function close(): void {
    if (isClosed) return;
    connection.close();
    isClosed = true;
  }

  return {
    connection,
    database,
    databasePath,
    now,
    ensureOpen,
    transaction,
    readSnapshot,
    notFound,
    statusInside,
    statusesInside,
    evaluationFromRow,
    ownedRun,
    reconcileInside,
    close,
  };
}
