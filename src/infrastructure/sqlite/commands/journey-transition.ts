import { and, eq, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { decisionRequestSchema, decisionValueFromResult, decisionValueSchema, type DecisionValue } from '../../../domain/decision/decision.js';
import { compileDecisionPacketForCompiler } from '../../../domain/decision/prompt.js';
import { validateDecision } from '../../../domain/decision/validate.js';
import type { JourneyDefinition } from '../../../domain/study/arm.js';
import { journeyEventsSchema, journeyRouteSchema, type JourneyRespondentState, type WorkerClaim } from '../../../domain/run/lifecycle.js';
import { runRequestSchema } from '../../../domain/run/request.js';
import type { AttemptOutcome, JourneyTransition } from '../../../application/run-store.js';
import { RunStoreError } from '../../../application/run-store.js';
import { hashCanonical } from '../../identity.js';
import { asNumber, asText, type DatabaseRow, parseJson, parseJsonRecord, parseStored } from '../rows.js';
import { encodeStoredPayload } from '../payload-codecs.js';
import { evaluationFailureJson, failureEvidenceJson } from '../evidence-records.js';
import { chargeReservedAttempt, linkWinningAnswer, markAttemptAnswered, markAttemptFailed, markEvaluationAnswered, markEvaluationFailed, markRunFailed, saveAttemptEvaluationFailure } from './settlement.js';
import { evaluations, journeyRespondents, questionGroups, runs } from '../tables.js';

export function persistNextJourneyTurn(database: NodeSQLiteDatabase, runId: string, next: NonNullable<JourneyTransition['nextEvaluation']>): void {
  database.insert(questionGroups).values({
    groupId: next.contextId,
    runId,
    ordinal: next.ordinal,
    contextId: next.contextId,
    respondentId: next.respondentId,
    stateJson: JSON.stringify(next.packet.state),
    questionIdsJson: JSON.stringify([next.questionId]),
  }).run();
  database.insert(evaluations).values({
    evaluationId: next.evaluationId,
    runId,
    ordinal: next.ordinal,
    contextId: next.contextId,
    respondentId: next.respondentId,
    questionId: next.questionId,
    groupId: next.contextId,
    turnId: next.turnId,
    nodeId: next.nodeId,
    pathId: next.pathId,
    occurrence: next.occurrence,
    packetJson: JSON.stringify(next.packet),
    packetFingerprint: next.packetFingerprint,
    status: 'pending',
  }).run();
  database.update(runs).set({ evaluationCount: sql`${runs.evaluationCount} + 1` })
    .where(eq(runs.runId, runId)).run();
}

export function persistJourneyRespondentState(database: NodeSQLiteDatabase, runId: string, transition: JourneyTransition): boolean {
  return database.update(journeyRespondents).set({
    status: transition.state.status,
    currentNodeId: transition.state.currentNodeId,
    currentTurnId: transition.state.currentTurnId,
    currentContextId: transition.state.currentContextId,
    revision: transition.state.revision,
    eventsJson: JSON.stringify(transition.state.events),
    routeJson: JSON.stringify(transition.state.route),
    outcome: transition.state.outcome ?? null,
  }).where(and(
    eq(journeyRespondents.runId, runId),
    eq(journeyRespondents.respondentId, transition.respondentId),
    eq(journeyRespondents.revision, transition.expectedRevision),
  )).returning({ runId: journeyRespondents.runId }).all().length === 1;
}

export function settleJourneyTurn(context: {
  database: DatabaseSync; orm: NodeSQLiteDatabase; now(): number;
  ownedRun(claim: WorkerClaim, nowMs: number): DatabaseRow;
  sameDecisionValue(left: DecisionValue, right: DecisionValue): boolean;
  journeyRouteTarget(journey: JourneyDefinition, nodeId: string, response: DecisionValue): string | undefined;
  isJourneyAskNode(journey: JourneyDefinition, nodeId: string, questionId: string): boolean;
}, claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome, transition: JourneyTransition): void {
      const nowMs = context.now();
      context.ownedRun(claim, nowMs);
      const attempt = context.database.prepare("SELECT evaluation_id FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
        .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
      const evaluationId = asText(attempt.evaluation_id, 'evaluation ID');
      const evaluation = context.database.prepare('SELECT packet_json, turn_id, node_id, respondent_id FROM evaluations WHERE evaluation_id = ? AND run_id = ?')
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
      const stateRow = context.database.prepare('SELECT * FROM journey_respondents WHERE run_id = ? AND respondent_id = ?')
        .get(claim.runId, respondentId) as DatabaseRow | undefined;
      if (!stateRow || asNumber(stateRow.revision, 'journey state revision') !== transition.expectedRevision ||
          asText(stateRow.current_turn_id, 'current turn ID') !== turnId || asText(stateRow.current_node_id, 'current node ID') !== nodeId) {
        throw new RunStoreError('journey_transition_conflict', 'Journey respondent state has moved since this turn was reserved.');
      }
      const priorEvents = parseStored(journeyEventsSchema, parseJson(stateRow.events_json, 'journey history'), 'journey history');
      const priorRoute = parseStored(journeyRouteSchema, parseJson(stateRow.route_json, 'journey route'), 'journey route');
      if (transition.state.events.length < priorEvents.length || JSON.stringify(transition.state.events.slice(0, priorEvents.length)) !== JSON.stringify(priorEvents) ||
          transition.state.route.length < priorRoute.length || JSON.stringify(transition.state.route.slice(0, priorRoute.length)) !== JSON.stringify(priorRoute)) {
        throw new RunStoreError('journey_transition_conflict', 'Journey transitions must preserve ordered prior evidence.');
      }
      const runRow = context.database.prepare('SELECT request_json FROM runs WHERE run_id = ?').get(claim.runId) as DatabaseRow | undefined;
      const storedRun = parseJsonRecord(runRow?.request_json, 'run request');
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
            !context.sameDecisionValue(answerEvent.result, result)) {
          throw new RunStoreError('journey_transition_conflict', 'Journey transition must append the exact typed answer for this turn.');
        }
        const routeAddition = transition.state.route.slice(priorRoute.length);
        const expectedTarget = context.journeyRouteTarget(parsedRunRequest.data.journey, nodeId, result);
        if (routeAddition.length !== 1 || routeAddition[0]!.nodeId !== nodeId || routeAddition[0]!.toNodeId !== expectedTarget ||
            !context.sameDecisionValue(routeAddition[0]!.response, result) || transition.state.status === 'failed') {
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
        markAttemptAnswered(context.orm, attemptId, nowMs, result.attempts,
          JSON.stringify({ attempts: result.attempts, provider: result.provider, model: result.model, ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}), latencyMs: result.latencyMs, usage: result.usage, ...(result.cost ? { cost: result.cost } : {}) }),
          JSON.stringify(result));
        markEvaluationAnswered(context.orm, evaluationId, encodeStoredPayload('decision-value', decisionValueFromResult(result), decisionValueSchema));
        linkWinningAnswer(context.orm, claim.runId, evaluationId, attemptId);
      } else {
        const sharedFailure = outcome.scope === 'run';
        if (transition.nextEvaluation || (sharedFailure
          ? transition.state.status !== 'active' || transition.state.currentTurnId !== turnId || transition.state.currentContextId !== asText(stateRow.current_context_id, 'current context ID') || transition.state.currentNodeId !== nodeId
          : transition.state.status !== 'failed' || transition.state.currentTurnId !== null || transition.state.currentContextId !== null || transition.state.currentNodeId !== null)) {
          throw new RunStoreError('journey_transition_conflict', 'A failed turn must preserve a resumable shared turn or stop only this respondent.');
        }
        const chargedCalls = outcome.providerAttempts ?? 1;
        markAttemptFailed(context.orm, attemptId, nowMs, chargedCalls, outcome.code, outcome.message, outcome.scope);
        markEvaluationFailed(context.orm, evaluationId, outcome.code, outcome.message, failureEvidenceJson(outcome));
        const failure = { code: outcome.code, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.providerFailure ? { providerFailure: outcome.providerFailure } : {}) };
        saveAttemptEvaluationFailure(context.orm, attemptId, evaluationId, evaluationFailureJson(failure));
        if (outcome.scope === 'run') markRunFailed(context.orm, claim.runId, outcome.code, outcome.message);
      }
      if (transition.nextEvaluation) {
        const next = transition.nextEvaluation;
        const nextPacket = decisionRequestSchema.safeParse(next.packet);
        const respondent = parsedRunRequest.data.respondents.find(({ id }) => id === respondentId);
        const current = context.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM evaluations WHERE run_id = ?').get(claim.runId) as DatabaseRow;
        if (!nextPacket.success || !respondent || next.respondentId !== respondentId || !Number.isSafeInteger(next.occurrence) || next.occurrence < 1 ||
            !Number.isSafeInteger(next.ordinal) || next.ordinal !== asNumber(current.ordinal, 'evaluation ordinal') + 1 ||
            next.questionId !== nextPacket.data.question.id || !context.isJourneyAskNode(parsedRunRequest.data.journey, next.nodeId, next.questionId) ||
            hashCanonical(compileDecisionPacketForCompiler(parsedRunRequest.data.journey, respondent, next.questionId, transition.state.events, storedRun.compilerFingerprint)) !== hashCanonical(nextPacket.data) ||
            hashCanonical({ packet: nextPacket.data, compilerFingerprint: storedRun.compilerFingerprint }) !== next.packetFingerprint) {
          throw new RunStoreError('invalid_journey_turn', 'Next journey turn is invalid or does not follow the persisted evaluation order.');
        }
        persistNextJourneyTurn(context.orm, claim.runId, next);
      }
      if (!persistJourneyRespondentState(context.orm, claim.runId, transition)) {
        throw new RunStoreError('journey_transition_conflict', 'Journey respondent state changed before its transition committed.');
      }
      if (!chargeReservedAttempt(context.orm, claim.runId, outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : outcome.result.attempts)) {
        throw new RunStoreError('data_integrity_error', 'The run has no reserved physical call to settle.');
      }
}
