import { and, eq, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { JourneyTransition } from '../../../application/run-store.js';
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
