import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { decisionRequestSchema } from '../domain/decision/decision.js';
import type { JourneyDefinition } from '../domain/study/arm.js';
import { evaluationStatusSchema, resumeRefusalMessage, type AttemptReservation, type AnswerRow, type JourneyRunRecord, type JourneyWorkerTurn, type Page, type RunAttempt, type RunContextDetail, type RunEvidencePage, type RunEvidenceQuery, type RunStatus, type RunStatusView, type WorkerClaim } from '../domain/run/lifecycle.js';
import type { DecisionBatchResult } from '../domain/decision/decision.js';
import { runRequestSchema, type FollowOnSourceSet, type FrozenEvaluation, type ParsedFollowOnRunRequest, type PreparedJourneyRun, type PreparedRun } from '../domain/run/request.js';
import { hashCanonical } from './identity.js';
import { journeyTopology, journeyTransitionForResponse } from '../domain/journey/topology.js';
import { asNumber, asText, parseJson, parseJsonRecord, parseStored, type DatabaseRow } from './sqlite/rows.js';
import { decodeCursor, encodeCursor, pageSize } from './sqlite/cursors.js';
import { loadAttempts } from './sqlite/attempt-queries.js';
import { loadRunDeletionSnapshot, type RunDeletionSnapshot } from './sqlite/run-deletion-queries.js';
import { queryEvidencePage } from './sqlite/evidence-query.js';
import { findRunBySubmission, loadEvaluationStatuses, runExists } from './sqlite/run-identity-queries.js';
import { loadJourneyWorkerTurn } from './sqlite/journey-queries.js';
import { loadFollowOnSources } from './sqlite/follow-on-queries.js';
import { claimPreparedRun, failOwnedRun, failPreparedLaunch, finishRun, refreshWorkerLease, requestRunCancellation } from './sqlite/commands/lifecycle.js';
import { reservePhysicalAttempt } from './sqlite/commands/reservation.js';
import { chargeReservedAttempt, markAttemptUncertain, settlePollBatch, settleSingleAttempt } from './sqlite/commands/settlement.js';
import { settleJourneyTurn } from './sqlite/commands/journey-transition.js';
import { deleteRunSelection, markActiveJourneyRespondentsUnreached, markPendingEvaluationsUnreached, prepareResumedRun, reopenFailedQuestions, reopenJourneyEvaluation, reopenSharedFailure, restoreFailedJourneyRespondent } from './sqlite/commands/recovery.js';
import { acceptPreparedJourney, acceptPreparedRun } from './sqlite/commands/acceptance.js';
import { validatePrepared } from './sqlite/commands/prepared-validation.js';
import { reconcileRun, reconcileSelectedRuns } from './sqlite/commands/reconciliation.js';
import { decodeResultAndExecution, storedEvaluationFailure } from './sqlite/evidence-records.js';
import { openSqliteConnection, readTransaction, writeTransaction, type SqliteConnection } from './sqlite/connection.js';
import { SCHEMA_VERSION } from './sqlite/schema.js';
import { PREPARED_LAUNCH_WINDOW_MS, RECONCILE_SELECTION_LIMIT, WORKER_LEASE_DURATION_MS } from './sqlite/work-policy.js';
import { RunStoreError } from '../application/run-store.js';
import type { AttemptOutcome, DeletePreview, DeleteResult, JourneyTransition, RunCommandRepository, RunListQuery, RunPersistence, RunReadRepository, RunStore, StorageInfo } from '../application/run-store.js';
export { SCHEMA_VERSION } from './sqlite/schema.js';
export type { AttemptOutcome, DeletePreview, DeleteResult, JourneyTransition, RunListQuery, RunPersistence, RunReadRepository, RunCommandRepository, RunStore, StorageInfo } from '../application/run-store.js';
export { RunStoreError } from '../application/run-store.js';
export { inspectRunStoreCompatibility, runStoreBackupAvailable, type StoreCompatibility } from './sqlite/recovery.js';
import { resetRunStore as resetRunStoreInternal } from './sqlite/recovery.js';
import { readStatusViews } from './sqlite/reads/status.js';
import { readPreparedRun, readRunKind } from './sqlite/reads/requests.js';
import { readJourneyRun } from './sqlite/reads/journeys.js';
import { readRunContext } from './sqlite/reads/contexts.js';

