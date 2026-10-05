import type { DatabaseSync } from 'node:sqlite';
import { hashCanonical } from '../../identity.js';
import { decisionPacketSchema } from '../../../domain/decision/prompt.js';
import { validateDecision } from '../../../domain/decision/validate.js';
import { runRequestSchema } from '../../../domain/run/request.js';
import { evaluationStatusSchema, journeyEventsSchema, journeyRespondentStatusSchema, journeyRouteSchema, type JourneyEvaluationRecord, type JourneyRespondentState, type JourneyRunRecord } from '../../../domain/run/lifecycle.js';
import { RunStoreError } from '../../../application/run-store.js';
import { asNumber, asNullableText, asText, parseJson, parseJsonRecord, parseStored, type DatabaseRow } from '../rows.js';
import { decodeResultAndExecution, storedEvaluationFailure } from '../evidence-records.js';

export function readJourneyRun(database: DatabaseSync, runId: string, notFound: () => Error): JourneyRunRecord {
  const row = database.prepare('SELECT request_json, request_fingerprint FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
  if (!row) throw notFound();
  const stored = parseJsonRecord(row.request_json, 'request');
  if (!('request' in stored) || !('requestFingerprint' in stored) || !('compilerFingerprint' in stored)) throw new RunStoreError('data_integrity_error', 'Stored journey request has an invalid shape.');
  const parsedRequest = runRequestSchema.safeParse(stored.request);
  if (!parsedRequest.success || parsedRequest.data.kind !== 'journey' || typeof stored.compilerFingerprint !== 'string' ||
      typeof stored.requestFingerprint !== 'string' || stored.requestFingerprint !== asText(row.request_fingerprint, 'request fingerprint') ||
      hashCanonical({ request: parsedRequest.data, compilerFingerprint: stored.compilerFingerprint }) !== stored.requestFingerprint) {
    throw new RunStoreError('data_integrity_error', 'Stored journey request or fingerprint is invalid.');
  }
  const evaluationRows = database.prepare(`SELECT e.*,
    (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id) WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
    FROM evaluations e WHERE e.run_id = ? ORDER BY e.ordinal`).all(runId) as DatabaseRow[];
  const evaluations: JourneyEvaluationRecord[] = evaluationRows.map((evaluation) => {
    const packet = parseStored(decisionPacketSchema, parseJson(evaluation.packet_json, 'frozen packet'), 'frozen packet');
    const base: JourneyEvaluationRecord = {
      evaluationId: asText(evaluation.evaluation_id, 'evaluation ID'), contextId: asText(evaluation.context_id, 'context ID'),
      respondentId: asText(evaluation.respondent_id, 'respondent ID'), questionId: asText(evaluation.question_id, 'question ID'), packet,
      packetFingerprint: asText(evaluation.packet_fingerprint, 'packet fingerprint'), turnId: asText(evaluation.turn_id, 'turn ID'),
      nodeId: asText(evaluation.node_id, 'node ID'), pathId: asText(evaluation.path_id, 'path ID'),
      occurrence: asNumber(evaluation.occurrence, 'turn occurrence'), ordinal: asNumber(evaluation.ordinal, 'evaluation ordinal'),
      status: parseStored(evaluationStatusSchema, asText(evaluation.status, 'evaluation status'), 'evaluation status'),
    };
    if ((base.status === 'answered' && evaluation.result_json === null) || (base.status === 'failed' && evaluation.failure_code === null)) {
      throw new RunStoreError('data_integrity_error', 'Stored journey evaluation status does not match its answer evidence.');
    }
    if (base.questionId !== packet.question.id || hashCanonical({ packet, compilerFingerprint: stored.compilerFingerprint }) !== base.packetFingerprint) {
      throw new RunStoreError('data_integrity_error', 'Stored journey packet does not match its context identity.');
    }
    if (evaluation.result_json !== null) {
      const decoded = decodeResultAndExecution(parseJson(evaluation.result_json, 'decision value'), parseJson(evaluation.execution_json, 'provider execution'));
      base.result = validateDecision(packet, decoded.result, { maxAttempts: decoded.result.attempts });
      base.execution = decoded.execution;
    }
    const failure = storedEvaluationFailure(evaluation);
    if (failure) base.failure = failure;
    return base;
  });
  const stateRows = database.prepare('SELECT * FROM journey_respondents WHERE run_id = ? ORDER BY respondent_id').all(runId) as DatabaseRow[];
  const respondents: JourneyRespondentState[] = stateRows.map((state) => ({
    respondentId: asText(state.respondent_id, 'respondent ID'),
    status: parseStored(journeyRespondentStatusSchema, asText(state.status, 'journey respondent status'), 'journey respondent status'),
    currentNodeId: asNullableText(state.current_node_id, 'current node ID'),
    currentTurnId: asNullableText(state.current_turn_id, 'current turn ID'),
    currentContextId: asNullableText(state.current_context_id, 'current context ID'),
    revision: asNumber(state.revision, 'journey state revision'),
    events: parseStored(journeyEventsSchema, parseJson(state.events_json, 'journey history'), 'journey history'),
    route: parseStored(journeyRouteSchema, parseJson(state.route_json, 'journey route'), 'journey route'),
    ...(state.outcome === null ? {} : { outcome: asText(state.outcome, 'journey outcome') }),
  }));
  const respondentIds = new Set(parsedRequest.data.respondents.map(({ id }) => id));
  if (respondents.length !== respondentIds.size || new Set(respondents.map(({ respondentId }) => respondentId)).size !== respondentIds.size ||
      respondents.some(({ respondentId }) => !respondentIds.has(respondentId)) ||
      respondents.some((state) => state.status === 'active' && evaluations.filter((evaluation) => ['pending', 'failed'].includes(evaluation.status) &&
        evaluation.turnId === state.currentTurnId && evaluation.contextId === state.currentContextId && evaluation.nodeId === state.currentNodeId && evaluation.respondentId === state.respondentId).length !== 1) ||
      respondents.some((state) => state.status !== 'active' && (state.currentTurnId !== null || state.currentContextId !== null || state.currentNodeId !== null))) {
    throw new RunStoreError('data_integrity_error', 'Stored journey respondent states do not match the reached turns.');
  }
  return { request: parsedRequest.data, requestFingerprint: stored.requestFingerprint, compilerFingerprint: stored.compilerFingerprint, evaluations, respondents };
}
