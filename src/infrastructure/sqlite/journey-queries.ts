import { DatabaseSync } from 'node:sqlite';
import { decisionPacketSchema } from '../../domain/decision/prompt.js';
import { evaluationStatusSchema, journeyEventsSchema, journeyRespondentStatusSchema, journeyRouteSchema, type JourneyEvaluationRecord, type JourneyRespondentState, type JourneyWorkerTurn } from '../../domain/run/lifecycle.js';
import { RunStoreError } from '../../application/run-store.js';
import { hashCanonical } from '../identity.js';
import { asNullableText, asNumber, asText, parseJson, parseStored, type DatabaseRow } from './rows.js';
import { storedJourneyIdentity } from './journey-request.js';

export function loadJourneyWorkerTurn(database: DatabaseSync, runId: string, evaluationId: string, respondentId: string): JourneyWorkerTurn {
  const rows = database.prepare(`WITH next_ordinal AS (
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM evaluations WHERE run_id = ?
    )
    SELECT r.request_json, r.request_fingerprint, e.*, jr.status AS respondent_status,
      jr.current_node_id AS respondent_current_node_id, jr.current_turn_id AS respondent_current_turn_id,
      jr.current_context_id AS respondent_current_context_id, jr.revision AS respondent_revision,
      jr.events_json AS respondent_events_json, jr.route_json AS respondent_route_json, jr.outcome AS respondent_outcome,
      next_ordinal.value AS next_ordinal
    FROM runs r JOIN evaluations e ON e.run_id = r.run_id
    JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
    CROSS JOIN next_ordinal
    WHERE r.run_id = ? AND e.evaluation_id = ? AND e.respondent_id = ?
    `).all(runId, runId, evaluationId, respondentId) as DatabaseRow[];
  const first = rows[0];
  if (!first) throw new RunStoreError('run_not_found', 'The requested run does not exist in this datastore.');
  const identity = storedJourneyIdentity(first);
  const profile = identity.request.respondents.find(({ id }) => id === respondentId);
  if (!profile) throw new RunStoreError('data_integrity_error', 'The journey turn references a respondent outside its frozen cohort.');

  const packet = parseStored(decisionPacketSchema, parseJson(first.packet_json, 'frozen packet'), 'frozen packet');
  const evaluation: JourneyEvaluationRecord = {
    evaluationId: asText(first.evaluation_id, 'evaluation ID'),
    contextId: asText(first.context_id, 'context ID'),
    respondentId: asText(first.respondent_id, 'respondent ID'),
    questionId: asText(first.question_id, 'question ID'),
    packet,
    packetFingerprint: asText(first.packet_fingerprint, 'packet fingerprint'),
    turnId: asText(first.turn_id, 'turn ID'),
    nodeId: asText(first.node_id, 'node ID'),
    pathId: asText(first.path_id, 'path ID'),
    occurrence: asNumber(first.occurrence, 'turn occurrence'),
    ordinal: asNumber(first.ordinal, 'evaluation ordinal'),
    status: parseStored(evaluationStatusSchema, asText(first.status, 'evaluation status'), 'evaluation status'),
  };
  if (evaluation.status !== 'pending' || evaluation.questionId !== packet.question.id ||
      hashCanonical({ packet, compilerFingerprint: identity.compilerFingerprint }) !== evaluation.packetFingerprint) {
    throw new RunStoreError('data_integrity_error', 'The reserved journey packet does not match its pending turn identity.');
  }

  const respondentStatus = parseStored(journeyRespondentStatusSchema, asText(first.respondent_status, 'journey respondent status'), 'journey respondent status');
  const events = parseStored(journeyEventsSchema, parseJson(first.respondent_events_json, 'journey history'), 'journey history');
  const route = parseStored(journeyRouteSchema, parseJson(first.respondent_route_json, 'journey route'), 'journey route');
  const respondent: JourneyRespondentState = {
    respondentId: asText(first.respondent_id, 'respondent ID'),
    status: respondentStatus,
    currentNodeId: asNullableText(first.respondent_current_node_id, 'current node ID'),
    currentTurnId: asNullableText(first.respondent_current_turn_id, 'current turn ID'),
    currentContextId: asNullableText(first.respondent_current_context_id, 'current context ID'),
    revision: asNumber(first.respondent_revision, 'journey state revision'),
    events,
    route,
    ...(first.respondent_outcome === null ? {} : { outcome: asText(first.respondent_outcome, 'journey outcome') }),
  };
  if (respondent.status !== 'active' || respondent.currentTurnId !== evaluation.turnId || respondent.currentNodeId !== evaluation.nodeId || respondent.currentContextId !== evaluation.contextId) {
    throw new RunStoreError('data_integrity_error', 'The reserved journey turn does not match the active respondent checkpoint.');
  }

  return {
    evaluation,
    respondent,
    profile,
    nextOrdinal: asNumber(first.next_ordinal, 'next evaluation ordinal'),
  };
}
