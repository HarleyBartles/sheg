import { statSync } from 'node:fs';
import { z } from 'zod';
import { evaluationStatusSchema, type AnswerRow, type RunStatus } from '../../domain/run/lifecycle.js';
import type { FollowOnSourceSet, ParsedFollowOnRunRequest } from '../../domain/run/request.js';
import type { RunReadRepository } from '../../application/run-store.js';
import { RunStoreError } from '../../application/run-store.js';
import { hashCanonical } from '../identity.js';
import { asNumber, asText, parseJson, parseStored, type DatabaseRow } from './rows.js';
import { decodeCursor, encodeCursor, pageSize } from './cursors.js';
import { loadAttempts } from './attempt-queries.js';
import { loadRunDeletionSnapshot } from './run-deletion-queries.js';
import { queryEvidencePage } from './evidence-query.js';
import { findRunBySubmission, loadEvaluationStatuses, runExists } from './run-identity-queries.js';
import { loadJourneyWorkerTurn } from './journey-queries.js';
import { loadFollowOnSources } from './follow-on-queries.js';
import { readPreparedRun, readRunKind } from './reads/requests.js';
import { readJourneyRun } from './reads/journeys.js';
import { readRunContext } from './reads/contexts.js';
import { decodeResultAndExecution, storedEvaluationFailure } from './evidence-records.js';
import type { SqliteRepositoryContext } from './repository-context.js';
import { PREPARED_LAUNCH_WINDOW_MS } from './work-policy.js';
import { validateRunIds } from './run-ids.js';
import { validatePrepared } from './commands/prepared-validation.js';

type CursorPayload = { kind: 'runs'; createdMs: number; runId: string; filtersFingerprint: string };
type AnswerCursorPayload = { kind: 'answers'; runId: string; ordinal: number };
const runCursorSchema = z.object({ kind: z.literal('runs'), createdMs: z.number().int().nonnegative(), runId: z.string().min(1), filtersFingerprint: z.string() }).strict();
const answerCursorSchema = z.object({ kind: z.literal('answers'), runId: z.string().min(1), ordinal: z.number().int().nonnegative() }).strict();

