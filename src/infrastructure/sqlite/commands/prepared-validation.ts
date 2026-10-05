import { createHash } from 'node:crypto';
import { decisionRequestSchema } from '../../../domain/decision/decision.js';
import { compileDecisionPacketForCompiler } from '../../../domain/decision/prompt.js';
import type { JourneyDefinition } from '../../../domain/study/arm.js';
import type { JourneyRespondentState } from '../../../domain/run/lifecycle.js';
import { followOnLineageSchema, runRequestSchema, type FollowOnLineage, type PreparedJourneyRun, type PreparedRun } from '../../../domain/run/request.js';
import { RunStoreError } from '../../../application/run-store.js';
import { hashCanonical } from '../../identity.js';
import { journeyTopology } from '../../../domain/journey/topology.js';
import { encounteredMaterialsFromState, materialCatalogForRequest } from '../evidence-records.js';

function isJourneyAskNode(journey: JourneyDefinition, nodeId: string, questionId: string): boolean {
  const node = journeyTopology(journey).nodes.find((candidate) => candidate.id === nodeId);
  return node?.kind === 'ask' && node.taskId === questionId;
}
export function validatePrepared(prepared: PreparedRun): PreparedRun {
  const parsedRequest = runRequestSchema.safeParse(prepared.request);
  if (!parsedRequest.success || prepared.compilerFingerprint.length === 0 ||
      hashCanonical({ request: parsedRequest.data, compilerFingerprint: prepared.compilerFingerprint }) !== prepared.requestFingerprint) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared run request or fingerprint is invalid.');
  }
  if (parsedRequest.data.kind === 'follow-on') {
    const parsedLineage = followOnLineageSchema.safeParse(prepared.lineage);
    if (!parsedLineage.success) throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on material lineage is invalid.');
    const lineage = parsedLineage.data;
    const includesSelectedMaterial = parsedRequest.data.context.includeSelectedMaterial === true;
    if (includesSelectedMaterial) {
      const coverage = lineage.selectionCoverage;
      const excludedIds = new Set(lineage.excludedSelections.map(({ sourceEvaluationId }) => sourceEvaluationId));
      const eligibleIds = new Set(lineage.selections.map(({ sourceEvaluationId }) => sourceEvaluationId));
      if (!coverage || coverage.eligible !== eligibleIds.size || coverage.matched !== coverage.eligible + lineage.excludedSelections.length ||
          [...eligibleIds].some((id) => excludedIds.has(id)) || lineage.selections.some(({ selectedMaterial }) => !selectedMaterial)) {
        throw new RunStoreError('invalid_prepared_run', 'Selected-material coverage and source lineage are inconsistent.');
      }
    } else if (lineage.selectionCoverage !== undefined || lineage.selections.some(({ selectedMaterial }) => selectedMaterial !== undefined)) {
      throw new RunStoreError('invalid_prepared_run', 'Selected-material lineage cannot be attached to a request without the resolver flag.');
    }
    const requestedQuestionIds = parsedRequest.data.questions.map(({ id }) => id);
    if (!lineage || lineage.sourceRunId !== parsedRequest.data.sourceRunId ||
        lineage.sourceVersion.status !== lineage.sourceStatusAtAcceptance || lineage.sourceCompleteAtAcceptance !== (lineage.sourceStatusAtAcceptance === 'completed')) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on lineage does not match its request and frozen evaluations.');
    }
    const evaluationIds = new Set<string>(); const groupIds = new Set<string>();
    const questionIdsByGroup = new Map<string, string[]>();
    if (!prepared.groups || prepared.groups.length === 0 || new Set(prepared.groups.map(({ groupId }) => groupId)).size !== prepared.groups.length) throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on groups are missing or duplicated.');
    for (const group of prepared.groups) groupIds.add(group.groupId);
    const snapshotKeys = new Set<string>();
    const snapshotsByKey = new Map<string, FollowOnLineage['materialSnapshots'][number]>();
    for (const snapshot of lineage.materialSnapshots) {
      const key = `${snapshot.contextId}:${snapshot.respondentId}`;
      if (snapshotKeys.has(key) || !prepared.groups.some((group) => group.contextId === snapshot.contextId && group.respondentId === snapshot.respondentId)) {
        throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on material snapshots do not match an accepted respondent context.');
      }
      snapshotKeys.add(key);
      snapshotsByKey.set(key, snapshot);
    }
    for (const evaluation of prepared.evaluations) {
      const packet = decisionRequestSchema.safeParse(evaluation.packet);
      if (!packet.success || !prepared.groups?.some((group) => group.groupId === evaluation.groupId && group.contextId === evaluation.contextId && group.respondentId === evaluation.respondentId && group.questionIds.includes(evaluation.questionId) && hashCanonical(group.state) === hashCanonical(packet.data.state)) ||
          !parsedRequest.data.questions.some((question) => question.id === evaluation.questionId) || packet.data.question.id !== evaluation.questionId ||
          hashCanonical({ packet: packet.data, compilerFingerprint: prepared.compilerFingerprint }) !== evaluation.packetFingerprint ||
          evaluationIds.has(evaluation.evaluationId) || !groupIds.has(evaluation.groupId ?? '')) {
        throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on evaluation or source selection is inconsistent.');
      }
      if (packet.data.question.type === 'choice' && packet.data.question.materialOptions) {
        const catalog = materialCatalogForRequest(parsedRequest.data, lineage, evaluation.contextId, evaluation.respondentId, encounteredMaterialsFromState(packet.data.state));
        for (const [optionId, materialId] of Object.entries(packet.data.question.materialOptions)) {
          const item = catalog.find(({ id }) => id === materialId);
          if (!item || !item.sourceId || !item.sourceSha256 || packet.data.question.options[optionId] !== item.text) {
            throw new RunStoreError('invalid_prepared_run', `Prepared Choice link for material ${materialId} has no matching frozen source evidence.`);
          }
        }
      }
      if (includesSelectedMaterial) {
        const mappings = lineage.selections.filter(({ evaluationId }) => evaluationId === evaluation.evaluationId);
        const selected = mappings[0]?.selectedMaterial;
        const snapshot = snapshotsByKey.get(`${evaluation.contextId}:${evaluation.respondentId}`);
        const snapshotItem = selected && snapshot?.materials.find(({ id }) => id === selected.materialId);
        const exposed = selected && encounteredMaterialsFromState(packet.data.state).some(({ id, text }) => id === selected.materialId && text === selected.text);
        if (mappings.length !== 1 || !selected || !snapshotItem || !exposed ||
            selected.textSha256 !== createHash('sha256').update(selected.text, 'utf8').digest('hex') ||
            snapshotItem.text !== selected.text || snapshotItem.sourceId !== selected.sourceId || snapshotItem.sourceSha256 !== selected.sourceSha256) {
          throw new RunStoreError('invalid_prepared_run', 'Selected-material lineage does not match its frozen recipient packet and catalog.');
        }
      }
      evaluationIds.add(evaluation.evaluationId);
      const ids = questionIdsByGroup.get(evaluation.groupId!) ?? []; ids.push(evaluation.questionId); questionIdsByGroup.set(evaluation.groupId!, ids);
    }
    if (!prepared.groups || prepared.groups.length === 0 || lineage.selections.some((selection) => !evaluationIds.has(selection.evaluationId)) ||
      prepared.groups.some((group) => JSON.stringify(group.questionIds) !== JSON.stringify(requestedQuestionIds) ||
          JSON.stringify(questionIdsByGroup.get(group.groupId) ?? []) !== JSON.stringify(group.questionIds))) throw new RunStoreError('invalid_prepared_run', 'Prepared follow-on group lineage is inconsistent.');
    if (includesSelectedMaterial) {
      const linkedIds = new Set(parsedRequest.data.questions.flatMap((question) => question.type === 'choice' ? Object.values(question.materialOptions ?? {}) : []));
      for (const group of prepared.groups) {
        const snapshot = snapshotsByKey.get(`${group.contextId}:${group.respondentId}`);
        const expectedIds = new Set([...encounteredMaterialsFromState(group.state).map(({ id }) => id), ...linkedIds]);
        if (!snapshot || JSON.stringify([...snapshot.materials.map(({ id }) => id)].sort()) !== JSON.stringify([...expectedIds].sort())) {
          throw new RunStoreError('invalid_prepared_run', 'Selected-material catalog contains unrelated material or omits a packet dependency.');
        }
      }
    }
    return { ...prepared, request: parsedRequest.data, lineage };
  }
  if (parsedRequest.data.kind !== 'poll') throw new RunStoreError('invalid_prepared_run', 'A journey must be accepted through journey preparation.');
  if (!prepared.groups || prepared.groups.length !== parsedRequest.data.respondents.length || prepared.evaluations.length !== parsedRequest.data.respondents.length * parsedRequest.data.questions.length) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared run question groups do not match respondents and questions.');
  }
  const respondentIds = new Set(parsedRequest.data.respondents.map(({ id }) => id));
  const requestedQuestionIds = parsedRequest.data.questions.map(({ id }) => id);
  const evaluationIds = new Set<string>();
  const seenRespondents = new Set<string>();
  const questionIdsByGroup = new Map<string, string[]>();
  for (const evaluation of prepared.evaluations) {
    const packet = decisionRequestSchema.safeParse(evaluation.packet);
    const group = prepared.groups.find(({ groupId }) => groupId === evaluation.groupId);
    if (!packet.success || !group || group.respondentId !== evaluation.respondentId || group.contextId !== evaluation.contextId || hashCanonical(group.state) !== hashCanonical(packet.data.state) || !respondentIds.has(evaluation.respondentId) || evaluationIds.has(evaluation.evaluationId) ||
        !parsedRequest.data.questions.some((question) => question.id === evaluation.questionId) || packet.data.question.id !== evaluation.questionId ||
        hashCanonical({ packet: packet.data, compilerFingerprint: prepared.compilerFingerprint }) !== evaluation.packetFingerprint) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared run evaluation or packet fingerprint is invalid.');
    }
    evaluationIds.add(evaluation.evaluationId);
    seenRespondents.add(evaluation.respondentId);
    const ids = questionIdsByGroup.get(group.groupId) ?? []; ids.push(evaluation.questionId); questionIdsByGroup.set(group.groupId, ids);
  }
  if (seenRespondents.size !== respondentIds.size || prepared.groups.some((group) => JSON.stringify(group.questionIds) !== JSON.stringify(requestedQuestionIds) ||
      JSON.stringify(questionIdsByGroup.get(group.groupId) ?? []) !== JSON.stringify(group.questionIds) || !respondentIds.has(group.respondentId))) throw new RunStoreError('invalid_prepared_run', 'Every respondent must have one complete ordered question group.');
  return { ...prepared, request: parsedRequest.data };
}