function sameDecisionValue(left: import('../domain/decision/decision.js').DecisionValue, right: import('../domain/decision/decision.js').DecisionValue): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'choice' && right.type === 'choice') return left.choice === right.choice && hashCanonical(left.probabilities ?? null) === hashCanonical(right.probabilities ?? null) && left.confidence === right.confidence;
  if (left.type === 'score' && right.type === 'score') return left.score === right.score && hashCanonical(left.probabilities) === hashCanonical(right.probabilities) && hashCanonical(left.legend) === hashCanonical(right.legend) && left.confidence === right.confidence;
  return left.type === 'noul' && right.type === 'noul' && left.noul === right.noul;
}

function isJourneyAskNode(journey: JourneyDefinition, nodeId: string, questionId: string): boolean {
  const node = journeyTopology(journey).nodes.find((candidate) => candidate.id === nodeId);
  return node?.kind === 'ask' && node.taskId === questionId;
}

function journeyRouteTarget(journey: JourneyDefinition, nodeId: string, response: import('../domain/decision/decision.js').DecisionValue): string | undefined {
  return journeyTransitionForResponse(journeyTopology(journey), nodeId, response)?.toNodeId;
}

type CursorPayload = { kind: 'runs'; createdMs: number; runId: string; filtersFingerprint: string };
type AnswerCursorPayload = { kind: 'answers'; runId: string; ordinal: number };
const runCursorSchema = z.object({ kind: z.literal('runs'), createdMs: z.number().int().nonnegative(), runId: z.string().min(1), filtersFingerprint: z.string() }).strict();
const answerCursorSchema = z.object({ kind: z.literal('answers'), runId: z.string().min(1), ordinal: z.number().int().nonnegative() }).strict();

function validateRunIds(runIds: string[]): void {
  if (!Array.isArray(runIds) || runIds.length < 1 || runIds.length > 200 || runIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(runIds).size !== runIds.length) {
    throw new RunStoreError('invalid_run_selection', 'Select between 1 and 200 unique run IDs.');
  }
}


export function openRunStore(dataRoot: string, options: { now?: () => number } = {}): RunStore {
  if (!path.isAbsolute(dataRoot)) throw new RunStoreError('invalid_data_root', 'Sheg data directory must be an absolute path.');
  mkdirSync(dataRoot, { recursive: true });
  const connection = openSqliteConnection(path.join(dataRoot, 'runs.sqlite'), dataRoot);
  return new SQLiteRunStore(connection, path.join(dataRoot, 'runs.sqlite'), options.now ?? Date.now);
}

export function openRunPersistence(dataRoot: string, options: { now?: () => number } = {}): RunPersistence {
  return splitRunStore(openRunStore(dataRoot, options));
}

export function splitRunStore(store: RunStore): RunPersistence {
  const reads: RunReadRepository = {
    findSubmission: store.findSubmission.bind(store), getStatus: store.getStatus.bind(store),
    evaluationStatuses: store.evaluationStatuses.bind(store), getRequestKind: store.getRequestKind.bind(store),
    getRequest: store.getRequest.bind(store), getJourneyRun: store.getJourneyRun.bind(store),
    getJourneyWorkerTurn: store.getJourneyWorkerTurn.bind(store), list: store.list.bind(store),
    queryEvidence: store.queryEvidence.bind(store), getContext: store.getContext.bind(store),
    resolveFollowOnSources: store.resolveFollowOnSources.bind(store), answers: store.answers.bind(store),
    attempts: store.attempts.bind(store), previewDelete: store.previewDelete.bind(store),
    storageInfo: store.storageInfo.bind(store), close: store.close.bind(store),
  };
  const commands: RunCommandRepository = {
    accept: store.accept.bind(store), acceptJourney: store.acceptJourney.bind(store),
    requestCancel: store.requestCancel.bind(store), resume: store.resume.bind(store),
    deleteRuns: store.deleteRuns.bind(store), optimizeStorage: store.optimizeStorage.bind(store),
    claim: store.claim.bind(store), heartbeat: store.heartbeat.bind(store), reserveNext: store.reserveNext.bind(store),
    reserveBatch: store.reserveBatch.bind(store), settleBatch: store.settleBatch.bind(store),
    settle: store.settle.bind(store), settleJourney: store.settleJourney.bind(store), finish: store.finish.bind(store),
    failLaunch: store.failLaunch.bind(store), failRun: store.failRun.bind(store),
    reconcile: store.reconcile.bind(store), reconcileMany: store.reconcileMany.bind(store), reconcileActive: store.reconcileActive.bind(store),
  };
  return { reads, commands, close: store.close.bind(store) };
}