export function createSqliteReadRepository(context: SqliteRepositoryContext): RunReadRepository {
  return {
    findSubmission(submissionId, requestFingerprint) {
      context.ensureOpen();
      return context.readSnapshot(() => {
        const row = findRunBySubmission(context.connection.orm, submissionId);
        if (!row) return null;
        if (row.requestFingerprint !== requestFingerprint) {
          throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
        }
        return context.statusInside(row.runId);
      });
    },

    getStatus(runId) {
      context.ensureOpen();
      return context.readSnapshot(() => context.statusInside(runId));
    },

    evaluationStatuses(runId) {
      context.ensureOpen();
      return context.readSnapshot(() => {
        if (!runExists(context.connection.orm, runId)) throw context.notFound();
        return loadEvaluationStatuses(context.connection.orm, runId).map((row) => ({
          evaluationId: row.evaluationId,
          status: parseStored(evaluationStatusSchema, row.status, 'evaluation status'),
        }));
      });
    },

    getRequestKind(runId) {
      context.ensureOpen();
      return context.readSnapshot(() => readRunKind(context.connection.orm, runId, context.notFound));
    },

    getRequest(runId) {
      context.ensureOpen();
      return context.readSnapshot(() => readPreparedRun(context.connection.orm, runId, {
        notFound: context.notFound,
        validate: validatePrepared,
        isRunAvailable: (sourceRunId) => runExists(context.connection.orm, sourceRunId),
      }));
    },

    getJourneyWorkerTurn(runId, evaluationId, respondentId) {
      context.ensureOpen();
      return context.readSnapshot(() => loadJourneyWorkerTurn(context.database, runId, evaluationId, respondentId));
    },

    getJourneyRun(runId) {
      context.ensureOpen();
      return context.readSnapshot(() => readJourneyRun(context.database, runId, context.notFound));
    },

    list(query) {
      context.ensureOpen();
      return context.readSnapshot(() => {
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
        const parameters: Array<string | number> = [];
        if (query.status !== undefined) { clauses.push('status = ?'); parameters.push(query.status); }
        if (query.label !== undefined) { clauses.push('label = ?'); parameters.push(query.label); }
        if (query.createdAfter !== undefined) { clauses.push('created_ms >= ?'); parameters.push(Date.parse(query.createdAfter)); }
        if (query.createdBefore !== undefined) { clauses.push('created_ms <= ?'); parameters.push(Date.parse(query.createdBefore)); }
        if (query.materialId !== undefined) {
          clauses.push(`(EXISTS (SELECT 1 FROM json_each(CASE WHEN json_extract(runs.request_json, '$.request.kind') = 'poll'
            THEN json_extract(runs.request_json, '$.request.material') WHEN json_extract(runs.request_json, '$.request.kind') = 'journey'
            THEN json_extract(runs.request_json, '$.request.journey.items') ELSE json_extract(runs.request_json, '$.request.material') END) AS source_material
            WHERE json_extract(source_material.value, '$.id') = ?) OR EXISTS (SELECT 1 FROM evaluations AS material_evaluation, json_each(material_evaluation.packet_json, '$.state.encounteredItems') AS encountered
            WHERE material_evaluation.run_id = runs.run_id AND json_extract(encountered.value, '$.id') = ?) OR EXISTS (
            SELECT 1 FROM json_each(runs.request_json, '$.lineage.materialSnapshots') AS retained_snapshot,
              json_each(retained_snapshot.value, '$.materials') AS retained_material
            WHERE json_extract(retained_material.value, '$.id') = ?))`);
          parameters.push(query.materialId, query.materialId, query.materialId);
        }
        if (cursor) {
          clauses.push('(created_ms > ? OR (created_ms = ? AND run_id > ?))');
          parameters.push(cursor.createdMs, cursor.createdMs, cursor.runId);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = context.database.prepare(`SELECT run_id, created_ms FROM runs ${where} ORDER BY created_ms, run_id LIMIT ?`).all(...parameters, limit + 1) as DatabaseRow[];
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        const items = context.statusesInside(pageRows.map((row) => asText(row.run_id, 'run ID')));
        const last = pageRows.at(-1);
        return {
          items,
          ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'runs', createdMs: asNumber(last.created_ms, 'created time'), runId: asText(last.run_id, 'run ID'), filtersFingerprint } satisfies CursorPayload) } : {}),
        };
      });
    },

    queryEvidence(input) {
      context.ensureOpen();
      return queryEvidencePage({
        database: context.database,
        now: context.now,
        ensureOpen: context.ensureOpen,
        readTransaction: context.readSnapshot,
        statusInside: context.statusInside,
        notFound: context.notFound,
      }, input);
    },

    getContext(runId, evaluationId, contextId) {
      context.ensureOpen();
      return context.readSnapshot(() => readRunContext(context.database, runId, evaluationId, contextId));
    },

    resolveFollowOnSources(input: ParsedFollowOnRunRequest): FollowOnSourceSet {
      context.ensureOpen();
      return context.readSnapshot(() => loadFollowOnSources(context.database, input, context.notFound));
    },

    answers(runId, cursorText, requestedLimit) {
      context.ensureOpen();
      return context.readSnapshot(() => {
        if (!runExists(context.connection.orm, runId)) throw context.notFound();
        const limit = pageSize(requestedLimit);
        let cursor: AnswerCursorPayload | undefined;
        if (cursorText) {
          cursor = decodeCursor(cursorText, 'answer', answerCursorSchema);
          if (cursor.kind !== 'answers' || cursor.runId !== runId || !Number.isInteger(cursor.ordinal) || cursor.ordinal < 0) {
            throw new RunStoreError('invalid_cursor', 'The answer cursor does not match this run.');
          }
        }
        const rows = context.database.prepare(`SELECT e.*,
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
        return {
          items,
          ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'answers', runId, ordinal: asNumber(last.ordinal, 'evaluation ordinal') } satisfies AnswerCursorPayload) } : {}),
        };
      });
    },

    attempts(runId, cursorText, requestedLimit) {
      context.ensureOpen();
      return context.readSnapshot(() => loadAttempts(context.connection.orm, runId, cursorText, requestedLimit, () => {
        if (!runExists(context.connection.orm, runId)) throw context.notFound();
      }));
    },

    previewDelete(runIds) {
      context.ensureOpen();
      validateRunIds(runIds);
      return context.readSnapshot(() => {
        const snapshot = loadRunDeletionSnapshot(context.connection.orm, runIds);
        if (snapshot.runs.length !== runIds.length) throw context.notFound();
        const nowMs = context.now();
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
    },

    storageInfo() {
      context.ensureOpen();
      try {
        return context.readSnapshot(() => {
          const integrityRows = context.database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
          const foreignKeyViolations = context.database.prepare('PRAGMA foreign_key_check').all() as DatabaseRow[];
          const integrity = integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyViolations.length === 0 ? 'ok' : 'failed';
          const count = (table: 'runs' | 'evaluations' | 'attempts', where = '') => asNumber((context.database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as DatabaseRow).count, `${table} count`);
          return {
            integrity,
            databaseBytes: statSync(context.databasePath).size,
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
    },

    close: context.close,
  };
}

function deletePreviewStatus(run: ReturnType<typeof loadRunDeletionSnapshot>['runs'][number], nowMs: number): RunStatus {
  const status = asText(run.status, 'run status') as RunStatus;
  const leaseExpires = run.leaseExpiresMs ?? run.createdMs + PREPARED_LAUNCH_WINDOW_MS;
  const expired = status === 'prepared' && leaseExpires <= nowMs ||
    status === 'running' && run.leaseExpiresMs !== null && leaseExpires <= nowMs;
  return expired ? 'interrupted' : status;
}

