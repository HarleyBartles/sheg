import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { decisionRequestSchema } from '../domain/decision/decision.js';
import { validateDecision } from '../domain/decision/validate.js';
import { compileDecisionPacketForCompiler } from '../domain/decision/prompt.js';
import type { JourneyDefinition } from '../domain/study/arm.js';
import { deriveRunLifecycle, resumeRefusalMessage, type AttemptReservation, type AnswerRow, type JourneyEvaluation, type JourneyEvaluationRecord, type JourneyRespondentState, type JourneyRunRecord, type Page, type RunAttempt, type RunContextDetail, type RunEvidencePage, type RunEvidenceQuery, type RunStatus, type RunStatusView, type WorkerClaim } from '../domain/run/lifecycle.js';
import { decisionFailureDetailForReason, decisionFailureDetailSchema, decisionResultSchema, decisionValueSchema, decisionBatchResultSchema, providerExecutionEvidenceSchema, type DecisionBatchResult, type DecisionFailureDetail } from '../domain/decision/decision.js';
import { followOnLineageSchema, followOnRunRequestSchema, runEvidenceQuerySchema, runLifecycleSchema, runRequestSchema, type FollowOnLineage, type FollowOnSourceSet, type FrozenEvaluation, type ParsedFollowOnRunRequest, type PreparedJourneyRun, type PreparedRun, type RunListQueryInput, type RunMaterialItem } from '../domain/run/request.js';
import { hashCanonical } from './identity.js';
import { journeyTopology } from '../domain/journey/topology.js';
import { hasSequentialMigrationPath } from './schema-migration-path.js';

const SCHEMA_VERSION = 8;
const LEASE_MS = 30_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function mergeMaterialCatalog(...collections: readonly (readonly RunMaterialItem[])[]): RunMaterialItem[] {
  const merged = new Map<string, RunMaterialItem>();
  for (const collection of collections) for (const item of collection) {
    const previous = merged.get(item.id);
    if (previous && (previous.text !== item.text || previous.sourceId && item.sourceId && previous.sourceId !== item.sourceId || previous.sourceSha256 && item.sourceSha256 && previous.sourceSha256 !== item.sourceSha256)) {
      throw new RunStoreError('data_integrity_error', `Stored material ${item.id} has conflicting text or source provenance.`);
    }
    merged.set(item.id, previous ? { ...previous, ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }), ...(item.sourceSha256 === undefined ? {} : { sourceSha256: item.sourceSha256 }) } : { ...item });
  }
  return [...merged.values()];
}

function materialCatalogForRequest(request: import('../domain/run/request.js').ParsedRunRequest, lineage: FollowOnLineage | undefined, contextId: string, respondentId: string, encountered: readonly { id: string; text: string }[] = []): RunMaterialItem[] {
  const source = request.kind === 'poll' ? request.material : request.kind === 'journey' ? request.journey.items : request.material ?? [];
  const inherited = request.kind === 'follow-on'
    ? lineage?.materialSnapshots.filter((snapshot) => snapshot.contextId === contextId && snapshot.respondentId === respondentId).flatMap(({ materials }) => materials) ?? []
    : [];
  return mergeMaterialCatalog(source, inherited, encountered);
}

function encounteredMaterialsFromState(state: Record<string, unknown>): Array<{ id: string; text: string }> {
  if (!Array.isArray(state.encounteredItems)) return [];
  return state.encounteredItems.flatMap((item) => typeof item === 'object' && item !== null &&
    'id' in item && typeof item.id === 'string' && 'text' in item && typeof item.text === 'string'
    ? [{ id: item.id, text: item.text }]
    : []);
}

export type AttemptOutcome =
  | { kind: 'answered'; result: import('../domain/decision/decision.js').DecisionResult }
  | { kind: 'failed'; code: string; message: string; scope: 'evaluation' | 'run'; detail?: DecisionFailureDetail; providerAttempts?: number };

export type RunListQuery = RunListQueryInput;
export type DeletePreview = { runs: Array<{ runId: string; status: RunStatus; evaluationCount: number; attemptCount: number; blockedByActiveWork: boolean; retainedFollowOnRunIds: string[] }>; blockedByActiveWork: boolean };
export type DeleteResult = {
  deletedRunIds: string[];
  removed: { runs: number; evaluations: number; attempts: number };
  maintenance: { optimization: 'completed' } | { optimization: 'failed'; failureCode: string };
};
export type StorageInfo = { integrity: 'ok' | 'failed'; databaseBytes: number; runCount: number; evaluationCount: number; attemptCount: number; activeRunCount: number };
export type JourneyTransition = { respondentId: string; expectedRevision: number; state: JourneyRespondentState; nextEvaluation?: JourneyEvaluation };

export class RunStoreError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunStoreError';
  }
}

function sameDecisionValue(left: import('../domain/decision/decision.js').DecisionValue, right: import('../domain/decision/decision.js').DecisionValue): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'choice' && right.type === 'choice') {
    return left.choice === right.choice && hashCanonical(left.probabilities ?? null) === hashCanonical(right.probabilities ?? null) && left.confidence === right.confidence;
  }
  if (left.type === 'score' && right.type === 'score') {
    return left.score === right.score && hashCanonical(left.probabilities) === hashCanonical(right.probabilities) &&
      hashCanonical(left.legend) === hashCanonical(right.legend) && left.confidence === right.confidence;
  }
  return left.type === 'noul' && right.type === 'noul' && left.noul === right.noul;
}

function isJourneyAskNode(journey: JourneyDefinition, nodeId: string, questionId: string): boolean {
  const node = journeyTopology(journey).nodes.find((candidate) => candidate.id === nodeId);
  return node?.kind === 'ask' && node.taskId === questionId;
}

function journeyRouteTarget(journey: JourneyDefinition, nodeId: string, response: import('../domain/decision/decision.js').DecisionValue): string | undefined {
  const graph = journeyTopology(journey);
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.kind !== 'ask') return undefined;
  const task = journey.tasks.find((candidate) => candidate.id === node.taskId);
  if (!task) return undefined;
  const edge = graph.transitions.find((candidate) => {
    if (candidate.fromNodeId !== nodeId) return false;
    if (response.type === 'choice') return candidate.optionId === response.choice;
    const interval = candidate.when;
    const value = response.type === 'score' ? response.score : response.noul;
    return interval?.type === response.type &&
      (value > interval.minimum || value === interval.minimum && interval.minimumInclusive) &&
      (value < interval.maximum || value === interval.maximum && interval.maximumInclusive);
  });
  return edge?.toNodeId;
}

export interface RunStore {
  findSubmission(submissionId: string, requestFingerprint: string): RunStatusView | null;
  accept(submissionId: string, prepared: PreparedRun): { created: boolean; run: RunStatusView };
  acceptJourney(submissionId: string, prepared: PreparedJourneyRun): { created: boolean; run: RunStatusView };
  getStatus(runId: string): RunStatusView;
  evaluationStatuses(runId: string): Array<{ evaluationId: string; status: AnswerRow['status'] }>;
  getRequestKind(runId: string): 'poll' | 'journey' | 'follow-on';
  getRequest(runId: string): PreparedRun;
  getJourneyRun(runId: string): JourneyRunRecord;
  list(query: RunListQuery): Page<RunStatusView>;
  queryEvidence(query: RunEvidenceQuery): RunEvidencePage;
  getContext(runId: string, evaluationId: string, contextId: string): RunContextDetail;
  resolveFollowOnSources(request: ParsedFollowOnRunRequest): FollowOnSourceSet;
  answers(runId: string, cursor?: string, limit?: number): Page<AnswerRow>;
  attempts(runId: string, cursor?: string, limit?: number): Page<RunAttempt>;
  requestCancel(runId: string): RunStatusView;
  resume(runId: string, nowMs: number): { started: boolean; run: RunStatusView };
  previewDelete(runIds: string[]): DeletePreview;
  deleteRuns(runIds: string[]): DeleteResult;
  storageInfo(): StorageInfo;
  optimizeStorage(): void;
  claim(runId: string, nowMs: number, workerPid: number): WorkerClaim | null;
  heartbeat(claim: WorkerClaim, nowMs: number): boolean;
  reserveNext(claim: WorkerClaim, nowMs: number): AttemptReservation | null;
  reserveBatch(claim: WorkerClaim, groupId: string, evaluationIds: string[], nowMs: number): { attemptId: string; evaluations: FrozenEvaluation[] } | null;
  settleBatch(claim: WorkerClaim, attemptId: string, outcome: { kind: 'answered'; result: DecisionBatchResult } | Extract<AttemptOutcome, { kind: 'failed' }>): void;
  settle(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome): void;
  settleJourney(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome, transition: JourneyTransition): void;
  finish(claim: WorkerClaim): RunStatusView;
  failLaunch(runId: string, code: string): void;
  failRun(claim: WorkerClaim, code: string, message: string): void;
  reconcile(runId: string, nowMs: number): RunStatusView;
  close(): void;
}

type DatabaseRow = Record<string, SQLOutputValue>;
type CursorPayload = { kind: 'runs'; createdMs: number; runId: string; filtersFingerprint: string };
type AnswerCursorPayload = { kind: 'answers'; runId: string; ordinal: number };
type AttemptCursorPayload = { kind: 'attempts'; runId: string; sequence: number };
type EvidenceCursorPayload = {
  kind: 'evidence'; sourceRunId: string; criteriaFingerprint: string; maxOrdinal: number; lastOrdinal: number;
  sourceStatus: RunStatus; sourceComplete: boolean; totalMatches: number;
  lifecycle: RunEvidencePage['lifecycle']; coverage: RunEvidencePage['coverage']; matchedCoverage: RunEvidencePage['matchedCoverage']; usedCalls: number; reservedCalls: number;
};

function asText(value: SQLOutputValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new RunStoreError('data_integrity_error', `Stored ${label} is not text.`);
  return value;
}

function asNullableText(value: SQLOutputValue | undefined, label: string): string | null {
  if (value === null) return null;
  return asText(value, label);
}

function asNumber(value: SQLOutputValue | undefined, label: string): number {
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new RunStoreError('data_integrity_error', `Stored ${label} is not numeric.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RunStoreError('data_integrity_error', `Stored ${label} is outside the safe integer range.`);
  return number;
}

function resultFromStorage(value: unknown, execution: unknown): import('../domain/decision/decision.js').DecisionResult {
  const complete = decisionResultSchema.safeParse(value);
  if (complete.success) return complete.data;
  const typed = decisionValueSchema.parse(value);
  const evidence = providerExecutionEvidenceSchema.parse(execution);
  return decisionResultSchema.parse({ ...typed, ...evidence });
}

function parseJson<T>(value: SQLOutputValue | undefined, label: string): T {
  try { return JSON.parse(asText(value, label)) as T; }
  catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('data_integrity_error', `Stored ${label} is not valid JSON.`, { cause: error });
  }
}

function failureDetailFromStorage(value: SQLOutputValue | undefined): DecisionFailureDetail | undefined {
  if (value === null || value === undefined) return undefined;
  return decisionFailureDetailSchema.parse(parseJson(value, 'typed-answer failure detail'));
}

function storedEvaluationFailure(row: DatabaseRow): import('../domain/run/lifecycle.js').EvaluationFailure | undefined {
  if (row.failure_code === null) return undefined;
  const detail = failureDetailFromStorage(row.failure_detail_json);
  return {
    code: asText(row.failure_code, 'failure code'),
    message: asText(row.failure_message, 'failure message'),
    ...(detail ? { detail } : {}),
  };
}

function evaluationFailureJson(failure: import('../domain/run/lifecycle.js').EvaluationFailure): string {
  return JSON.stringify(failure);
}

function evaluationFailureFromJson(value: SQLOutputValue | undefined): import('../domain/run/lifecycle.js').EvaluationFailure | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = parseJson<Record<string, unknown>>(value, 'attempt evaluation failure');
  if (typeof parsed.code !== 'string' || typeof parsed.message !== 'string') throw new RunStoreError('data_integrity_error', 'Stored attempt evaluation failure is invalid.');
  const detail = parsed.detail === undefined ? undefined : decisionFailureDetailSchema.parse(parsed.detail);
  return { code: parsed.code, message: parsed.message, ...(detail ? { detail } : {}) };
}

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(value: string, label: string): T {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('Cursor must be an object.');
    return parsed as T;
  }
  catch (error) { throw new RunStoreError('invalid_cursor', `The ${label} cursor is invalid.`, { cause: error }); }
}

function pageSize(limit: number | undefined): number {
  const size = limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new RunStoreError('invalid_page_size', `Page size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return size;
}

function validateRunIds(runIds: string[]): void {
  if (!Array.isArray(runIds) || runIds.length < 1 || runIds.length > 200 || runIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(runIds).size !== runIds.length) {
    throw new RunStoreError('invalid_run_selection', 'Select between 1 and 200 unique run IDs.');
  }
}

function isTransientSqliteLock(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errcode' in error &&
    (error.errcode === 5 || error.errcode === 6);
}

function setWriteAheadLogMode(database: DatabaseSync): void {
  const deadline = Date.now() + 5_000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      database.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (!isTransientSqliteLock(error) || Date.now() >= deadline) throw error;
      Atomics.wait(waitCell, 0, 0, Math.min(25, deadline - Date.now()));
    }
  }
}

type SchemaMigration = { fromVersion: number; toVersion: number; id: string; apply(database: DatabaseSync): void };

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [{
  fromVersion: 7,
  toVersion: 8,
  id: 'schema-v7-to-v8-ledger',
  apply(database) {
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)');
    database.prepare('INSERT INTO schema_migrations (version, migration_id, applied_at) VALUES (?, ?, ?)')
      .run(8, 'schema-v7-to-v8-ledger', new Date().toISOString());
  },
}];

function hasMigrationPath(fromVersion: number, targetVersion = SCHEMA_VERSION): boolean {
  return hasSequentialMigrationPath(fromVersion, targetVersion, SCHEMA_MIGRATIONS);
}

const REQUIRED_SCHEMA_COLUMNS = {
  runs: ['run_id', 'submission_id', 'request_fingerprint', 'created_at', 'created_ms', 'label', 'status', 'request_json', 'evaluation_count', 'max_calls', 'used_calls', 'reserved_calls', 'cancel_requested', 'owner_token', 'owner_pid', 'lease_expires_ms', 'failure_scope', 'failure_code', 'failure_message'],
  question_groups: ['group_id', 'run_id', 'ordinal', 'context_id', 'respondent_id', 'state_json', 'question_ids_json'],
  evaluations: ['evaluation_id', 'run_id', 'ordinal', 'context_id', 'respondent_id', 'question_id', 'group_id', 'turn_id', 'node_id', 'path_id', 'occurrence', 'packet_json', 'packet_fingerprint', 'status', 'result_json', 'failure_code', 'failure_message', 'failure_detail_json'],
  journey_respondents: ['run_id', 'respondent_id', 'status', 'current_node_id', 'current_turn_id', 'current_context_id', 'revision', 'events_json', 'route_json', 'outcome'],
  attempts: ['attempt_sequence', 'attempt_id', 'run_id', 'group_id', 'evaluation_id', 'packet_fingerprint', 'owner_token', 'status', 'started_ms', 'settled_ms', 'result_json', 'execution_json', 'failure_code', 'failure_message', 'failure_scope'],
  attempt_evaluations: ['attempt_id', 'evaluation_id', 'failure_json'],
  evaluation_answer_attempts: ['evaluation_id', 'attempt_id'],
  schema_migrations: ['version', 'migration_id', 'applied_at'],
} as const;

function validateSchemaShape(database: DatabaseSync): void {
  const rows = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as DatabaseRow[];
  const actual = new Set(rows.map((row) => asText(row.name, 'schema table name')));
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    if (!actual.has(table)) throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore is missing required schema objects. Preserve its original files and use run_storage to inspect recovery options.');
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as DatabaseRow[];
    const columnNames = new Set(columns.map((column) => asText(column.name, `${table} column name`)));
    if (requiredColumns.some((column) => !columnNames.has(column))) throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore is missing required schema objects. Preserve its original files and use run_storage to inspect recovery options.');
  }
  const migration = database.prepare('SELECT migration_id FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION) as DatabaseRow | undefined;
  const migrationId = migration?.migration_id;
  const validMigrationIds = [`baseline-v${SCHEMA_VERSION}`, ...SCHEMA_MIGRATIONS.filter(({ toVersion }) => toVersion === SCHEMA_VERSION).map(({ id }) => id)];
  if (typeof migrationId !== 'string' || !validMigrationIds.includes(migrationId)) throw new RunStoreError('datastore_schema_invalid', 'The Sheg datastore has no recognized applied-migration record for its current schema. Preserve its original files and use run_storage to inspect recovery options.');
}

function checkDatabaseIntegrity(database: DatabaseSync, checkForeignKeys = true): void {
  const integrity = database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new RunStoreError('migration_integrity_failed', 'The datastore failed its SQLite integrity check during migration. The original database was left recoverable.');
  }
  const foreignKeys = checkForeignKeys ? database.prepare('PRAGMA foreign_key_check').all() : [];
  if (foreignKeys.length > 0) {
    throw new RunStoreError('migration_integrity_failed', 'The datastore has foreign-key violations during migration. The original database was left recoverable.');
  }
}