class SQLiteRunStore implements RunStore {
  private isClosed = false;
  private readonly database: DatabaseSync;

  constructor(private readonly connection: SqliteConnection, private readonly databasePath: string, private readonly now: () => number) {
    this.database = connection.client;
  }

  findSubmission(submissionId: string, requestFingerprint: string): RunStatusView | null {
    this.ensureOpen();
    return this.readTransaction(() => {
      const row = findRunBySubmission(this.connection.orm, submissionId);
      if (!row) return null;
      if (row.requestFingerprint !== requestFingerprint) {
        throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
      }
      return this.statusInside(row.runId);
    });
  }

  accept(submissionId: string, preparedInput: PreparedRun): { created: boolean; run: RunStatusView } {
    this.ensureOpen();
    return acceptPreparedRun(this.acceptanceContext(), submissionId, preparedInput);
  }

  acceptJourney(submissionId: string, preparedInput: PreparedJourneyRun): { created: boolean; run: RunStatusView } {
    this.ensureOpen();
    return acceptPreparedJourney(this.acceptanceContext(), submissionId, preparedInput);
  }

  getStatus(runId: string): RunStatusView {
    this.ensureOpen();
    return this.readTransaction(() => this.statusInside(runId));
  }

  evaluationStatuses(runId: string): Array<{ evaluationId: string; status: AnswerRow['status'] }> {
    this.ensureOpen();
    return this.readTransaction(() => {
      if (!runExists(this.connection.orm, runId)) throw this.notFound();
      return loadEvaluationStatuses(this.connection.orm, runId).map((row) => ({
        evaluationId: row.evaluationId,
        status: parseStored(evaluationStatusSchema, row.status, 'evaluation status'),
      }));
    });
  }

  getRequestKind(runId: string): 'poll' | 'journey' | 'follow-on' {
    this.ensureOpen();
    return this.readTransaction(() => readRunKind(this.connection.orm, runId, () => this.notFound()));
  }

  getRequest(runId: string): PreparedRun {
    this.ensureOpen();
    return this.readTransaction(() => readPreparedRun(this.connection.orm, runId, {
      notFound: () => this.notFound(), validate: validatePrepared,
      isRunAvailable: (sourceRunId) => runExists(this.connection.orm, sourceRunId),
    }));
  }

  getJourneyWorkerTurn(runId: string, evaluationId: string, respondentId: string): JourneyWorkerTurn {
    this.ensureOpen();
    return this.readTransaction(() => loadJourneyWorkerTurn(this.database, runId, evaluationId, respondentId));
  }

  getJourneyRun(runId: string): JourneyRunRecord {
    this.ensureOpen();
    return this.readTransaction(() => readJourneyRun(this.database, runId, () => this.notFound()));
  }

