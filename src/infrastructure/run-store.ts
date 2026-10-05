import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decisionRequestSchema, decisionValueFromResult, decisionValueSchema } from '../domain/decision/decision.js';
import { validateDecision } from '../domain/decision/validate.js';
import { compileDecisionPacketForCompiler } from '../domain/decision/prompt.js';
import type { JourneyDefinition } from '../domain/study/arm.js';
import { deriveRunLifecycle, resumeRefusalMessage, type AttemptReservation, type AnswerRow, type JourneyEvaluationRecord, type JourneyRespondentState, type JourneyRunRecord, type JourneyWorkerTurn, type Page, type RunAttempt, type RunContextDetail, type RunEvidencePage, type RunEvidenceQuery, type RunStatus, type RunStatusView, type WorkerClaim } from '../domain/run/lifecycle.js';
import { decisionFailureDetailForReason, decisionResultSchema, decisionBatchResultSchema, providerExecutionEvidenceSchema, type DecisionBatchResult } from '../domain/decision/decision.js';
import { followOnLineageSchema, followOnRunRequestSchema, runRequestSchema, type FollowOnLineage, type FollowOnSourceSet, type FrozenEvaluation, type ParsedFollowOnRunRequest, type PreparedJourneyRun, type PreparedRun } from '../domain/run/request.js';
import { hashCanonical } from './identity.js';
import { journeyTopology } from '../domain/journey/topology.js';
import { asNumber, asNullableText, asText, parseJson, type DatabaseRow } from './sqlite/rows.js';
import { decodeCursor, encodeCursor, pageSize } from './sqlite/cursors.js';
import { queryEvidencePage } from './sqlite/evidence-query.js';
import { findRunBySubmission, loadAcceptedRequest, loadEvaluationStatuses, loadPreparedEvaluations, loadQuestionGroups, runExists } from './sqlite/run-identity-queries.js';
import { encodeStoredPayload } from './sqlite/payload-codecs.js';
import { storedJourneyIdentity } from './sqlite/journey-request.js';
import { insertAcceptedRun, insertPreparedJourneyData, insertPreparedRunData } from './sqlite/commands/acceptance.js';
import { encounteredMaterialsFromState, evaluationFailureFromJson, evaluationFailureJson, failureEvidenceJson, materialCatalogForRequest, resultFromStorage, storedEvaluationFailure } from './sqlite/evidence-records.js';
import { openSqliteConnection, type SqliteConnection } from './sqlite/connection.js';
import { SCHEMA_VERSION } from './sqlite/schema.js';
import { RunStoreError } from '../application/run-store.js';
import type { AttemptOutcome, DeletePreview, DeleteResult, JourneyTransition, RunCommandRepository, RunListQuery, RunPersistence, RunReadRepository, RunStore, StorageInfo } from '../application/run-store.js';
export { SCHEMA_VERSION } from './sqlite/schema.js';
export type { AttemptOutcome, DeletePreview, DeleteResult, JourneyTransition, RunListQuery, RunPersistence, RunReadRepository, RunCommandRepository, RunStore, StorageInfo } from '../application/run-store.js';
export { RunStoreError } from '../application/run-store.js';
export { inspectRunStoreCompatibility, runStoreBackupAvailable, type StoreCompatibility } from './sqlite/recovery.js';
import { resetRunStore as resetRunStoreInternal } from './sqlite/recovery.js';

function sameDecisionValue(left: import('../domain/decision/decision.js').DecisionValue, right: import('../domain/decision/decision.js').DecisionValue): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'choice' && right.type === 'choice') return left.choice === right.choice && hashCanonical(left.probabilities ?? null) === hashCanonical(right.probabilities ?? null) && left.confidence === right.confidence;
  if (left.type === 'score' && right.type === 'score') return left.score === right.score && hashCanonical(left.probabilities) === hashCanonical(right.probabilities) && hashCanonical(left.legend) === hashCanonical(right.legend) && left.confidence === right.confidence;
  return left.type === 'noul' && right.type === 'noul' && left.noul === right.noul;
}

function isJourneyAskNode(journey: JourneyDefinition, nodeId: string, questionId: string): boolean {
  const node = journeyTopology(journey).nodes.find((candidate) => candidate.id === nodeId);
  return node?.kind === 'ask' && node.taskId === questionId;
}

function journeyRouteTarget(journey: JourneyDefinition, nodeId: string, response: import('../domain/decision/decision.js').DecisionValue): string | undefined {
  const graph = journeyTopology(journey);
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.kind !== 'ask') return undefined;
  const edge = graph.transitions.find((candidate) => {
    if (candidate.fromNodeId !== nodeId) return false;
    if (response.type === 'choice') return candidate.optionId === response.choice;
    const interval = candidate.when;
    const value = response.type === 'score' ? response.score : response.noul;
    return interval?.type === response.type &&
      (value > interval.minimum || value === interval.minimum && interval.minimumInclusive) &&
      (value < interval.maximum || value === interval.maximum && interval.maximumInclusive);
  });
  return edge?.toNodeId;
}

const LEASE_MS = 30_000;

type CursorPayload = { kind: 'runs'; createdMs: number; runId: string; filtersFingerprint: string };
type AnswerCursorPayload = { kind: 'answers'; runId: string; ordinal: number };
type AttemptCursorPayload = { kind: 'attempts'; runId: string; sequence: number };

function validateRunIds(runIds: string[]): void {
  if (!Array.isArray(runIds) || runIds.length < 1 || runIds.length > 200 || runIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(runIds).size !== runIds.length) {
    throw new RunStoreError('invalid_run_selection', 'Select between 1 and 200 unique run IDs.');
  }
}


