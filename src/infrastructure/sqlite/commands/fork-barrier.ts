import { eq, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { compileForkConditionEntry, journeyForkBarrierReadiness } from '../../../domain/journey/forks.js';
import type { JourneyEvaluationRecord, JourneyRespondentState, WorkerClaim } from '../../../domain/run/lifecycle.js';
import { runRequestSchema } from '../../../domain/run/request.js';
import { RunStoreError, type ForkAdvanceResult } from '../../../application/run-store.js';
import { hashCanonical } from '../../identity.js';
import { asNumber, asText, parseJsonRecord, type DatabaseRow } from '../rows.js';
import { readJourneyRun } from '../reads/journeys.js';
import { evaluations, journeyForkMembers, journeyForks, journeyRespondents, questionGroups, runs } from '../tables.js';

export function advanceJourneyForkBarrier(context: {
  database: DatabaseSync;
  orm: NodeSQLiteDatabase;
  now(): number;
  ownedRun(claim: WorkerClaim, nowMs: number): DatabaseRow;
}, claim: WorkerClaim, forkNodeId: string, parentBranchId: string): ForkAdvanceResult {
  const nowMs = context.now();
  context.ownedRun(claim, nowMs);
  const requestRow = context.database.prepare('SELECT request_json FROM runs WHERE run_id = ?').get(claim.runId) as DatabaseRow | undefined;
  const stored = parseJsonRecord(requestRow?.request_json, 'run request');
  const parsed = runRequestSchema.safeParse(stored.request);
  if (!parsed.success || parsed.data.kind !== 'journey' || typeof stored.compilerFingerprint !== 'string') {
    throw new RunStoreError('data_integrity_error', 'Stored journey request cannot advance its fork barrier.');
  }
  const existingBarrier = context.database.prepare('SELECT status FROM journey_forks WHERE run_id = ? AND fork_node_id = ? AND parent_branch_id = ?')
    .get(claim.runId, forkNodeId, parentBranchId) as DatabaseRow | undefined;
  if (existingBarrier && asText(existingBarrier.status, 'fork barrier status') === 'closed') return { status: 'closed', createdEvaluationIds: [], createdEvaluations: [], parentRespondents: [], childRespondents: [] };
  const journeyRun = readJourneyRun(context.database, claim.runId, () => new RunStoreError('run_not_found', 'Run was not found.'));
  const readiness = journeyForkBarrierReadiness(parsed.data.journey, forkNodeId, parentBranchId, journeyRun.respondents);
  if (readiness.arrived.length === 0) throw new RunStoreError('journey_transition_conflict', 'A matched fork barrier can advance only after a respondent reaches it.');

  context.orm.insert(journeyForks).values({ runId: claim.runId, forkNodeId, parentBranchId, status: 'open', cohortCount: 0,
    openedMs: nowMs, closedMs: null, revision: 0 }).onConflictDoNothing().run();
  const barrier = context.database.prepare('SELECT status, revision FROM journey_forks WHERE run_id = ? AND fork_node_id = ? AND parent_branch_id = ?')
    .get(claim.runId, forkNodeId, parentBranchId) as DatabaseRow | undefined;
  if (!barrier) throw new RunStoreError('data_integrity_error', 'Matched fork barrier was not persisted.');
  if (asText(barrier.status, 'fork barrier status') === 'closed') return { status: 'closed', createdEvaluationIds: [], createdEvaluations: [], parentRespondents: [], childRespondents: [] };
  if (!readiness.canClose) return { status: 'waiting', createdEvaluationIds: [], createdEvaluations: [], parentRespondents: [], childRespondents: [] };

  const cohort = [...readiness.arrived].sort((left, right) => left.respondentId < right.respondentId ? -1 : left.respondentId > right.respondentId ? 1 : 0);
  const fork = parsed.data.journey.presentation.kind === 'graph'
    ? parsed.data.journey.presentation.nodes.find((node) => node.id === forkNodeId)
    : undefined;
  if (fork?.kind !== 'fork') throw new RunStoreError('data_integrity_error', `Matched fork ${forkNodeId} is absent from the accepted journey.`);

  let nextOrdinal = asNumber((context.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?')
    .get(claim.runId) as DatabaseRow).maximum, 'maximum evaluation ordinal') + 1;
  const members: Array<{ respondentId: string; conditionOrdinal: number; conditionId: string; childBranchId: string;
    sourceContextId: string; childContextId: string; childTurnId: string; childEvaluationId: string }> = [];
  const createdEvaluationIds: string[] = [];
  const createdEvaluations: JourneyEvaluationRecord[] = [];
  const childRespondents: JourneyRespondentState[] = [];
  const parentRespondents: JourneyRespondentState[] = [];

  for (const parent of cohort) {
    if (!parent.currentContextId) throw new RunStoreError('data_integrity_error', 'A fork arrival has no source context identity.');
    const profile = parsed.data.respondents.find((candidate) => candidate.id === parent.respondentId);
    if (!profile) throw new RunStoreError('data_integrity_error', 'A fork arrival has no frozen respondent profile.');
    for (const [conditionOrdinal, condition] of fork.conditions.entries()) {
      let branch;
      try {
        branch = compileForkConditionEntry({ journey: parsed.data.journey, profile, parent, forkNodeId, conditionId: condition.id,
          compilerFingerprint: stored.compilerFingerprint });
      } catch (error) {
        throw new RunStoreError('data_integrity_error', error instanceof Error ? error.message : 'Fork treatment packet could not be compiled.');
      }
      const childContextId = randomUUID();
      const childTurnId = randomUUID();
      const childEvaluationId = randomUUID();
      const occurrence = branch.events.filter((event) => event.type === 'response' && event.taskId === branch.taskId).length + 1;
      const packetFingerprint = hashCanonical({ packet: branch.packet, compilerFingerprint: stored.compilerFingerprint });
      const evaluation = {
        evaluationId: childEvaluationId, turnId: childTurnId, contextId: childContextId,
        respondentId: parent.respondentId, branchId: branch.branchId, questionId: branch.taskId, nodeId: branch.nodeId,
        pathId: branch.pathId, occurrence, ordinal: nextOrdinal++, packet: branch.packet, packetFingerprint,
      };
      createdEvaluations.push({ ...evaluation, status: 'pending' });
      context.orm.insert(questionGroups).values({ groupId: childContextId, runId: claim.runId, ordinal: evaluation.ordinal,
        contextId: childContextId, respondentId: parent.respondentId, stateJson: JSON.stringify(branch.packet.state),
        questionIdsJson: JSON.stringify([branch.taskId]) }).run();
      context.orm.insert(evaluations).values({ ...evaluation, runId: claim.runId, groupId: childContextId,
        packetJson: JSON.stringify(branch.packet), providerSelectionJson: null, status: 'pending' }).run();
      const childState: JourneyRespondentState = { respondentId: parent.respondentId, branchId: branch.branchId,
        status: 'active', currentNodeId: branch.nodeId, currentTurnId: childTurnId, currentContextId: childContextId, revision: 0,
        events: branch.events, route: parent.route };
      childRespondents.push(childState);
      context.orm.insert(journeyRespondents).values({ runId: claim.runId, respondentId: parent.respondentId, branchId: branch.branchId,
        status: 'active', currentNodeId: branch.nodeId, currentTurnId: childTurnId, currentContextId: childContextId, revision: 0,
        eventsJson: JSON.stringify(branch.events), routeJson: JSON.stringify(parent.route), outcome: null }).run();
      members.push({ respondentId: parent.respondentId, conditionOrdinal, conditionId: condition.id, childBranchId: branch.branchId,
        sourceContextId: parent.currentContextId, childContextId, childTurnId, childEvaluationId });
      createdEvaluationIds.push(childEvaluationId);
    }
  }

  for (const parent of cohort) {
    const changed = context.orm.update(journeyRespondents).set({ status: 'branched', currentNodeId: null, currentTurnId: null,
      currentContextId: null, revision: parent.revision + 1 })
      .where(sql`${journeyRespondents.runId} = ${claim.runId} AND ${journeyRespondents.respondentId} = ${parent.respondentId} AND ${journeyRespondents.branchId} = ${parent.branchId} AND ${journeyRespondents.revision} = ${parent.revision} AND ${journeyRespondents.status} = 'waiting-fork' AND ${journeyRespondents.currentNodeId} = ${forkNodeId}`)
      .returning({ respondentId: journeyRespondents.respondentId }).all();
    if (changed.length !== 1) throw new RunStoreError('journey_transition_conflict', 'A respondent fork arrival changed while the cohort was being frozen.');
    parentRespondents.push({ ...parent, status: 'branched', currentNodeId: null, currentTurnId: null, currentContextId: null, revision: parent.revision + 1 });
  }
  for (const member of members) context.orm.insert(journeyForkMembers).values({ runId: claim.runId, forkNodeId, parentBranchId, ...member }).run();
  const closed = context.orm.update(journeyForks).set({ status: 'closed', cohortCount: cohort.length, closedMs: nowMs,
    revision: asNumber(barrier.revision, 'fork barrier revision') + 1 })
    .where(sql`${journeyForks.runId} = ${claim.runId} AND ${journeyForks.forkNodeId} = ${forkNodeId} AND ${journeyForks.parentBranchId} = ${parentBranchId} AND ${journeyForks.status} = 'open' AND ${journeyForks.revision} = ${asNumber(barrier.revision, 'fork barrier revision')}`)
    .returning({ runId: journeyForks.runId }).all();
  if (closed.length !== 1) throw new RunStoreError('journey_transition_conflict', 'The matched fork barrier changed while it was being closed.');
  context.orm.update(runs).set({ evaluationCount: sql`${runs.evaluationCount} + ${createdEvaluationIds.length}` })
    .where(eq(runs.runId, claim.runId)).run();
  return { status: 'closed', createdEvaluationIds, createdEvaluations, parentRespondents, childRespondents };
}