  list(query: RunListQuery): Page<RunStatusView> {
    this.ensureOpen();
    return this.readTransaction(() => {
    const limit = pageSize(query.limit);
    const filtersFingerprint = hashCanonical({ status: query.status ?? null, label: query.label ?? null, createdAfter: query.createdAfter ?? null, createdBefore: query.createdBefore ?? null, materialId: query.materialId ?? null });
    let cursor: CursorPayload | undefined;
    if (query.cursor) {
      cursor = decodeCursor(query.cursor, 'run list', runCursorSchema);
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
    const items = this.statusesInside(pageRows.map((row) => asText(row.run_id, 'run ID')));
    const last = pageRows.at(-1);
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'runs', createdMs: asNumber(last.created_ms, 'created time'), runId: asText(last.run_id, 'run ID'), filtersFingerprint } satisfies CursorPayload) } : {}),
    };
    });
  }

  resolveFollowOnSources(input: ParsedFollowOnRunRequest): FollowOnSourceSet {
    this.ensureOpen();
    return this.readTransaction(() => loadFollowOnSources(this.database, input, () => this.notFound()));
  }

  queryEvidence(input: RunEvidenceQuery): RunEvidencePage {
    return queryEvidencePage({
      database: this.database,
      now: this.now,
      ensureOpen: () => this.ensureOpen(),
      readTransaction: (operation) => this.readTransaction(operation),
      statusInside: (runId) => this.statusInside(runId),
      notFound: () => this.notFound(),
    }, input);
  }

  getContext(runId: string, evaluationId: string, contextId: string): RunContextDetail {
    this.ensureOpen();
    return this.readTransaction(() => readRunContext(this.database, runId, evaluationId, contextId));
  }

  answers(runId: string, cursorText?: string, requestedLimit?: number): Page<AnswerRow> {
    this.ensureOpen();
    return this.readTransaction(() => {
    if (!runExists(this.connection.orm, runId)) throw this.notFound();
    const limit = pageSize(requestedLimit);
    let cursor: AnswerCursorPayload | undefined;
    if (cursorText) {
      cursor = decodeCursor(cursorText, 'answer', answerCursorSchema);
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
      const decoded = row.result_json === null ? undefined : decodeResultAndExecution(parseJson(row.result_json, 'decision result'), parseJson(row.execution_json, 'provider execution'));
      return {
        evaluationId: asText(row.evaluation_id, 'evaluation ID'),
        contextId: asText(row.context_id, 'context ID'),
        respondentId: asText(row.respondent_id, 'respondent ID'),
        questionId: asText(row.question_id, 'question ID'),
        status: parseStored(evaluationStatusSchema, asText(row.status, 'evaluation status'), 'evaluation status'),
        ...(decoded === undefined ? {} : { result: decoded.result, execution: decoded.execution }),
        ...(failure === undefined ? {} : { failure }),
      };
    });
    const last = pageRows.at(-1);
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'answers', runId, ordinal: asNumber(last.ordinal, 'evaluation ordinal') } satisfies AnswerCursorPayload) } : {}) };
    });
  }

  attempts(runId: string, cursorText?: string, requestedLimit?: number): Page<RunAttempt> {
    this.ensureOpen();
    return this.readTransaction(() => loadAttempts(this.connection.orm, runId, cursorText, requestedLimit, () => {
      if (!runExists(this.connection.orm, runId)) throw this.notFound();
    }));
  }

  requestCancel(runId: string): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      const row = this.database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
      if (!row) throw this.notFound();
      const status = asText(row.status, 'run status');
      requestRunCancellation(this.connection.orm, runId, status);
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
      const storedRequest = parseJsonRecord(run.request_json, 'run request');
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
        reopenSharedFailure(this.connection.orm, runId, asText(runFailure.attempt_id, 'failed attempt ID'));
      }
      if (canRetryQuestionFailures) reopenFailedQuestions(this.connection.orm, runId);
      for (const checkpoint of journeyFailures) {
        const evaluationId = asText(checkpoint.evaluation_id, 'failed evaluation ID');
        const respondentId = asText(checkpoint.respondent_id, 'failed respondent ID');
        const reopened = reopenJourneyEvaluation(this.connection.orm, runId, evaluationId, respondentId);
        const restored = restoreFailedJourneyRespondent(this.connection.orm, runId, respondentId,
          asText(checkpoint.node_id, 'failed turn node ID'), asText(checkpoint.turn_id, 'failed turn ID'),
          asText(checkpoint.context_id, 'failed turn context ID'));
        if (!reopened || !restored) {
          throw new RunStoreError('data_integrity_error', 'The saved failed journey checkpoint changed during resume.');
        }
      }
      prepareResumedRun(this.connection.orm, runId, nowMs + PREPARED_LAUNCH_WINDOW_MS);
      return { started: true, run: this.statusInside(runId) };
    });
  }

  previewDelete(runIds: string[]): DeletePreview {
    this.ensureOpen();
    validateRunIds(runIds);
    return this.readTransaction(() => {
      const snapshot = loadRunDeletionSnapshot(this.connection.orm, runIds);
      if (snapshot.runs.length !== runIds.length) throw this.notFound();
      const nowMs = this.now();
      const selected = new Set(runIds);
      const runs = runIds.map((runId) => {
        const row = snapshot.runs.find((candidate) => candidate.runId === runId)!;
        const status = deletePreviewStatus(row, nowMs);
        return {
          runId,
          status,
          evaluationCount: snapshot.evaluationCounts.get(runId) ?? 0,
          attemptCount: snapshot.attemptCounts.get(runId) ?? 0,
          blockedByActiveWork: status === 'prepared' || status === 'running',
          retainedFollowOnRunIds: (snapshot.dependentRunIds.get(runId) ?? []).filter((dependentId) => !selected.has(dependentId)),
        };
      });
      return { runs, blockedByActiveWork: runs.some(({ blockedByActiveWork }) => blockedByActiveWork) };
    });
  }

  deleteRuns(runIds: string[]): DeleteResult {
    this.ensureOpen();
    validateRunIds(runIds);
    return deleteRunSelection({
      database: this.database,
      orm: this.connection.orm,
      transaction: <T>(operation: () => T) => this.transaction(operation),
      now: this.now,
      reconcile: (snapshot, nowMs) => reconcileSelectedRuns(this.connection.orm, snapshot, nowMs),
      notFound: () => this.notFound(),
      optimize: () => this.optimizeStorage(),
    }, runIds);
  }

  storageInfo(): StorageInfo {
    this.ensureOpen();
    try {
      return this.readTransaction(() => {
        const integrityRows = this.database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
        const foreignKeyViolations = this.database.prepare('PRAGMA foreign_key_check').all() as DatabaseRow[];
        const integrity = integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyViolations.length === 0 ? 'ok' : 'failed';
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
      const launchDeadline = row.lease_expires_ms === null ? asNumber(row.created_ms, 'created time') + PREPARED_LAUNCH_WINDOW_MS : asNumber(row.lease_expires_ms, 'launch deadline');
      if (asText(row.status, 'run status') !== 'prepared' || asNumber(row.cancel_requested, 'cancel flag') === 1 || nowMs >= launchDeadline) return null;
      const ownerToken = randomUUID();
      if (!claimPreparedRun(this.connection.orm, runId, ownerToken, workerPid, nowMs + WORKER_LEASE_DURATION_MS)) return null;
      return { runId, ownerToken };
    });
  }

  heartbeat(claim: WorkerClaim, nowMs: number): boolean {
    this.ensureOpen();
    return this.transaction(() => refreshWorkerLease(this.connection.orm, claim, nowMs, WORKER_LEASE_DURATION_MS));
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
      reservePhysicalAttempt(this.connection.orm, {
        attemptId, runId: claim.runId, groupId: asText(row.group_id, 'group ID'), anchorEvaluationId: evaluationId,
        packetFingerprint: asText(row.packet_fingerprint, 'packet fingerprint'), ownerToken: claim.ownerToken,
        startedMs: nowMs, evaluationIds: [evaluationId],
      });
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
      const orderedIds = parseStored(z.array(z.string().min(1)), parseJson(group.question_ids_json, 'group question IDs'), 'group question IDs');
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
      reservePhysicalAttempt(this.connection.orm, {
        attemptId, runId: claim.runId, groupId, anchorEvaluationId: anchorId, packetFingerprint,
        ownerToken: claim.ownerToken, startedMs: nowMs,
        evaluationIds: sorted.map((row) => asText(row.evaluation_id, 'evaluation ID')),
      });
      return { attemptId, evaluations: sorted.map((row) => this.evaluationFromRow(row)) };
    });
  }

  settleBatch(claim: WorkerClaim, attemptId: string, outcome: { kind: 'answered'; result: DecisionBatchResult } | Extract<AttemptOutcome, { kind: 'failed' }>): Array<{ evaluationId: string; status: AnswerRow['status'] }> {
    this.ensureOpen();
    return this.transaction(() => settlePollBatch({ database: this.database, orm: this.connection.orm, now: this.now, ownedRun: (owner, nowMs) => this.ownedRun(owner, nowMs) }, claim, attemptId, outcome));
  }
  settle(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome): void {
    this.ensureOpen();
    this.transaction(() => settleSingleAttempt({ database: this.database, orm: this.connection.orm, now: this.now, ownedRun: (owner, nowMs) => this.ownedRun(owner, nowMs) }, claim, attemptId, outcome));
  }

  settleJourney(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome, transition: JourneyTransition): void {
    this.ensureOpen();
    this.transaction(() => settleJourneyTurn({ database: this.database, orm: this.connection.orm, now: this.now, ownedRun: (owner, nowMs) => this.ownedRun(owner, nowMs), sameDecisionValue, journeyRouteTarget, isJourneyAskNode }, claim, attemptId, outcome, transition));
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
          markPendingEvaluationsUnreached(this.connection.orm, claim.runId);
          markActiveJourneyRespondentsUnreached(this.connection.orm, claim.runId);
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
      finishRun(this.connection.orm, claim.runId, status);
      return this.statusInside(claim.runId);
    });
  }

  failLaunch(runId: string, code: string): void {
    this.ensureOpen();
    this.transaction(() => {
      if (!failPreparedLaunch(this.connection.orm, runId, code)) this.statusInside(runId);
    });
  }

  failRun(claim: WorkerClaim, code: string, message: string): void {
    this.ensureOpen();
    this.transaction(() => {
      this.ownedRun(claim, this.now());
      const reserved = this.database.prepare("SELECT attempt_id FROM attempts WHERE run_id = ? AND owner_token = ? AND status = 'reserved'").get(claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (reserved) {
        markAttemptUncertain(this.connection.orm, asText(reserved.attempt_id, 'attempt ID'), this.now(), 'The provider outcome could not be confirmed');
        if (!chargeReservedAttempt(this.connection.orm, claim.runId, 1)) {
          throw new RunStoreError('data_integrity_error', 'The run has no reserved physical call to account for.');
        }
      }
      if (!failOwnedRun(this.connection.orm, claim.runId, claim.ownerToken, code, message)) {
        throw new RunStoreError('worker_ownership_lost', 'This worker no longer owns the run.');
      }
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
    this.connection.close();
    this.isClosed = true;
  }

  private ensureOpen(): void {
    if (this.isClosed) throw new RunStoreError('store_closed', 'This run store connection is closed.');
    const version = (this.database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version;
    if (asNumber(version, 'schema version') !== SCHEMA_VERSION) {
      throw new RunStoreError('datastore_schema_changed', 'The datastore schema changed while this process was open. Close and reopen Sheg before continuing.');
    }
  }

  reconcileMany(runIds: string[], nowMs: number): void {
    this.ensureOpen();
    const uniqueRunIds = [...new Set(runIds)];
    this.transaction(() => {
      for (const runId of uniqueRunIds) this.reconcileInside(runId, nowMs);
    });
  }

  reconcileActive(nowMs: number): void {
    this.ensureOpen();
    this.transaction(() => {
      while (true) {
        const active = this.database.prepare(`SELECT run_id FROM runs WHERE
          (status = 'prepared' AND COALESCE(lease_expires_ms, created_ms + ?) <= ?) OR
          (status = 'running' AND lease_expires_ms <= ?)
          ORDER BY COALESCE(lease_expires_ms, created_ms), run_id LIMIT ?`)
          .all(PREPARED_LAUNCH_WINDOW_MS, nowMs, nowMs, RECONCILE_SELECTION_LIMIT) as DatabaseRow[];
        if (!active.length) break;
        for (const row of active) this.reconcileInside(asText(row.run_id, 'run ID'), nowMs);
      }
    });
  }

  private transaction<T>(operation: () => T): T {
    return writeTransaction(this.database, operation);
  }

  private acceptanceContext() {
    return {
      database: this.database,
      orm: this.connection.orm,
      now: this.now,
      transaction: <T>(operation: () => T) => this.transaction(operation),
      statusInside: (runId: string) => this.statusInside(runId),
      reconcileInside: (runId: string, nowMs: number) => this.reconcileInside(runId, nowMs),
      notFound: () => this.notFound(),
    };
  }

  private readTransaction<T>(operation: () => T): T {
    return readTransaction(this.database, operation);
  }

  private notFound(): never { throw new RunStoreError('run_not_found', 'The requested run does not exist in this datastore.'); }

  private statusInside(runId: string): RunStatusView {
    const result = this.statusesInside([runId])[0];
    if (!result) throw this.notFound();
    return result;
  }

  private statusesInside(runIds: string[]): RunStatusView[] {
    return readStatusViews(this.database, runIds);
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
    reconcileRun(this.database, this.connection.orm, runId, nowMs, () => this.notFound());
  }

}

function deletePreviewStatus(run: RunDeletionSnapshot['runs'][number], nowMs: number): RunStatus {
  const status = asText(run.status, 'run status') as RunStatus;
  const leaseExpires = run.leaseExpiresMs ?? run.createdMs + PREPARED_LAUNCH_WINDOW_MS;
  const expired = status === 'prepared' && leaseExpires <= nowMs ||
    status === 'running' && run.leaseExpiresMs !== null && leaseExpires <= nowMs;
  return expired ? 'interrupted' : status;
}

export function resetRunStore(dataRoot: string): ReturnType<typeof import('./sqlite/recovery.js').resetRunStore> {
  return resetRunStoreInternal(dataRoot, () => {
    const store = openRunStore(dataRoot);
    store.close();
  });
}