function verifiedBackup(database: DatabaseSync, dataRoot: string, fromVersion: number, toVersion: number, purpose = `before-${toVersion}`, checkForeignKeys = true): string {
  const backupRoot = path.join(dataRoot, 'backups');
  mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, `runs-schema-${fromVersion}-${purpose}-${randomUUID()}.sqlite`);
  const escapedPath = backupPath.replaceAll("'", "''");
  try {
    database.exec(`VACUUM INTO '${escapedPath}'`);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const versionRow = backup.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
      if (asNumber(versionRow?.user_version, 'backup schema version') !== fromVersion) {
        throw new RunStoreError('migration_backup_failed', 'The datastore backup does not match the source schema version.');
      }
      checkDatabaseIntegrity(backup, checkForeignKeys);
    } finally { backup.close(); }
    return backupPath;
  } catch (error) {
    try { unlinkSync(backupPath); } catch { /* Preserve the backup error. */ }
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('migration_backup_failed', 'Sheg could not verify a recoverable datastore backup; the source database was not migrated.', { cause: error });
  }
}

function migrate(database: DatabaseSync, dataRoot: string, startingVersion: number): void {
  let version = startingVersion;
  while (version < SCHEMA_VERSION) {
    const step = SCHEMA_MIGRATIONS.find(({ fromVersion }) => fromVersion === version);
    if (!step || step.toVersion !== step.fromVersion + 1 || step.toVersion > SCHEMA_VERSION) {
      throw new RunStoreError('unsupported_schema_version', `The Sheg datastore schema ${version} has no supported migration path to ${SCHEMA_VERSION}. Preserve the database and use run_storage to inspect recovery options.`);
    }
    const liveVersion = asNumber((database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version, 'schema version');
    if (liveVersion === step.toVersion) { version = liveVersion; continue; }
    if (liveVersion !== step.fromVersion) throw new RunStoreError('unsupported_schema_version', `The Sheg datastore changed to schema ${liveVersion} while opening; preserve it and use run_storage to inspect compatibility.`);
    try { verifiedBackup(database, dataRoot, step.fromVersion, step.toVersion); }
    catch (error) {
      const updatedVersion = asNumber((database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version, 'schema version');
      if (updatedVersion === step.toVersion) { version = updatedVersion; continue; }
      throw error;
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      const lockedVersion = asNumber((database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version, 'schema version');
      if (lockedVersion === step.toVersion) {
        database.exec('COMMIT');
        version = lockedVersion;
        continue;
      }
      if (lockedVersion !== step.fromVersion) throw new RunStoreError('unsupported_schema_version', `The Sheg datastore changed to schema ${lockedVersion} while migrating; preserve it and use run_storage to inspect compatibility.`);
      step.apply(database);
      database.exec(`PRAGMA user_version = ${step.toVersion}`);
      checkDatabaseIntegrity(database);
      if (step.toVersion === SCHEMA_VERSION) validateSchemaShape(database);
      database.exec('COMMIT');
      version = step.toVersion;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the migration error. */ }
      if (error instanceof RunStoreError) throw error;
      throw new RunStoreError('migration_failed', `Sheg could not migrate the datastore from schema ${step.fromVersion} to ${step.toVersion}. A verified backup was retained; use run_storage to inspect recovery options.`, { cause: error });
    }
  }
}

function initialize(database: DatabaseSync, dataRoot: string): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
  const version = asNumber(versionRow?.user_version, 'schema version');
  const existing = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as DatabaseRow | undefined;
  const tableCount = asNumber(existing?.count, 'table count');

  if (version === 0 && tableCount !== 0) {
    throw new RunStoreError('unsupported_schema_version', 'The datastore contains unversioned tables and cannot be opened safely. Preserve it and use run_storage to inspect recovery options.');
  }
  if (version > SCHEMA_VERSION) {
    throw new RunStoreError('unsupported_schema_version', `The Sheg database schema version ${version} is newer than this build. Preserve it and use run_storage to inspect recovery options.`);
  }
  if (version !== 0 && version < 7) {
    throw new RunStoreError('unsupported_schema_version', `The Sheg database schema version ${version} is not supported. Export or reset this pre-v1 datastore only through explicit run_storage recovery.`);
  }

  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA synchronous = FULL;');

  if (version === SCHEMA_VERSION) {
    checkDatabaseIntegrity(database);
    validateSchemaShape(database);
    setWriteAheadLogMode(database);
    return;
  }
  if (version >= 7 && version < SCHEMA_VERSION) {
    migrate(database, dataRoot, version);
    setWriteAheadLogMode(database);
    return;
  }

  setWriteAheadLogMode(database);
  database.exec('BEGIN IMMEDIATE');
  try {
    const lockedVersion = asNumber((database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version, 'schema version');
    const lockedTables = asNumber((database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as DatabaseRow).count, 'table count');
    if (lockedVersion === SCHEMA_VERSION && lockedTables > 0) {
      database.exec('COMMIT');
      checkDatabaseIntegrity(database);
      return;
    }
    if (lockedVersion !== 0 || lockedTables !== 0) throw new RunStoreError('unsupported_schema_version', 'The Sheg datastore changed while being initialized; preserve it and use run_storage to inspect compatibility.');
    database.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      label TEXT,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted')),
      request_json TEXT NOT NULL,
      evaluation_count INTEGER NOT NULL CHECK (evaluation_count > 0),
      max_calls INTEGER NOT NULL CHECK (max_calls > 0),
      used_calls INTEGER NOT NULL DEFAULT 0 CHECK (used_calls >= 0),
      reserved_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      owner_token TEXT,
      owner_pid INTEGER,
      lease_expires_ms INTEGER,
      failure_scope TEXT CHECK (failure_scope IS NULL OR failure_scope IN ('evaluation', 'run')),
      failure_code TEXT,
      failure_message TEXT,
      CHECK (used_calls + reserved_calls <= max_calls)
    );
    CREATE TABLE evaluations (
      evaluation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      context_id TEXT NOT NULL,
      respondent_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      turn_id TEXT,
      node_id TEXT,
      path_id TEXT,
      occurrence INTEGER,
      packet_json TEXT NOT NULL,
      packet_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'failed', 'unreached')),
      result_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      failure_detail_json TEXT,
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, evaluation_id),
      FOREIGN KEY (run_id, group_id) REFERENCES question_groups(run_id, group_id) ON DELETE CASCADE,
      UNIQUE (run_id, turn_id),
      UNIQUE (run_id, respondent_id, node_id, occurrence),
      CHECK ((turn_id IS NULL AND node_id IS NULL AND path_id IS NULL AND occurrence IS NULL) OR
             (turn_id IS NOT NULL AND node_id IS NOT NULL AND path_id IS NOT NULL AND occurrence IS NOT NULL AND occurrence >= 1))
    );
    CREATE TABLE journey_respondents (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      respondent_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'unreached')),
      current_node_id TEXT,
      current_turn_id TEXT,
      current_context_id TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      events_json TEXT NOT NULL,
      route_json TEXT NOT NULL,
      outcome TEXT,
      PRIMARY KEY (run_id, respondent_id),
      CHECK ((status = 'active' AND current_node_id IS NOT NULL AND current_turn_id IS NOT NULL AND current_context_id IS NOT NULL) OR
             (status <> 'active' AND current_node_id IS NULL AND current_turn_id IS NULL AND current_context_id IS NULL))
    );
    CREATE TABLE attempts (
      attempt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      group_id TEXT NOT NULL,
      evaluation_id TEXT NOT NULL,
      packet_fingerprint TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'answered', 'failed', 'uncertain')),
      started_ms INTEGER NOT NULL,
      settled_ms INTEGER,
      result_json TEXT,
      execution_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      failure_scope TEXT CHECK (failure_scope IS NULL OR failure_scope IN ('evaluation', 'run')),
      FOREIGN KEY (run_id, evaluation_id) REFERENCES evaluations(run_id, evaluation_id) ON DELETE CASCADE,
      FOREIGN KEY (run_id, group_id) REFERENCES question_groups(run_id, group_id) ON DELETE CASCADE
    );
    CREATE TABLE question_groups (
      group_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      context_id TEXT NOT NULL,
      respondent_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      question_ids_json TEXT NOT NULL,
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, group_id)
    );
    CREATE TABLE attempt_evaluations (
      attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
      failure_json TEXT,
      PRIMARY KEY (attempt_id, evaluation_id)
    );
    CREATE TABLE evaluation_answer_attempts (
      evaluation_id TEXT PRIMARY KEY REFERENCES evaluations(evaluation_id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      FOREIGN KEY (attempt_id, evaluation_id) REFERENCES attempt_evaluations(attempt_id, evaluation_id) ON DELETE CASCADE
    );
    CREATE INDEX evaluations_run_ordinal ON evaluations(run_id, ordinal);
    CREATE INDEX runs_created_identity ON runs(created_ms, run_id);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, migration_id, applied_at) VALUES (${SCHEMA_VERSION}, 'baseline-v${SCHEMA_VERSION}', '${new Date().toISOString()}');
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the initialization error. */ }
    throw error;
  }
}

export type StoreCompatibility =
  | { status: 'current'; schemaVersion: 8 }
  | { status: 'migration_available'; schemaVersion: number; targetSchemaVersion: 8 }
  | { status: 'unsupported'; schemaVersion: number | null; targetSchemaVersion: 8 }
  | { status: 'uninitialized'; schemaVersion: 0; targetSchemaVersion: 8 }
  | { status: 'unreadable'; schemaVersion: null; targetSchemaVersion: 8 };

export function inspectRunStoreCompatibility(dataRoot: string): StoreCompatibility {
  if (!path.isAbsolute(dataRoot)) return { status: 'unreadable', schemaVersion: null, targetSchemaVersion: SCHEMA_VERSION };
  const databasePath = path.join(dataRoot, 'runs.sqlite');
  if (!existsSync(databasePath)) return { status: 'uninitialized', schemaVersion: 0, targetSchemaVersion: SCHEMA_VERSION };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
    const versionRow = database.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
    const version = asNumber(versionRow?.user_version, 'schema version');
    const existing = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as DatabaseRow | undefined;
    const tableCount = asNumber(existing?.count, 'table count');
    if (version === SCHEMA_VERSION) {
      checkDatabaseIntegrity(database);
      validateSchemaShape(database);
      return { status: 'current', schemaVersion: SCHEMA_VERSION };
    }
    if (version === 0 && tableCount === 0) return { status: 'uninitialized', schemaVersion: 0, targetSchemaVersion: SCHEMA_VERSION };
    if (version >= 7 && version < SCHEMA_VERSION && hasMigrationPath(version)) return { status: 'migration_available', schemaVersion: version, targetSchemaVersion: SCHEMA_VERSION };
    return { status: 'unsupported', schemaVersion: version, targetSchemaVersion: SCHEMA_VERSION };
  } catch {
    return { status: 'unreadable', schemaVersion: null, targetSchemaVersion: SCHEMA_VERSION };
  } finally { database?.close(); }
}

export function runStoreBackupAvailable(dataRoot: string): boolean {
  const backupRoot = path.join(dataRoot, 'backups');
  if (!existsSync(backupRoot)) return false;
  try { return readdirSync(backupRoot).some((name) => name.startsWith('runs-schema-') && name.endsWith('.sqlite')); }
  catch { return false; }
}

export function resetRunStore(dataRoot: string): { reset: true; backupRetained: true; preservation: 'verified-sqlite-backup'; schemaVersion: 8 } | { reset: true; backupRetained: false; preservation: 'quarantined-original-files'; schemaVersion: 8 } {
  if (!path.isAbsolute(dataRoot)) throw new RunStoreError('invalid_data_root', 'Sheg data directory must be an absolute path.');
  const databasePath = path.join(dataRoot, 'runs.sqlite');
  let inspectionDatabase: DatabaseSync | undefined;
  let version: number;
  try {
    inspectionDatabase = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
    const versionRow = inspectionDatabase.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
    version = asNumber(versionRow?.user_version, 'schema version');
    checkDatabaseIntegrity(inspectionDatabase, false);
  } catch {
    inspectionDatabase?.close();
    return resetUnreadableRunStore(dataRoot, databasePath);
  }
  inspectionDatabase.close();
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    verifiedBackup(database, dataRoot, version, version, 'before-reset', false);
  } catch (error) {
    database.close();
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('recovery_backup_failed', 'Sheg could not verify a recoverable datastore backup; the original files were left untouched.', { cause: error });
  }
  database.close();

  const recoveryRoot = path.join(dataRoot, 'recovery', randomUUID());
  mkdirSync(recoveryRoot, { recursive: true });
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const moved: Array<{ original: string; archived: string }> = [];
  try {
    for (const original of files) {
      if (!existsSync(original)) continue;
      const archived = path.join(recoveryRoot, path.basename(original));
      renameSync(original, archived);
      moved.push({ original, archived });
    }
    const freshStore = openRunStore(dataRoot);
    freshStore.close();
    return { reset: true, backupRetained: true, preservation: 'verified-sqlite-backup', schemaVersion: SCHEMA_VERSION };
  } catch (error) {
    for (const original of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      try { unlinkSync(original); } catch { /* Preserve the reset error. */ }
    }
    for (const item of moved.toReversed()) {
      try { renameSync(item.archived, item.original); } catch { /* The verified backup remains available. */ }
    }
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('recovery_reset_failed', 'Sheg could not complete the explicit datastore reset; the original database and verified backup were preserved.', { cause: error });
  }
}

function resetUnreadableRunStore(dataRoot: string, databasePath: string): { reset: true; backupRetained: false; preservation: 'quarantined-original-files'; schemaVersion: 8 } {
  if (!existsSync(databasePath)) throw new RunStoreError('recovery_backup_failed', 'Sheg could not find the original datastore files to preserve; no reset was performed.');
  const recoveryRoot = path.join(dataRoot, 'recovery', randomUUID());
  mkdirSync(recoveryRoot, { recursive: true });
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const moved: Array<{ original: string; archived: string; size: number }> = [];
  try {
    for (const original of files) {
      if (!existsSync(original)) continue;
      const size = statSync(original).size;
      const archived = path.join(recoveryRoot, path.basename(original));
      renameSync(original, archived);
      if (statSync(archived).size !== size) throw new Error('Quarantined datastore file size changed.');
      moved.push({ original, archived, size });
    }
    const freshStore = openRunStore(dataRoot);
    freshStore.close();
    return { reset: true, backupRetained: false, preservation: 'quarantined-original-files', schemaVersion: SCHEMA_VERSION };
  } catch (error) {
    for (const original of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      try { unlinkSync(original); } catch { /* Preserve the reset error. */ }
    }
    for (const item of moved.toReversed()) {
      try { renameSync(item.archived, item.original); } catch { /* The original remains in recovery when restoration fails. */ }
    }
    throw new RunStoreError('recovery_reset_failed', 'Sheg could not complete the explicit reset; the original database files were preserved.', { cause: error });
  }
}

