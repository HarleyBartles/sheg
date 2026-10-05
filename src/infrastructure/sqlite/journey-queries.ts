import { DatabaseSync } from 'node:sqlite';
import { decisionPacketSchema } from '../../domain/decision/prompt.js';
import { evaluationStatusSchema, journeyEventsSchema, journeyRespondentStatusSchema, journeyRouteSchema, type JourneyEvaluationRecord, type JourneyRespondentState, type JourneyWorkerTurn } from '../../domain/run/lifecycle.js';
import { RunStoreError } from '../../application/run-store.js';
import { hashCanonical } from '../identity.js';
import { asNullableText, asNumber, asText, parseJson, parseStored } from './rows.js';
import { storedJourneyIdentity } from './journey-request.js';
import { createSqliteQuery } from './query-library.js';
import { z } from 'zod';

const sqliteInteger = z.union([z.number(), z.bigint()]);
const journeyTurnRowSchema = z.object({
  request_json: z.string(), request_fingerprint: z.string(), evaluation_id: z.string(), context_id: z.string(),
  respondent_id: z.string(), question_id: z.string(), packet_json: z.string(), packet_fingerprint: z.string(),
  turn_id: z.string(), node_id: z.string(), path_id: z.string(), occurrence: sqliteInteger, ordinal: sqliteInteger,
  status: z.string(), respondent_status: z.string(), respondent_current_node_id: z.string().nullable(),
  respondent_current_turn_id: z.string().nullable(), respondent_current_context_id: z.string().nullable(),
  respondent_revision: sqliteInteger, respondent_events_json: z.string(), respondent_route_json: z.string(),
  respondent_outcome: z.string().nullable(), next_ordinal: sqliteInteger,
}).passthrough();
const loadJourneyWorkerTurnQuery = createSqliteQuery(
  'load-journey-worker-turn',
  z.tuple([z.string(), z.string(), z.string(), z.string()]),
  z.array(journeyTurnRowSchema),
);

export function loadJourneyWorkerTurn(database: DatabaseSync, runId: string, evaluationId: string, respondentId: string): JourneyWorkerTurn {
  const rows = loadJourneyWorkerTurnQuery.all(database, runId, runId, evaluationId, respondentId);
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
