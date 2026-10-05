import { z } from 'zod';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { followOnLineageSchema, followOnRunRequestSchema, inlineRunRequestSchema, runRequestSchema, type FollowOnLineage, type PreparedRun } from '../../../domain/run/request.js';
import { decisionRequestSchema } from '../../../domain/decision/decision.js';
import { RunStoreError } from '../../../application/run-store.js';
import { parseJson, parseJsonRecord, parseStored } from '../rows.js';
import { loadAcceptedRequest, loadPreparedEvaluations, loadQuestionGroups, runExists } from '../run-identity-queries.js';

const preparedRunRecordSchema = z.object({
  request: z.union([inlineRunRequestSchema, followOnRunRequestSchema]),
  requestFingerprint: z.string().min(1),
  compilerFingerprint: z.string().min(1),
  lineage: followOnLineageSchema.optional(),
});

export function readRunKind(database: NodeSQLiteDatabase, runId: string, notFound: () => Error): 'poll' | 'journey' | 'follow-on' {
  const row = loadAcceptedRequest(database, runId);
  if (!row) throw notFound();
  const stored = parseJsonRecord(row.requestJson, 'request');
  const request = runRequestSchema.safeParse(stored.request);
  if (!request.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
  return request.data.kind;
}

export function readPreparedRun(
  database: NodeSQLiteDatabase,
  runId: string,
  options: { notFound: () => Error; validate: (run: PreparedRun) => PreparedRun; isRunAvailable?: (runId: string) => boolean },
): PreparedRun {
  const row = loadAcceptedRequest(database, runId);
  if (!row) throw options.notFound();
  const stored = parseStored(preparedRunRecordSchema, parseJson(row.requestJson, 'request'), 'run request');
  const { lineage, ...storedBase } = stored;
  const evaluations = loadPreparedEvaluations(database, runId);
  const groups = loadQuestionGroups(database, runId);
  const parsed = options.validate({ ...storedBase, ...(lineage === undefined ? {} : { lineage }), groups: groups.map((group) => ({
    groupId: group.groupId, contextId: group.contextId, respondentId: group.respondentId,
    state: parseStored(z.record(z.string(), z.unknown()), parseJson(group.stateJson, 'group state'), 'group state'),
    questionIds: parseStored(z.array(z.string().min(1)), parseJson(group.questionIdsJson, 'group question IDs'), 'group question IDs'),
  })), evaluations: evaluations.map((evaluation) => ({
    groupId: evaluation.groupId,
    evaluationId: evaluation.evaluationId,
    contextId: evaluation.contextId,
    respondentId: evaluation.respondentId,
    questionId: evaluation.questionId,
    packet: parseStored(decisionRequestSchema, parseJson(evaluation.packetJson, 'frozen packet'), 'frozen packet'),
    packetFingerprint: evaluation.packetFingerprint,
  })) });
  if (parsed.requestFingerprint !== row.requestFingerprint) throw new RunStoreError('data_integrity_error', 'Stored run and request fingerprints do not match.');
  if (parsed.request.kind === 'follow-on' && parsed.lineage) {
    const sourceAvailable = (options.isRunAvailable ?? ((sourceRunId) => runExists(database, sourceRunId)))(parsed.lineage.sourceRunId);
    const lineageWithAvailability: FollowOnLineage = { ...parsed.lineage, sourceAvailable, sourceRecordState: sourceAvailable ? 'live' : 'historical' };
    return { ...parsed, lineage: lineageWithAvailability };
  }
  return parsed;
}