function validatePrepared(prepared: PreparedRun): PreparedRun {
  const parsedRequest = runRequestSchema.safeParse(prepared.request);
  if (!parsedRequest.success || prepared.compilerFingerprint.length === 0 ||
      hashCanonical({ request: parsedRequest.data, compilerFingerprint: prepared.compilerFingerprint }) !== prepared.requestFingerprint) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared run request or fingerprint is invalid.');
  }
  if (parsedRequest.data.kind === 'follow-on') {
    const parsedLineage = followOnLineageSchema.safeParse(prepared.lineage);
    if (!parsedLineage.success) throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on material lineage is invalid.');
    const lineage = parsedLineage.data;
    const includesSelectedMaterial = parsedRequest.data.context.includeSelectedMaterial === true;
    if (includesSelectedMaterial) {
      const coverage = lineage.selectionCoverage;
      const excludedIds = new Set(lineage.excludedSelections.map(({ sourceEvaluationId }) => sourceEvaluationId));
      const eligibleIds = new Set(lineage.selections.map(({ sourceEvaluationId }) => sourceEvaluationId));
      if (!coverage || coverage.eligible !== eligibleIds.size || coverage.matched !== coverage.eligible + lineage.excludedSelections.length ||
          [...eligibleIds].some((id) => excludedIds.has(id)) || lineage.selections.some(({ selectedMaterial }) => !selectedMaterial)) {
        throw new RunStoreError('invalid_prepared_run', 'Selected-material coverage and source lineage are inconsistent.');
      }
    } else if (lineage.selectionCoverage !== undefined || lineage.selections.some(({ selectedMaterial }) => selectedMaterial !== undefined)) {
      throw new RunStoreError('invalid_prepared_run', 'Selected-material lineage cannot be attached to a request without the resolver flag.');
    }
    const requestedQuestionIds = parsedRequest.data.questions.map(({ id }) => id);
    if (!lineage || lineage.sourceRunId !== parsedRequest.data.sourceRunId ||
        lineage.sourceVersion.status !== lineage.sourceStatusAtAcceptance || lineage.sourceCompleteAtAcceptance !== (lineage.sourceStatusAtAcceptance === 'completed')) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on lineage does not match its request and frozen evaluations.');
    }
    const evaluationIds = new Set<string>(); const groupIds = new Set<string>();
    const questionIdsByGroup = new Map<string, string[]>();
    if (!prepared.groups || prepared.groups.length === 0 || new Set(prepared.groups.map(({ groupId }) => groupId)).size !== prepared.groups.length) throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on groups are missing or duplicated.');
    for (const group of prepared.groups) groupIds.add(group.groupId);
    const snapshotKeys = new Set<string>();
    const snapshotsByKey = new Map<string, FollowOnLineage['materialSnapshots'][number]>();
    for (const snapshot of lineage.materialSnapshots) {
      const key = `${snapshot.contextId}:${snapshot.respondentId}`;
      if (snapshotKeys.has(key) || !prepared.groups.some((group) => group.contextId === snapshot.contextId && group.respondentId === snapshot.respondentId)) {
        throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on material snapshots do not match an accepted respondent context.');
      }
      snapshotKeys.add(key);
      snapshotsByKey.set(key, snapshot);
    }
    for (const evaluation of prepared.evaluations) {
      const packet = decisionRequestSchema.safeParse(evaluation.packet);
      if (!packet.success || !prepared.groups?.some((group) => group.groupId === evaluation.groupId && group.contextId === evaluation.contextId && group.respondentId === evaluation.respondentId && group.questionIds.includes(evaluation.questionId) && hashCanonical(group.state) === hashCanonical(packet.data.state)) ||
          !parsedRequest.data.questions.some((question) => question.id === evaluation.questionId) || packet.data.question.id !== evaluation.questionId ||
          hashCanonical({ packet: packet.data, compilerFingerprint: prepared.compilerFingerprint }) !== evaluation.packetFingerprint ||
          evaluationIds.has(evaluation.evaluationId) || !groupIds.has(evaluation.groupId ?? '')) {
        throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on evaluation or source selection is inconsistent.');
      }
      if (packet.data.question.type === 'choice' && packet.data.question.materialOptions) {
        const catalog = materialCatalogForRequest(parsedRequest.data, lineage, evaluation.contextId, evaluation.respondentId, encounteredMaterialsFromState(packet.data.state));
        for (const [optionId, materialId] of Object.entries(packet.data.question.materialOptions)) {
          const item = catalog.find(({ id }) => id === materialId);
          if (!item || !item.sourceId || !item.sourceSha256 || packet.data.question.options[optionId] !== item.text) {
            throw new RunStoreError('invalid_prepared_run', `Prepared Choice link for material ${materialId} has no matching frozen source evidence.`);
          }
        }
      }
      if (includesSelectedMaterial) {
        const mappings = lineage.selections.filter(({ evaluationId }) => evaluationId === evaluation.evaluationId);
        const selected = mappings[0]?.selectedMaterial;
        const snapshot = snapshotsByKey.get(`${evaluation.contextId}:${evaluation.respondentId}`);
        const snapshotItem = selected && snapshot?.materials.find(({ id }) => id === selected.materialId);
        const exposed = selected && encounteredMaterialsFromState(packet.data.state).some(({ id, text }) => id === selected.materialId && text === selected.text);
        if (mappings.length !== 1 || !selected || !snapshotItem || !exposed ||
            selected.textSha256 !== createHash('sha256').update(selected.text, 'utf8').digest('hex') ||
            snapshotItem.text !== selected.text || snapshotItem.sourceId !== selected.sourceId || snapshotItem.sourceSha256 !== selected.sourceSha256) {
          throw new RunStoreError('invalid_prepared_run', 'Selected-material lineage does not match its frozen recipient packet and catalog.');
        }
      }
      evaluationIds.add(evaluation.evaluationId);
      const ids = questionIdsByGroup.get(evaluation.groupId!) ?? []; ids.push(evaluation.questionId); questionIdsByGroup.set(evaluation.groupId!, ids);
    }
    if (!prepared.groups || prepared.groups.length === 0 || lineage.selections.some((selection) => !evaluationIds.has(selection.evaluationId)) ||
      prepared.groups.some((group) => JSON.stringify(group.questionIds) !== JSON.stringify(requestedQuestionIds) ||
          JSON.stringify(questionIdsByGroup.get(group.groupId) ?? []) !== JSON.stringify(group.questionIds))) throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on group lineage is inconsistent.');
    if (includesSelectedMaterial) {
      const linkedIds = new Set(parsedRequest.data.questions.flatMap((question) => question.type === 'choice' ? Object.values(question.materialOptions ?? {}) : []));
      for (const group of prepared.groups) {
        const snapshot = snapshotsByKey.get(`${group.contextId}:${group.respondentId}`);
        const expectedIds = new Set([...encounteredMaterialsFromState(group.state).map(({ id }) => id), ...linkedIds]);
        if (!snapshot || JSON.stringify([...snapshot.materials.map(({ id }) => id)].sort()) !== JSON.stringify([...expectedIds].sort())) {
          throw new RunStoreError('invalid_prepared_run', 'Selected-material catalog contains unrelated material or omits a packet dependency.');
        }
      }
    }
    return { ...prepared, request: parsedRequest.data, lineage };
  }
  if (parsedRequest.data.kind !== 'poll') throw new RunStoreError('invalid_prepared_run', 'A journey must be accepted through journey preparation.');
  if (!prepared.groups || prepared.groups.length !== parsedRequest.data.respondents.length || prepared.evaluations.length !== parsedRequest.data.respondents.length * parsedRequest.data.questions.length) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared run question groups do not match respondents and questions.');
  }
  const respondentIds = new Set(parsedRequest.data.respondents.map(({ id }) => id));
  const requestedQuestionIds = parsedRequest.data.questions.map(({ id }) => id);
  const evaluationIds = new Set<string>();
  const seenRespondents = new Set<string>();
  const questionIdsByGroup = new Map<string, string[]>();
  for (const evaluation of prepared.evaluations) {
    const packet = decisionRequestSchema.safeParse(evaluation.packet);
    const group = prepared.groups.find(({ groupId }) => groupId === evaluation.groupId);
    if (!packet.success || !group || group.respondentId !== evaluation.respondentId || group.contextId !== evaluation.contextId || hashCanonical(group.state) !== hashCanonical(packet.data.state) || !respondentIds.has(evaluation.respondentId) || evaluationIds.has(evaluation.evaluationId) ||
        !parsedRequest.data.questions.some((question) => question.id === evaluation.questionId) || packet.data.question.id !== evaluation.questionId ||
        hashCanonical({ packet: packet.data, compilerFingerprint: prepared.compilerFingerprint }) !== evaluation.packetFingerprint) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared run evaluation or packet fingerprint is invalid.');
    }
    evaluationIds.add(evaluation.evaluationId);
    seenRespondents.add(evaluation.respondentId);
    const ids = questionIdsByGroup.get(group.groupId) ?? []; ids.push(evaluation.questionId); questionIdsByGroup.set(group.groupId, ids);
  }
  if (seenRespondents.size !== respondentIds.size || prepared.groups.some((group) => JSON.stringify(group.questionIds) !== JSON.stringify(requestedQuestionIds) ||
      JSON.stringify(questionIdsByGroup.get(group.groupId) ?? []) !== JSON.stringify(group.questionIds) || !respondentIds.has(group.respondentId))) throw new RunStoreError('invalid_prepared_run', 'Every respondent must have one complete ordered question group.');
  return { ...prepared, request: parsedRequest.data };
}

function validatePreparedJourney(prepared: PreparedJourneyRun): PreparedJourneyRun {
  const parsedRequest = runRequestSchema.safeParse(prepared.request);
  if (!parsedRequest.success || parsedRequest.data.kind !== 'journey' || prepared.compilerFingerprint.length === 0 ||
      hashCanonical({ request: parsedRequest.data, compilerFingerprint: prepared.compilerFingerprint }) !== prepared.requestFingerprint) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared journey request or fingerprint is invalid.');
  }
  const respondentIds = parsedRequest.data.respondents.map(({ id }) => id);
  const respondentIdSet = new Set(respondentIds);
  if (respondentIdSet.size !== respondentIds.length || prepared.respondents.length !== respondentIds.length || prepared.evaluations.length === 0) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared journey requires unique respondent state and at least one reached turn.');
  }
  const stateById = new Map<string, JourneyRespondentState>();
  const allowedStatuses = new Set(['active', 'completed', 'failed', 'unreached']);
  for (const state of prepared.respondents) {
    if (!allowedStatuses.has(state.status) || !respondentIdSet.has(state.respondentId) || stateById.has(state.respondentId) || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
        !Array.isArray(state.events) || !Array.isArray(state.route) ||
        (state.status === 'active' ? !(state.currentNodeId && state.currentTurnId && state.currentContextId) :
          state.currentNodeId !== null || state.currentTurnId !== null || state.currentContextId !== null)) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared journey respondent state is inconsistent.');
    }
    stateById.set(state.respondentId, state);
  }
  if (stateById.size !== respondentIdSet.size) throw new RunStoreError('invalid_prepared_run', 'Every journey respondent requires durable state.');

  const evaluationIds = new Set<string>();
  const turnIds = new Set<string>();
  const contextIds = new Set<string>();
  const nodeOccurrences = new Set<string>();
  const activeTurnIds = new Set<string>();
  for (const evaluation of prepared.evaluations) {
    const packet = decisionRequestSchema.safeParse(evaluation.packet);
    const state = stateById.get(evaluation.respondentId);
    const respondent = parsedRequest.data.respondents.find(({ id }) => id === evaluation.respondentId);
    const nodeOccurrence = `${evaluation.respondentId}\0${evaluation.nodeId}\0${evaluation.occurrence}`;
    if (!packet.success || !state || !respondent || state.status !== 'active' ||
        !Number.isSafeInteger(evaluation.ordinal) || evaluation.ordinal < 0 || !Number.isSafeInteger(evaluation.occurrence) || evaluation.occurrence < 1 ||
        !evaluation.turnId || !evaluation.nodeId || !evaluation.pathId || evaluation.questionId !== packet.data.question.id ||
        state.currentTurnId !== evaluation.turnId || state.currentContextId !== evaluation.contextId || state.currentNodeId !== evaluation.nodeId ||
        !isJourneyAskNode(parsedRequest.data.journey, evaluation.nodeId, evaluation.questionId) ||
        hashCanonical(compileDecisionPacketForCompiler(parsedRequest.data.journey, respondent, evaluation.questionId, state.events, prepared.compilerFingerprint)) !== hashCanonical(packet.data) ||
        evaluationIds.has(evaluation.evaluationId) || turnIds.has(evaluation.turnId) || contextIds.has(evaluation.contextId) || nodeOccurrences.has(nodeOccurrence) ||
        !respondentIdSet.has(evaluation.respondentId) ||
        hashCanonical({ packet: packet.data, compilerFingerprint: prepared.compilerFingerprint }) !== evaluation.packetFingerprint) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared journey turn or context reference is invalid.');
    }
    evaluationIds.add(evaluation.evaluationId);
    turnIds.add(evaluation.turnId);
    contextIds.add(evaluation.contextId);
    nodeOccurrences.add(nodeOccurrence);
    activeTurnIds.add(evaluation.turnId);
  }
  for (const state of prepared.respondents) {
    if (state.status === 'active' && !activeTurnIds.has(state.currentTurnId!)) {
      throw new RunStoreError('invalid_prepared_run', 'Every active journey respondent requires one pending turn.');
    }
    if (state.status !== 'active' && prepared.evaluations.some(({ respondentId }) => respondentId === state.respondentId)) {
      throw new RunStoreError('invalid_prepared_run', 'A terminal or unreached respondent cannot have a pending turn.');
    }
  }
  const ordered = prepared.evaluations.toSorted((left, right) => left.ordinal - right.ordinal);
  if (ordered.some((evaluation, index) => evaluation.ordinal !== index)) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared journey turn ordinals must be contiguous from zero.');
  }
  return { ...prepared, request: parsedRequest.data };
}

export function openRunStore(dataRoot: string, options: { now?: () => number } = {}): RunStore {
  if (!path.isAbsolute(dataRoot)) throw new RunStoreError('invalid_data_root', 'Sheg data directory must be an absolute path.');
  mkdirSync(dataRoot, { recursive: true });
  const database = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'), { timeout: 5_000, enableForeignKeyConstraints: true });
  try { initialize(database, dataRoot); }
  catch (error) { database.close(); throw error; }
  return new SQLiteRunStore(database, path.join(dataRoot, 'runs.sqlite'), options.now ?? Date.now);
}

class SQLiteRunStore implements RunStore {
  private isClosed = false;

  constructor(private readonly database: DatabaseSync, private readonly databasePath: string, private readonly now: () => number) {}

  findSubmission(submissionId: string, requestFingerprint: string): RunStatusView | null {
    this.ensureOpen();
    const row = this.database.prepare('SELECT run_id, request_fingerprint FROM runs WHERE submission_id = ?').get(submissionId) as DatabaseRow | undefined;
    if (!row) return null;
    if (asText(row.request_fingerprint, 'request fingerprint') !== requestFingerprint) {
      throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
    }
    return this.getStatus(asText(row.run_id, 'run ID'));
  }