function validatePrepared(prepared: PreparedRun): PreparedRun {
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

function validatePreparedJourney(prepared: PreparedJourneyRun): PreparedJourneyRun {
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

export function openRunStore(dataRoot: string, options: { now?: () => number } = {}): RunStore {
  if (!path.isAbsolute(dataRoot)) throw new RunStoreError('invalid_data_root', 'Sheg data directory must be an absolute path.');
  mkdirSync(dataRoot, { recursive: true });
  const connection = openSqliteConnection(path.join(dataRoot, 'runs.sqlite'), dataRoot);
  return new SQLiteRunStore(connection, path.join(dataRoot, 'runs.sqlite'), options.now ?? Date.now);
}

export function openRunPersistence(dataRoot: string, options: { now?: () => number } = {}): RunPersistence {
  return splitRunStore(openRunStore(dataRoot, options));
}

export function splitRunStore(store: RunStore): RunPersistence {
  const reads: RunReadRepository = {
    findSubmission: store.findSubmission.bind(store), getStatus: store.getStatus.bind(store),
    evaluationStatuses: store.evaluationStatuses.bind(store), getRequestKind: store.getRequestKind.bind(store),
    getRequest: store.getRequest.bind(store), getJourneyRun: store.getJourneyRun.bind(store),
    getJourneyWorkerTurn: store.getJourneyWorkerTurn.bind(store), list: store.list.bind(store),
    queryEvidence: store.queryEvidence.bind(store), getContext: store.getContext.bind(store),
    resolveFollowOnSources: store.resolveFollowOnSources.bind(store), answers: store.answers.bind(store),
    attempts: store.attempts.bind(store), previewDelete: store.previewDelete.bind(store),
    storageInfo: store.storageInfo.bind(store), close: store.close.bind(store),
  };
  const commands: RunCommandRepository = {
    accept: store.accept.bind(store), acceptJourney: store.acceptJourney.bind(store),
    requestCancel: store.requestCancel.bind(store), resume: store.resume.bind(store),
    deleteRuns: store.deleteRuns.bind(store), optimizeStorage: store.optimizeStorage.bind(store),
    claim: store.claim.bind(store), heartbeat: store.heartbeat.bind(store), reserveNext: store.reserveNext.bind(store),
    reserveBatch: store.reserveBatch.bind(store), settleBatch: store.settleBatch.bind(store),
    settle: store.settle.bind(store), settleJourney: store.settleJourney.bind(store), finish: store.finish.bind(store),
    failLaunch: store.failLaunch.bind(store), failRun: store.failRun.bind(store),
    reconcile: store.reconcile.bind(store), reconcileMany: store.reconcileMany.bind(store), reconcileActive: store.reconcileActive.bind(store),
  };
  return { reads, commands, close: store.close.bind(store) };
}

class SQLiteRunStore implements RunStore {
  private isClosed = false;
  private readonly database: DatabaseSync;

  constructor(private readonly connection: SqliteConnection, private readonly databasePath: string, private readonly now: () => number) {
    this.database = connection.client;
  }

  findSubmission(submissionId: string, requestFingerprint: string): RunStatusView | null {
    this.ensureOpen();
    return this.readTransaction(() => {
      const row = findRunBySubmission(this.connection.orm, submissionId);
      if (!row) return null;
      if (row.requestFingerprint !== requestFingerprint) {
        throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
      }
      return this.statusInside(row.runId);
    });
  }

  accept(submissionId: string, preparedInput: PreparedRun): { created: boolean; run: RunStatusView } {
    this.ensureOpen();
    if (!submissionId.trim()) throw new RunStoreError('invalid_submission_id', 'A submission ID is required.');
    const prepared = validatePrepared(preparedInput);
    return this.transaction(() => {
      const prior = this.database.prepare('SELECT run_id, request_fingerprint FROM runs WHERE submission_id = ?').get(submissionId) as DatabaseRow | undefined;
      if (prior) {
        const priorFingerprint = asText(prior.request_fingerprint, 'request fingerprint');
        if (priorFingerprint !== prepared.requestFingerprint) throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
        const runId = asText(prior.run_id, 'run ID');
        this.reconcileInside(runId, this.now());
        return { created: false, run: this.statusInside(runId) };
      }

      if (prepared.request.kind === 'follow-on') {
        const source = this.database.prepare('SELECT status, used_calls, reserved_calls FROM runs WHERE run_id = ?').get(prepared.lineage!.sourceRunId) as DatabaseRow | undefined;
        if (!source) throw this.notFound();
        const maxOrdinal = asNumber((this.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?').get(prepared.lineage!.sourceRunId) as DatabaseRow).maximum, 'maximum evaluation ordinal');
        const version = prepared.lineage!.sourceVersion;
        if (asText(source.status, 'source run status') !== version.status || asNumber(source.used_calls, 'source used calls') !== version.usedCalls ||
            asNumber(source.reserved_calls, 'source reserved calls') !== version.reservedCalls || maxOrdinal !== version.maxOrdinal) {
          throw new RunStoreError('source_changed_during_acceptance', 'The source run changed after follow-on inspection. Inspect the request again to use its current evidence.');
        }
        for (const selection of prepared.lineage!.selections) {
          const sourceEvaluation = this.database.prepare('SELECT 1 AS found FROM evaluations WHERE run_id = ? AND evaluation_id = ? AND context_id = ?').get(prepared.lineage!.sourceRunId, selection.sourceEvaluationId, selection.sourceContextId);
          if (!sourceEvaluation) throw new RunStoreError('source_changed_during_acceptance', 'A selected source evaluation changed after follow-on inspection. Inspect the request again.');
        }
      }

      const runId = randomUUID();
      const nowMs = this.now();
      const createdAt = new Date(nowMs).toISOString();
      insertAcceptedRun(this.connection.orm, { runId, submissionId, requestFingerprint: prepared.requestFingerprint, createdAt, createdMs: nowMs }, prepared);
      insertPreparedRunData(this.connection.orm, runId, prepared);
      return { created: true, run: this.statusInside(runId) };
    });
  }

  acceptJourney(submissionId: string, preparedInput: PreparedJourneyRun): { created: boolean; run: RunStatusView } {
    this.ensureOpen();
    if (!submissionId.trim()) throw new RunStoreError('invalid_submission_id', 'A submission ID is required.');
    const prepared = validatePreparedJourney(preparedInput);
    return this.transaction(() => {
      const prior = this.database.prepare('SELECT run_id, request_fingerprint FROM runs WHERE submission_id = ?').get(submissionId) as DatabaseRow | undefined;
      if (prior) {
        const priorFingerprint = asText(prior.request_fingerprint, 'request fingerprint');
        if (priorFingerprint !== prepared.requestFingerprint) throw new RunStoreError('submission_conflict', 'This submission ID has already been used with different request contents.');
        const runId = asText(prior.run_id, 'run ID');
        this.reconcileInside(runId, this.now());
        return { created: false, run: this.statusInside(runId) };
      }

      const runId = randomUUID();
      const nowMs = this.now();
      const createdAt = new Date(nowMs).toISOString();
      insertAcceptedRun(this.connection.orm, { runId, submissionId, requestFingerprint: prepared.requestFingerprint, createdAt, createdMs: nowMs }, prepared);
      insertPreparedJourneyData(this.connection.orm, runId, prepared);
      return { created: true, run: this.statusInside(runId) };
    });
  }

  getStatus(runId: string): RunStatusView {
    this.ensureOpen();
    return this.readTransaction(() => this.statusInside(runId));
  }

  evaluationStatuses(runId: string): Array<{ evaluationId: string; status: AnswerRow['status'] }> {
    this.ensureOpen();
    return this.readTransaction(() => {
      this.statusInside(runId);
      return loadEvaluationStatuses(this.connection.orm, runId).map((row) => ({
        evaluationId: row.evaluationId,
        status: row.status as AnswerRow['status'],
      }));
    });
  }

  getRequestKind(runId: string): 'poll' | 'journey' | 'follow-on' {
    this.ensureOpen();
    return this.readTransaction(() => {
      this.statusInside(runId);
      const row = loadAcceptedRequest(this.connection.orm, runId);
      if (!row) throw this.notFound();
      const stored = parseJson<unknown>(row.requestJson, 'request');
      if (typeof stored !== 'object' || stored === null || !('request' in stored)) {
        throw new RunStoreError('data_integrity_error', 'Stored run request has an invalid shape.');
      }
      const request = runRequestSchema.safeParse(stored.request);
      if (!request.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
      return request.data.kind;
    });
  }

  getRequest(runId: string): PreparedRun {
    this.ensureOpen();
    return this.readTransaction(() => {
    this.statusInside(runId);
    const row = loadAcceptedRequest(this.connection.orm, runId);
    if (!row) throw this.notFound();
    const stored = parseJson<unknown>(row.requestJson, 'request');
    if (typeof stored !== 'object' || stored === null || !('request' in stored) || !('requestFingerprint' in stored) || !('compilerFingerprint' in stored)) {
      throw new RunStoreError('data_integrity_error', 'Stored run request has an invalid shape.');
    }
    const evaluations = loadPreparedEvaluations(this.connection.orm, runId);
    const groups = loadQuestionGroups(this.connection.orm, runId);
    const prepared = stored as Omit<PreparedRun, 'evaluations'>;
    const parsed = validatePrepared({ ...prepared, groups: groups.map((row) => ({
      groupId: row.groupId, contextId: row.contextId, respondentId: row.respondentId,
      state: parseJson(row.stateJson, 'group state'), questionIds: parseJson(row.questionIdsJson, 'group question IDs'),
    })), evaluations: evaluations.map((row) => ({
      groupId: row.groupId,
      evaluationId: row.evaluationId,
      contextId: row.contextId,
      respondentId: row.respondentId,
      questionId: row.questionId,
      packet: parseJson(row.packetJson, 'frozen packet'),
      packetFingerprint: row.packetFingerprint,
    })) });
    if (parsed.requestFingerprint !== row.requestFingerprint) {
      throw new RunStoreError('data_integrity_error', 'Stored run and request fingerprints do not match.');
    }
    if (parsed.request.kind === 'follow-on' && parsed.lineage) {
      const sourceAvailable = runExists(this.connection.orm, parsed.lineage.sourceRunId);
      return { ...parsed, lineage: { ...parsed.lineage, sourceAvailable, sourceRecordState: sourceAvailable ? 'live' : 'historical' } };
    }
    return parsed;
    });
  }

  getJourneyWorkerTurn(runId: string, evaluationId: string, respondentId: string): JourneyWorkerTurn {
    this.ensureOpen();
    return this.readTransaction(() => {
      const rows = this.database.prepare(`WITH next_ordinal AS (
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM evaluations WHERE run_id = ?
        ), node_occurrences AS (
          SELECT node_id, COUNT(*) AS count FROM evaluations WHERE run_id = ? AND respondent_id = ? GROUP BY node_id
        )
        SELECT r.request_json, r.request_fingerprint, e.*, jr.status AS respondent_status,
          jr.current_node_id AS respondent_current_node_id, jr.current_turn_id AS respondent_current_turn_id,
          jr.current_context_id AS respondent_current_context_id, jr.revision AS respondent_revision,
          jr.events_json AS respondent_events_json, jr.route_json AS respondent_route_json, jr.outcome AS respondent_outcome,
          next_ordinal.value AS next_ordinal, node_occurrences.node_id AS occurrence_node_id, node_occurrences.count AS occurrence_count
        FROM runs r JOIN evaluations e ON e.run_id = r.run_id
        JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
        CROSS JOIN next_ordinal LEFT JOIN node_occurrences ON 1 = 1
        WHERE r.run_id = ? AND e.evaluation_id = ? AND e.respondent_id = ?
        ORDER BY node_occurrences.node_id`).all(runId, runId, respondentId, runId, evaluationId, respondentId) as DatabaseRow[];
      const first = rows[0];
      if (!first) throw this.notFound();
      const identity = storedJourneyIdentity(first);
      const profile = identity.request.respondents.find(({ id }) => id === respondentId);
      if (!profile) throw new RunStoreError('data_integrity_error', 'The journey turn references a respondent outside its frozen cohort.');

      const packet = decisionRequestSchema.parse(parseJson(first.packet_json, 'frozen packet')) as JourneyEvaluationRecord['packet'];
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
        status: asText(first.status, 'evaluation status') as JourneyEvaluationRecord['status'],
      };
      if (evaluation.status !== 'pending' || evaluation.questionId !== packet.question.id ||
          hashCanonical({ packet, compilerFingerprint: identity.compilerFingerprint }) !== evaluation.packetFingerprint) {
        throw new RunStoreError('data_integrity_error', 'The reserved journey packet does not match its pending turn identity.');
      }

      const respondentStatus = asText(first.respondent_status, 'journey respondent status');
      const events = parseJson<unknown>(first.respondent_events_json, 'journey history');
      const route = parseJson<unknown>(first.respondent_route_json, 'journey route');
      if (!['active', 'completed', 'failed', 'unreached'].includes(respondentStatus) || !Array.isArray(events) || !Array.isArray(route)) {
        throw new RunStoreError('data_integrity_error', 'Stored journey respondent state has an invalid shape.');
      }
      const respondent: JourneyRespondentState = {
        respondentId: asText(first.respondent_id, 'respondent ID'),
        status: respondentStatus as JourneyRespondentState['status'],
        currentNodeId: asNullableText(first.respondent_current_node_id, 'current node ID'),
        currentTurnId: asNullableText(first.respondent_current_turn_id, 'current turn ID'),
        currentContextId: asNullableText(first.respondent_current_context_id, 'current context ID'),
        revision: asNumber(first.respondent_revision, 'journey state revision'),
        events: events as JourneyRespondentState['events'],
        route: route as JourneyRespondentState['route'],
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
        nodeOccurrences: rows.flatMap((row) => row.occurrence_node_id === null ? [] : [{ nodeId: asText(row.occurrence_node_id, 'occurrence node ID'), count: asNumber(row.occurrence_count, 'node occurrence count') }]),
      };
    });
  }

  getJourneyRun(runId: string): JourneyRunRecord {
    this.ensureOpen();
    return this.readTransaction(() => {
    this.statusInside(runId);
    const row = this.database.prepare('SELECT request_json, request_fingerprint FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
    if (!row) throw this.notFound();
    const stored = parseJson<unknown>(row.request_json, 'request');
    if (typeof stored !== 'object' || stored === null || !('request' in stored) || !('requestFingerprint' in stored) || !('compilerFingerprint' in stored)) {
      throw new RunStoreError('data_integrity_error', 'Stored journey request has an invalid shape.');
    }
    const parsedRequest = runRequestSchema.safeParse(stored.request);
    if (!parsedRequest.success || parsedRequest.data.kind !== 'journey' || typeof stored.compilerFingerprint !== 'string' ||
        typeof stored.requestFingerprint !== 'string' || stored.requestFingerprint !== asText(row.request_fingerprint, 'request fingerprint') ||
        hashCanonical({ request: parsedRequest.data, compilerFingerprint: stored.compilerFingerprint }) !== stored.requestFingerprint) {
      throw new RunStoreError('data_integrity_error', 'Stored journey request or fingerprint is invalid.');
    }
    const evaluationRows = this.database.prepare(`SELECT e.*,
      (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id) WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
      FROM evaluations e WHERE e.run_id = ? ORDER BY e.ordinal`).all(runId) as DatabaseRow[];
    const evaluations: JourneyEvaluationRecord[] = evaluationRows.map((evaluation) => {
      const packet = decisionRequestSchema.parse(parseJson(evaluation.packet_json, 'frozen packet')) as JourneyEvaluationRecord['packet'];
      const base: JourneyEvaluationRecord = {
        evaluationId: asText(evaluation.evaluation_id, 'evaluation ID'),
        contextId: asText(evaluation.context_id, 'context ID'),
        respondentId: asText(evaluation.respondent_id, 'respondent ID'),
        questionId: asText(evaluation.question_id, 'question ID'),
        packet,
        packetFingerprint: asText(evaluation.packet_fingerprint, 'packet fingerprint'),
        turnId: asText(evaluation.turn_id, 'turn ID'),
        nodeId: asText(evaluation.node_id, 'node ID'),
        pathId: asText(evaluation.path_id, 'path ID'),
        occurrence: asNumber(evaluation.occurrence, 'turn occurrence'),
        ordinal: asNumber(evaluation.ordinal, 'evaluation ordinal'),
        status: asText(evaluation.status, 'evaluation status') as JourneyEvaluationRecord['status'],
      };
      if (!['pending', 'answered', 'failed', 'unreached'].includes(base.status) ||
          (base.status === 'answered' && evaluation.result_json === null) || (base.status === 'failed' && evaluation.failure_code === null)) {
        throw new RunStoreError('data_integrity_error', 'Stored journey evaluation status does not match its answer evidence.');
      }
      if (base.questionId !== packet.question.id || hashCanonical({ packet, compilerFingerprint: stored.compilerFingerprint }) !== base.packetFingerprint) {
        throw new RunStoreError('data_integrity_error', 'Stored journey packet does not match its context identity.');
      }
      if (evaluation.result_json !== null) {
        const result = resultFromStorage(parseJson(evaluation.result_json, 'decision value'), evaluation.execution_json === null ? undefined : parseJson(evaluation.execution_json, 'provider execution'));
        base.result = validateDecision(packet, result, { maxAttempts: result.attempts });
      }
      const evaluationFailure = storedEvaluationFailure(evaluation);
      if (evaluationFailure) base.failure = evaluationFailure;
      return base;
    });
    const stateRows = this.database.prepare('SELECT * FROM journey_respondents WHERE run_id = ? ORDER BY respondent_id').all(runId) as DatabaseRow[];
    const respondents: JourneyRespondentState[] = stateRows.map((state) => {
      const status = asText(state.status, 'journey respondent status');
      const events = parseJson<unknown>(state.events_json, 'journey history');
      const route = parseJson<unknown>(state.route_json, 'journey route');
      if (!['active', 'completed', 'failed', 'unreached'].includes(status) || !Array.isArray(events) || !Array.isArray(route)) {
        throw new RunStoreError('data_integrity_error', 'Stored journey respondent state has an invalid shape.');
      }
      return {
        respondentId: asText(state.respondent_id, 'respondent ID'),
        status: status as JourneyRespondentState['status'],
        currentNodeId: asNullableText(state.current_node_id, 'current node ID'),
        currentTurnId: asNullableText(state.current_turn_id, 'current turn ID'),
        currentContextId: asNullableText(state.current_context_id, 'current context ID'),
        revision: asNumber(state.revision, 'journey state revision'),
        events: events as JourneyRespondentState['events'],
        route: route as JourneyRespondentState['route'],
        ...(state.outcome === null ? {} : { outcome: asText(state.outcome, 'journey outcome') }),
      };
    });
    const respondentIds = new Set(parsedRequest.data.respondents.map(({ id }) => id));
    if (respondents.length !== respondentIds.size || new Set(respondents.map(({ respondentId }) => respondentId)).size !== respondentIds.size ||
        respondents.some((state) => !respondentIds.has(state.respondentId)) ||
        respondents.some((state) => state.status === 'active' && evaluations.filter((evaluation) => ['pending', 'failed'].includes(evaluation.status) && evaluation.turnId === state.currentTurnId && evaluation.contextId === state.currentContextId && evaluation.nodeId === state.currentNodeId && evaluation.respondentId === state.respondentId).length !== 1) ||
        respondents.some((state) => state.status !== 'active' && (state.currentTurnId !== null || state.currentContextId !== null || state.currentNodeId !== null))) {
      throw new RunStoreError('data_integrity_error', 'Stored journey respondent states do not match the reached turns.');
    }
    return { request: parsedRequest.data, requestFingerprint: stored.requestFingerprint, compilerFingerprint: stored.compilerFingerprint, evaluations, respondents };
    });
  }

  list(query: RunListQuery): Page<RunStatusView> {
    this.ensureOpen();
    return this.readTransaction(() => {
    const limit = pageSize(query.limit);
    const filtersFingerprint = hashCanonical({ status: query.status ?? null, label: query.label ?? null, createdAfter: query.createdAfter ?? null, createdBefore: query.createdBefore ?? null, materialId: query.materialId ?? null });
    let cursor: CursorPayload | undefined;
    if (query.cursor) {
      cursor = decodeCursor<CursorPayload>(query.cursor, 'run list');
      if (cursor.kind !== 'runs' || !Number.isSafeInteger(cursor.createdMs) || cursor.createdMs < 0 || typeof cursor.runId !== 'string' || cursor.runId.length === 0 ||
          cursor.filtersFingerprint !== filtersFingerprint) {
        throw new RunStoreError('invalid_cursor', 'The run list cursor does not match the requested filters.');
      }
    }
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.status !== undefined) { clauses.push('status = ?'); params.push(query.status); }
    if (query.label !== undefined) { clauses.push('label = ?'); params.push(query.label); }
    if (query.createdAfter !== undefined) { clauses.push('created_ms >= ?'); params.push(Date.parse(query.createdAfter)); }
    if (query.createdBefore !== undefined) { clauses.push('created_ms <= ?'); params.push(Date.parse(query.createdBefore)); }
    if (query.materialId !== undefined) {
      clauses.push(`(EXISTS (SELECT 1 FROM json_each(CASE WHEN json_extract(runs.request_json, '$.request.kind') = 'poll'
        THEN json_extract(runs.request_json, '$.request.material') WHEN json_extract(runs.request_json, '$.request.kind') = 'journey'
        THEN json_extract(runs.request_json, '$.request.journey.items') ELSE json_extract(runs.request_json, '$.request.material') END) AS source_material
        WHERE json_extract(source_material.value, '$.id') = ?) OR EXISTS (SELECT 1 FROM evaluations AS material_evaluation, json_each(material_evaluation.packet_json, '$.state.encounteredItems') AS encountered
        WHERE material_evaluation.run_id = runs.run_id AND json_extract(encountered.value, '$.id') = ?) OR EXISTS (
        SELECT 1 FROM json_each(runs.request_json, '$.lineage.materialSnapshots') AS retained_snapshot,
          json_each(retained_snapshot.value, '$.materials') AS retained_material
        WHERE json_extract(retained_material.value, '$.id') = ?))`);
      params.push(query.materialId, query.materialId, query.materialId);
    }
    if (cursor) {
      clauses.push('(created_ms > ? OR (created_ms = ? AND run_id > ?))');
      params.push(cursor.createdMs, cursor.createdMs, cursor.runId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`SELECT run_id, created_ms FROM runs ${where} ORDER BY created_ms, run_id LIMIT ?`).all(...params, limit + 1) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = this.statusesInside(pageRows.map((row) => asText(row.run_id, 'run ID')));
    const last = pageRows.at(-1);
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'runs', createdMs: asNumber(last.created_ms, 'created time'), runId: asText(last.run_id, 'run ID'), filtersFingerprint } satisfies CursorPayload) } : {}),
    };
    });
  }

  resolveFollowOnSources(input: ParsedFollowOnRunRequest): FollowOnSourceSet {
    this.ensureOpen();
    const request = followOnRunRequestSchema.parse(input);
    return this.readTransaction(() => {
      const run = this.database.prepare('SELECT status, used_calls, reserved_calls, request_json FROM runs WHERE run_id = ?').get(request.sourceRunId) as DatabaseRow | undefined;
      if (!run) throw this.notFound();
      const stored = parseJson<{ request?: unknown; lineage?: unknown }>(run.request_json, 'source run request');
      const sourceRequest = runRequestSchema.safeParse(stored.request);
      if (!sourceRequest.success) throw new RunStoreError('data_integrity_error', 'Stored source run request is invalid.');
      let sourceLineage: FollowOnLineage | undefined;
      if (sourceRequest.data.kind === 'follow-on') {
        const parsedLineage = followOnLineageSchema.safeParse(stored.lineage);
        if (!parsedLineage.success) throw new RunStoreError('data_integrity_error', 'Stored source follow-on material lineage is invalid.');
        sourceLineage = parsedLineage.data;
      }
      const sourceStatus = asText(run.status, 'run status') as RunStatus;
      const usedCalls = asNumber(run.used_calls, 'used calls');
      const reservedCalls = asNumber(run.reserved_calls, 'reserved calls');
      const maxOrdinal = asNumber((this.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS maximum FROM evaluations WHERE run_id = ?').get(request.sourceRunId) as DatabaseRow).maximum, 'maximum evaluation ordinal');
      const where = ['e.run_id = ?', 'e.ordinal <= ?'];
      const parameters: Array<string | number> = [request.sourceRunId, maxOrdinal];
      if ('references' in request.selection) {
        where.push(`EXISTS (
          SELECT 1 FROM json_each(?) AS selected
          WHERE json_extract(selected.value, '$.evaluationId') = e.evaluation_id
            AND json_extract(selected.value, '$.contextId') = e.context_id
        )`);
        parameters.push(JSON.stringify(request.selection.references));
      } else {
        const criteria = request.selection.criteria;
        if (criteria.respondentId !== undefined) { where.push('e.respondent_id = ?'); parameters.push(criteria.respondentId); }
        if (criteria.status !== undefined) { where.push('e.status = ?'); parameters.push(criteria.status); }
        if (criteria.questionId !== undefined) { where.push('e.question_id = ?'); parameters.push(criteria.questionId); }
        if (criteria.materialId !== undefined) {
          where.push("EXISTS (SELECT 1 FROM json_each(e.packet_json, '$.state.encounteredItems') AS encountered WHERE json_extract(encountered.value, '$.id') = ?)");
          parameters.push(criteria.materialId);
        }
        if (criteria.answer?.type === 'choice') {
          where.push("json_extract(e.result_json, '$.value.type') = 'choice' AND json_extract(e.result_json, '$.value.choice') = ?"); parameters.push(criteria.answer.choiceId);
        } else if (criteria.answer?.type === 'score' || criteria.answer?.type === 'noul') {
          const field = criteria.answer.type === 'score' ? 'score' : 'noul';
          const operator = criteria.answer.operator === 'eq' ? '=' : criteria.answer.operator === 'lt' ? '<' : criteria.answer.operator === 'lte' ? '<=' : criteria.answer.operator === 'gt' ? '>' : '>=';
          where.push(`json_extract(e.result_json, '$.value.type') = '${field}' AND json_extract(e.result_json, '$.value.${field}') ${operator} ?`); parameters.push(criteria.answer.value);
        }
        if (criteria.outcome !== undefined) { where.push('jr.outcome = ?'); parameters.push(criteria.outcome); }
      }
      const rows = this.database.prepare(`SELECT e.*,
        (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id)
          WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
        FROM evaluations AS e
        LEFT JOIN journey_respondents AS jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
        WHERE ${where.join(' AND ')} ORDER BY e.ordinal LIMIT 10001`).all(...parameters) as DatabaseRow[];
      if (rows.length > 10_000) throw new RunStoreError('follow_on_selection_too_large', 'Follow-on selection matched more than 10,000 evaluations. Narrow the criteria or use explicit references.');
      if ('references' in request.selection && rows.length !== request.selection.references.length) {
        throw new RunStoreError('follow_on_reference_not_found', 'One or more evaluation/context references were not found in the source run.');
      }
      const turns: FollowOnSourceSet['turns'] = rows.map((row) => {
        const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'source packet')) as FollowOnSourceSet['turns'][number]['packet'];
        const result = row.result_json === null ? undefined : resultFromStorage(parseJson(row.result_json, 'source answer'), row.execution_json === null ? undefined : parseJson(row.execution_json, 'source execution'));
        const contextId = asText(row.context_id, 'context ID');
        const respondentId = asText(row.respondent_id, 'respondent ID');
        return {
          evaluationId: asText(row.evaluation_id, 'evaluation ID'), contextId,
          respondentId, status: asText(row.status, 'evaluation status') as FollowOnSourceSet['turns'][number]['status'], packet, ...(result ? { result } : {}),
          materials: materialCatalogForRequest(sourceRequest.data, sourceLineage, contextId, respondentId, packet.state.encounteredItems),
          ...(result?.type === 'choice' && packet.question.type === 'choice' && packet.question.materialOptions?.[result.choice]
            ? (() => {
              const materialId = packet.question.type === 'choice' ? packet.question.materialOptions?.[result.choice] : undefined;
              const candidate = materialCatalogForRequest(sourceRequest.data, sourceLineage, contextId, respondentId, packet.state.encounteredItems).find(({ id }) => id === materialId);
              if (!candidate?.sourceId || !candidate.sourceSha256) throw new RunStoreError('data_integrity_error', `Mapped Choice answer has no retained material evidence for ${materialId}.`);
              return { selectedMaterial: { materialId: candidate.id, text: candidate.text, sourceId: candidate.sourceId, sourceSha256: candidate.sourceSha256, textSha256: createHash('sha256').update(candidate.text, 'utf8').digest('hex') } };
            })() : {}),
        };
      });
      return {
        sourceRunId: request.sourceRunId, sourceStatus, sourceComplete: sourceStatus === 'completed',
        version: { status: sourceStatus, usedCalls, reservedCalls, maxOrdinal }, turns,
      };
    });
  }

  queryEvidence(input: RunEvidenceQuery): RunEvidencePage {
    return queryEvidencePage({
      database: this.database,
      now: this.now,
      ensureOpen: () => this.ensureOpen(),
      readTransaction: (operation) => this.readTransaction(operation),
      statusInside: (runId) => this.statusInside(runId),
      notFound: () => this.notFound(),
    }, input);
  }

  getContext(runId: string, evaluationId: string, contextId: string): RunContextDetail {
    this.ensureOpen();
    return this.readTransaction(() => {
      const row = this.database.prepare(`SELECT e.*, r.request_json FROM evaluations e JOIN runs r USING (run_id)
        WHERE e.run_id = ? AND e.evaluation_id = ? AND e.context_id = ?`).get(runId, evaluationId, contextId) as DatabaseRow | undefined;
      if (!row) throw new RunStoreError('context_not_found', 'The evaluation and context handles do not identify a context in this run.');
      const stored = parseJson<{ compilerFingerprint?: unknown }>(row.request_json, 'run request');
      if (typeof stored.compilerFingerprint !== 'string' || stored.compilerFingerprint.length === 0) throw new RunStoreError('data_integrity_error', 'Stored compiler identity is invalid.');
      const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet')) as import('../domain/decision/decision.js').DecisionRequest & { state: import('../domain/decision/prompt.js').PromptState };
      const packetFingerprint = asText(row.packet_fingerprint, 'packet fingerprint');
      if (hashCanonical({ packet, compilerFingerprint: stored.compilerFingerprint }) !== packetFingerprint) throw new RunStoreError('data_integrity_error', 'Stored context packet fingerprint does not match its frozen input.');
      return {
        runId,
        evaluationId,
        contextId,
        respondentId: asText(row.respondent_id, 'respondent ID'),
        questionId: asText(row.question_id, 'question ID'),
        status: asText(row.status, 'evaluation status') as RunContextDetail['status'],
        packet,
        provenance: {
          compilerFingerprint: stored.compilerFingerprint,
          packetFingerprint,
          contextFingerprint: hashCanonical({ state: packet.state, compilerFingerprint: stored.compilerFingerprint }),
        },
      };
    });
  }

  answers(runId: string, cursorText?: string, requestedLimit?: number): Page<AnswerRow> {
    this.ensureOpen();
    return this.readTransaction(() => {
    this.statusInside(runId);
    const limit = pageSize(requestedLimit);
    let cursor: AnswerCursorPayload | undefined;
    if (cursorText) {
      cursor = decodeCursor<AnswerCursorPayload>(cursorText, 'answer');
      if (cursor.kind !== 'answers' || cursor.runId !== runId || !Number.isInteger(cursor.ordinal) || cursor.ordinal < 0) {
        throw new RunStoreError('invalid_cursor', 'The answer cursor does not match this run.');
      }
    }
    const rows = this.database.prepare(`SELECT e.*,
      (SELECT a.execution_json FROM evaluation_answer_attempts ea JOIN attempts a USING (attempt_id)
        WHERE ea.evaluation_id = e.evaluation_id) AS execution_json
      FROM evaluations e WHERE run_id = ? ${cursor ? 'AND ordinal > ?' : ''} ORDER BY ordinal LIMIT ?`)
      .all(...(cursor ? [runId, cursor.ordinal, limit + 1] : [runId, limit + 1])) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row): AnswerRow => {
      const failure = storedEvaluationFailure(row);
      return {
        evaluationId: asText(row.evaluation_id, 'evaluation ID'),
        contextId: asText(row.context_id, 'context ID'),
        respondentId: asText(row.respondent_id, 'respondent ID'),
        questionId: asText(row.question_id, 'question ID'),
        status: asText(row.status, 'evaluation status') as AnswerRow['status'],
        ...(row.result_json === null ? {} : { result: resultFromStorage(parseJson(row.result_json, 'decision result'), row.execution_json === null ? undefined : parseJson(row.execution_json, 'provider execution')) }),
        ...(row.execution_json === null ? {} : { execution: providerExecutionEvidenceSchema.parse(parseJson(row.execution_json, 'provider execution')) }),
        ...(failure === undefined ? {} : { failure }),
      };
    });
    const last = pageRows.at(-1);
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({ kind: 'answers', runId, ordinal: asNumber(last.ordinal, 'evaluation ordinal') } satisfies AnswerCursorPayload) } : {}) };
    });
  }

  attempts(runId: string, cursorText?: string, requestedLimit?: number): Page<RunAttempt> {
    this.ensureOpen();
    return this.readTransaction(() => {
    this.statusInside(runId);
    const limit = pageSize(requestedLimit);
    let cursor: AttemptCursorPayload | undefined;
    if (cursorText) {
      cursor = decodeCursor<AttemptCursorPayload>(cursorText, 'attempts');
      if (cursor.kind !== 'attempts' || cursor.runId !== runId || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1) {
        throw new RunStoreError('invalid_cursor', 'The attempt cursor does not match this run.');
      }
    }
    const rows = this.database.prepare(`SELECT a.* FROM attempts a
      WHERE a.run_id = ? ${cursor ? 'AND a.attempt_sequence > ?' : ''}
      ORDER BY a.attempt_sequence LIMIT ?`)
      .all(...(cursor ? [runId, cursor.sequence, limit + 1] : [runId, limit + 1])) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const attemptIds = pageRows.map((row) => asText(row.attempt_id, 'attempt ID'));
    const memberships = attemptIds.length === 0 ? [] : this.database.prepare(`SELECT ae.attempt_id, ae.evaluation_id, e.question_id, ae.failure_json
      FROM attempt_evaluations ae JOIN evaluations e ON e.run_id = ae.run_id AND e.evaluation_id = ae.evaluation_id
      WHERE ae.run_id = ? AND ae.attempt_id IN (${attemptIds.map(() => '?').join(', ')}) ORDER BY e.ordinal`)
      .all(runId, ...attemptIds) as DatabaseRow[];
    const membershipsByAttempt = new Map<string, string[]>();
    const failuresByAttempt = new Map<string, RunAttempt['evaluationFailures']>();
    for (const membership of memberships) {
      const attemptId = asText(membership.attempt_id, 'attempt ID');
      const evaluationId = asText(membership.evaluation_id, 'attempt evaluation ID');
      membershipsByAttempt.set(attemptId, [...membershipsByAttempt.get(attemptId) ?? [], evaluationId]);
      const failure = evaluationFailureFromJson(membership.failure_json);
      if (failure) failuresByAttempt.set(attemptId, [...failuresByAttempt.get(attemptId) ?? [], {
        evaluationId, questionId: asText(membership.question_id, 'attempt question ID'), failure,
      }]);
    }
    const items = pageRows.map((row): RunAttempt => {
      const attemptId = asText(row.attempt_id, 'attempt ID');
      const evaluationFailures = failuresByAttempt.get(attemptId) ?? [];
      return {
        attemptId,
        groupId: asText(row.group_id, 'question group ID'),
        evaluationIds: membershipsByAttempt.get(attemptId) ?? [],
        status: asText(row.status, 'attempt status') as RunAttempt['status'],
        startedAt: new Date(asNumber(row.started_ms, 'attempt start time')).toISOString(),
        ...(row.settled_ms === null ? {} : { settledAt: new Date(asNumber(row.settled_ms, 'attempt settlement time')).toISOString() }),
        ...(row.failure_code === null ? {} : { failure: {
          code: asText(row.failure_code, 'attempt failure code'),
          message: asText(row.failure_message, 'attempt failure message'),
          ...(row.failure_scope === null ? {} : { scope: asText(row.failure_scope, 'attempt failure scope') as 'evaluation' | 'run' }),
        } }),
        ...(evaluationFailures.length === 0 ? {} : { evaluationFailures }),
        ...(row.execution_json === null ? {} : { execution: providerExecutionEvidenceSchema.parse(parseJson(row.execution_json, 'attempt execution')) }),
      };
    });
    const last = pageRows.at(-1);
    return { items, ...(hasMore && last ? { nextCursor: encodeCursor({
      kind: 'attempts', runId, sequence: asNumber(last.attempt_sequence, 'attempt sequence'),
    } satisfies AttemptCursorPayload) } : {}) };
    });
  }

  requestCancel(runId: string): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      const row = this.database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
      if (!row) throw this.notFound();
      const status = asText(row.status, 'run status');
      if (status === 'prepared') {
        this.database.prepare("UPDATE runs SET status = 'cancelled', cancel_requested = 1 WHERE run_id = ? AND status = 'prepared'").run(runId);
      } else if (status === 'running') {
        this.database.prepare('UPDATE runs SET cancel_requested = 1 WHERE run_id = ?').run(runId);
      }
      return this.statusInside(runId);
    });
  }

  resume(runId: string, nowMs: number): { started: boolean; run: RunStatusView } {
    this.ensureOpen();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RunStoreError('invalid_time', 'Resume time must be a nonnegative safe integer.');
    return this.transaction(() => {
      this.reconcileInside(runId, nowMs);
      const statusView = this.statusInside(runId);
      if (statusView.status === 'prepared') return { started: false, run: statusView };
      if (!statusView.lifecycle.resume.eligible) {
        throw new RunStoreError('run_not_resumable', resumeRefusalMessage(statusView.lifecycle.resume.reason));
      }
      const run = this.database.prepare('SELECT status, failure_scope, reserved_calls, cancel_requested, used_calls, max_calls, request_json FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
      if (!run) throw this.notFound();
      const status = asText(run.status, 'run status');
      const storedRequest = parseJson<{ request?: unknown }>(run.request_json, 'run request');
      const parsedRequest = runRequestSchema.safeParse(storedRequest.request);
      if (!parsedRequest.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
      const isJourney = parsedRequest.data.kind === 'journey';

      const failed = this.database.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ? AND status = 'failed'").get(runId) as DatabaseRow;
      const journeyFailures = status === 'partial' && isJourney && statusView.lifecycle.resume.eligible
        ? this.database.prepare(`SELECT e.evaluation_id, e.respondent_id, e.turn_id, e.node_id, e.context_id
          FROM evaluations e JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
          WHERE e.run_id = ? AND e.status = 'failed' AND jr.status = 'failed' ORDER BY e.ordinal`).all(runId) as DatabaseRow[]
        : [];
      const runFailure = this.database.prepare("SELECT attempt_id, evaluation_id FROM attempts WHERE run_id = ? AND status = 'failed' AND failure_scope = 'run' ORDER BY attempt_sequence DESC LIMIT 1").get(runId) as DatabaseRow | undefined;
      const failedRunEvaluationId = runFailure ? asText(runFailure.evaluation_id, 'failed evaluation ID') : undefined;
      const failedEvaluation = failedRunEvaluationId
        ? this.database.prepare("SELECT status FROM evaluations WHERE run_id = ? AND evaluation_id = ?").get(runId, failedRunEvaluationId) as DatabaseRow | undefined
        : undefined;
      const canRetrySharedFailure = status === 'failed' && asText(run.failure_scope, 'failure scope') === 'run' &&
        failedEvaluation !== undefined && asText(failedEvaluation.status, 'evaluation status') === 'failed';
      const canRetryQuestionFailures = status === 'partial' && asNumber(failed.count, 'failed evaluation count') > 0 &&
        !isJourney;
      if (canRetrySharedFailure && runFailure) {
        this.database.prepare(`UPDATE evaluations SET status = 'pending', result_json = NULL, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL
          WHERE run_id = ? AND status = 'failed' AND evaluation_id IN (SELECT evaluation_id FROM attempt_evaluations WHERE attempt_id = ?)`)
          .run(runId, asText(runFailure.attempt_id, 'failed attempt ID'));
      }
      if (canRetryQuestionFailures) this.database.prepare("UPDATE evaluations SET status = 'pending', result_json = NULL, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL WHERE run_id = ? AND status = 'failed'").run(runId);
      for (const checkpoint of journeyFailures) {
        const evaluationId = asText(checkpoint.evaluation_id, 'failed evaluation ID');
        const respondentId = asText(checkpoint.respondent_id, 'failed respondent ID');
        const reopened = this.database.prepare(`UPDATE evaluations SET status = 'pending', result_json = NULL,
          failure_code = NULL, failure_message = NULL, failure_detail_json = NULL
          WHERE run_id = ? AND evaluation_id = ? AND respondent_id = ? AND status = 'failed'`).run(runId, evaluationId, respondentId);
        const restored = this.database.prepare(`UPDATE journey_respondents SET status = 'active',
          current_node_id = ?, current_turn_id = ?, current_context_id = ?, revision = revision + 1
          WHERE run_id = ? AND respondent_id = ? AND status = 'failed'`).run(
          asText(checkpoint.node_id, 'failed turn node ID'), asText(checkpoint.turn_id, 'failed turn ID'),
          asText(checkpoint.context_id, 'failed turn context ID'), runId, respondentId);
        if (reopened.changes !== 1 || restored.changes !== 1) {
          throw new RunStoreError('data_integrity_error', 'The saved failed journey checkpoint changed during resume.');
        }
      }
      this.database.prepare(`UPDATE runs SET status = 'prepared', failure_scope = NULL, failure_code = NULL,
        failure_message = NULL, lease_expires_ms = ?, owner_token = NULL, owner_pid = NULL
        WHERE run_id = ? AND status IN ('interrupted', 'failed', 'partial')`)
        .run(nowMs + LEASE_MS, runId);
      return { started: true, run: this.statusInside(runId) };
    });
  }

  previewDelete(runIds: string[]): DeletePreview {
    this.ensureOpen();
    validateRunIds(runIds);
    return this.transaction(() => {
      const nowMs = this.now();
      const runs = runIds.map((runId) => {
        const row = this.database.prepare('SELECT status, created_ms, lease_expires_ms FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
        if (!row) throw this.notFound();
        const storedStatus = asText(row.status, 'run status') as RunStatus;
        const leaseExpires = row.lease_expires_ms === null ? asNumber(row.created_ms, 'run creation time') + LEASE_MS : asNumber(row.lease_expires_ms, 'run lease expiry');
        const expired = storedStatus === 'prepared' && leaseExpires <= nowMs ||
          storedStatus === 'running' && row.lease_expires_ms !== null && leaseExpires <= nowMs;
        const status: RunStatus = expired ? 'interrupted' : storedStatus;
        const evaluationCount = asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ?').get(runId) as DatabaseRow).count, 'evaluation count');
        const attemptCount = asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(runId) as DatabaseRow).count, 'attempt count');
        const dependentRows = this.database.prepare("SELECT run_id FROM runs WHERE json_extract(request_json, '$.lineage.sourceRunId') = ? ORDER BY created_ms, run_id").all(runId) as DatabaseRow[];
        const retainedFollowOnRunIds = dependentRows.map((row) => asText(row.run_id, 'dependent follow-on run ID')).filter((dependentId) => !runIds.includes(dependentId));
        return { runId, status, evaluationCount, attemptCount, blockedByActiveWork: status === 'prepared' || status === 'running', retainedFollowOnRunIds };
      });
      return { runs, blockedByActiveWork: runs.some(({ blockedByActiveWork }) => blockedByActiveWork) };
    });
  }

  deleteRuns(runIds: string[]): DeleteResult {
    this.ensureOpen();
    validateRunIds(runIds);
    const result = this.transaction(() => {
      const nowMs = this.now();
      const counts = runIds.map((runId) => {
        this.reconcileInside(runId, nowMs);
        const status = asText((this.database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined)?.status, 'run status') as RunStatus;
        if (status === 'prepared' || status === 'running') {
          throw new RunStoreError('runs_active', 'Active runs cannot be deleted. Cancel each run, wait until it reaches a terminal state, then submit the explicit selection again.');
        }
        return {
          runId,
          evaluations: asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM evaluations WHERE run_id = ?').get(runId) as DatabaseRow).count, 'evaluation count'),
          attempts: asNumber((this.database.prepare('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?').get(runId) as DatabaseRow).count, 'attempt count'),
        };
      });
      for (const { runId } of counts) this.database.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
      const violations = this.database.prepare('PRAGMA foreign_key_check').all() as DatabaseRow[];
      const integrity = this.database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
      if (violations.length > 0 || integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new RunStoreError('storage_integrity_failed', 'The datastore integrity check failed; no runs were deleted.');
      }
      return { deletedRunIds: counts.map(({ runId }) => runId), removed: { runs: counts.length, evaluations: counts.reduce((sum, item) => sum + item.evaluations, 0), attempts: counts.reduce((sum, item) => sum + item.attempts, 0) } };
    });
    let maintenance: DeleteResult['maintenance'];
    try {
      this.optimizeStorage();
      maintenance = { optimization: 'completed' };
    } catch (error) {
      maintenance = { optimization: 'failed', failureCode: error instanceof RunStoreError ? error.code : 'storage_operation_failed' };
    }
    return { ...result, maintenance };
  }

  storageInfo(): StorageInfo {
    this.ensureOpen();
    try {
      return this.readTransaction(() => {
        const integrityRows = this.database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
        const foreignKeyViolations = this.database.prepare('PRAGMA foreign_key_check').all() as DatabaseRow[];
        const integrity = integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyViolations.length === 0 ? 'ok' : 'failed';
        const count = (table: 'runs' | 'evaluations' | 'attempts', where = '') => asNumber((this.database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as DatabaseRow).count, `${table} count`);
        return {
          integrity,
          databaseBytes: statSync(this.databasePath).size,
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
  }

  optimizeStorage(): void {
    this.ensureOpen();
    if (this.storageInfo().integrity !== 'ok') throw new RunStoreError('storage_integrity_failed', 'Sheg will not optimize a datastore whose integrity check failed.');
    try { this.database.exec('PRAGMA optimize'); }
    catch (error) { throw new RunStoreError('storage_operation_failed', 'Sheg could not optimize the datastore.', { cause: error }); }
  }

  claim(runId: string, nowMs: number, workerPid: number): WorkerClaim | null {
    this.ensureOpen();
    if (!Number.isSafeInteger(workerPid) || workerPid < 1) throw new RunStoreError('invalid_worker_pid', 'Worker PID must be a positive integer.');
    return this.transaction(() => {
      const row = this.database.prepare('SELECT status, created_ms, cancel_requested, lease_expires_ms FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
      if (!row) throw this.notFound();
      const launchDeadline = row.lease_expires_ms === null ? asNumber(row.created_ms, 'created time') + LEASE_MS : asNumber(row.lease_expires_ms, 'launch deadline');
      if (asText(row.status, 'run status') !== 'prepared' || asNumber(row.cancel_requested, 'cancel flag') === 1 || nowMs >= launchDeadline) return null;
      const ownerToken = randomUUID();
      this.database.prepare("UPDATE runs SET status = 'running', owner_token = ?, owner_pid = ?, lease_expires_ms = ? WHERE run_id = ? AND status = 'prepared'")
        .run(ownerToken, workerPid, nowMs + LEASE_MS, runId);
      return { runId, ownerToken };
    });
  }

  heartbeat(claim: WorkerClaim, nowMs: number): boolean {
    this.ensureOpen();
    return this.transaction(() => {
      const updated = this.database.prepare(`UPDATE runs SET lease_expires_ms = ?
        WHERE run_id = ? AND status = 'running' AND owner_token = ? AND lease_expires_ms > ?`)
        .run(nowMs + LEASE_MS, claim.runId, claim.ownerToken, nowMs);
      return updated.changes === 1;
    });
  }

  reserveNext(claim: WorkerClaim, nowMs: number): AttemptReservation | null {
    this.ensureOpen();
    return this.transaction(() => {
      const run = this.ownedRun(claim, nowMs);
      if (asNumber(run.cancel_requested, 'cancel flag') === 1) return null;
      if (asNumber(run.reserved_calls, 'reserved calls') !== 0) return null;
      if (asNumber(run.used_calls, 'used calls') + asNumber(run.reserved_calls, 'reserved calls') >= asNumber(run.max_calls, 'maximum calls')) return null;
      const row = this.database.prepare("SELECT * FROM evaluations WHERE run_id = ? AND status = 'pending' ORDER BY ordinal LIMIT 1").get(claim.runId) as DatabaseRow | undefined;
      if (!row) return null;
      const attemptId = randomUUID();
      const evaluationId = asText(row.evaluation_id, 'evaluation ID');
      this.database.prepare("INSERT INTO attempts (attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)")
        .run(attemptId, claim.runId, asText(row.group_id, 'group ID'), evaluationId, asText(row.packet_fingerprint, 'packet fingerprint'), claim.ownerToken, nowMs);
      this.database.prepare('INSERT INTO attempt_evaluations (run_id, attempt_id, evaluation_id) VALUES (?, ?, ?)').run(claim.runId, attemptId, evaluationId);
      this.database.prepare('UPDATE runs SET reserved_calls = reserved_calls + 1 WHERE run_id = ?').run(claim.runId);
      return { attemptId, evaluation: this.evaluationFromRow(row) };
    });
  }

  reserveBatch(claim: WorkerClaim, groupId: string, evaluationIds: string[], nowMs: number): { attemptId: string; evaluations: FrozenEvaluation[] } | null {
    this.ensureOpen();
    return this.transaction(() => {
      const run = this.ownedRun(claim, nowMs);
      if (!evaluationIds.length || new Set(evaluationIds).size !== evaluationIds.length || asNumber(run.cancel_requested, 'cancel flag') === 1 ||
          asNumber(run.reserved_calls, 'reserved calls') !== 0 || asNumber(run.used_calls, 'used calls') >= asNumber(run.max_calls, 'maximum calls')) return null;
      const group = this.database.prepare('SELECT * FROM question_groups WHERE run_id = ? AND group_id = ?').get(claim.runId, groupId) as DatabaseRow | undefined;
      if (!group) throw new RunStoreError('question_group_not_found', 'The requested question group was not found in this run.');
      const orderedIds = parseJson<string[]>(group.question_ids_json, 'group question IDs');
      const rows = this.database.prepare(`SELECT * FROM evaluations WHERE run_id = ? AND group_id = ? AND status = 'pending'`).all(claim.runId, groupId) as DatabaseRow[];
      const byId = new Map(rows.map((row) => [asText(row.evaluation_id, 'evaluation ID'), row]));
      const selected = evaluationIds.map((id) => byId.get(id));
      if (selected.some((row) => !row) || selected.some((row) => !orderedIds.includes(asText(row!.question_id, 'question ID')))) {
        throw new RunStoreError('invalid_batch_reservation', 'A batch may reserve only pending evaluations from the requested group.');
      }
      const sorted = [...selected as DatabaseRow[]].sort((left, right) => orderedIds.indexOf(asText(left.question_id, 'question ID')) - orderedIds.indexOf(asText(right.question_id, 'question ID')));
      const attemptId = randomUUID(); const anchorId = asText(sorted[0]!.evaluation_id, 'evaluation ID');
      const state = parseJson(group.state_json, 'group state');
      const packetQuestions = sorted.map((row) => decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet')).question);
      const packetFingerprint = hashCanonical({ state, questions: packetQuestions });
      this.database.prepare("INSERT INTO attempts (attempt_id, run_id, group_id, evaluation_id, packet_fingerprint, owner_token, status, started_ms) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)")
        .run(attemptId, claim.runId, groupId, anchorId, packetFingerprint, claim.ownerToken, nowMs);
      const link = this.database.prepare('INSERT INTO attempt_evaluations (run_id, attempt_id, evaluation_id) VALUES (?, ?, ?)');
      for (const row of sorted) link.run(claim.runId, attemptId, asText(row.evaluation_id, 'evaluation ID'));
      this.database.prepare('UPDATE runs SET reserved_calls = reserved_calls + 1 WHERE run_id = ?').run(claim.runId);
      return { attemptId, evaluations: sorted.map((row) => this.evaluationFromRow(row)) };
    });
  }

  settleBatch(claim: WorkerClaim, attemptId: string, outcome: { kind: 'answered'; result: DecisionBatchResult } | Extract<AttemptOutcome, { kind: 'failed' }>): void {
    this.ensureOpen();
    this.transaction(() => {
      const nowMs = this.now(); this.ownedRun(claim, nowMs);
      const attempt = this.database.prepare("SELECT * FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
        .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
      const rows = this.database.prepare(`SELECT e.* FROM attempt_evaluations ae JOIN evaluations e USING (evaluation_id) WHERE ae.attempt_id = ? ORDER BY e.ordinal`).all(attemptId) as DatabaseRow[];
      if (!rows.length) throw new RunStoreError('data_integrity_error', 'The provider attempt has no linked evaluations.');
      const chargedCalls = outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : outcome.result.execution.attempts;
      if (outcome.kind === 'failed') {
        this.database.prepare("UPDATE attempts SET status = 'failed', settled_ms = ?, charged_calls = ?, failure_code = ?, failure_message = ?, failure_scope = ? WHERE attempt_id = ?")
          .run(nowMs, chargedCalls, outcome.code, outcome.message, outcome.scope, attemptId);
        for (const row of rows) {
          const evaluationId = asText(row.evaluation_id, 'evaluation ID');
          this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
            .run(outcome.code, outcome.message, failureEvidenceJson(outcome), evaluationId);
          if (outcome.detail || outcome.providerFailure) this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
            .run(evaluationFailureJson({ code: outcome.code, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.providerFailure ? { providerFailure: outcome.providerFailure } : {}) }), attemptId, evaluationId);
        }
        if (outcome.scope === 'run') this.database.prepare('UPDATE runs SET failure_scope = ?, failure_code = ?, failure_message = ? WHERE run_id = ?').run(outcome.scope, outcome.code, outcome.message, claim.runId);
      } else {
        const result = decisionBatchResultSchema.safeParse(outcome.result);
        if (!result.success) throw new RunStoreError('invalid_batch_result', 'The batch result envelope is invalid.');
        const expected = new Map(rows.map((row) => [asText(row.question_id, 'question ID'), row]));
        if (result.data.answers.some(({ questionId }) => !expected.has(questionId))) throw new RunStoreError('invalid_batch_result', 'The batch result contains an unknown question ID.');
        this.database.prepare("UPDATE attempts SET status = 'answered', settled_ms = ?, charged_calls = ?, execution_json = ? WHERE attempt_id = ?")
          .run(nowMs, result.data.execution.attempts, JSON.stringify(result.data.execution), attemptId);
        for (const [questionId, row] of expected) {
          const answer = result.data.answers.find((item) => item.questionId === questionId);
          const evaluationId = asText(row.evaluation_id, 'evaluation ID');
          if (!answer) {
            this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = 'missing_batch_answer', failure_message = 'Provider returned no answer for this question.' WHERE evaluation_id = ?").run(evaluationId);
            this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
              .run(evaluationFailureJson({ code: 'missing_batch_answer', message: 'Provider returned no answer for this question.' }), attemptId, evaluationId);
          } else if ('failure' in answer) {
            const failure = { code: answer.failure.code, message: answer.failure.message, ...(answer.failure.detail ? { detail: answer.failure.detail } : {}) };
            this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
              .run(failure.code, failure.message, failureEvidenceJson(failure), evaluationId);
            this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
              .run(evaluationFailureJson(failure), attemptId, evaluationId);
          } else {
            const packet = decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet'));
            let validated: ReturnType<typeof validateDecision> | undefined;
            try {
              const typed = decisionResultSchema.parse({ ...answer.value, ...result.data.execution });
              validated = validateDecision(packet, typed, { maxAttempts: 1 });
            } catch {
              const failure = { code: 'invalid_decision', message: 'The stored answer did not satisfy this question contract.', detail: decisionFailureDetailForReason('invalid_answer') };
              this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
                .run(failure.code, failure.message, failureEvidenceJson(failure), evaluationId);
              this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
                .run(evaluationFailureJson(failure), attemptId, evaluationId);
            }
            if (validated) {
              this.database.prepare("UPDATE evaluations SET status = 'answered', result_json = ?, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL WHERE evaluation_id = ?").run(encodeStoredPayload('decision-value', answer.value, decisionValueSchema), evaluationId);
              this.database.prepare('INSERT INTO evaluation_answer_attempts (run_id, evaluation_id, attempt_id) VALUES (?, ?, ?)').run(claim.runId, evaluationId, attemptId);
            }
          }
        }
      }
      this.database.prepare('UPDATE runs SET used_calls = used_calls + ?, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0')
        .run(chargedCalls, claim.runId);
    });
  }

  settle(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome): void {
    this.ensureOpen();
    this.transaction(() => {
      const nowMs = this.now();
      this.ownedRun(claim, nowMs);
      const attempt = this.database.prepare("SELECT evaluation_id FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
        .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
      const evaluationId = asText(attempt.evaluation_id, 'evaluation ID');
      const evaluation = this.database.prepare('SELECT packet_json FROM evaluations WHERE evaluation_id = ? AND run_id = ?').get(evaluationId, claim.runId) as DatabaseRow | undefined;
      if (!evaluation) throw new RunStoreError('data_integrity_error', 'The reserved evaluation is missing.');
      const packet = decisionRequestSchema.parse(parseJson(evaluation.packet_json, 'frozen packet'));

      if (outcome.kind === 'answered') {
        const result = validateDecision(packet, outcome.result, { maxAttempts: 1 });
        this.database.prepare("UPDATE attempts SET status = 'answered', settled_ms = ?, charged_calls = ?, result_json = ?, execution_json = ? WHERE attempt_id = ?")
          .run(nowMs, result.attempts, JSON.stringify(result), JSON.stringify({ attempts: result.attempts, provider: result.provider, model: result.model, ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}), latencyMs: result.latencyMs, usage: result.usage, ...(result.cost ? { cost: result.cost } : {}) }), attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'answered', result_json = ?, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL WHERE evaluation_id = ?")
          .run(encodeStoredPayload('decision-value', decisionValueFromResult(result), decisionValueSchema), evaluationId);
        this.database.prepare('INSERT INTO evaluation_answer_attempts (run_id, evaluation_id, attempt_id) VALUES (?, ?, ?)').run(claim.runId, evaluationId, attemptId);
      } else {
        const chargedCalls = outcome.providerAttempts ?? 1;
        this.database.prepare("UPDATE attempts SET status = 'failed', settled_ms = ?, charged_calls = ?, failure_code = ?, failure_message = ?, failure_scope = ? WHERE attempt_id = ?")
          .run(nowMs, chargedCalls, outcome.code, outcome.message, outcome.scope, attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
          .run(outcome.code, outcome.message, failureEvidenceJson(outcome), evaluationId);
        const failure = { code: outcome.code, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.providerFailure ? { providerFailure: outcome.providerFailure } : {}) };
        this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
          .run(evaluationFailureJson(failure), attemptId, evaluationId);
        if (outcome.scope === 'run') {
          this.database.prepare('UPDATE runs SET failure_scope = ?, failure_code = ?, failure_message = ? WHERE run_id = ?')
            .run(outcome.scope, outcome.code, outcome.message, claim.runId);
        }
      }
      this.database.prepare('UPDATE runs SET used_calls = used_calls + ?, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0')
        .run(outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : outcome.result.attempts, claim.runId);
    });
  }

  settleJourney(claim: WorkerClaim, attemptId: string, outcome: AttemptOutcome, transition: JourneyTransition): void {
    this.ensureOpen();
    this.transaction(() => {
      const nowMs = this.now();
      this.ownedRun(claim, nowMs);
      const attempt = this.database.prepare("SELECT evaluation_id FROM attempts WHERE attempt_id = ? AND run_id = ? AND owner_token = ? AND status = 'reserved'")
        .get(attemptId, claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (!attempt) throw new RunStoreError('attempt_not_reserved', 'The provider attempt is not reserved by this worker.');
      const evaluationId = asText(attempt.evaluation_id, 'evaluation ID');
      const evaluation = this.database.prepare('SELECT packet_json, turn_id, node_id, respondent_id FROM evaluations WHERE evaluation_id = ? AND run_id = ?')
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
      const stateRow = this.database.prepare('SELECT * FROM journey_respondents WHERE run_id = ? AND respondent_id = ?')
        .get(claim.runId, respondentId) as DatabaseRow | undefined;
      if (!stateRow || asNumber(stateRow.revision, 'journey state revision') !== transition.expectedRevision ||
          asText(stateRow.current_turn_id, 'current turn ID') !== turnId || asText(stateRow.current_node_id, 'current node ID') !== nodeId) {
        throw new RunStoreError('journey_transition_conflict', 'Journey respondent state has moved since this turn was reserved.');
      }
      const priorEvents = parseJson<JourneyRespondentState['events']>(stateRow.events_json, 'journey history');
      const priorRoute = parseJson<JourneyRespondentState['route']>(stateRow.route_json, 'journey route');
      if (transition.state.events.length < priorEvents.length || JSON.stringify(transition.state.events.slice(0, priorEvents.length)) !== JSON.stringify(priorEvents) ||
          transition.state.route.length < priorRoute.length || JSON.stringify(transition.state.route.slice(0, priorRoute.length)) !== JSON.stringify(priorRoute)) {
        throw new RunStoreError('journey_transition_conflict', 'Journey transitions must preserve ordered prior evidence.');
      }
      const runRow = this.database.prepare('SELECT request_json FROM runs WHERE run_id = ?').get(claim.runId) as DatabaseRow | undefined;
      const storedRun = parseJson<{ request?: unknown; compilerFingerprint?: unknown }>(runRow?.request_json, 'run request');
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
            !sameDecisionValue(answerEvent.result, result)) {
          throw new RunStoreError('journey_transition_conflict', 'Journey transition must append the exact typed answer for this turn.');
        }
        const routeAddition = transition.state.route.slice(priorRoute.length);
        const expectedTarget = journeyRouteTarget(parsedRunRequest.data.journey, nodeId, result);
        if (routeAddition.length !== 1 || routeAddition[0]!.nodeId !== nodeId || routeAddition[0]!.toNodeId !== expectedTarget ||
            !sameDecisionValue(routeAddition[0]!.response, result) || transition.state.status === 'failed') {
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
        this.database.prepare("UPDATE attempts SET status = 'answered', settled_ms = ?, charged_calls = ?, result_json = ?, execution_json = ? WHERE attempt_id = ?")
          .run(nowMs, result.attempts, JSON.stringify(result), JSON.stringify({ attempts: result.attempts, provider: result.provider, model: result.model, ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}), latencyMs: result.latencyMs, usage: result.usage, ...(result.cost ? { cost: result.cost } : {}) }), attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'answered', result_json = ?, failure_code = NULL, failure_message = NULL, failure_detail_json = NULL WHERE evaluation_id = ?")
          .run(encodeStoredPayload('decision-value', decisionValueFromResult(result), decisionValueSchema), evaluationId);
        this.database.prepare('INSERT INTO evaluation_answer_attempts (run_id, evaluation_id, attempt_id) VALUES (?, ?, ?)').run(claim.runId, evaluationId, attemptId);
      } else {
        const sharedFailure = outcome.scope === 'run';
        if (transition.nextEvaluation || (sharedFailure
          ? transition.state.status !== 'active' || transition.state.currentTurnId !== turnId || transition.state.currentContextId !== asText(stateRow.current_context_id, 'current context ID') || transition.state.currentNodeId !== nodeId
          : transition.state.status !== 'failed' || transition.state.currentTurnId !== null || transition.state.currentContextId !== null || transition.state.currentNodeId !== null)) {
          throw new RunStoreError('journey_transition_conflict', 'A failed turn must preserve a resumable shared turn or stop only this respondent.');
        }
        const chargedCalls = outcome.providerAttempts ?? 1;
        this.database.prepare("UPDATE attempts SET status = 'failed', settled_ms = ?, charged_calls = ?, failure_code = ?, failure_message = ?, failure_scope = ? WHERE attempt_id = ?")
          .run(nowMs, chargedCalls, outcome.code, outcome.message, outcome.scope, attemptId);
        this.database.prepare("UPDATE evaluations SET status = 'failed', failure_code = ?, failure_message = ?, failure_detail_json = ? WHERE evaluation_id = ?")
          .run(outcome.code, outcome.message, failureEvidenceJson(outcome), evaluationId);
        const failure = { code: outcome.code, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.providerFailure ? { providerFailure: outcome.providerFailure } : {}) };
        this.database.prepare('UPDATE attempt_evaluations SET failure_json = ? WHERE attempt_id = ? AND evaluation_id = ?')
          .run(evaluationFailureJson(failure), attemptId, evaluationId);
        if (outcome.scope === 'run') {
          this.database.prepare('UPDATE runs SET failure_scope = ?, failure_code = ?, failure_message = ? WHERE run_id = ?')
            .run(outcome.scope, outcome.code, outcome.message, claim.runId);
        }
      }
      if (transition.nextEvaluation) {
        const next = transition.nextEvaluation;
        const nextPacket = decisionRequestSchema.safeParse(next.packet);
        const respondent = parsedRunRequest.data.respondents.find(({ id }) => id === respondentId);
        const current = this.database.prepare('SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM evaluations WHERE run_id = ?').get(claim.runId) as DatabaseRow;
        if (!nextPacket.success || !respondent || next.respondentId !== respondentId || !Number.isSafeInteger(next.occurrence) || next.occurrence < 1 ||
            !Number.isSafeInteger(next.ordinal) || next.ordinal !== asNumber(current.ordinal, 'evaluation ordinal') + 1 ||
            next.questionId !== nextPacket.data.question.id || !isJourneyAskNode(parsedRunRequest.data.journey, next.nodeId, next.questionId) ||
            hashCanonical(compileDecisionPacketForCompiler(parsedRunRequest.data.journey, respondent, next.questionId, transition.state.events, storedRun.compilerFingerprint)) !== hashCanonical(nextPacket.data) ||
            hashCanonical({ packet: nextPacket.data, compilerFingerprint: storedRun.compilerFingerprint }) !== next.packetFingerprint) {
          throw new RunStoreError('invalid_journey_turn', 'Next journey turn is invalid or does not follow the persisted evaluation order.');
        }
        this.database.prepare(`INSERT INTO question_groups (group_id, run_id, ordinal, context_id, respondent_id, state_json, question_ids_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(next.contextId, claim.runId, next.ordinal, next.contextId, next.respondentId, JSON.stringify(next.packet.state), JSON.stringify([next.questionId]));
        this.database.prepare(`INSERT INTO evaluations
          (evaluation_id, run_id, ordinal, context_id, respondent_id, question_id, group_id, turn_id, node_id, path_id, occurrence, packet_json, packet_fingerprint, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(next.evaluationId, claim.runId, next.ordinal, next.contextId, next.respondentId, next.questionId,
            next.contextId, next.turnId, next.nodeId, next.pathId, next.occurrence, JSON.stringify(next.packet), next.packetFingerprint);
        this.database.prepare('UPDATE runs SET evaluation_count = evaluation_count + 1 WHERE run_id = ?').run(claim.runId);
      }
      const updatedState = this.database.prepare(`UPDATE journey_respondents SET status = ?, current_node_id = ?, current_turn_id = ?, current_context_id = ?,
        revision = ?, events_json = ?, route_json = ?, outcome = ? WHERE run_id = ? AND respondent_id = ? AND revision = ?`)
        .run(transition.state.status, transition.state.currentNodeId, transition.state.currentTurnId, transition.state.currentContextId,
          transition.state.revision, JSON.stringify(transition.state.events), JSON.stringify(transition.state.route), transition.state.outcome ?? null,
          claim.runId, respondentId, transition.expectedRevision);
      if (updatedState.changes !== 1) throw new RunStoreError('journey_transition_conflict', 'Journey respondent state changed before its transition committed.');
      this.database.prepare('UPDATE runs SET used_calls = used_calls + ?, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0')
        .run(outcome.kind === 'failed' ? outcome.providerAttempts ?? 1 : outcome.result.attempts, claim.runId);
    });
  }

  finish(claim: WorkerClaim): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      const run = this.ownedRun(claim, this.now());
      if (asNumber(run.reserved_calls, 'reserved calls') !== 0) {
        throw new RunStoreError('attempt_in_flight', 'A run cannot finish while a provider attempt is still reserved.');
      }
      const atCallCeiling = asNumber(run.used_calls, 'used calls') >= asNumber(run.max_calls, 'maximum calls');
      if (atCallCeiling && asNumber(run.cancel_requested, 'cancel flag') === 0 && run.failure_scope !== 'run') {
        const hasJourney = this.database.prepare('SELECT 1 FROM journey_respondents WHERE run_id = ? LIMIT 1').get(claim.runId) as DatabaseRow | undefined;
        if (hasJourney) {
          this.database.prepare("UPDATE evaluations SET status = 'unreached' WHERE run_id = ? AND status = 'pending'").run(claim.runId);
          this.database.prepare(`UPDATE journey_respondents SET status = 'unreached', current_node_id = NULL, current_turn_id = NULL,
            current_context_id = NULL, revision = revision + 1 WHERE run_id = ? AND status = 'active'`).run(claim.runId);
        }
      }
      let status: RunStatus;
      if (run.failure_scope === 'run') status = 'failed';
      else if (asNumber(run.cancel_requested, 'cancel flag') === 1) status = 'cancelled';
      else {
        const counts = this.database.prepare(`SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'unreached' THEN 1 ELSE 0 END) AS unreached
          FROM evaluations WHERE run_id = ?`).get(claim.runId) as DatabaseRow;
        status = asNumber(counts.pending, 'pending count') === 0 && asNumber(counts.failed, 'failed count') === 0 && asNumber(counts.unreached, 'unreached count') === 0 ? 'completed' : 'partial';
      }
      this.database.prepare('UPDATE runs SET status = ?, owner_token = NULL, owner_pid = NULL, lease_expires_ms = NULL WHERE run_id = ?')
        .run(status, claim.runId);
      return this.statusInside(claim.runId);
    });
  }

  failLaunch(runId: string, code: string): void {
    this.ensureOpen();
    this.transaction(() => {
      const updated = this.database.prepare("UPDATE runs SET status = 'failed', failure_scope = 'run', failure_code = ?, failure_message = 'Worker could not be launched' WHERE run_id = ? AND status = 'prepared'")
        .run(code, runId);
      if (updated.changes === 0) this.statusInside(runId);
    });
  }

  failRun(claim: WorkerClaim, code: string, message: string): void {
    this.ensureOpen();
    this.transaction(() => {
      this.ownedRun(claim, this.now());
      const reserved = this.database.prepare("SELECT attempt_id FROM attempts WHERE run_id = ? AND owner_token = ? AND status = 'reserved'").get(claim.runId, claim.ownerToken) as DatabaseRow | undefined;
      if (reserved) {
        this.database.prepare("UPDATE attempts SET status = 'uncertain', settled_ms = ?, charged_calls = 1, failure_code = 'worker_interrupted', failure_message = 'The provider outcome could not be confirmed' WHERE attempt_id = ?")
          .run(this.now(), asText(reserved.attempt_id, 'attempt ID'));
        this.database.prepare('UPDATE runs SET used_calls = used_calls + 1, reserved_calls = reserved_calls - 1 WHERE run_id = ? AND reserved_calls > 0').run(claim.runId);
      }
      this.database.prepare("UPDATE runs SET status = 'failed', failure_scope = 'run', failure_code = ?, failure_message = ?, owner_token = NULL, owner_pid = NULL, lease_expires_ms = NULL WHERE run_id = ? AND owner_token = ?")
        .run(code, message, claim.runId, claim.ownerToken);
    });
  }

  reconcile(runId: string, nowMs: number): RunStatusView {
    this.ensureOpen();
    return this.transaction(() => {
      this.reconcileInside(runId, nowMs);
      return this.statusInside(runId);
    });
  }

  close(): void {
    if (this.isClosed) return;
    this.connection.close();
    this.isClosed = true;
  }

  private ensureOpen(): void {
    if (this.isClosed) throw new RunStoreError('store_closed', 'This run store connection is closed.');
    const version = (this.database.prepare('PRAGMA user_version').get() as DatabaseRow).user_version;
    if (asNumber(version, 'schema version') !== SCHEMA_VERSION) {
      throw new RunStoreError('datastore_schema_changed', 'The datastore schema changed while this process was open. Close and reopen Sheg before continuing.');
    }
  }

  reconcileMany(runIds: string[], nowMs: number): void {
    this.ensureOpen();
    const uniqueRunIds = [...new Set(runIds)];
    this.transaction(() => {
      for (const runId of uniqueRunIds) this.reconcileInside(runId, nowMs);
    });
  }

  reconcileActive(nowMs: number): void {
    this.ensureOpen();
    this.transaction(() => {
      const active = this.database.prepare("SELECT run_id FROM runs WHERE status IN ('prepared', 'running')").all() as DatabaseRow[];
      for (const row of active) this.reconcileInside(asText(row.run_id, 'run ID'), nowMs);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* The original operation error carries the useful detail. */ }
      throw error;
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* Preserve the useful resolver error. */ }
      throw error;
    }
  }

  private notFound(): RunStoreError { return new RunStoreError('run_not_found', 'The requested run does not exist in this datastore.'); }

  private statusInside(runId: string): RunStatusView {
    const result = this.statusesInside([runId])[0];
    if (!result) throw this.notFound();
    return result;
  }

  private statusesInside(runIds: string[]): RunStatusView[] {
    if (runIds.length === 0) return [];
    const rows = this.database.prepare(`SELECT r.*,
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'answered') AS completed_evaluations,
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'failed') AS failed_evaluations,
      (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'pending') AS pending_evaluations,
      EXISTS (SELECT 1 FROM attempts a JOIN attempt_evaluations ae USING (attempt_id)
        JOIN evaluations e ON e.run_id = a.run_id AND e.evaluation_id = ae.evaluation_id
        WHERE a.run_id = r.run_id AND a.status = 'failed' AND a.failure_scope = 'run' AND e.status = 'failed'
          AND a.attempt_sequence = (SELECT MAX(latest.attempt_sequence) FROM attempts latest WHERE latest.run_id = r.run_id AND latest.status = 'failed' AND latest.failure_scope = 'run')) AS retryable_shared_failure,
      (EXISTS (SELECT 1 FROM evaluations e JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
          WHERE e.run_id = r.run_id AND e.status = 'failed' AND jr.status = 'failed') AND
       NOT EXISTS (SELECT 1 FROM evaluations e LEFT JOIN journey_respondents jr ON jr.run_id = e.run_id AND jr.respondent_id = e.respondent_id
          WHERE e.run_id = r.run_id AND e.status = 'failed' AND (jr.respondent_id IS NULL OR jr.status <> 'failed' OR
            e.turn_id IS NULL OR length(trim(e.turn_id)) = 0 OR e.node_id IS NULL OR length(trim(e.node_id)) = 0 OR
            e.path_id IS NULL OR length(trim(e.path_id)) = 0 OR e.occurrence IS NULL OR e.occurrence < 1 OR
            length(trim(e.packet_json)) = 0 OR length(trim(e.packet_fingerprint)) = 0)) AND
       NOT EXISTS (SELECT e.respondent_id FROM evaluations e WHERE e.run_id = r.run_id AND e.status = 'failed'
          GROUP BY e.respondent_id HAVING COUNT(*) <> 1) AND
       NOT EXISTS (SELECT 1 FROM journey_respondents jr WHERE jr.run_id = r.run_id AND jr.status = 'failed' AND
          (SELECT COUNT(*) FROM evaluations e WHERE e.run_id = jr.run_id AND e.respondent_id = jr.respondent_id AND e.status = 'failed') <> 1)) AS retryable_journey_failure
      FROM runs r WHERE r.run_id IN (${runIds.map(() => '?').join(', ')}) ORDER BY r.created_ms, r.run_id`).all(...runIds) as DatabaseRow[];
    return rows.map((row) => {
      const stored = parseJson<{ request?: unknown }>(row.request_json, 'run request');
      const request = runRequestSchema.safeParse(stored.request);
      if (!request.success) throw new RunStoreError('data_integrity_error', 'Stored run request is invalid.');
      const status = asText(row.status, 'run status') as RunStatus;
      const usedCalls = asNumber(row.used_calls, 'used calls');
      const reservedCalls = asNumber(row.reserved_calls, 'reserved calls');
      const maxCalls = asNumber(row.max_calls, 'maximum calls');
      return {
      runId: asText(row.run_id, 'run ID'),
      status,
      createdAt: asText(row.created_at, 'created time'),
      completedEvaluations: asNumber(row.completed_evaluations, 'completed evaluation count'),
      failedEvaluations: asNumber(row.failed_evaluations, 'failed evaluation count'),
      totalEvaluations: asNumber(row.evaluation_count, 'evaluation count'),
      usedCalls,
      reservedCalls,
      maxCalls,
      cancelRequested: asNumber(row.cancel_requested, 'cancel flag') === 1,
      lifecycle: deriveRunLifecycle({ status, kind: request.data.kind, cancelRequested: asNumber(row.cancel_requested, 'cancel flag') === 1,
        ...(row.failure_scope === null ? {} : { failureScope: asText(row.failure_scope, 'failure scope') as 'evaluation' | 'run' }),
        usedCalls, reservedCalls, maxCalls,
        hasPendingEvaluations: asNumber(row.pending_evaluations, 'pending evaluation count') > 0,
        hasFailedEvaluations: asNumber(row.failed_evaluations, 'failed evaluation count') > 0,
        canRetrySharedFailure: asNumber(row.retryable_shared_failure, 'retryable shared failure') === 1,
        hasRetryableJourneyFailure: asNumber(row.retryable_journey_failure, 'retryable journey failure') === 1 }),
      ...(row.failure_code === null ? {} : { failure: { code: asText(row.failure_code, 'failure code'), message: asText(row.failure_message, 'failure message') } }),
      };
    });
  }

  private evaluationFromRow(row: DatabaseRow): FrozenEvaluation {
    return {
      evaluationId: asText(row.evaluation_id, 'evaluation ID'),
      contextId: asText(row.context_id, 'context ID'),
      respondentId: asText(row.respondent_id, 'respondent ID'),
      questionId: asText(row.question_id, 'question ID'),
      packet: decisionRequestSchema.parse(parseJson(row.packet_json, 'frozen packet')),
      packetFingerprint: asText(row.packet_fingerprint, 'packet fingerprint'),
    };
  }

  private ownedRun(claim: WorkerClaim, nowMs: number): DatabaseRow {
    const run = this.database.prepare("SELECT * FROM runs WHERE run_id = ? AND status = 'running' AND owner_token = ? AND lease_expires_ms > ?")
      .get(claim.runId, claim.ownerToken, nowMs) as DatabaseRow | undefined;
    if (!run) throw new RunStoreError('worker_ownership_lost', 'This worker no longer owns the run.');
    return run;
  }

  private reconcileInside(runId: string, nowMs: number): void {
    const run = this.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as DatabaseRow | undefined;
    if (!run) throw this.notFound();
    const status = asText(run.status, 'run status');
    const launchDeadline = run.lease_expires_ms === null ? asNumber(run.created_ms, 'created time') + LEASE_MS : asNumber(run.lease_expires_ms, 'launch deadline');
    if (status === 'prepared' && nowMs >= launchDeadline) {
      this.database.prepare("UPDATE runs SET status = 'interrupted', failure_scope = 'run', failure_code = 'worker_not_claimed', failure_message = 'No worker claimed the accepted run before its launch window expired' WHERE run_id = ? AND status = 'prepared'").run(runId);
    } else if (status === 'running' && run.lease_expires_ms !== null && asNumber(run.lease_expires_ms, 'worker lease') <= nowMs) {
      const attempts = this.database.prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND status = 'reserved'").get(runId) as DatabaseRow;
      const uncertain = asNumber(attempts.count, 'uncertain attempt count');
      if (uncertain !== asNumber(run.reserved_calls, 'reserved calls')) {
        throw new RunStoreError('data_integrity_error', 'Reserved call counters do not match reserved attempts.');
      }
      this.database.prepare("UPDATE attempts SET status = 'uncertain', settled_ms = ?, charged_calls = 1, failure_code = 'worker_interrupted', failure_message = 'Provider completion is unknown' WHERE run_id = ? AND status = 'reserved'").run(nowMs, runId);
      this.database.prepare(`UPDATE runs SET status = 'interrupted', used_calls = used_calls + ?,
        reserved_calls = reserved_calls - ?, owner_token = NULL, owner_pid = NULL, lease_expires_ms = NULL,
        failure_scope = 'run', failure_code = 'worker_interrupted', failure_message = 'Worker ownership expired; unfinished work requires explicit resume'
        WHERE run_id = ? AND status = 'running' AND lease_expires_ms <= ? AND reserved_calls >= ?`)
        .run(uncertain, uncertain, runId, nowMs, uncertain);
    }
  }
}

export function resetRunStore(dataRoot: string): ReturnType<typeof import('./sqlite/recovery.js').resetRunStore> {
  return resetRunStoreInternal(dataRoot, () => {
    const store = openRunStore(dataRoot);
    store.close();
  });
}
