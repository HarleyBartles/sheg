import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { decisionRequestSchema } from '../domain/decision/decision.js';
import { validateDecision } from '../domain/decision/validate.js';
import type { AttemptReservation, AnswerRow, Page, RunStatus, RunStatusView, WorkerClaim } from '../domain/run/lifecycle.js';
import { inlineRunRequestSchema, type FrozenEvaluation, type PreparedRun } from '../domain/run/request.js';
import { hashCanonical } from './identity.js';

const SCHEMA_VERSION = 1;
const LEASE_MS = 30_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export type AttemptOutcome =
  | { kind: 'answered'; result: import('../domain/decision/decision.js').DecisionResult }
  | { kind: 'failed'; code: string; message: string; scope: 'evaluation' | 'run' };

export type RunListQuery = { status?: RunStatus; label?: string; cursor?: string; limit?: number };
export type DeletePreview = { runs: Array<{ runId: string; status: RunStatus; evaluationCount: number; attemptCount: number; blockedByActiveWork: boolean }>; blockedByActiveWork: boolean };
export type DeleteResult = { deletedRunIds: string[]; removed: { runs: number; evaluations: number; attempts: number } };

export class RunStoreError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunStoreError';
  }
}

export interface RunStore {
  findSubmission(submissionId: string, requestFingerprint: string): RunStatusView | null;
  accept(submissionId: string, prepared: PreparedRun): { created: boolean; run: RunStatusView };
  getStatus(runId: string): RunStatusView;
  getRequest(runId: string): PreparedRun;
  list(query: RunListQuery): Page<RunStatusView>;
  answers(runId: string, cursor?: string, limit?: number): Page<AnswerRow>;
  requestCancel(runId: string): RunStatusView;
  resume(runId: string, nowMs: number): { started: boolean; run: RunStatusView };
  previewDelete(runIds: string[]): DeletePreview;
  deleteRuns(runIds: string[]): DeleteResult;
  claim(runId: string, nowMs: number, workerPid: number): WorkerClaim | null;
  heartbeat(claim: WorkerClaim, nowMs: number): boolean;
  reserveNext(claim: WorkerClaim, nowMs: number): AttemptReservation | null;
  settle(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome): void;
  finish(claim: WorkerClaim): RunStatusView;
  failLaunch(runId: string, code: string): void;
  failRun(claim: WorkerClaim, code: string, message: string): void;
  reconcile(runId: string, nowMs: number): RunStatusView;
  close(): void;
}

type DatabaseRow = Record<string, SQLOutputValue>;
type CursorPayload = { kind: 'runs'; createdMs: number; runId: string; status?: RunStatus; label?: string };
type AnswerCursorPayload = { kind: 'answers'; runId: string; ordinal: number };

function asText(value: SQLOutputValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new RunStoreError('data_integrity_error', `Stored ${label} is not text.`);
  return value;
}