  accept(submissionId: string, preparedInput: PreparedRun): { created: boolean; run: RunStatusView } {
    this.ensureOpen();
    if (!submissionId.trim()) throw new RunStoreError('invalid_submission_id', 'A submission ID is required.');
    const prepared = validatePrepared(preparedInput);
    return this.transaction(() => {
      const prior = this.database.prepare('SELECT run_id, request_fingerprint FROM runs WHERE submission_id = ?').get(submissionId) as DatabaseRow | undefined;
      if (prior) {
        const priorFingerprint = asText(prior.request_fingerprint, 'request fingerprint');
        if (priorFingerprint !== prepared.requestFingerprint) throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
        const runId = asText(prior.run_id, 'run ID');
        this.reconcileInside(runId, this.now());
        return { created: false, run: this.statusInside(runId) };
      }

      if (prepared.request.kind === 'follow-on') {
        const source = this.database.prepare('SELECT status, used_calls, reserved_calls FROM runs WHERE run_id = ?').get(prepared.lineage!.sourceRunId) as DatabaseRow | undefined;
        if (!source) throw this.notFound();
        const maxOrdinal = asNumber((this.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?').get(prepared.lineage!.sourceRunId) as DatabaseRow).maximum, 'maximum evaluation ordinal');
        const version = prepared.lineage!.sourceVersion;
        if (asText(source.status, 'source run status') !== version.status || asNumber(source.used_calls, 'source used calls') !== version.usedCalls ||
            asNumber(source.reserved_calls, 'source reserved calls') !== version.reservedCalls || maxOrdinal !== version.maxOrdinal) {
          throw new RunStoreError('source_changed_during_acceptance', 'The source run changed after follow-on inspection. Inspect the request again to use its current evidence.');
        }
        for (const selection of prepared.lineage!.selections) {
          const sourceEvaluation = this.database.prepare('SELECT 1 AS found FROM evaluations WHERE run_id = ? AND evaluation_id = ? AND context_id = ?').get(prepared.lineage!.sourceRunId, selection.sourceEvaluationId, selection.sourceContextId);
          if (!sourceEvaluation) throw new RunStoreError('source_changed_during_acceptance', 'A selected source evaluation changed after follow-on inspection. Inspect the request again.');
        }
      }

      const runId = randomUUID();
      const nowMs = this.now();
      const createdAt = new Date(nowMs).toISOString();
      this.database.prepare(`INSERT INTO runs
        (run_id, submission_id, request_fingerprint, created_at, created_ms, label, status, request_json, evaluation_count, max_calls)
        VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`)
        .run(runId, submissionId, prepared.requestFingerprint, createdAt, nowMs, prepared.request.label ?? null,
          JSON.stringify({ request: prepared.request, requestFingerprint: prepared.requestFingerprint, compilerFingerprint: prepared.compilerFingerprint, ...(prepared.lineage ? { lineage: prepared.lineage } : {}) }), prepared.evaluations.length, prepared.request.maxCalls);
      const insertEvaluation = this.database.prepare(`INSERT INTO evaluations
        (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, packet_json, packet_fingerprint, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
      const insertGroup = this.database.prepare(`INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const [ordinal, group] of (prepared.groups ?? []).entries()) insertGroup.run(group.groupId, runId, ordinal, group.contextId, group.respondentId, JSON.stringify(group.state), JSON.stringify(group.questionIds));
      for (const [ordinal, evaluation] of prepared.evaluations.entries()) {
        insertEvaluation.run(evaluation.evaluationId, runId, ordinal, evaluation.contextId, evaluation.respondentId,
          evaluation.questionId, evaluation.groupId ?? null, JSON.stringify(evaluation.packet), evaluation.packetFingerprint);
      }
      return { created: true, run: this.statusInside(runId) };
    });
  }

  acceptJourney(submissionId: string, preparedInput: PreparedJourneyRun): { created: boolean; run: RunStatusView } {
    this.ensureOpen();
    if (!submissionId.trim()) throw new RunStoreError('invalid_submission_id', 'A submission ID is required.');
    const prepared = validatePreparedJourney(preparedInput);
    return this.transaction(() => {
      const prior = this.database.prepare('SELECT run_id, request_fingerprint FROM runs WHERE submission_id = ?').get(submissionId) as DatabaseRow | undefined;
      if (prior) {
        const priorFingerprint = asText(prior.request_fingerprint, 'request fingerprint');
        if (priorFingerprint !== prepared.requestFingerprint) throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
        const runId = asText(prior.run_id, 'run ID');
        this.reconcileInside(runId, this.now());
        return { created: false, run: this.statusInside(runId) };
      }

      const runId = randomUUID();
      const nowMs = this.now();
      const createdAt = new Date(nowMs).toISOString();
      this.database.prepare(`INSERT INTO runs
        (run_id, submission_id, request_fingerprint, created_at, created_ms, label, status, request_json, evaluation_count, max_calls)
        VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`)
        .run(runId, submissionId, prepared.requestFingerprint, createdAt, nowMs, prepared.request.label ?? null,
          JSON.stringify({ request: prepared.request, requestFingerprint: prepared.requestFingerprint, compilerFingerprint: prepared.compilerFingerprint }), prepared.evaluations.length, prepared.request.maxCalls);
      const insertEvaluation = this.database.prepare(`INSERT INTO evaluations
        (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
      for (const evaluation of prepared.evaluations) {
        const groupId = evaluation.contextId;
        this.database.prepare(`INSERT OR IGNORE INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(groupId, runId, evaluation.ordinal, evaluation.contextId, evaluation.respondentId, JSON.stringify(evaluation.packet.state), JSON.stringify([evaluation.questionId]));
        insertEvaluation.run(evaluation.evaluationId, runId, evaluation.ordinal, evaluation.contextId, evaluation.respondentId,
          evaluation.questionId, groupId, evaluation.turnId, evaluation.nodeId, evaluation.pathId, evaluation.occurrence,
          JSON.stringify(evaluation.packet), evaluation.packetFingerprint);
      }
      const insertState = this.database.prepare(`INSERT INTO journey_respondents
        (run_id, respondent_id, status, current_node_id, current_turn_id, current_context_id, revision, events_json, route_json, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const state of prepared.respondents) {
        insertState.run(runId, state.respondentId, state.status, state.currentNodeId, state.currentTurnId,
          state.currentContextId, state.revision, JSON.stringify(state.events), JSON.stringify(state.route), state.outcome ?? null);
      }
      return { created: true, run: this.statusInside(runId) };
    });
  }

  getStatus(runId: string): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      this.reconcileInside(runId, this.now());
      return this.statusInside(runId);
    });
  }

  evaluationStatuses(runId: string): Array<{ evaluationId: string; status: AnswerRow['status'] }> {
    this.ensureOpen();
    this.getStatus(runId);
    const rows = this.database.prepare('SELECT evaluation_id, status FROM evaluations WHERE run_id = ? ORDER BY ordinal').all(runId) as DatabaseRow[];
    return rows.map((row) => ({
      evaluationId: asText(row.evaluation_id, 'evaluation ID'),
      status: asText(row.status, 'evaluation status') as AnswerRow['status'],
    }));
  }

  getRequestKind(runId: string): 'poll' | 'journey' | 'follow-on' {
    this.getStatus(runId);
    const row = this.database.prepare('SELECT request_json FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
    if (!row) throw this.notFound();
    const stored = parseJson<unknown>(row.request_json, 'request');
    if (typeof stored !== 'object' || stored === null || !('request' in stored)) {
      throw new RunStoreError('data_integrity_error', 'Stored run request has an invalid shape.');
    }
    const request = runRequestSchema.safeParse(stored.request);
    if (!request.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
    return request.data.kind;
  }

  getRequest(runId: string): PreparedRun {
    this.getStatus(runId);
    const row = this.database.prepare('SELECT request_json, request_fingerprint FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
    if (!row) throw this.notFound();
    const stored = parseJson<unknown>(row.request_json, 'request');
    if (typeof stored !== 'object' || stored === null || !('request' in stored) || !('requestFingerprint' in stored) || !('compilerFingerprint' in stored)) {
      throw new RunStoreError('data_integrity_error', 'Stored run request has an invalid shape.');
    }
    const evaluations = this.database.prepare('SELECT * FROM evaluations WHERE run_id = ? ORDER BY ordinal').all(runId) as DatabaseRow[];
    const groups = this.database.prepare('SELECT * FROM question_groups WHERE run_id = ? ORDER BY ordinal').all(runId) as DatabaseRow[];
    const prepared = stored as Omit<PreparedRun, 'evaluations'>;
    const parsed = validatePrepared({ ...prepared, groups: groups.map((row) => ({
      groupId: asText(row.group_id, 'group ID'), contextId: asText(row.context_id, 'context ID'), respondentId: asText(row.respondent_id, 'respondent ID'),
      state: parseJson(row.state_json, 'group state'), questionIds: parseJson(row.question_ids_json, 'group question IDs'),
    })), evaluations: evaluations.map((row) => ({
      groupId: asText(row.group_id, 'group ID'),
      evaluationId: asText(row.evaluation_id, 'evaluation ID'),
      contextId: asText(row.context_id, 'context ID'),
      respondentId: asText(row.respondent_id, 'respondent ID'),
      questionId: asText(row.question_id, 'question ID'),
      packet: parseJson(row.packet_json, 'frozen packet'),
      packetFingerprint: asText(row.packet_fingerprint, 'packet fingerprint'),
    })) });
    if (parsed.requestFingerprint !== asText(row.request_fingerprint, 'request fingerprint')) {
      throw new RunStoreError('data_integrity_error', 'Stored run and request fingerprints do not match.');
    }
    if (parsed.request.kind === 'follow-on' && parsed.lineage) {
      const sourceAvailable = Boolean(this.database.prepare('SELECT 1 AS found FROM runs WHERE run_id = ?').get(parsed.lineage.sourceRunId));
      return { ...parsed, lineage: { ...parsed.lineage, sourceAvailable, sourceRecordState: sourceAvailable ? 'live' : 'historical' } };
    }
    return parsed;
  }

  getJourneyRun(runId: string): JourneyRunRecord {
    this.getStatus(runId);
    const row = this.database.prepare('SELECT request_json, request_fingerprint FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
    if (!row) throw this.notFound();
    const stored = parseJson<unknown>(row.request_json, 'request');
    if (typeof stored !== 'object' || stored === null || !('request' in stored) || !('requestFingerprint' in stored) || !('compilerFingerprint' in stored)) {
      throw new RunStoreError('data_integrity_error', 'Stored journey request has an invalid shape.');
    }
    const parsedRequest = runRequestSchema.safeParse(stored.request);
    if (!parsedRequest.success || parsedRequest.data.kind !== 'journey' || typeof stored.compilerFingerprint !== 'string' ||
        typeof stored.requestFingerprint !== 'string' || stored.requestFingerprint !== asText(row.request_fingerprint, 'request fingerprint') ||
        hashCanonical({ request: parsedRequest.data, compilerFingerprint: stored.compilerFingerprint }) !== stored.requestFingerprint) {
      throw new RunStoreError('data_integrity_error', 'Stored journey request or fingerprint is invalid.');
    }
    const evaluationRows = this.database.prepare('SELECT * FROM evaluations WHERE run_id = ? ORDER BY ordinal').all(runId) as DatabaseRow[];
    const evaluations: JourneyEvaluationRecord[] = evaluationRows.map((evaluation) => {
      const packet = decisionRequestSchema.parse(parseJson(evaluation.packet_json, 'frozen packet')) as JourneyEvaluationRecord['packet'];
      const base: JourneyEvaluationRecord = {
        evaluationId: asText(evaluation.evaluation_id, 'evaluation ID'),
        contextId: asText(evaluation.context_id, 'context ID'),
        respondentId: asText(evaluation.respondent_id, 'respondent ID'),
        questionId: asText(evaluation.question_id, 'question ID'),
        packet,
        packetFingerprint: asText(evaluation.packet_fingerprint, 'packet fingerprint'),
        turnId: asText(evaluation.turn_id, 'turn ID'),
        nodeId: asText(evaluation.node_id, 'node ID'),
        pathId: asText(evaluation.path_id, 'path ID'),
        occurrence: asNumber(evaluation.occurrence, 'turn occurrence'),
        ordinal: asNumber(evaluation.ordinal, 'evaluation ordinal'),
        status: asText(evaluation.status, 'evaluation status') as JourneyEvaluationRecord['status'],
      };
      if (!['pending', 'answered', 'failed', 'unreached'].includes(base.status) ||
          (base.status === 'answered' && evaluation.result_json === null) || (base.status === 'failed' && evaluation.failure_code === null)) {
        throw new RunStoreError('data_integrity_error', 'Stored journey evaluation status does not match its answer evidence.');
      }
      if (base.questionId !== packet.question.id || hashCanonical({ packet, compilerFingerprint: stored.compilerFingerprint }) !== base.packetFingerprint) {
        throw new RunStoreError('data_integrity_error', 'Stored journey packet does not match its context identity.');
      }
      if (evaluation.result_json !== null) base.result = validateDecision(packet, parseJson(evaluation.result_json, 'decision result'), { maxAttempts: 1 });
      const evaluationFailure = storedEvaluationFailure(evaluation);
      if (evaluationFailure) base.failure = evaluationFailure;
      return base;
    });
    const stateRows = this.database.prepare('SELECT * FROM journey_respondents WHERE run_id = ? ORDER BY respondent_id').all(runId) as DatabaseRow[];
    const respondents: JourneyRespondentState[] = stateRows.map((state) => {
      const status = asText(state.status, 'journey respondent status');
      const events = parseJson<unknown>(state.events_json, 'journey history');
      const route = parseJson<unknown>(state.route_json, 'journey route');
      if (!['active', 'completed', 'failed', 'unreached'].includes(status) || !Array.isArray(events) || !Array.isArray(route)) {
        throw new RunStoreError('data_integrity_error', 'Stored journey respondent state has an invalid shape.');
      }
      return {
        respondentId: asText(state.respondent_id, 'respondent ID'),
        status: status as JourneyRespondentState['status'],
        currentNodeId: asNullableText(state.current_node_id, 'current node ID'),
        currentTurnId: asNullableText(state.current_turn_id, 'current turn ID'),
        currentContextId: asNullableText(state.current_context_id, 'current context ID'),
        revision: asNumber(state.revision, 'journey state revision'),
        events: events as JourneyRespondentState['events'],
        route: route as JourneyRespondentState['route'],
        ...(state.outcome === null ? {} : { outcome: asText(state.outcome, 'journey outcome') }),
      };
    });
    const respondentIds = new Set(parsedRequest.data.respondents.map(({ id }) => id));
    if (respondents.length !== respondentIds.size || new Set(respondents.map(({ respondentId }) => respondentId)).size !== respondentIds.size ||
        respondents.some((state) => !respondentIds.has(state.respondentId)) ||
        respondents.some((state) => state.status === 'active' && evaluations.filter((evaluation) => ['pending', 'failed'].includes(evaluation.status) && evaluation.turnId === state.currentTurnId && evaluation.contextId === state.currentContextId && evaluation.nodeId === state.currentNodeId && evaluation.respondentId === state.respondentId).length !== 1) ||
        respondents.some((state) => state.status !== 'active' && (state.currentTurnId !== null || state.currentContextId !== null || state.currentNodeId !== null))) {
      throw new RunStoreError('data_integrity_error', 'Stored journey respondent states do not match the reached turns.');
    }
    return { request: parsedRequest.data, requestFingerprint: stored.requestFingerprint, compilerFingerprint: stored.compilerFingerprint, evaluations, respondents };
  }

  list(query: RunListQuery): Page<RunStatusView> {
    this.ensureOpen();
    const limit = pageSize(query.limit);
    const nowMs = this.now();
    this.transaction(() => {
      const active = this.database.prepare("SELECT run_id FROM runs WHERE status IN ('prepared', 'running')").all() as DatabaseRow[];
      for (const row of active) this.reconcileInside(asText(row.run_id, 'run ID'), nowMs);
    });
    const filtersFingerprint = hashCanonical({ status: query.status ?? null, label: query.label ?? null, createdAfter: query.createdAfter ?? null, createdBefore: query.createdBefore ?? null, materialId: query.materialId ?? null });
    let cursor: CursorPayload | undefined;
    if (query.cursor) {
      cursor = decodeCursor<CursorPayload>(query.cursor, 'run list');
      if (cursor.kind !== 'runs' || !Number.isSafeInteger(cursor.createdMs) || cursor.createdMs < 0 || typeof cursor.runId !== 'string' || cursor.runId.length === 0 ||
          cursor.filtersFingerprint !== filtersFingerprint) {
        throw new RunStoreError('invalid_cursor', 'The run list cursor does not match the requested filters.');
      }
    }
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.status !== undefined) { clauses.push('status = ?'); params.push(query.status); }
    if (query.label !== undefined) { clauses.push('label = ?'); params.push(query.label); }
    if (query.createdAfter !== undefined) { clauses.push('created_ms >= ?'); params.push(Date.parse(query.createdAfter)); }
    if (query.createdBefore !== undefined) { clauses.push('created_ms <= ?'); params.push(Date.parse(query.createdBefore)); }
    if (query.materialId !== undefined) {
      clauses.push(`(EXISTS (SELECT 1 FROM json_each(CASE WHEN json_extract(runs.request_json, '$.request.kind') = 'poll'
        THEN json_extract(runs.request_json, '$.request.material') WHEN json_extract(runs.request_json, '$.request.kind') = 'journey'
        THEN json_extract(runs.request_json, '$.request.journey.items') ELSE json_extract(runs.request_json, '$.request.material') END) AS source_material
        WHERE json_extract(source_material.value, '$.id') = ?) OR EXISTS (SELECT 1 FROM evaluations AS material_evaluation, json_each(material_evaluation.packet_json, '$.state.encounteredItems') AS encountered
        WHERE material_evaluation.run_id = runs.run_id AND json_extract(encountered.value, '$.id') = ?) OR EXISTS (
        SELECT 1 FROM json_each(runs.request_json, '$.lineage.materialSnapshots') AS retained_snapshot,
          json_each(retained_snapshot.value, '$.materials') AS retained_material
        WHERE json_extract(retained_material.value, '$.id') = ?))`);
      params.push(query.materialId, query.materialId, query.materialId);
    }
    if (cursor) {
      clauses.push('(created_ms > ? OR (created_ms = ? AND run_id > ?))');
      params.push(cursor.createdMs, cursor.createdMs, cursor.runId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`SELECT run_id, created_ms FROM runs ${where} ORDER BY created_ms, run_id LIMIT ?`).all(...params, limit + 1) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row) => this.getStatus(asText(row.run_id, 'run ID')));
    const last = pageRows.at(-1);
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'runs', createdMs: asNumber(last.created_ms, 'created time'), runId: asText(last.run_id, 'run ID'), filtersFingerprint } satisfies CursorPayload) } : {}),
    };
  }

  resolveFollowOnSources(input: ParsedFollowOnRunRequest): FollowOnSourceSet {
    this.ensureOpen();
    const request = followOnRunRequestSchema.parse(input);
    return this.transaction(() => {
      this.reconcileInside(request.sourceRunId, this.now());
      const run = this.database.prepare('SELECT status, used_calls, reserved_calls, request_json FROM runs WHERE run_id = ?').get(request.sourceRunId) as DatabaseRow | undefined;
      if (!run) throw this.notFound();
      const stored = parseJson<{ request?: unknown; lineage?: unknown }>(run.request_json, 'source run request');
      const sourceRequest = runRequestSchema.safeParse(stored.request);
      if (!sourceRequest.success) throw new RunStoreError('data_integrity_error', 'Stored source run request is invalid.');
      let sourceLineage: FollowOnLineage | undefined;
      if (sourceRequest.data.kind === 'follow-on') {
        const parsedLineage = followOnLineageSchema.safeParse(stored.lineage);
        if (!parsedLineage.success) throw new RunStoreError('data_integrity_error', 'Stored source follow-on material lineage is invalid.');
        sourceLineage = parsedLineage.data;
      }
      const sourceStatus = asText(run.status, 'run status') as RunStatus;
      const usedCalls = asNumber(run.used_calls, 'used calls');
      const reservedCalls = asNumber(run.reserved_calls, 'reserved calls');
      const maxOrdinal = asNumber((this.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?').get(request.sourceRunId) as DatabaseRow).maximum, 'maximum evaluation ordinal');
      const where = ['e.run_id = ?', 'e.ordinal <= ?'];
      const parameters: Array<string | number> = [request.sourceRunId, maxOrdinal];
      if ('references' in request.selection) {
        where.push(`EXISTS (
          SELECT 1 FROM json_each(?) AS selected
          WHERE json_extract(selected.value, '$.evaluationId') = e.evaluation_id
            AND json_extract(selected.value, '$.contextId') = e.context_id
        )`);
        parameters.push(JSON.stringify(request.selection.references));
      } else {
        const criteria = request.selection.criteria;
        if (criteria.respondentId !== undefined) { where.push('e.respondent_id = ?'); parameters.push(criteria.respondentId); }
        if (criteria.status !== undefined) { where.push('e.status = ?'); parameters.push(criteria.status); }
        if (criteria.questionId !== undefined) { where.push('e.question_id = ?'); parameters.push(criteria.questionId); }
        if (criteria.materialId !== undefined) {
          where.push("EXISTS (SELECT 1 FROM json_each(e.packet_json, '$.state.encounteredItems') AS encountered WHERE json_extract(encountered.value, '$.id') = ?)");
          parameters.push(criteria.materialId);
        }
        if (criteria.answer?.type === 'choice') {
          where.push("json_extract(e.result_json, '$.type') = 'choice' AND json_extract(e.result_json, '$.choice') = ?"); parameters.push(criteria.answer.choiceId);
        } else if (criteria.answer?.type === 'score' || criteria.answer?.type === 'noul') {
          const field = criteria.answer.type === 'score' ? 'score' : 'noul';
          const operator = criteria.answer.operator === 'eq' ? '=' : criteria.answer.operator === 'lt' ? '<' : criteria.answer.operator === 'lte' ? '<=' : criteria.answer.operator === 'gt' ? '>' : '>=';
          where.push(`json_extract(e.result_json, '$.type') = '${field}' AND json_extract(e.result_json, '$.${field}') ${operator} ?`); parameters.push(criteria.answer.value);
        }
        if (criteria.outcome !== undefined) { where.push('jr.outcome = ?'); parameters.push(criteria.outcome); }
      }
      const rows = this.database.prepare(`SELECT e.*,
        (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id)
          WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
        FROM evaluations AS e
        LEFT JOIN journey_respondents AS jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
        WHERE ${where.join(' AND ')} ORDER BY e.ordinal LIMIT 10001`).all(...parameters) as DatabaseRow[];
      if (rows.length > 10_000) throw new RunStoreError('follow_on_selection_too_large', 'Follow-on selection matched more than 10,000 evaluations. Narrow the criteria or use explicit references.');
      if ('references' in request.selection && rows.length !== request.selection.references.length) {
        throw new RunStoreError('follow_on_reference_not_found', 'One or more evaluation/context references were not found in the source run.');
      }
      const turns: FollowOnSourceSet['turns'] = rows.map((row) => {
        const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'source packet')) as FollowOnSourceSet['turns'][number]['packet'];
        const result = row.result_json === null ? undefined : resultFromStorage(parseJson(row.result_json, 'source answer'), row.execution_json === null ? undefined : parseJson(row.execution_json, 'source execution'));
        const contextId = asText(row.context_id, 'context ID');
        const respondentId = asText(row.respondent_id, 'respondent ID');
        return {
          evaluationId: asText(row.evaluation_id, 'evaluation ID'), contextId,
          respondentId, status: asText(row.status, 'evaluation status') as FollowOnSourceSet['turns'][number]['status'], packet, ...(result ? { result } : {}),
          materials: materialCatalogForRequest(sourceRequest.data, sourceLineage, contextId, respondentId, packet.state.encounteredItems),
          ...(result?.type === 'choice' && packet.question.type === 'choice' && packet.question.materialOptions?.[result.choice]
            ? (() => {
              const materialId = packet.question.type === 'choice' ? packet.question.materialOptions?.[result.choice] : undefined;
              const candidate = materialCatalogForRequest(sourceRequest.data, sourceLineage, contextId, respondentId, packet.state.encounteredItems).find(({ id }) => id === materialId);
              if (!candidate?.sourceId || !candidate.sourceSha256) throw new RunStoreError('data_integrity_error', `Mapped Choice answer has no retained material evidence for ${materialId}.`);
              return { selectedMaterial: { materialId: candidate.id, text: candidate.text, sourceId: candidate.sourceId, sourceSha256: candidate.sourceSha256, textSha256: createHash('sha256').update(candidate.text, 'utf8').digest('hex') } };
            })() : {}),
        };
      });
      return {
        sourceRunId: request.sourceRunId, sourceStatus, sourceComplete: sourceStatus === 'completed',
        version: { status: sourceStatus, usedCalls, reservedCalls, maxOrdinal }, turns,
      };
    });
  }

  queryEvidence(input: RunEvidenceQuery): RunEvidencePage {
    this.ensureOpen();
    const parsed = runEvidenceQuerySchema.safeParse(input);
    if (!parsed.success) throw new RunStoreError('invalid_query', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    const query = parsed.data;
    const limit = pageSize(query.limit);
    const criteriaFingerprint = hashCanonical(query.criteria);
    return this.transaction(() => {
      const nowMs = this.now();
      this.reconcileInside(query.sourceRunId, nowMs);
      const run = this.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(query.sourceRunId) as DatabaseRow | undefined;
      if (!run) throw this.notFound();
      const sourceStatus = asText(run.status, 'run status') as RunStatus;
      const usedCalls = asNumber(run.used_calls, 'used calls');
      const reservedCalls = asNumber(run.reserved_calls, 'reserved calls');
      const runRecord = parseJson<{ request?: unknown; compilerFingerprint?: unknown; lineage?: unknown }>(run.request_json, 'run request');
      const parsedRequest = runRequestSchema.safeParse(runRecord.request);
      if (!parsedRequest.success || typeof runRecord.compilerFingerprint !== 'string') {
        throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
      }
      const compilerFingerprint = runRecord.compilerFingerprint;
      let lineage: FollowOnLineage | undefined;
      if (parsedRequest.data.kind === 'follow-on') {
        const parsedLineage = followOnLineageSchema.safeParse(runRecord.lineage);
        if (!parsedLineage.success) throw new RunStoreError('data_integrity_error', 'Stored follow-on material lineage is invalid.');
        lineage = parsedLineage.data;
      }

      let cursor: EvidenceCursorPayload | undefined;
      if (query.cursor) {
        cursor = decodeCursor<EvidenceCursorPayload>(query.cursor, 'evidence');
        const coverage = cursor.coverage as unknown as Record<string, unknown> | undefined;
        const respondents = coverage?.respondents as Record<string, unknown> | undefined;
        const matched = cursor.matchedCoverage as unknown as Record<string, unknown> | undefined;
        const matchedEvaluations = matched?.evaluations as Record<string, unknown> | undefined;
        const selectedMaterials = matched?.selectedMaterials as Record<string, unknown> | undefined;
        const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
        if (cursor.kind !== 'evidence' || cursor.sourceRunId !== query.sourceRunId || cursor.criteriaFingerprint !== criteriaFingerprint ||
            !Number.isSafeInteger(cursor.maxOrdinal) || cursor.maxOrdinal < -1 || !Number.isSafeInteger(cursor.lastOrdinal) ||
            cursor.lastOrdinal < -1 || cursor.lastOrdinal > cursor.maxOrdinal || !Number.isSafeInteger(cursor.totalMatches) || cursor.totalMatches < 0 ||
            !Number.isSafeInteger(cursor.usedCalls) || !Number.isSafeInteger(cursor.reservedCalls) ||
            !['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(cursor.sourceStatus) ||
            typeof cursor.sourceComplete !== 'boolean' || !runLifecycleSchema.safeParse(cursor.lifecycle).success ||
            !validCount(coverage?.totalEvaluations) || !validCount(coverage?.completedEvaluations) ||
            !validCount(coverage?.failedEvaluations) || !validCount(respondents?.total) || !validCount(respondents?.active) ||
            !validCount(respondents?.completed) || !validCount(respondents?.failed) || !validCount(respondents?.unreached) ||
            !validCount(matched?.representedRespondents) || !validCount(matchedEvaluations?.total) || !validCount(matchedEvaluations?.pending) ||
            !validCount(matchedEvaluations?.answered) || !validCount(matchedEvaluations?.failed) || !validCount(matchedEvaluations?.unreached) ||
            !validCount(selectedMaterials?.evaluations) || !validCount(selectedMaterials?.respondents) || !validCount(selectedMaterials?.distinctMaterials)) {
          throw new RunStoreError('invalid_cursor', 'The evidence cursor does not match this source run and criteria.');
        }
      }

      const maximumOrdinal = asNumber((this.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?').get(query.sourceRunId) as DatabaseRow).maximum, 'maximum evaluation ordinal');
      if (cursor && (cursor.maxOrdinal !== maximumOrdinal || cursor.sourceStatus !== sourceStatus || cursor.usedCalls !== usedCalls || cursor.reservedCalls !== reservedCalls)) {
        throw new RunStoreError('stale_cursor', 'The source run changed while paging this query. Start a fresh query to see its current evidence.');
      }
      const currentLifecycle = this.statusInside(query.sourceRunId).lifecycle;
      if (cursor && hashCanonical(cursor.lifecycle) !== hashCanonical(currentLifecycle)) {
        throw new RunStoreError('stale_cursor', 'The source run recovery state changed while paging this query. Start a fresh query to see its current evidence.');
      }
      const maxOrdinal = cursor?.maxOrdinal ?? maximumOrdinal;
      const where: string[] = ['e.run_id = ?', 'e.ordinal <= ?'];
      const parameters: Array<string | number> = [query.sourceRunId, maxOrdinal];
      const criteria = query.criteria;
      if (criteria.respondentId !== undefined) { where.push('e.respondent_id = ?'); parameters.push(criteria.respondentId); }
      if (criteria.status !== undefined) { where.push('e.status = ?'); parameters.push(criteria.status); }
      if (criteria.questionId !== undefined) { where.push('e.question_id = ?'); parameters.push(criteria.questionId); }
      if (criteria.materialId !== undefined) {
        where.push("EXISTS (SELECT 1 FROM json_each(e.packet_json, '$.state.encounteredItems') AS encountered WHERE json_extract(encountered.value, '$.id') = ?)");
        parameters.push(criteria.materialId);
      }
      if (criteria.answer?.type === 'choice') {
        where.push("json_extract(e.result_json, '$.type') = 'choice' AND json_extract(e.result_json, '$.choice') = ?");
        parameters.push(criteria.answer.choiceId);
      } else if (criteria.answer?.type === 'score' || criteria.answer?.type === 'noul') {
        const field = criteria.answer.type === 'score' ? 'score' : 'noul';
        const valueExpression = criteria.answer.type === 'score' ? "json_extract(e.result_json, '$.score')" : "json_extract(e.result_json, '$.noul')";
        where.push(`json_extract(e.result_json, '$.type') = '${field}' AND ${valueExpression} ${criteria.answer.operator === 'eq' ? '=' : criteria.answer.operator === 'lt' ? '<' : criteria.answer.operator === 'lte' ? '<=' : criteria.answer.operator === 'gt' ? '>' : '>='} ?`);
        parameters.push(criteria.answer.value);
      }
      if (criteria.outcome !== undefined) { where.push('jr.outcome = ?'); parameters.push(criteria.outcome); }
      const whereSql = where.join(' AND ');
      const join = 'LEFT JOIN journey_respondents AS jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id';
      const snapshotCount = cursor?.totalMatches ?? asNumber((this.database.prepare(`SELECT COUNT(*) AS count FROM evaluations AS e ${join} WHERE ${whereSql}`).get(...parameters) as DatabaseRow).count, 'query match count');
      const evaluationCoverage = cursor?.coverage ?? {
        totalEvaluations: asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ?').get(query.sourceRunId, maxOrdinal) as DatabaseRow).count, 'evaluation denominator'),
        completedEvaluations: asNumber((this.database.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ? AND status = 'answered'").get(query.sourceRunId, maxOrdinal) as DatabaseRow).count, 'completed evaluation denominator'),
        failedEvaluations: asNumber((this.database.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ? AND status = 'failed'").get(query.sourceRunId, maxOrdinal) as DatabaseRow).count, 'failed evaluation denominator'),
      };
      let respondentCoverage = cursor?.coverage.respondents;
      if (!respondentCoverage) {
        const total = parsedRequest.data.kind === 'journey' ? parsedRequest.data.respondents.length
          : parsedRequest.data.kind === 'poll' ? parsedRequest.data.respondents.length
            : asNumber((this.database.prepare('SELECT COUNT(DISTINCT respondent_id) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ?').get(query.sourceRunId, maxOrdinal) as DatabaseRow).count, 'respondent denominator');
        const statusCounts = parsedRequest.data.kind === 'journey'
          ? this.database.prepare('SELECT status, COUNT(*) AS count FROM journey_respondents WHERE run_id = ? GROUP BY status').all(query.sourceRunId) as DatabaseRow[]
          : parsedRequest.data.kind === 'follow-on' || parsedRequest.data.kind === 'poll'
            ? this.database.prepare(`SELECT status, COUNT(*) AS count FROM (
                SELECT respondent_id, CASE
                  WHEN SUM(status = 'pending') > 0 THEN 'active'
                  WHEN SUM(status = 'failed') > 0 THEN 'failed'
                  WHEN SUM(status = 'unreached') > 0 THEN 'unreached'
                  ELSE 'answered' END AS status
                FROM evaluations WHERE run_id = ? AND ordinal <= ? GROUP BY respondent_id
              ) GROUP BY status`).all(query.sourceRunId, maxOrdinal) as DatabaseRow[]
            : this.database.prepare("SELECT status, COUNT(DISTINCT respondent_id) AS count FROM evaluations WHERE run_id = ? AND ordinal <= ? GROUP BY status").all(query.sourceRunId, maxOrdinal) as DatabaseRow[];
        const countByStatus = new Map(statusCounts.map((row) => [asText(row.status, 'respondent status'), asNumber(row.count, 'respondent count')]));
        const completed = countByStatus.get(parsedRequest.data.kind === 'journey' ? 'completed' : 'answered') ?? 0;
        const failed = countByStatus.get('failed') ?? 0;
        const unreached = countByStatus.get('unreached') ?? 0;
        respondentCoverage = { total, completed, failed, unreached, active: Math.max(0, total - completed - failed - unreached) };
      }
      const coverage = { ...evaluationCoverage, respondents: respondentCoverage };
      const lifecycle = cursor?.lifecycle ?? currentLifecycle;
      const matchedCoverage = cursor?.matchedCoverage ?? (() => {
        const matchedRows = this.database.prepare(`SELECT e.status, e.respondent_id, e.packet_json, e.result_json
          FROM evaluations AS e ${join} WHERE ${whereSql} ORDER BY e.ordinal`).all(...parameters) as DatabaseRow[];
        const counts = { total: 0, pending: 0, answered: 0, failed: 0, unreached: 0 };
        const respondents = new Set<string>();
        const selectedMaterialIds = new Set<string>();
        const selectedMaterialRespondents = new Set<string>();
        let selectedMaterialEvaluations = 0;
        for (const row of matchedRows) {
          const status = asText(row.status, 'matched evaluation status') as keyof typeof counts;
          counts.total += 1;
          counts[status] += 1;
          const respondentId = asText(row.respondent_id, 'matched respondent ID');
          respondents.add(respondentId);
          if (status !== 'answered' || row.result_json === null) continue;
          const result = decisionValueSchema.safeParse(parseJson(row.result_json, 'matched result'));
          if (!result.success || result.data.type !== 'choice') continue;
          const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'matched packet'));
          if (packet.question.type !== 'choice') continue;
          const materialId = packet.question.materialOptions?.[result.data.choice];
          if (materialId) {
            selectedMaterialEvaluations += 1;
            selectedMaterialIds.add(materialId);
            selectedMaterialRespondents.add(respondentId);
          }
        }
        return { evaluations: counts, representedRespondents: respondents.size,
          selectedMaterials: { evaluations: selectedMaterialEvaluations, respondents: selectedMaterialRespondents.size, distinctMaterials: selectedMaterialIds.size } };
      })();
      const rows = this.database.prepare(`SELECT e.*, jr.outcome AS route_outcome,
        (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id)
          WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
        FROM evaluations AS e ${join}
        WHERE ${whereSql} ${cursor ? 'AND e.ordinal > ?' : ''} ORDER BY e.ordinal LIMIT ?`)
        .all(...parameters, ...(cursor ? [cursor.lastOrdinal, limit + 1] : [limit + 1])) as DatabaseRow[];
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const endpoint = parsedRequest.data.provider.kind === 'jev'
        ? parsedRequest.data.provider.endpoint
        : parsedRequest.data.provider.baseUrl;
      const model = parsedRequest.data.provider.kind === 'jev'
        ? parsedRequest.data.provider.model
        : parsedRequest.data.provider.checkpoint;
      const items: RunEvidencePage['items'] = pageRows.map((row) => {
        const contextId = asText(row.context_id, 'context ID');
        const respondentId = asText(row.respondent_id, 'respondent ID');
        const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'evidence packet'));
        const result = row.result_json === null ? undefined : resultFromStorage(parseJson(row.result_json, 'decision result'), row.execution_json === null ? undefined : parseJson(row.execution_json, 'provider execution'));
        const failure = storedEvaluationFailure(row);
        let selectedMaterial: RunEvidencePage['items'][number]['selectedMaterial'];
        if (result?.type === 'choice') {
          const materialId = packet.question.type === 'choice' ? packet.question.materialOptions?.[result.choice] : undefined;
          if (materialId) {
            const candidate = materialCatalogForRequest(parsedRequest.data, lineage, contextId, respondentId, encounteredMaterialsFromState(packet.state)).find(({ id }) => id === materialId);
            if (!candidate || !candidate.sourceId || !candidate.sourceSha256) throw new RunStoreError('data_integrity_error', `Mapped Choice answer has no retained material evidence for ${materialId}.`);
            selectedMaterial = { materialId, text: candidate.text, sourceId: candidate.sourceId, sourceSha256: candidate.sourceSha256,
              textSha256: createHash('sha256').update(candidate.text, 'utf8').digest('hex') };
          }
        }
        return {
          sourceRunId: query.sourceRunId,
          evaluationId: asText(row.evaluation_id, 'evaluation ID'),
          contextId,
          respondentId,
          questionId: asText(row.question_id, 'question ID'),
          status: asText(row.status, 'evaluation status') as RunEvidencePage['items'][number]['status'],
          ...(result === undefined ? {} : { result }),
          ...(failure === undefined ? {} : { failure }),
          ...(selectedMaterial === undefined ? {} : { selectedMaterial }),
          ...(row.execution_json === null ? {} : { execution: providerExecutionEvidenceSchema.parse(parseJson(row.execution_json, 'provider execution')) }),
          ...(row.turn_id === null ? {} : { turnId: asText(row.turn_id, 'turn ID') }),
          ...(row.node_id === null ? {} : { nodeId: asText(row.node_id, 'node ID') }),
          ...(row.occurrence === null ? {} : { occurrence: asNumber(row.occurrence, 'turn occurrence') }),
          ...(row.route_outcome === null ? {} : { outcome: asText(row.route_outcome, 'route outcome') }),
          provenance: {
            provider: parsedRequest.data.provider.kind,
            model,
            endpoint,
            compilerFingerprint,
            contextFingerprint: hashCanonical({ state: packet.state, compilerFingerprint }),
          },
        };
      });
      const last = pageRows.at(-1);
      const sourceComplete = cursor?.sourceComplete ?? sourceStatus === 'completed';
      return {
        items,
        totalMatches: snapshotCount,
        sourceRunId: query.sourceRunId,
        sourceStatus: cursor?.sourceStatus ?? sourceStatus,
        sourceComplete,
        lifecycle,
        coverage,
        matchedCoverage,
        ...(hasMore && last ? { nextCursor: encodeCursor({
          kind: 'evidence', sourceRunId: query.sourceRunId, criteriaFingerprint, maxOrdinal,
          lastOrdinal: asNumber(last.ordinal, 'evaluation ordinal'), sourceStatus: cursor?.sourceStatus ?? sourceStatus,
          sourceComplete, totalMatches: snapshotCount, lifecycle, coverage, matchedCoverage, usedCalls, reservedCalls,
        } satisfies EvidenceCursorPayload) } : {}),
      };
    });
  }

  getContext(runId: string, evaluationId: string, contextId: string): RunContextDetail {
    this.ensureOpen();
    return this.readTransaction(() => {
      const row = this.database.prepare(`SELECT e.*, r.request_json FROM evaluations e JOIN runs r USING (run_id)
        WHERE e.run_id = ? AND e.evaluation_id = ? AND e.context_id = ?`).get(runId, evaluationId, contextId) as DatabaseRow | undefined;
      if (!row) throw new RunStoreError('context_not_found', 'The evaluation and context handles do not identify a context in this run.');
      const stored = parseJson<{ compilerFingerprint?: unknown }>(row.request_json, 'run request');
      if (typeof stored.compilerFingerprint !== 'string' || stored.compilerFingerprint.length === 0) throw new RunStoreError('data_integrity_error', 'Stored compiler identity is invalid.');
      const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet')) as import('../domain/decision/decision.js').DecisionRequest & { state: import('../domain/decision/prompt.js').PromptState };
      const packetFingerprint = asText(row.packet_fingerprint, 'packet fingerprint');
      if (hashCanonical({ packet, compilerFingerprint: stored.compilerFingerprint }) !== packetFingerprint) throw new RunStoreError('data_integrity_error', 'Stored context packet fingerprint does not match its frozen input.');
      return {
        runId,
        evaluationId,
        contextId,
        respondentId: asText(row.respondent_id, 'respondent ID'),
        questionId: asText(row.question_id, 'question ID'),
        status: asText(row.status, 'evaluation status') as RunContextDetail['status'],
        packet,
        provenance: {
          compilerFingerprint: stored.compilerFingerprint,
          packetFingerprint,
          contextFingerprint: hashCanonical({ state: packet.state, compilerFingerprint: stored.compilerFingerprint }),
        },
      };
    });
  }

  answers(runId: string, cursorText?: string, requestedLimit?: number): Page<AnswerRow> {
    this.getStatus(runId);
    const limit = pageSize(requestedLimit);
    let cursor: AnswerCursorPayload | undefined;
    if (cursorText) {
      cursor = decodeCursor<AnswerCursorPayload>(cursorText, 'answer');
      if (cursor.kind !== 'answers' || cursor.runId !== runId || !Number.isInteger(cursor.ordinal) || cursor.ordinal < 0) {
        throw new RunStoreError('invalid_cursor', 'The answer cursor does not match this run.');
      }
    }
    const rows = this.database.prepare(`SELECT e.*,
      (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id)
        WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
      FROM evaluations e WHERE run_id = ? ${cursor ? 'AND ordinal > ?' : ''} ORDER BY ordinal LIMIT ?`)
      .all(...(cursor ? [runId, cursor.ordinal, limit + 1] : [runId, limit + 1])) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row): AnswerRow => {
      const failure = storedEvaluationFailure(row);
      return {
        evaluationId: asText(row.evaluation_id, 'evaluation ID'),
        contextId: asText(row.context_id, 'context ID'),
        respondentId: asText(row.respondent_id, 'respondent ID'),
        questionId: asText(row.question_id, 'question ID'),
        status: asText(row.status, 'evaluation status') as AnswerRow['status'],
        ...(row.result_json === null ? {} : { result: resultFromStorage(parseJson(row.result_json, 'decision result'), row.execution_json === null ? undefined : parseJson(row.execution_json, 'provider execution')) }),
        ...(row.execution_json === null ? {} : { execution: providerExecutionEvidenceSchema.parse(parseJson(row.execution_json, 'provider execution')) }),
        ...(failure === undefined ? {} : { failure }),
      };
    });
    const last = pageRows.at(-1);
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'answers', runId, ordinal: asNumber(last.ordinal, 'evaluation ordinal') } satisfies AnswerCursorPayload) } : {}) };
  }

  attempts(runId: string, cursorText?: string, requestedLimit?: number): Page<RunAttempt> {
    this.getStatus(runId);
    const limit = pageSize(requestedLimit);
    let cursor: AttemptCursorPayload | undefined;
    if (cursorText) {
      cursor = decodeCursor<AttemptCursorPayload>(cursorText, 'attempts');
      if (cursor.kind !== 'attempts' || cursor.runId !== runId || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1) {
        throw new RunStoreError('invalid_cursor', 'The attempt cursor does not match this run.');
      }
    }
    const rows = this.database.prepare(`SELECT a.*, GROUP_CONCAT(ae.evaluation_id) AS evaluation_ids
      FROM attempts a JOIN attempt_evaluations ae USING (attempt_id)
      WHERE a.run_id = ? ${cursor ? 'AND a.attempt_sequence > ?' : ''}
      GROUP BY a.attempt_id ORDER BY a.attempt_sequence LIMIT ?`)
      .all(...(cursor ? [runId, cursor.sequence, limit + 1] : [runId, limit + 1])) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row): RunAttempt => {
      const attemptId = asText(row.attempt_id, 'attempt ID');
      const evaluationFailures = (this.database.prepare(`SELECT ae.evaluation_id, e.question_id, ae.failure_json
        FROM attempt_evaluations ae JOIN evaluations e USING (evaluation_id)
        WHERE ae.attempt_id = ? AND ae.failure_json IS NOT NULL ORDER BY e.ordinal`).all(attemptId) as DatabaseRow[]).flatMap((failureRow) => {
        const failure = evaluationFailureFromJson(failureRow.failure_json);
        return failure ? [{ evaluationId: asText(failureRow.evaluation_id, 'attempt evaluation ID'), questionId: asText(failureRow.question_id, 'attempt question ID'), failure }] : [];
      });
      return {
        attemptId,
        groupId: asText(row.group_id, 'question group ID'),
        evaluationIds: asText(row.evaluation_ids, 'attempt evaluation IDs').split(','),
        status: asText(row.status, 'attempt status') as RunAttempt['status'],
        startedAt: new Date(asNumber(row.started_ms, 'attempt start time')).toISOString(),
        ...(row.settled_ms === null ? {} : { settledAt: new Date(asNumber(row.settled_ms, 'attempt settlement time')).toISOString() }),
        ...(row.failure_code === null ? {} : { failure: {
          code: asText(row.failure_code, 'attempt failure code'),
          message: asText(row.failure_message, 'attempt failure message'),
          ...(row.failure_scope === null ? {} : { scope: asText(row.failure_scope, 'attempt failure scope') as 'evaluation' | 'run' }),
        } }),
        ...(evaluationFailures.length === 0 ? {} : { evaluationFailures }),
        ...(row.execution_json === null ? {} : { execution: providerExecutionEvidenceSchema.parse(parseJson(row.execution_json, 'attempt execution')) }),
      };
    });
    const last = pageRows.at(-1);
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({
      kind: 'attempts', runId, sequence: asNumber(last.attempt_sequence, 'attempt sequence'),
    } satisfies AttemptCursorPayload) } : {}) };
  }

  requestCancel(runId: string): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      const row = this.database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
      if (!row) throw this.notFound();
      const status = asText(row.status, 'run status');
      if (status === 'prepared') {
        this.database.prepare("UPDATE runs SET status = 'cancelled', cancel_requested = 1 WHERE run_id = ? AND status = 'prepared'").run(runId);
      } else if (status === 'running') {
        this.database.prepare('UPDATE runs SET cancel_requested = 1 WHERE run_id = ?').run(runId);
      }
      return this.statusInside(runId);
    });
  }

  resume(runId: string, nowMs: number): { started: boolean; run: RunStatusView } {
    this.ensureOpen();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RunStoreError('invalid_time', 'Resume time must be a nonnegative safe integer.');
    return this.transaction(() => {
      this.reconcileInside(runId, nowMs);
      const statusView = this.statusInside(runId);
      if (statusView.status === 'prepared') return { started: false, run: statusView };
      if (!statusView.lifecycle.resume.eligible) {
        throw new RunStoreError('run_not_resumable', resumeRefusalMessage(statusView.lifecycle.resume.reason));
      }
      const run = this.database.prepare('SELECT status, failure_scope, reserved_calls, cancel_requested, used_calls, max_calls, request_json FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
      if (!run) throw this.notFound();
      const status = asText(run.status, 'run status');
      const storedRequest = parseJson<{ request?: unknown }>(run.request_json, 'run request');
      const parsedRequest = runRequestSchema.safeParse(storedRequest.request);
      if (!parsedRequest.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
      const isJourney = parsedRequest.data.kind === 'journey';

      const failed = this.database.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND status = 'failed'").get(runId) as DatabaseRow;
      const journeyFailures = status === 'partial' && isJourney && statusView.lifecycle.resume.eligible
        ? this.database.prepare(`SELECT e.evaluation_id, e.respondent_id, e.turn_id, e.node_id, e.context_id
          FROM evaluations e JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
          WHERE e.run_id = ? AND e.status = 'failed' AND jr.status = 'failed' ORDER BY e.ordinal`).all(runId) as DatabaseRow[]
        : [];
      const runFailure = this.database.prepare("SELECT attempt_id, evaluation_id FROM attempts WHERE run_id = ? AND status = 'failed' AND failure_scope = 'run' ORDER BY attempt_sequence DESC LIMIT 1").get(runId) as DatabaseRow | undefined;
      const failedRunEvaluationId = runFailure ? asText(runFailure.evaluation_id, 'failed evaluation ID') : undefined;
      const failedEvaluation = failedRunEvaluationId
        ? this.database.prepare("SELECT status FROM evaluations WHERE run_id = ? AND evaluation_id = ?").get(runId, failedRunEvaluationId) as DatabaseRow | undefined
        : undefined;
      const canRetrySharedFailure = status === 'failed' && asText(run.failure_scope, 'failure scope') === 'run' &&
        failedEvaluation !== undefined && asText(failedEvaluation.status, 'evaluation status') === 'failed';
      const canRetryQuestionFailures = status === 'partial' && asNumber(failed.count, 'failed evaluation count') > 0 &&
        !isJourney;
      if (canRetrySharedFailure && runFailure) {
        this.database.prepare(`UPDATE evaluations SET status = 'pending', result_json = NULL, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL
          WHERE run_id = ? AND status = 'failed' AND evaluation_id IN (SELECT evaluation_id FROM attempt_evaluations WHERE attempt_id = ?)`)
          .run(runId, asText(runFailure.attempt_id, 'failed attempt ID'));
      }
      if (canRetryQuestionFailures) this.database.prepare("UPDATE evaluations SET status = 'pending', result_json = NULL, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL WHERE run_id = ? AND status = 'failed'").run(runId);
      for (const checkpoint of journeyFailures) {
        const evaluationId = asText(checkpoint.evaluation_id, 'failed evaluation ID');
        const respondentId = asText(checkpoint.respondent_id, 'failed respondent ID');
        const reopened = this.database.prepare(`UPDATE evaluations SET status = 'pending', result_json = NULL,
          failure_code = NULL, failure_message = NULL, failure_detail_json = NULL
          WHERE run_id = ? AND evaluation_id = ? AND respondent_id = ? AND status = 'failed'`).run(runId, evaluationId, respondentId);
        const restored = this.database.prepare(`UPDATE journey_respondents SET status = 'active',
          current_node_id = ?, current_turn_id = ?, current_context_id = ?, revision = revision + 1
          WHERE run_id = ? AND respondent_id = ? AND status = 'failed'`).run(
          asText(checkpoint.node_id, 'failed turn node ID'), asText(checkpoint.turn_id, 'failed turn ID'),
          asText(checkpoint.context_id, 'failed turn context ID'), runId, respondentId);
        if (reopened.changes !== 1 || restored.changes !== 1) {
          throw new RunStoreError('data_integrity_error', 'The saved failed journey checkpoint changed during resume.');
        }
      }
      this.database.prepare(`UPDATE runs SET status = 'prepared', failure_scope = NULL, failure_code = NULL,
        failure_message = NULL, lease_expires_ms = ?, owner_token = NULL, owner_pid = NULL
        WHERE run_id = ? AND status IN ('interrupted', 'failed', 'partial')`)
        .run(nowMs + LEASE_MS, runId);
      return { started: true, run: this.statusInside(runId) };
    });
  }

  previewDelete(runIds: string[]): DeletePreview {
    this.ensureOpen();
    validateRunIds(runIds);
    return this.transaction(() => {
      const nowMs = this.now();
      const runs = runIds.map((runId) => {
        const row = this.database.prepare('SELECT status, created_ms, lease_expires_ms FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
        if (!row) throw this.notFound();
        const storedStatus = asText(row.status, 'run status') as RunStatus;
        const leaseExpires = row.lease_expires_ms === null ? asNumber(row.created_ms, 'run creation time') + LEASE_MS : asNumber(row.lease_expires_ms, 'run lease expiry');
        const expired = storedStatus === 'prepared' && leaseExpires <= nowMs ||
          storedStatus === 'running' && row.lease_expires_ms !== null && leaseExpires <= nowMs;
        const status: RunStatus = expired ? 'interrupted' : storedStatus;
        const evaluationCount = asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ?').get(runId) as DatabaseRow).count, 'evaluation count');
        const attemptCount = asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(runId) as DatabaseRow).count, 'attempt count');
        const dependentRows = this.database.prepare("SELECT run_id FROM runs WHERE json_extract(request_json, '$.lineage.sourceRunId') = ? ORDER BY created_ms, run_id").all(runId) as DatabaseRow[];
        const retainedFollowOnRunIds = dependentRows.map((row) => asText(row.run_id, 'dependent follow-on run ID')).filter((dependentId) => !runIds.includes(dependentId));
        return { runId, status, evaluationCount, attemptCount, blockedByActiveWork: status === 'prepared' || status === 'running', retainedFollowOnRunIds };
      });
      return { runs, blockedByActiveWork: runs.some(({ blockedByActiveWork }) => blockedByActiveWork) };
    });
  }

  deleteRuns(runIds: string[]): DeleteResult {
    this.ensureOpen();
    validateRunIds(runIds);
    const result = this.transaction(() => {
      const nowMs = this.now();
      const counts = runIds.map((runId) => {
        this.reconcileInside(runId, nowMs);
        const status = asText((this.database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined)?.status, 'run status') as RunStatus;
        if (status === 'prepared' || status === 'running') {
          throw new RunStoreError('runs_active', 'Active runs cannot be deleted. Cancel each run, wait until it reaches a terminal state, then submit the explicit selection again.');
        }
        return {
          runId,
          evaluations: asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ?').get(runId) as DatabaseRow).count, 'evaluation count'),
          attempts: asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(runId) as DatabaseRow).count, 'attempt count'),
        };
      });
      for (const { runId } of counts) this.database.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
      const violations = this.database.prepare('PRAGMA foreign_key_check').all() as DatabaseRow[];
      const integrity = this.database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
      if (violations.length > 0 || integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new RunStoreError('storage_integrity_failed', 'The datastore integrity check failed; no runs were deleted.');
      }
      return { deletedRunIds: counts.map(({ runId }) => runId), removed: { runs: counts.length, evaluations: counts.reduce((sum, item) => sum + item.evaluations, 0), attempts: counts.reduce((sum, item) => sum + item.attempts, 0) } };
    });
    let maintenance: DeleteResult['maintenance'];
    try {
      this.optimizeStorage();
      maintenance = { optimization: 'completed' };
    } catch (error) {
      maintenance = { optimization: 'failed', failureCode: error instanceof RunStoreError ? error.code : 'storage_operation_failed' };
    }
    return { ...result, maintenance };
  }

  storageInfo(): StorageInfo {
    this.ensureOpen();
    try {
      return this.transaction(() => {
        const integrityRows = this.database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
        const foreignKeyViolations = this.database.prepare('PRAGMA foreign_key_check').all() as DatabaseRow[];
        const integrity = integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyViolations.length === 0 ? 'ok' : 'failed';
        if (integrity === 'ok') {
          const active = this.database.prepare("SELECT run_id FROM runs WHERE status IN ('prepared', 'running')").all() as DatabaseRow[];
          for (const row of active) this.reconcileInside(asText(row.run_id, 'run ID'), this.now());
        }
        const count = (table: 'runs' | 'evaluations' | 'attempts', where = '') => asNumber((this.database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as DatabaseRow).count, `${table} count`);
        return {
          integrity,
          databaseBytes: statSync(this.databasePath).size,
          runCount: count('runs'),
          evaluationCount: count('evaluations'),
          attemptCount: count('attempts'),
          activeRunCount: count('runs', "WHERE status IN ('prepared', 'running')"),
        };
      });
    } catch (error) {
      if (error instanceof RunStoreError) throw error;
      throw new RunStoreError('storage_operation_failed', 'Sheg could not inspect datastore health.', { cause: error });
    }
  }

  optimizeStorage(): void {
    this.ensureOpen();
    if (this.storageInfo().integrity !== 'ok') throw new RunStoreError('storage_integrity_failed', 'Sheg will not optimize a datastore whose integrity check failed.');
    try { this.database.exec('PRAGMA optimize'); }
    catch (error) { throw new RunStoreError('storage_operation_failed', 'Sheg could not optimize the datastore.', { cause: error }); }
  }

  claim(runId: string, nowMs: number, workerPid: number): WorkerClaim | null {
    this.ensureOpen();
    if (!Number.isSafeInteger(workerPid) || workerPid < 1) throw new RunStoreError('invalid_worker_pid', 'Worker PID must be a positive integer.');
    return this.transaction(() => {
      const row = this.database.prepare('SELECT status, created_ms, cancel_requested, lease_expires_ms FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
      if (!row) throw this.notFound();
      const launchDeadline = row.lease_expires_ms === null ? asNumber(row.created_ms, 'created time') + LEASE_MS : asNumber(row.lease_expires_ms, 'launch deadline');
      if (asText(row.status, 'run status') !== 'prepared' || asNumber(row.cancel_requested, 'cancel flag') === 1 || nowMs >= launchDeadline) return null;
      const ownerToken = randomUUID();
      this.database.prepare("UPDATE runs SET status = 'running', owner_token = ?, owner_pid = ?, lease_expires_ms = ? WHERE run_id = ? AND status = 'prepared'")
        .run(ownerToken, workerPid, nowMs + LEASE_MS, runId);
      return { runId, ownerToken };
    });
  }

  heartbeat(claim: WorkerClaim, nowMs: number): boolean {
    this.ensureOpen();
    return this.transaction(() => {
      const updated = this.database.prepare(`UPDATE runs SET lease_expires_ms = ?
        WHERE run_id = ? AND status = 'running' AND owner_token = ? AND lease_expires_ms > ?`)
        .run(nowMs + LEASE_MS, claim.runId, claim.ownerToken, nowMs);
      return updated.changes === 1;
    });
  }

  reserveNext(claim: WorkerClaim, nowMs: number): AttemptReservation | null {
    this.ensureOpen();
    return this.transaction(() => {
      const run = this.ownedRun(claim, nowMs);
      if (asNumber(run.cancel_requested, 'cancel flag') === 1) return null;
      if (asNumber(run.reserved_calls, 'reserved calls') !== 0) return null;
      if (asNumber(run.used_calls, 'used calls') + asNumber(run.reserved_calls, 'reserved calls') >= asNumber(run.max_calls, 'maximum calls')) return null;
      const row = this.database.prepare("SELECT * FROM evaluations WHERE run_id = ? AND status = 'pending' ORDER BY ordinal LIMIT 1").get(claim.runId) as DatabaseRow | undefined;
      if (!row) return null;
      const attemptId = randomUUID();
      const evaluationId = asText(row.evaluation_id, 'evaluation ID');
      this.database.prepare("INSERT INTO attempts (attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)")
        .run(attemptId, claim.runId, asText(row.group_id, 'group ID'), evaluationId, asText(row.packet_fingerprint, 'packet fingerprint'), claim.ownerToken, nowMs);
      this.database.prepare('INSERT INTO attempt_evaluations (attempt_id, evaluation_id) VALUES (?, ?)').run(attemptId, evaluationId);
      this.database.prepare('UPDATE runs SET reserved_calls = reserved_calls + 1 WHERE run_id = ?').run(claim.runId);
      return { attemptId, evaluation: this.evaluationFromRow(row) };
    });
  }

  reserveBatch(claim: WorkerClaim, groupId: string, evaluationIds: string[], nowMs: number): { attemptId: string; evaluations: FrozenEvaluation[] } | null {
    this.ensureOpen();
    return this.transaction(() => {
      const run = this.ownedRun(claim, nowMs);
      if (!evaluationIds.length || new Set(evaluationIds).size !== evaluationIds.length || asNumber(run.cancel_requested, 'cancel flag') === 1 ||
          asNumber(run.reserved_calls, 'reserved calls') !== 0 || asNumber(run.used_calls, 'used calls') >= asNumber(run.max_calls, 'maximum calls')) return null;
      const group = this.database.prepare('SELECT * FROM question_groups WHERE run_id = ? AND group_id = ?').get(claim.runId, groupId) as DatabaseRow | undefined;
      if (!group) throw new RunStoreError('question_group_not_found', 'The requested question group was not found in this run.');
      const orderedIds = parseJson<string[]>(group.question_ids_json, 'group question IDs');
      const rows = this.database.prepare(`SELECT * FROM evaluations WHERE run_id = ? AND group_id = ? AND status = 'pending'`).all(claim.runId, groupId) as DatabaseRow[];
      const byId = new Map(rows.map((row) => [asText(row.evaluation_id, 'evaluation ID'), row]));
      const selected = evaluationIds.map((id) => byId.get(id));
      if (selected.some((row) => !row) || selected.some((row) => !orderedIds.includes(asText(row!.question_id, 'question ID')))) {
        throw new RunStoreError('invalid_batch_reservation', 'A batch may reserve only pending evaluations from the requested group.');
      }
      const sorted = [...selected as DatabaseRow[]].sort((left, right) => orderedIds.indexOf(asText(left.question_id, 'question ID')) - orderedIds.indexOf(asText(right.question_id, 'question ID')));
      const attemptId = randomUUID(); const anchorId = asText(sorted[0]!.evaluation_id, 'evaluation ID');
      const state = parseJson(group.state_json, 'group state');
      const packetQuestions = sorted.map((row) => decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet')).question);
      const packetFingerprint = hashCanonical({ state, questions: packetQuestions });
      this.database.prepare("INSERT INTO attempts (attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)")
        .run(attemptId, claim.runId, groupId, anchorId, packetFingerprint, claim.ownerToken, nowMs);
      const link = this.database.prepare('INSERT INTO attempt_evaluations (attempt_id, evaluation_id) VALUES (?, ?)');
      for (const row of sorted) link.run(attemptId, asText(row.evaluation_id, 'evaluation ID'));
      this.database.prepare('UPDATE runs SET reserved_calls = reserved_calls + 1 WHERE run_id = ?').run(claim.runId);
      return { attemptId, evaluations: sorted.map((row) => this.evaluationFromRow(row)) };
    });
  }

  settleBatch(claim: WorkerClaim, attemptId: string, outcome: { kind: 'answered'; result: DecisionBatchResult } | Extract<AttemptOutcome, { kind: 'failed' }>): void {
    this.ensureOpen();
    this.transaction(() => {
      const nowMs = this.now(); this.ownedRun(claim, nowMs);
      const attempt = this.database.prepare("SELECT * FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
        .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
      const rows = this.database.prepare(`SELECT e.* FROM attempt_evaluations ae JOIN evaluations e USING (evaluation_id) WHERE ae.attempt_id = ? ORDER BY e.ordinal`).all(attemptId) as DatabaseRow[];
      if (!rows.length) throw new RunStoreError('data_integrity_error', 'The provider attempt has no linked evaluations.');
      if (outcome.kind === 'failed') {
        this.database.prepare("UPDATE attempts SET status = 'failed', settled_ms = ?, failure_code = ?, failure_message = ?, failure_scope = ? WHERE attempt_id = ?")
          .run(nowMs, outcome.code, outcome.message, outcome.scope, attemptId);
        for (const row of rows) {
          const evaluationId = asText(row.evaluation_id, 'evaluation ID');
          this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
            .run(outcome.code, outcome.message, outcome.detail ? JSON.stringify(outcome.detail) : null, evaluationId);
          if (outcome.detail) this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
            .run(evaluationFailureJson({ code: outcome.code, message: outcome.message, detail: outcome.detail }), attemptId, evaluationId);
        }
        if (outcome.scope === 'run') this.database.prepare('UPDATE runs SET failure_scope = ?, failure_code = ?, failure_message = ? WHERE run_id = ?').run(outcome.scope, outcome.code, outcome.message, claim.runId);
      } else {
        const result = decisionBatchResultSchema.safeParse(outcome.result);
        if (!result.success) throw new RunStoreError('invalid_batch_result', 'The batch result envelope is invalid.');
        const expected = new Map(rows.map((row) => [asText(row.question_id, 'question ID'), row]));
        if (result.data.answers.some(({ questionId }) => !expected.has(questionId))) throw new RunStoreError('invalid_batch_result', 'The batch result contains an unknown question ID.');
        this.database.prepare("UPDATE attempts SET status = 'answered', settled_ms = ?, execution_json = ? WHERE attempt_id = ?")
          .run(nowMs, JSON.stringify(result.data.execution), attemptId);
        for (const [questionId, row] of expected) {
          const answer = result.data.answers.find((item) => item.questionId === questionId);
          const evaluationId = asText(row.evaluation_id, 'evaluation ID');
          if (!answer) {
            this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = 'missing_batch_answer', failure_message = 'Provider returned no answer for this question.' WHERE evaluation_id = ?").run(evaluationId);
            this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
              .run(evaluationFailureJson({ code: 'missing_batch_answer', message: 'Provider returned no answer for this question.' }), attemptId, evaluationId);
          } else if ('failure' in answer) {
            const failure = { code: answer.failure.code, message: answer.failure.message, ...(answer.failure.detail ? { detail: answer.failure.detail } : {}) };
            this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
              .run(failure.code, failure.message, failure.detail ? JSON.stringify(failure.detail) : null, evaluationId);
            this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
              .run(evaluationFailureJson(failure), attemptId, evaluationId);
          } else {
            const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet'));
            let validated: ReturnType<typeof validateDecision> | undefined;
            try {
              const typed = decisionResultSchema.parse({ ...answer.value, ...result.data.execution });
              validated = validateDecision(packet, typed, { maxAttempts: 1 });
            } catch {
              const failure = { code: 'invalid_decision', message: 'The stored answer did not satisfy this question contract.', detail: decisionFailureDetailForReason('invalid_answer') };
              this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
                .run(failure.code, failure.message, JSON.stringify(failure.detail), evaluationId);
              this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
                .run(evaluationFailureJson(failure), attemptId, evaluationId);
            }
            if (validated) {
              this.database.prepare("UPDATE evaluations SET status = 'answered', result_json = ?, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL WHERE evaluation_id = ?").run(JSON.stringify(answer.value), evaluationId);
              this.database.prepare('INSERT INTO evaluation_answer_attempts (evaluation_id, attempt_id) VALUES (?, ?)').run(evaluationId, attemptId);
            }
          }
        }
      }
      this.database.prepare('UPDATE runs SET used_calls = used_calls + ?, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0')
        .run(outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : 1, claim.runId);
    });
  }

  settle(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome): void {
    this.ensureOpen();
    this.transaction(() => {
      const nowMs = this.now();
      this.ownedRun(claim, nowMs);
      const attempt = this.database.prepare("SELECT evaluation_id FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
        .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
      const evaluationId = asText(attempt.evaluation_id, 'evaluation ID');
      const evaluation = this.database.prepare('SELECT packet_json FROM evaluations WHERE evaluation_id = ? AND run_id = ?').get(evaluationId, claim.runId) as DatabaseRow | undefined;
      if (!evaluation) throw new RunStoreError('data_integrity_error', 'The reserved evaluation is missing.');
      const packet = decisionRequestSchema.parse(parseJson(evaluation.packet_json, 'frozen packet'));

      if (outcome.kind === 'answered') {
        const result = validateDecision(packet, outcome.result, { maxAttempts: 1 });
        this.database.prepare("UPDATE attempts SET status = 'answered', settled_ms = ?, result_json = ?, execution_json = ? WHERE attempt_id = ?")
          .run(nowMs, JSON.stringify(result), JSON.stringify({ attempts: result.attempts, provider: result.provider, model: result.model, ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}), latencyMs: result.latencyMs, usage: result.usage, ...(result.cost ? { cost: result.cost } : {}) }), attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'answered', result_json = ?, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL WHERE evaluation_id = ?")
          .run(JSON.stringify(result), evaluationId);
        this.database.prepare('INSERT INTO evaluation_answer_attempts (evaluation_id, attempt_id) VALUES (?, ?)').run(evaluationId, attemptId);
      } else {
        this.database.prepare("UPDATE attempts SET status = 'failed', settled_ms = ?, failure_code = ?, failure_message = ?, failure_scope = ? WHERE attempt_id = ?")
          .run(nowMs, outcome.code, outcome.message, outcome.scope, attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
          .run(outcome.code, outcome.message, outcome.detail ? JSON.stringify(outcome.detail) : null, evaluationId);
        const failure = { code: outcome.code, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}) };
        this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
          .run(evaluationFailureJson(failure), attemptId, evaluationId);
        if (outcome.scope === 'run') {
          this.database.prepare('UPDATE runs SET failure_scope = ?, failure_code = ?, failure_message = ? WHERE run_id = ?')
            .run(outcome.scope, outcome.code, outcome.message, claim.runId);
        }
      }
      this.database.prepare('UPDATE runs SET used_calls = used_calls + ?, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0')
        .run(outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : 1, claim.runId);
    });
  }

  settleJourney(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome, transition: JourneyTransition): void {
    this.ensureOpen();
    this.transaction(() => {
      const nowMs = this.now();
      this.ownedRun(claim, nowMs);
      const attempt = this.database.prepare("SELECT evaluation_id FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
        .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
      const evaluationId = asText(attempt.evaluation_id, 'evaluation ID');
      const evaluation = this.database.prepare('SELECT packet_json, turn_id, node_id, respondent_id FROM evaluations WHERE evaluation_id = ? AND run_id = ?')
        .get(evaluationId, claim.runId) as DatabaseRow | undefined;
      if (!evaluation) throw new RunStoreError('data_integrity_error', 'The reserved journey turn is missing.');
      const turnId = asText(evaluation.turn_id, 'turn ID');
      const nodeId = asText(evaluation.node_id, 'node ID');
      const respondentId = asText(evaluation.respondent_id, 'respondent ID');
      if (transition.respondentId !== respondentId || transition.state.respondentId !== respondentId ||
          !Number.isSafeInteger(transition.expectedRevision) || transition.expectedRevision < 0 ||
          transition.state.revision !== transition.expectedRevision + 1) {
        throw new RunStoreError('journey_transition_conflict', 'Journey transition does not match the reserved respondent turn.');
      }
      const stateRow = this.database.prepare('SELECT * FROM journey_respondents WHERE run_id = ? AND respondent_id = ?')
        .get(claim.runId, respondentId) as DatabaseRow | undefined;
      if (!stateRow || asNumber(stateRow.revision, 'journey state revision') !== transition.expectedRevision ||
          asText(stateRow.current_turn_id, 'current turn ID') !== turnId || asText(stateRow.current_node_id, 'current node ID') !== nodeId) {
        throw new RunStoreError('journey_transition_conflict', 'Journey respondent state has moved since this turn was reserved.');
      }
      const priorEvents = parseJson<JourneyRespondentState['events']>(stateRow.events_json, 'journey history');
      const priorRoute = parseJson<JourneyRespondentState['route']>(stateRow.route_json, 'journey route');
      if (transition.state.events.length < priorEvents.length || JSON.stringify(transition.state.events.slice(0, priorEvents.length)) !== JSON.stringify(priorEvents) ||
          transition.state.route.length < priorRoute.length || JSON.stringify(transition.state.route.slice(0, priorRoute.length)) !== JSON.stringify(priorRoute)) {
        throw new RunStoreError('journey_transition_conflict', 'Journey transitions must preserve ordered prior evidence.');
      }
      const runRow = this.database.prepare('SELECT request_json FROM runs WHERE run_id = ?').get(claim.runId) as DatabaseRow | undefined;
      const storedRun = parseJson<{ request?: unknown; compilerFingerprint?: unknown }>(runRow?.request_json, 'run request');
      const parsedRunRequest = runRequestSchema.safeParse(storedRun.request);
      if (!parsedRunRequest.success || parsedRunRequest.data.kind !== 'journey' || typeof storedRun.compilerFingerprint !== 'string') {
        throw new RunStoreError('data_integrity_error', 'Stored journey request is invalid.');
      }
      const packet = decisionRequestSchema.parse(parseJson(evaluation.packet_json, 'frozen packet'));
      if (outcome.kind === 'answered') {
        const result = validateDecision(packet, outcome.result, { maxAttempts: 1 });
        const answerEvent = transition.state.events.slice(priorEvents.length).findLast(
          (event): event is Extract<JourneyRespondentState['events'][number], { type: 'response' }> => event.type === 'response' && event.nodeId === nodeId,
        );
        if (!answerEvent || answerEvent.taskId !== packet.question.id ||
            !sameDecisionValue(answerEvent.result, result)) {
          throw new RunStoreError('journey_transition_conflict', 'Journey transition must append the exact typed answer for this turn.');
        }
        const routeAddition = transition.state.route.slice(priorRoute.length);
        const expectedTarget = journeyRouteTarget(parsedRunRequest.data.journey, nodeId, result);
        if (routeAddition.length !== 1 || routeAddition[0]!.nodeId !== nodeId || routeAddition[0]!.toNodeId !== expectedTarget ||
            !sameDecisionValue(routeAddition[0]!.response, result) || transition.state.status === 'failed') {
          throw new RunStoreError('journey_transition_conflict', 'Journey transition must record the exact typed response and matching route outcome.');
        }
        if (transition.state.status === 'active') {
          if (!transition.nextEvaluation || transition.nextEvaluation.respondentId !== respondentId ||
              transition.state.currentTurnId !== transition.nextEvaluation.turnId || transition.state.currentContextId !== transition.nextEvaluation.contextId ||
              transition.state.currentNodeId !== transition.nextEvaluation.nodeId) {
            throw new RunStoreError('journey_transition_conflict', 'An active respondent must point to exactly one next reached turn.');
          }
        } else if (transition.nextEvaluation || transition.state.currentTurnId !== null || transition.state.currentContextId !== null || transition.state.currentNodeId !== null) {
          throw new RunStoreError('journey_transition_conflict', 'A terminal respondent state cannot have a next reached turn.');
        }
        this.database.prepare("UPDATE attempts SET status = 'answered', settled_ms = ?, result_json = ?, execution_json = ? WHERE attempt_id = ?")
          .run(nowMs, JSON.stringify(result), JSON.stringify({ attempts: result.attempts, provider: result.provider, model: result.model, ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}), latencyMs: result.latencyMs, usage: result.usage, ...(result.cost ? { cost: result.cost } : {}) }), attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'answered', result_json = ?, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL WHERE evaluation_id = ?")
          .run(JSON.stringify(result), evaluationId);
        this.database.prepare('INSERT INTO evaluation_answer_attempts (evaluation_id, attempt_id) VALUES (?, ?)').run(evaluationId, attemptId);
      } else {
        const sharedFailure = outcome.scope === 'run';
        if (transition.nextEvaluation || (sharedFailure
          ? transition.state.status !== 'active' || transition.state.currentTurnId !== turnId || transition.state.currentContextId !== asText(stateRow.current_context_id, 'current context ID') || transition.state.currentNodeId !== nodeId
          : transition.state.status !== 'failed' || transition.state.currentTurnId !== null || transition.state.currentContextId !== null || transition.state.currentNodeId !== null)) {
          throw new RunStoreError('journey_transition_conflict', 'A failed turn must preserve a resumable shared turn or stop only this respondent.');
        }
        this.database.prepare("UPDATE attempts SET status = 'failed', settled_ms = ?, failure_code = ?, failure_message = ?, failure_scope = ? WHERE attempt_id = ?")
          .run(nowMs, outcome.code, outcome.message, outcome.scope, attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
          .run(outcome.code, outcome.message, outcome.detail ? JSON.stringify(outcome.detail) : null, evaluationId);
        const failure = { code: outcome.code, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}) };
        this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
          .run(evaluationFailureJson(failure), attemptId, evaluationId);
        if (outcome.scope === 'run') {
          this.database.prepare('UPDATE runs SET failure_scope = ?, failure_code = ?, failure_message = ? WHERE run_id = ?')
            .run(outcome.scope, outcome.code, outcome.message, claim.runId);
        }
      }
      if (transition.nextEvaluation) {
        const next = transition.nextEvaluation;
        const nextPacket = decisionRequestSchema.safeParse(next.packet);
        const respondent = parsedRunRequest.data.respondents.find(({ id }) => id === respondentId);
        const current = this.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM evaluations WHERE run_id = ?').get(claim.runId) as DatabaseRow;
        if (!nextPacket.success || !respondent || next.respondentId !== respondentId || !Number.isSafeInteger(next.occurrence) || next.occurrence < 1 ||
            !Number.isSafeInteger(next.ordinal) || next.ordinal !== asNumber(current.ordinal, 'evaluation ordinal') + 1 ||
            next.questionId !== nextPacket.data.question.id || !isJourneyAskNode(parsedRunRequest.data.journey, next.nodeId, next.questionId) ||
            hashCanonical(compileDecisionPacketForCompiler(parsedRunRequest.data.journey, respondent, next.questionId, transition.state.events, storedRun.compilerFingerprint)) !== hashCanonical(nextPacket.data) ||
            hashCanonical({ packet: nextPacket.data, compilerFingerprint: storedRun.compilerFingerprint }) !== next.packetFingerprint) {
          throw new RunStoreError('invalid_journey_turn', 'Next journey turn is invalid or does not follow the persisted evaluation order.');
        }
        this.database.prepare(`INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(next.contextId, claim.runId, next.ordinal, next.contextId, next.respondentId, JSON.stringify(next.packet.state), JSON.stringify([next.questionId]));
        this.database.prepare(`INSERT INTO evaluations
          (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(next.evaluationId, claim.runId, next.ordinal, next.contextId, next.respondentId, next.questionId,
            next.contextId, next.turnId, next.nodeId, next.pathId, next.occurrence, JSON.stringify(next.packet), next.packetFingerprint);
        this.database.prepare('UPDATE runs SET evaluation_count = evaluation_count + 1 WHERE run_id = ?').run(claim.runId);
      }
      const updatedState = this.database.prepare(`UPDATE journey_respondents SET status = ?, current_node_id = ?, current_turn_id = ?, current_context_id = ?,
        revision = ?, events_json = ?, route_json = ?, outcome = ? WHERE run_id = ? AND respondent_id = ? AND revision = ?`)
        .run(transition.state.status, transition.state.currentNodeId, transition.state.currentTurnId, transition.state.currentContextId,
          transition.state.revision, JSON.stringify(transition.state.events), JSON.stringify(transition.state.route), transition.state.outcome ?? null,
          claim.runId, respondentId, transition.expectedRevision);
      if (updatedState.changes !== 1) throw new RunStoreError('journey_transition_conflict', 'Journey respondent state changed before its transition committed.');
      this.database.prepare('UPDATE runs SET used_calls = used_calls + ?, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0')
        .run(outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : 1, claim.runId);
    });
  }

  finish(claim: WorkerClaim): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      const run = this.ownedRun(claim, this.now());
      if (asNumber(run.reserved_calls, 'reserved calls') !== 0) {
        throw new RunStoreError('attempt_in_flight', 'A run cannot finish while a provider attempt is still reserved.');
      }
      const atCallCeiling = asNumber(run.used_calls, 'used calls') >= asNumber(run.max_calls, 'maximum calls');
      if (atCallCeiling && asNumber(run.cancel_requested, 'cancel flag') === 0 && run.failure_scope !== 'run') {
        const hasJourney = this.database.prepare('SELECT 1 FROM journey_respondents WHERE run_id = ? LIMIT 1').get(claim.runId) as DatabaseRow | undefined;
        if (hasJourney) {
          this.database.prepare("UPDATE evaluations SET status = 'unreached' WHERE run_id = ? AND status = 'pending'").run(claim.runId);
          this.database.prepare(`UPDATE journey_respondents SET status = 'unreached', current_node_id = NULL, current_turn_id = NULL,
            current_context_id = NULL, revision = revision + 1 WHERE run_id = ? AND status = 'active'`).run(claim.runId);
        }
      }
      let status: RunStatus;
      if (run.failure_scope === 'run') status = 'failed';
      else if (asNumber(run.cancel_requested, 'cancel flag') === 1) status = 'cancelled';
      else {
        const counts = this.database.prepare(`SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'unreached' THEN 1 ELSE 0 END) AS unreached
          FROM evaluations WHERE run_id = ?`).get(claim.runId) as DatabaseRow;
        status = asNumber(counts.pending, 'pending count') === 0 && asNumber(counts.failed, 'failed count') === 0 && asNumber(counts.unreached, 'unreached count') === 0 ? 'completed' : 'partial';
      }
      this.database.prepare('UPDATE runs SET status = ?, owner_token = NULL, owner_pid = NULL, lease_expires_ms = NULL WHERE run_id = ?')
        .run(status, claim.runId);
      return this.statusInside(claim.runId);
    });
  }

  failLaunch(runId: string, code: string): void {
    this.ensureOpen();
    this.transaction(() => {
      const updated = this.database.prepare("UPDATE runs SET status = 'failed', failure_scope = 'run', failure_code = ?, failure_message = 'Worker could not be launched' WHERE run_id = ? AND status = 'prepared'")
        .run(code, runId);
      if (updated.changes === 0) this.statusInside(runId);
    });
  }

  failRun(claim: WorkerClaim, code: string, message: string): void {
    this.ensureOpen();
    this.transaction(() => {
      this.ownedRun(claim, this.now());
      const reserved = this.database.prepare("SELECT attempt_id FROM attempts WHERE run_id = ? AND owner_token = ? AND status = 'reserved'").get(claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (reserved) {
        this.database.prepare("UPDATE attempts SET status = 'uncertain', settled_ms = ?, failure_code = 'worker_interrupted', failure_message = 'The provider outcome could not be confirmed' WHERE attempt_id = ?")
          .run(this.now(), asText(reserved.attempt_id, 'attempt ID'));
        this.database.prepare('UPDATE runs SET used_calls = used_calls + 1, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0').run(claim.runId);
      }
      this.database.prepare("UPDATE runs SET status = 'failed', failure_scope = 'run', failure_code = ?, failure_message = ?, owner_token = NULL, owner_pid = NULL, lease_expires_ms = NULL WHERE run_id = ? AND owner_token = ?")
        .run(code, message, claim.runId, claim.ownerToken);
    });
  }

  reconcile(runId: string, nowMs: number): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      this.reconcileInside(runId, nowMs);
      return this.statusInside(runId);
    });
  }

  close(): void {
    if (this.isClosed) return;
    this.database.close();
    this.isClosed = true;
  }

  private ensureOpen(): void {
    if (this.isClosed) throw new RunStoreError('store_closed', 'This run store connection is closed.');
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* The original operation error carries the useful detail. */ }
      throw error;
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* Preserve the useful resolver error. */ }
      throw error;
    }
  }

  private notFound(): RunStoreError { return new RunStoreError('run_not_found', 'The requested run does not exist in this datastore.'); }

  private statusInside(runId: string): RunStatusView {
    const row = this.database.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'answered') AS completed_evaluations,
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'failed') AS failed_evaluations,
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'pending') AS pending_evaluations,
      EXISTS (SELECT 1 FROM attempts a JOIN attempt_evaluations ae USING (attempt_id)
        JOIN evaluations e ON e.run_id = a.run_id AND e.evaluation_id = ae.evaluation_id
        WHERE a.run_id = r.run_id AND a.status = 'failed' AND a.failure_scope = 'run' AND e.status = 'failed'
          AND a.attempt_sequence = (SELECT MAX(latest.attempt_sequence) FROM attempts latest WHERE latest.run_id = r.run_id AND latest.status = 'failed' AND latest.failure_scope = 'run')) AS retryable_shared_failure,
      (EXISTS (SELECT 1 FROM evaluations e JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
          WHERE e.run_id = r.run_id AND e.status = 'failed' AND jr.status = 'failed') AND
       NOT EXISTS (SELECT 1 FROM evaluations e LEFT JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
          WHERE e.run_id = r.run_id AND e.status = 'failed' AND (jr.respondent_id IS NULL OR jr.status <> 'failed' OR
            e.turn_id IS NULL OR length(trim(e.turn_id)) = 0 OR e.node_id IS NULL OR length(trim(e.node_id)) = 0 OR
            e.path_id IS NULL OR length(trim(e.path_id)) = 0 OR e.occurrence IS NULL OR e.occurrence < 1 OR
            length(trim(e.packet_json)) = 0 OR length(trim(e.packet_fingerprint)) = 0)) AND
       NOT EXISTS (SELECT e.respondent_id FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'failed'
          GROUP BY e.respondent_id HAVING COUNT(*) <> 1) AND
       NOT EXISTS (SELECT 1 FROM journey_respondents jr WHERE jr.run_id = r.run_id AND jr.status = 'failed' AND
          (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = jr.run_id AND e.respondent_id = jr.respondent_id AND e.status = 'failed') <> 1)) AS retryable_journey_failure
      FROM runs r WHERE r.run_id = ?`).get(runId) as DatabaseRow | undefined;
    if (!row) throw this.notFound();
    const stored = parseJson<{ request?: unknown }>(row.request_json, 'run request');
    const request = runRequestSchema.safeParse(stored.request);
    if (!request.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
    const status = asText(row.status, 'run status') as RunStatus;
    const usedCalls = asNumber(row.used_calls, 'used calls');
    const reservedCalls = asNumber(row.reserved_calls, 'reserved calls');
    const maxCalls = asNumber(row.max_calls, 'maximum calls');
    return {
      runId: asText(row.run_id, 'run ID'),
      status,
      createdAt: asText(row.created_at, 'created time'),
      completedEvaluations: asNumber(row.completed_evaluations, 'completed evaluation count'),
      failedEvaluations: asNumber(row.failed_evaluations, 'failed evaluation count'),
      totalEvaluations: asNumber(row.evaluation_count, 'evaluation count'),
      usedCalls,
      reservedCalls,
      maxCalls,
      cancelRequested: asNumber(row.cancel_requested, 'cancel flag') === 1,
      lifecycle: deriveRunLifecycle({ status, kind: request.data.kind, cancelRequested: asNumber(row.cancel_requested, 'cancel flag') === 1,
        ...(row.failure_scope === null ? {} : { failureScope: asText(row.failure_scope, 'failure scope') as 'evaluation' | 'run' }),
        usedCalls, reservedCalls, maxCalls,
        hasPendingEvaluations: asNumber(row.pending_evaluations, 'pending evaluation count') > 0,
        hasFailedEvaluations: asNumber(row.failed_evaluations, 'failed evaluation count') > 0,
        canRetrySharedFailure: asNumber(row.retryable_shared_failure, 'retryable shared failure') === 1,
        hasRetryableJourneyFailure: asNumber(row.retryable_journey_failure, 'retryable journey failure') === 1 }),
      ...(row.failure_code === null ? {} : { failure: { code: asText(row.failure_code, 'failure code'), message: asText(row.failure_message, 'failure message') } }),
    };
  }

  private evaluationFromRow(row: DatabaseRow): FrozenEvaluation {
    return {
      evaluationId: asText(row.evaluation_id, 'evaluation ID'),
      contextId: asText(row.context_id, 'context ID'),
      respondentId: asText(row.respondent_id, 'respondent ID'),
      questionId: asText(row.question_id, 'question ID'),
      packet: decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet')),
      packetFingerprint: asText(row.packet_fingerprint, 'packet fingerprint'),
    };
  }

  private ownedRun(claim: WorkerClaim, nowMs: number): DatabaseRow {
    const run = this.database.prepare("SELECT * FROM runs WHERE run_id = ? AND status = 'running' AND owner_token = ? AND lease_expires_ms > ?")
      .get(claim.runId, claim.ownerToken, nowMs) as DatabaseRow | undefined;
    if (!run) throw new RunStoreError('worker_ownership_lost', 'This worker no longer owns the run.');
    return run;
  }

  private reconcileInside(runId: string, nowMs: number): void {
    const run = this.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
    if (!run) throw this.notFound();
    const status = asText(run.status, 'run status');
    const launchDeadline = run.lease_expires_ms === null ? asNumber(run.created_ms, 'created time') + LEASE_MS : asNumber(run.lease_expires_ms, 'launch deadline');
    if (status === 'prepared' && nowMs >= launchDeadline) {
      this.database.prepare("UPDATE runs SET status = 'interrupted', failure_scope = 'run', failure_code = 'worker_not_claimed', failure_message = 'No worker claimed the accepted run before its launch window expired' WHERE run_id = ? AND status = 'prepared'").run(runId);
    } else if (status === 'running' && run.lease_expires_ms !== null && asNumber(run.lease_expires_ms, 'worker lease') <= nowMs) {
      const attempts = this.database.prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND status = 'reserved'").get(runId) as DatabaseRow;
      const uncertain = asNumber(attempts.count, 'uncertain attempt count');
      if (uncertain !== asNumber(run.reserved_calls, 'reserved calls')) {
        throw new RunStoreError('data_integrity_error', 'Reserved call counters do not match reserved attempts.');
      }
      this.database.prepare("UPDATE attempts SET status = 'uncertain', settled_ms = ?, failure_code = 'worker_interrupted', failure_message = 'Provider completion is unknown' WHERE run_id = ? AND status = 'reserved'").run(nowMs, runId);
      this.database.prepare(`UPDATE runs SET status = 'interrupted', used_calls = used_calls + ?,
        reserved_calls = reserved_calls - ?, owner_token = NULL, owner_pid = NULL, lease_expires_ms = NULL,
        failure_scope = 'run', failure_code = 'worker_interrupted', failure_message = 'Worker ownership expired; unfinished work requires explicit resume'
        WHERE run_id = ? AND status = 'running' AND lease_expires_ms <= ? AND reserved_calls >= ?`)
        .run(uncertain, uncertain, runId, nowMs, uncertain);
    }
  }
}
