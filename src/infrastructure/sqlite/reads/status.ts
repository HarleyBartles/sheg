import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { deriveRunLifecycle, runStatusSchema, type RunStatusView } from '../../../domain/run/lifecycle.js';
import { runRequestSchema } from '../../../domain/run/request.js';
import { RunStoreError } from '../../../application/run-store.js';
import { asNumber, asText, parseJsonRecord, parseStored } from '../rows.js';
import { createSqliteQuery } from '../query-library.js';

const sqliteInteger = z.union([z.number(), z.bigint()]);
const sqliteFlag = z.union([z.number(), z.bigint(), z.boolean()]);
const statusProjectionSchema = z.object({
  run_id: z.string(), status: z.string(), created_at: z.string(), request_json: z.string(),
  evaluation_count: sqliteInteger, used_calls: sqliteInteger, reserved_calls: sqliteInteger,
  cancel_requested: sqliteFlag, failure_scope: z.string().nullable(), failure_code: z.string().nullable(),
  failure_message: z.string().nullable(), completed_evaluations: sqliteInteger, failed_evaluations: sqliteInteger,
  pending_evaluations: sqliteInteger, retryable_shared_failure: sqliteFlag, retryable_journey_failure: sqliteFlag,
}).passthrough();

const readStatusRowsQuery = createSqliteQuery('read-run-status-views', z.tuple([z.string()]), z.array(statusProjectionSchema));

export function readStatusViews(database: DatabaseSync, runIds: readonly string[]): RunStatusView[] {
  if (runIds.length === 0) return [];
  return readStatusRowsQuery.all(database, JSON.stringify(runIds)).map((row) => {
    const stored = parseJsonRecord(row.request_json, 'run request');
    const request = runRequestSchema.safeParse(stored.request);
    if (!request.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
    const status = parseStored(runStatusSchema, asText(row.status, 'run status'), 'run status');
    const usedCalls = asNumber(row.used_calls, 'used calls');
    const reservedCalls = asNumber(row.reserved_calls, 'reserved calls');
    const maxCalls = asNumber(row.max_calls, 'maximum calls');
    const cancelRequested = asNumber(row.cancel_requested, 'cancel flag') === 1;
    const failureScope = row.failure_scope === null ? undefined : parseStored(z.enum(['evaluation', 'run']), asText(row.failure_scope, 'failure scope'), 'failure scope');
    return {
      runId: asText(row.run_id, 'run ID'), status, createdAt: asText(row.created_at, 'created time'),
      completedEvaluations: asNumber(row.completed_evaluations, 'completed evaluation count'),
      failedEvaluations: asNumber(row.failed_evaluations, 'failed evaluation count'),
      totalEvaluations: asNumber(row.evaluation_count, 'evaluation count'), usedCalls, reservedCalls, maxCalls, cancelRequested,
      lifecycle: deriveRunLifecycle({ status, kind: request.data.kind, cancelRequested, ...(failureScope ? { failureScope } : {}),
        usedCalls, reservedCalls, maxCalls,
        hasPendingEvaluations: asNumber(row.pending_evaluations, 'pending evaluation count') > 0,
        hasFailedEvaluations: asNumber(row.failed_evaluations, 'failed evaluation count') > 0,
        canRetrySharedFailure: asNumber(row.retryable_shared_failure, 'retryable shared failure') === 1,
        hasRetryableJourneyFailure: asNumber(row.retryable_journey_failure, 'retryable journey failure') === 1 }),
      ...(row.failure_code === null ? {} : { failure: { code: asText(row.failure_code, 'failure code'), message: asText(row.failure_message, 'failure message') } }),
    };
  });
}