export function validatePreparedJourney(prepared: PreparedJourneyRun): PreparedJourneyRun {
  const parsedRequest = runRequestSchema.safeParse(prepared.request);
  if (!parsedRequest.success || parsedRequest.data.kind !== 'journey' || prepared.compilerFingerprint.length === 0 ||
      hashCanonical({ request: parsedRequest.data, compilerFingerprint: prepared.compilerFingerprint }) !== prepared.requestFingerprint) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared journey request or fingerprint is invalid.');
  }
  const respondentIds = parsedRequest.data.respondents.map(({ id }) => id);
  const respondentIdSet = new Set(respondentIds);
  if (respondentIdSet.size !== respondentIds.length || prepared.respondents.length !== respondentIds.length || prepared.evaluations.length === 0) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared journey requires unique respondent state and at least one reached turn.');
  }
  const stateById = new Map<string, JourneyRespondentState>();
  const allowedStatuses = new Set(['active', 'completed', 'failed', 'unreached']);
  for (const state of prepared.respondents) {
    if (!allowedStatuses.has(state.status) || !respondentIdSet.has(state.respondentId) || stateById.has(state.respondentId) || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
        !Array.isArray(state.events) || !Array.isArray(state.route) ||
        (state.status === 'active' ? !(state.currentNodeId && state.currentTurnId && state.currentContextId) :
          state.currentNodeId !== null || state.currentTurnId !== null || state.currentContextId !== null)) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared journey respondent state is inconsistent.');
    }
    stateById.set(state.respondentId, state);
  }
  if (stateById.size !== respondentIdSet.size) throw new RunStoreError('invalid_prepared_run', 'Every journey respondent requires durable state.');

  const evaluationIds = new Set<string>();
  const turnIds = new Set<string>();
  const contextIds = new Set<string>();
  const nodeOccurrences = new Set<string>();
  const activeTurnIds = new Set<string>();
  for (const evaluation of prepared.evaluations) {
    const packet = decisionRequestSchema.safeParse(evaluation.packet);
    const state = stateById.get(evaluation.respondentId);
    const respondent = parsedRequest.data.respondents.find(({ id }) => id === evaluation.respondentId);
    const nodeOccurrence = `${evaluation.respondentId}\0${evaluation.nodeId}\0${evaluation.occurrence}`;
    if (!packet.success || !state || !respondent || state.status !== 'active' ||
        !Number.isSafeInteger(evaluation.ordinal) || evaluation.ordinal < 0 || !Number.isSafeInteger(evaluation.occurrence) || evaluation.occurrence < 1 ||
        !evaluation.turnId || !evaluation.nodeId || !evaluation.pathId || evaluation.questionId !== packet.data.question.id ||
        state.currentTurnId !== evaluation.turnId || state.currentContextId !== evaluation.contextId || state.currentNodeId !== evaluation.nodeId ||
        !isJourneyAskNode(parsedRequest.data.journey, evaluation.nodeId, evaluation.questionId) ||
        hashCanonical(compileDecisionPacketForCompiler(parsedRequest.data.journey, respondent, evaluation.questionId, state.events, prepared.compilerFingerprint)) !== hashCanonical(packet.data) ||
        evaluationIds.has(evaluation.evaluationId) || turnIds.has(evaluation.turnId) || contextIds.has(evaluation.contextId) || nodeOccurrences.has(nodeOccurrence) ||
        !respondentIdSet.has(evaluation.respondentId) ||
        hashCanonical({ packet: packet.data, compilerFingerprint: prepared.compilerFingerprint }) !== evaluation.packetFingerprint) {
      throw new RunStoreError('invalid_prepared_run', 'Prepared journey turn or context reference is invalid.');
    }
    evaluationIds.add(evaluation.evaluationId);
    turnIds.add(evaluation.turnId);
    contextIds.add(evaluation.contextId);
    nodeOccurrences.add(nodeOccurrence);
    activeTurnIds.add(evaluation.turnId);
  }
  for (const state of prepared.respondents) {
    if (state.status === 'active' && !activeTurnIds.has(state.currentTurnId!)) {
      throw new RunStoreError('invalid_prepared_run', 'Every active journey respondent requires one pending turn.');
    }
    if (state.status !== 'active' && prepared.evaluations.some(({ respondentId }) => respondentId === state.respondentId)) {
      throw new RunStoreError('invalid_prepared_run', 'A terminal or unreached respondent cannot have a pending turn.');
    }
  }
  const ordered = prepared.evaluations.toSorted((left, right) => left.ordinal - right.ordinal);
  if (ordered.some((evaluation, index) => evaluation.ordinal !== index)) {
    throw new RunStoreError('invalid_prepared_run', 'Prepared journey turn ordinals must be contiguous from zero.');
  }
  return { ...prepared, request: parsedRequest.data };
}