function asNumber(value: SQLOutputValue | undefined, label: string): number {
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new RunStoreError('data_integrity_error', `Stored ${label} is not numeric.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RunStoreError('data_integrity_error', `Stored ${label} is outside the safe integer range.`);
  return number;
}

function parseJson<T>(value: SQLOutputValue | undefined, label: string): T {
  try { return JSON.parse(asText(value, label)) as T; }
  catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('data_integrity_error', `Stored ${label} is not valid JSON.`, { cause: error });
  }
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

function initialize(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  database.exec('BEGIN IMMEDIATE');
  try {
    const versionRow = database.prepare('PRAGMA user_version').get() as DatabaseRow | undefined;
    const version = asNumber(versionRow?.user_version, 'schema version');
    if (version === SCHEMA_VERSION) {
      database.exec('COMMIT');
      return;
    }
    if (version !== 0) throw new RunStoreError('unsupported_schema_version', `The Sheg database schema version ${version} is not supported. Export or reset this pre-v1 datastore before continuing.`);

    const existing = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as DatabaseRow | undefined;
    if (asNumber(existing?.count, 'table count') !== 0) {
      throw new RunStoreError('unsupported_schema_version', 'The datastore contains tables without a supported Sheg schema version. Export or reset this pre-v1 datastore before continuing.');
    }

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
      packet_json TEXT NOT NULL,
      packet_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'failed')),
      result_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, evaluation_id)
    );
    CREATE TABLE attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'answered', 'failed', 'uncertain')),
      started_ms INTEGER NOT NULL,
      settled_ms INTEGER,
      result_json TEXT,
      failure_code TEXT,
      failure_message TEXT,
      failure_scope TEXT CHECK (failure_scope IS NULL OR failure_scope IN ('evaluation', 'run')),
      FOREIGN KEY (run_id, evaluation_id) REFERENCES evaluations(run_id, evaluation_id) ON DELETE CASCADE
    );
    CREATE INDEX evaluations_run_ordinal ON evaluations(run_id, ordinal);
    CREATE INDEX runs_created_identity ON runs(created_ms, run_id);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the initialization error. */ }
    throw error;
  }
}

function validatePrepared(prepared: PreparedRun): PreparedRun {
  const parsedRequest = inlineRunRequestSchema.safeParse(prepared.request);
  if (!parsedRequest.success || prepared.compilerFingerprint.length === 0 ||
      hashCanonical({ request: parsedRequest.data, compilerFingerprint: prepared.compilerFingerprint }) !== prepared.requestFingerprint) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared run request or fingerprint is invalid.');
  }
  if (prepared.evaluations.length !== parsedRequest.data.respondents.length) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared run evaluations do not match the respondent count.');
  }
  const respondentIds = new Set(parsedRequest.data.respondents.map(({ id }) => id));
  const evaluationIds = new Set<string>();
  const contextIds = new Set<string>();
  const seenRespondents = new Set<string>();
  for (const evaluation of prepared.evaluations) {
    const packet = decisionRequestSchema.safeParse(evaluation.packet);
    if (!packet.success || !respondentIds.has(evaluation.respondentId) || seenRespondents.has(evaluation.respondentId) || evaluationIds.has(evaluation.evaluationId) || contextIds.has(evaluation.contextId) ||
        evaluation.questionId !== parsedRequest.data.questions[0].id || packet.data.question.id !== evaluation.questionId ||
        hashCanonical({ packet: packet.data, compilerFingerprint: prepared.compilerFingerprint }) !== evaluation.packetFingerprint) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared run evaluation or packet fingerprint is invalid.');
    }
    evaluationIds.add(evaluation.evaluationId);
    contextIds.add(evaluation.contextId);
    seenRespondents.add(evaluation.respondentId);
  }
  if (seenRespondents.size !== respondentIds.size) throw new RunStoreError('invalid_prepared_run', 'Every respondent must have exactly one prepared evaluation.');
  return { ...prepared, request: parsedRequest.data };
}

export function openRunStore(dataRoot: string, options: { now?: () => number } = {}): RunStore {
  if (!path.isAbsolute(dataRoot)) throw new RunStoreError('invalid_data_root', 'Sheg data directory must be an absolute path.');
  mkdirSync(dataRoot, { recursive: true });
  const database = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'), { timeout: 5_000, enableForeignKeyConstraints: true });
  try { initialize(database); }
  catch (error) { database.close(); throw error; }
  return new SQLiteRunStore(database, options.now ?? Date.now);
}

class SQLiteRunStore implements RunStore {
  private isClosed = false;

  constructor(private readonly database: DatabaseSync, private readonly now: () => number) {}

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

      const runId = randomUUID();
      const nowMs = this.now();
      const createdAt = new Date(nowMs).toISOString();
      this.database.prepare(`INSERT INTO runs
        (run_id, submission_id, request_fingerprint, created_at, created_ms, label, status, request_json, evaluation_count, max_calls)
        VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`)
        .run(runId, submissionId, prepared.requestFingerprint, createdAt, nowMs, prepared.request.label ?? null,
          JSON.stringify({ request: prepared.request, requestFingerprint: prepared.requestFingerprint, compilerFingerprint: prepared.compilerFingerprint }), prepared.evaluations.length, prepared.request.maxCalls);
      const insertEvaluation = this.database.prepare(`INSERT INTO evaluations
        (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, packet_json, packet_fingerprint, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
      for (const [ordinal, evaluation] of prepared.evaluations.entries()) {
        insertEvaluation.run(evaluation.evaluationId, runId, ordinal, evaluation.contextId, evaluation.respondentId,
          evaluation.questionId, JSON.stringify(evaluation.packet), evaluation.packetFingerprint);
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

  getRequest(runId: string): PreparedRun {
    this.getStatus(runId);
    const row = this.database.prepare('SELECT request_json, request_fingerprint FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
    if (!row) throw this.notFound();
    const stored = parseJson<unknown>(row.request_json, 'request');
    if (typeof stored !== 'object' || stored === null || !('request' in stored) || !('requestFingerprint' in stored) || !('compilerFingerprint' in stored)) {
      throw new RunStoreError('data_integrity_error', 'Stored run request has an invalid shape.');
    }
    const evaluations = this.database.prepare('SELECT * FROM evaluations WHERE run_id = ? ORDER BY ordinal').all(runId) as DatabaseRow[];
    const prepared = stored as Omit<PreparedRun, 'evaluations'>;
    const parsed = validatePrepared({ ...prepared, evaluations: evaluations.map((row) => ({
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
    return parsed;
  }

  list(query: RunListQuery): Page<RunStatusView> {
    this.ensureOpen();
    const limit = pageSize(query.limit);
    const nowMs = this.now();
    this.transaction(() => {
      const active = this.database.prepare("SELECT run_id FROM runs WHERE status IN ('prepared', 'running')").all() as DatabaseRow[];
      for (const row of active) this.reconcileInside(asText(row.run_id, 'run ID'), nowMs);
    });
    const filterKey = JSON.stringify({ ...(query.status === undefined ? {} : { status: query.status }), ...(query.label === undefined ? {} : { label: query.label }) });
    let cursor: CursorPayload | undefined;
    if (query.cursor) {
      cursor = decodeCursor<CursorPayload>(query.cursor, 'run list');
      if (cursor.kind !== 'runs' || !Number.isSafeInteger(cursor.createdMs) || cursor.createdMs < 0 || typeof cursor.runId !== 'string' || cursor.runId.length === 0 ||
          JSON.stringify({ ...(cursor.status === undefined ? {} : { status: cursor.status }), ...(cursor.label === undefined ? {} : { label: cursor.label }) }) !== filterKey) {
        throw new RunStoreError('invalid_cursor', 'The run list cursor does not match the requested filters.');
      }
    }
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.status !== undefined) { clauses.push('status = ?'); params.push(query.status); }
    if (query.label !== undefined) { clauses.push('label = ?'); params.push(query.label); }
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
      ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'runs', createdMs: asNumber(last.created_ms, 'created time'), runId: asText(last.run_id, 'run ID'), ...(query.status === undefined ? {} : { status: query.status }), ...(query.label === undefined ? {} : { label: query.label }) } satisfies CursorPayload) } : {}),
    };
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
    const rows = this.database.prepare(`SELECT * FROM evaluations WHERE run_id = ? ${cursor ? 'AND ordinal > ?' : ''} ORDER BY ordinal LIMIT ?`)
      .all(...(cursor ? [runId, cursor.ordinal, limit + 1] : [runId, limit + 1])) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row): AnswerRow => ({
      evaluationId: asText(row.evaluation_id, 'evaluation ID'),
      contextId: asText(row.context_id, 'context ID'),
      respondentId: asText(row.respondent_id, 'respondent ID'),
      questionId: asText(row.question_id, 'question ID'),
      status: asText(row.status, 'evaluation status') as AnswerRow['status'],
      ...(row.result_json === null ? {} : { result: parseJson(row.result_json, 'decision result') }),
      ...(row.failure_code === null ? {} : { failure: { code: asText(row.failure_code, 'failure code'), message: asText(row.failure_message, 'failure message') } }),
    }));
    const last = pageRows.at(-1);
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'answers', runId, ordinal: asNumber(last.ordinal, 'evaluation ordinal') } satisfies AnswerCursorPayload) } : {}) };
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
      const run = this.database.prepare('SELECT status, failure_scope, reserved_calls, cancel_requested, used_calls, max_calls FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
      if (!run) throw this.notFound();
      const status = asText(run.status, 'run status');
      if (status === 'prepared') return { started: false, run: this.statusInside(runId) };
      if (status !== 'interrupted' && status !== 'failed') {
        throw new RunStoreError('run_not_resumable', `A run in ${status} state cannot be resumed.`);
      }
      if (asNumber(run.cancel_requested, 'cancel flag') === 1) {
        throw new RunStoreError('run_not_resumable', 'A run with a cancellation request cannot be resumed.');
      }
      if (asNumber(run.reserved_calls, 'reserved calls') !== 0) {
        throw new RunStoreError('data_integrity_error', 'A run with an unresolved provider reservation cannot be resumed.');
      }
      if (asNumber(run.used_calls, 'used calls') >= asNumber(run.max_calls, 'maximum calls')) {
        throw new RunStoreError('run_not_resumable', 'This run has no remaining provider-call allowance.');
      }

      const pending = this.database.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND status = 'pending'").get(runId) as DatabaseRow;
      const runFailure = this.database.prepare("SELECT evaluation_id FROM attempts WHERE run_id = ? AND status = 'failed' AND failure_scope = 'run' ORDER BY started_ms DESC, attempt_id DESC LIMIT 1").get(runId) as DatabaseRow | undefined;
      const failedRunEvaluationId = runFailure ? asText(runFailure.evaluation_id, 'failed evaluation ID') : undefined;
      const failedEvaluation = failedRunEvaluationId
        ? this.database.prepare("SELECT status FROM evaluations WHERE run_id = ? AND evaluation_id = ?").get(runId, failedRunEvaluationId) as DatabaseRow | undefined
        : undefined;
      const canRetrySharedFailure = status === 'failed' && asText(run.failure_scope, 'failure scope') === 'run' &&
        failedEvaluation !== undefined && asText(failedEvaluation.status, 'evaluation status') === 'failed';
      const hasPending = asNumber(pending.count, 'pending count') > 0;
      const hasUnfinished = hasPending || canRetrySharedFailure;
      if (!hasUnfinished || (status === 'failed' && asText(run.failure_scope, 'failure scope') !== 'run')) {
        throw new RunStoreError('run_not_resumable', 'This run has no resumable unfinished work.');
      }
      if (canRetrySharedFailure && failedRunEvaluationId) {
        this.database.prepare("UPDATE evaluations SET status = 'pending', result_json = NULL, failure_code = NULL, failure_message = NULL WHERE run_id = ? AND evaluation_id = ? AND status = 'failed'")
          .run(runId, failedRunEvaluationId);
      }
      this.database.prepare(`UPDATE runs SET status = 'prepared', failure_scope = NULL, failure_code = NULL,
        failure_message = NULL, lease_expires_ms = ?, owner_token = NULL, owner_pid = NULL
        WHERE run_id = ? AND status IN ('interrupted', 'failed')`)
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
        this.reconcileInside(runId, nowMs);
        const status = asText((this.database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined)?.status, 'run status') as RunStatus;
        const evaluationCount = asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ?').get(runId) as DatabaseRow).count, 'evaluation count');
        const attemptCount = asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(runId) as DatabaseRow).count, 'attempt count');
        return { runId, status, evaluationCount, attemptCount, blockedByActiveWork: status === 'prepared' || status === 'running' };
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
    this.database.exec('PRAGMA optimize');
    return result;
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
      this.database.prepare("INSERT INTO attempts (attempt_id, run_id, evaluation_id, owner_token, status, started_ms) VALUES (?, ?, ?, ?, 'reserved', ?)")
        .run(attemptId, claim.runId, evaluationId, claim.ownerToken, nowMs);
      this.database.prepare('UPDATE runs SET reserved_calls = reserved_calls + 1 WHERE run_id = ?').run(claim.runId);
      return { attemptId, evaluation: this.evaluationFromRow(row) };
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
        this.database.prepare("UPDATE attempts SET status = 'answered', settled_ms = ?, result_json = ? WHERE attempt_id = ?")
          .run(nowMs, JSON.stringify(result), attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'answered', result_json = ?, failure_code = NULL, failure_message = NULL WHERE evaluation_id = ?")
          .run(JSON.stringify(result), evaluationId);
      } else {
        this.database.prepare("UPDATE attempts SET status = 'failed', settled_ms = ?, failure_code = ?, failure_message = ?, failure_scope = ? WHERE attempt_id = ?")
          .run(nowMs, outcome.code, outcome.message, outcome.scope, attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ? WHERE evaluation_id = ?")
          .run(outcome.code, outcome.message, evaluationId);
        if (outcome.scope === 'run') {
          this.database.prepare('UPDATE runs SET failure_scope = ?, failure_code = ?, failure_message = ? WHERE run_id = ?')
            .run(outcome.scope, outcome.code, outcome.message, claim.runId);
        }
      }
      this.database.prepare('UPDATE runs SET used_calls = used_calls + 1, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0').run(claim.runId);
    });
  }

  finish(claim: WorkerClaim): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      const run = this.ownedRun(claim, this.now());
      if (asNumber(run.reserved_calls, 'reserved calls') !== 0) {
        throw new RunStoreError('attempt_in_flight', 'A run cannot finish while a provider attempt is still reserved.');
      }
      let status: RunStatus;
      if (run.failure_scope === 'run') status = 'failed';
      else if (asNumber(run.cancel_requested, 'cancel flag') === 1) status = 'cancelled';
      else {
        const counts = this.database.prepare(`SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
          FROM evaluations WHERE run_id = ?`).get(claim.runId) as DatabaseRow;
        status = asNumber(counts.pending, 'pending count') === 0 && asNumber(counts.failed, 'failed count') === 0 ? 'completed' : 'partial';
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

  private notFound(): RunStoreError { return new RunStoreError('run_not_found', 'The requested run does not exist in this datastore.'); }

  private statusInside(runId: string): RunStatusView {
    const row = this.database.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'answered') AS completed_evaluations,
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'failed') AS failed_evaluations
      FROM runs r WHERE r.run_id = ?`).get(runId) as DatabaseRow | undefined;
    if (!row) throw this.notFound();
    return {
      runId: asText(row.run_id, 'run ID'),
      status: asText(row.status, 'run status') as RunStatus,
      createdAt: asText(row.created_at, 'created time'),
      completedEvaluations: asNumber(row.completed_evaluations, 'completed evaluation count'),
      failedEvaluations: asNumber(row.failed_evaluations, 'failed evaluation count'),
      totalEvaluations: asNumber(row.evaluation_count, 'evaluation count'),
      usedCalls: asNumber(row.used_calls, 'used calls'),
      reservedCalls: asNumber(row.reserved_calls, 'reserved calls'),
      maxCalls: asNumber(row.max_calls, 'maximum calls'),
      cancelRequested: asNumber(row.cancel_requested, 'cancel flag') === 1,
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
