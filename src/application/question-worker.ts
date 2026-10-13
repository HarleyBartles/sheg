import { setInterval, clearInterval } from 'node:timers';
import { randomUUID } from 'node:crypto';
import type { RunCommandRepository, RunPersistence, RunReadRepository } from './run-store.js';
import { hashCanonical } from '../infrastructure/identity.js';
import { advanceJourney, normalizeResponse } from '../domain/journey/run.js';
import { providerSelectionInitialChoiceSchema, type JourneyRespondentState } from '../domain/run/lifecycle.js';
import { ProviderCallError } from '../domain/decision/provider-failure.js';
import type { EvaluationFailure } from '../domain/run/lifecycle.js';
import type { ProviderFactory } from './run-service.js';
import type { ProviderFactoryOptions } from '../providers/config.js';
import { decisionValueFromResult } from '../domain/decision/decision.js';
import type { DecisionBatchRequest, DecisionBatchResult } from '../domain/decision/decision.js';
import { requireExplicitProvider } from '../domain/run/request.js';
import { assessProviderBatchPlan } from './provider-batch-planning.js';
import { selectProvider } from './provider-selection.js';
import { providerModelIdentity } from '../providers/config.js';
import type { ProviderConfigInput } from '../providers/config.js';

const HEARTBEAT_MS = 2_000;
class NoEligibleJourneyProviderError extends Error {}
export async function executeQuestionRun(persistence: RunPersistence, runId: string, providerFactory: ProviderFactory, providerOptions: ProviderFactoryOptions = {}, assertProviderReady?: (config: ProviderConfigInput) => Promise<void>): Promise<void> {
  const { reads, commands } = persistence;
  const claim = commands.claim(runId, Date.now(), process.pid);
  if (!claim) return;
  const heartbeat = setInterval(() => {
    try {
      if (!commands.heartbeat(claim, Date.now())) clearInterval(heartbeat);
    } catch { clearInterval(heartbeat); }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    if (reads.getRequestKind(runId) === 'journey') {
      await executeJourney(reads, commands, runId, claim, providerFactory, providerOptions, assertProviderReady);
    } else {
      await executePoll(reads, commands, runId, claim, providerFactory, providerOptions);
    }
    commands.finish(claim);
  } catch {
    try { commands.failRun(claim, 'worker_failed', 'The run worker stopped unexpectedly.'); } catch { /* Expired ownership is reconciled by a later read. */ }
  } finally {
    clearInterval(heartbeat);
  }
}

async function executePoll(reads: RunReadRepository, commands: RunCommandRepository, runId: string, claim: import('../domain/run/lifecycle.js').WorkerClaim, providerFactory: ProviderFactory, providerOptions: ProviderFactoryOptions): Promise<void> {
  const prepared = reads.getRequest(runId);
  const explicitProvider = prepared.request.provider ? requireExplicitProvider(prepared.request) : undefined;
  const answers = new Map(reads.evaluationStatuses(runId).map((answer) => [answer.evaluationId, answer.status]));
  for (const group of prepared.groups ?? []) {
    const evaluations = prepared.evaluations.filter((evaluation) => evaluation.groupId === group.groupId);
    const initialChoice = evaluations[0]?.providerSelection ?? prepared.providerSelectionSnapshot?.initialChoices?.find((choice) => choice.respondentId === group.respondentId && choice.questionId === evaluations[0]?.questionId);
    const configured = explicitProvider ?? prepared.providerSelectionSnapshot?.catalogue.entries.find(({ id }) => id === initialChoice?.providerId)?.provider;
    if (!configured) throw new Error('The accepted question group has no frozen provider choice.');
    if (evaluations.some((evaluation) => evaluation.providerSelection && evaluation.providerSelection.providerId !== initialChoice?.providerId)) throw new Error('A question group contains incompatible frozen provider choices.');
    const provider = providerFactory(configured, providerOptions);
    const providerKind = configured.kind;
    const modelIdentity = providerKind === 'jev' || providerKind === 'clef' ? configured.model : configured.checkpoint;
    while (true) {
      if (!commands.heartbeat(claim, Date.now())) return;
      const pending = evaluations.filter((evaluation) => answers.get(evaluation.evaluationId) === 'pending');
      if (!pending.length) break;
      const pendingPackets = pending.map(({ packet }) => packet);
      const singletonExecution = prepared.request.providerSelection?.batching === 'singleton' || !provider.decideBatch || !provider.measureBatch;
      const plan = await assessProviderBatchPlan({
        group: { groupId: group.groupId, contextId: group.contextId, respondentId: group.respondentId, state: group.state,
          questions: pendingPackets.map(({ question }) => question), packets: pendingPackets },
        provider, providerKind, modelIdentity, batching: singletonExecution ? 'singleton' : 'automatic',
      });
      if (!plan.batches.length) throw new Error('The provider could not confirm a fitting batch plan for the remaining questions.');
      const selectedIds = new Set(plan.questionIdsByBatch[0]);
      const batchEvaluations = pending.filter(({ questionId }) => selectedIds.has(questionId));
      const reservation = commands.reserveBatch(claim, group.groupId, batchEvaluations.map(({ evaluationId }) => evaluationId), Date.now());
      if (!reservation) break;
      const batchQuestions = reservation.evaluations.map(({ packet }) => packet.question);
      const batchMaterials = batchVisualMaterials(reservation.evaluations.map(({ packet }) => packet.visualMaterials ?? []));
      const batch: DecisionBatchRequest = { state: group.state, questions: batchQuestions, ...(batchMaterials.length ? { visualMaterials: batchMaterials } : {}) };
      let settled: Array<{ evaluationId: string; status: import('../domain/run/lifecycle.js').AnswerRow['status'] }>;
      try {
        let result: DecisionBatchResult;
        if (provider.decideBatch && prepared.request.providerSelection?.batching !== 'singleton') result = await provider.decideBatch(batch, 1);
        else {
          const single = await provider.decide(reservation.evaluations[0]!.packet, 1);
          result = { answers: [{ questionId: reservation.evaluations[0]!.questionId, value: decisionValueFromResult(single) }], execution: {
            attempts: single.attempts, provider: single.provider, model: single.model,
            ...(single.checkpoint ? { checkpoint: single.checkpoint } : {}), latencyMs: single.latencyMs, usage: single.usage,
            ...(single.cost ? { cost: single.cost } : {}),
          } };
        }
        settled = commands.settleBatch(claim, reservation.attemptId, { kind: 'answered', result });
      } catch (error) {
        const scope = failureScope(error);
        settled = commands.settleBatch(claim, reservation.attemptId, { kind: 'failed', ...failureDetails(error, scope), scope });
        if (scope === 'run') return;
      }
      for (const evaluation of settled) answers.set(evaluation.evaluationId, evaluation.status);
    }
  }
}

async function executeJourney(reads: RunReadRepository, commands: RunCommandRepository, runId: string, claim: import('../domain/run/lifecycle.js').WorkerClaim, providerFactory: ProviderFactory, providerOptions: ProviderFactoryOptions, assertProviderReady?: (config: ProviderConfigInput) => Promise<void>): Promise<void> {
  const accepted = reads.getJourneyRun(runId);
  const explicitProvider = accepted.request.provider ? requireExplicitProvider(accepted.request) : undefined;
  while (true) {
    if (!commands.heartbeat(claim, Date.now())) return;
    const waitingForks = new Map(accepted.respondents.filter((state) => state.status === 'waiting-fork' && state.currentNodeId !== null)
      .map((state) => [JSON.stringify([state.branchId, state.currentNodeId]), { forkNodeId: state.currentNodeId!, parentBranchId: state.branchId }]));
    for (const fork of waitingForks.values()) {
      const advanced = commands.advanceJourneyFork(claim, fork.forkNodeId, fork.parentBranchId);
      if (advanced.status === 'closed' && advanced.createdEvaluations.length > 0) {
        accepted.evaluations.push(...advanced.createdEvaluations);
        accepted.respondents = accepted.respondents.filter((state) => !(state.status === 'waiting-fork' && state.branchId === fork.parentBranchId && state.currentNodeId === fork.forkNodeId));
        accepted.respondents.push(...advanced.parentRespondents, ...advanced.childRespondents);
      }
    }
    const pending = accepted.evaluations.find((evaluation) => evaluation.status === 'pending');
    if (!pending) break;
    const existingChoice = pending.providerSelection ?? accepted.providerSelectionSnapshot?.initialChoices?.find((choice) => choice.respondentId === pending.respondentId && choice.questionId === pending.questionId && (choice.branchId ?? 'root') === pending.branchId);
    let choice;
    try { choice = explicitProvider ? undefined : existingChoice ?? await resolveJourneyProvider(reads, runId, accepted, pending, providerFactory, providerOptions, assertProviderReady); }
    catch (error) {
      if (!(error instanceof NoEligibleJourneyProviderError)) throw error;
      commands.failPendingJourneyEvaluation(claim, pending.evaluationId, pending.packetFingerprint,
        { code: 'provider_selection_unavailable', message: 'No enabled provider fits the reached journey unit and its declared comparison constraints.' }, Date.now());
      pending.status = 'failed';
      pending.failure = { code: 'provider_selection_unavailable', message: 'No enabled provider fits the reached journey unit and its declared comparison constraints.' };
      accepted.respondents = accepted.respondents.map((state) => state.respondentId === pending.respondentId && state.branchId === pending.branchId ? {
        ...state, status: 'failed', currentNodeId: null, currentTurnId: null, currentContextId: null, revision: state.revision + 1,
      } : state);
      continue;
    }
    const reservation = commands.reserveNext(claim, Date.now(), choice ? { evaluationId: pending.evaluationId, packetFingerprint: pending.packetFingerprint, providerSelection: choice } : undefined);
    if (!reservation) break;
    if (choice) pending.providerSelection = choice;
    const currentTurn = reads.getJourneyWorkerTurn(runId, reservation.evaluation.evaluationId, reservation.evaluation.respondentId, reservation.evaluation.branchId ?? 'root');
    const { evaluation: currentEvaluation, respondent: respondentState, profile } = currentTurn;
    const providerConfig = explicitProvider ?? accepted.providerSelectionSnapshot?.catalogue.entries.find(({ id }) => id === reservation.evaluation.providerSelection?.providerId)?.provider;
    if (!providerConfig) throw new Error('The frozen provider choice is absent from the accepted catalogue.');
    const provider = providerFactory(providerConfig, providerOptions);
    try {
      const result = await provider.decide(reservation.evaluation.packet, 1);
      const value = normalizeResponse(result, reservation.evaluation.packet.question.type);
      const progress = advanceJourney(accepted.request.journey, profile, {
        branchId: respondentState.branchId, currentNodeId: currentEvaluation.nodeId, events: respondentState.events, route: respondentState.route,
      }, value, accepted.compilerFingerprint, currentEvaluation.packet.question.visual ? {
        provider: result.provider, model: result.model, visualMaterials: currentEvaluation.packet.visualMaterials ?? [],
      } : undefined);
      const nextEvaluation = progress.next ? {
        evaluationId: randomUUID(), turnId: randomUUID(), contextId: randomUUID(),
        respondentId: respondentState.respondentId, branchId: respondentState.branchId, questionId: progress.next.taskId, nodeId: progress.next.nodeId,
        pathId: progress.next.pathId,
        occurrence: progress.events.filter((event) => event.type === 'response' && event.taskId === progress.next!.taskId).length + 1,
        ordinal: currentTurn.nextOrdinal, packet: progress.next.packet,
        packetFingerprint: hashCanonical({ packet: progress.next.packet, compilerFingerprint: accepted.compilerFingerprint }),
      } : undefined;
      const state: JourneyRespondentState = {
        ...respondentState,
        status: progress.status,
        currentNodeId: nextEvaluation?.nodeId ?? progress.forkNodeId ?? null,
        currentTurnId: nextEvaluation?.turnId ?? null,
        currentContextId: nextEvaluation?.contextId ?? (progress.status === 'waiting-fork' ? currentEvaluation.contextId : null),
        revision: respondentState.revision + 1,
        events: progress.events,
        route: progress.route,
        ...(progress.outcome === null ? {} : { outcome: progress.outcome }),
      };
      commands.settleJourney(claim, reservation.attemptId, { kind: 'answered', result }, {
        respondentId: respondentState.respondentId, expectedRevision: respondentState.revision, state, ...(nextEvaluation ? { nextEvaluation } : {}),
      });
      const settled = accepted.evaluations.find(({ evaluationId }) => evaluationId === currentEvaluation.evaluationId);
      if (!settled) throw new Error('The settled journey turn is absent from the worker snapshot.');
      settled.status = 'answered';
      settled.result = result;
      if (nextEvaluation) accepted.evaluations.push({ ...nextEvaluation, status: 'pending' });
      accepted.respondents = accepted.respondents.map((existingState) => existingState.respondentId === respondentState.respondentId && existingState.branchId === respondentState.branchId ? state : existingState);
    } catch (error) {
      const scope = failureScope(error);
      const state: JourneyRespondentState = {
        ...respondentState,
        status: scope === 'run' ? 'active' : 'failed',
        currentNodeId: scope === 'run' ? currentEvaluation.nodeId : null,
        currentTurnId: scope === 'run' ? currentEvaluation.turnId : null,
        currentContextId: scope === 'run' ? currentEvaluation.contextId : null,
        revision: respondentState.revision + 1,
      };
      commands.settleJourney(claim, reservation.attemptId, { kind: 'failed', ...failureDetails(error, scope), scope }, {
        respondentId: respondentState.respondentId, expectedRevision: respondentState.revision, state,
      });
      const settled = accepted.evaluations.find(({ evaluationId }) => evaluationId === currentEvaluation.evaluationId);
      if (!settled) throw new Error('The failed journey turn is absent from the worker snapshot.', { cause: error });
      settled.status = 'failed';
      settled.failure = { code: failureDetails(error, scope).code, message: failureDetails(error, scope).message };
      accepted.respondents = accepted.respondents.map((existingState) => existingState.respondentId === respondentState.respondentId && existingState.branchId === respondentState.branchId ? state : existingState);
      if (scope === 'run') break;
    }
  }
}

async function resolveJourneyProvider(reads: RunReadRepository, runId: string, run: import('../domain/run/lifecycle.js').JourneyRunRecord, evaluation: import('../domain/run/lifecycle.js').JourneyEvaluationRecord,
  providerFactory: ProviderFactory, providerOptions: ProviderFactoryOptions, assertProviderReady?: (config: ProviderConfigInput) => Promise<void>) {
  const snapshot = run.providerSelectionSnapshot;
  if (!snapshot) throw new Error('The automatic provider catalogue was not frozen with the accepted run.');
  const status = reads.getStatus(runId);
  const remainingCalls = Math.max(0, status.maxCalls - status.usedCalls - status.reservedCalls);
  const lock = run.request.providerSelection?.comparisonLocks?.find(({ members }) => members.some(({ respondentId, questionId, branchId }) => respondentId === evaluation.respondentId && questionId === evaluation.questionId && (branchId ?? 'root') === evaluation.branchId));
  const prior = lock ? run.evaluations.filter((item) => item.providerSelection?.comparisonLockId === lock.id).map((item) => item.providerSelection!) : [];
  const lockedProvider = lock?.equality.provider === 'same' ? prior[0]?.providerId : undefined;
  const lockedModel = lock?.equality.model === 'same' ? prior[0]?.modelIdentity : undefined;
  const unitId = `${evaluation.respondentId}/${evaluation.questionId}/${evaluation.branchId}`;
  const pins = [...new Set([run.request.providerSelection?.unitOverrides?.[unitId], run.request.providerSelection?.unitOverrides?.[`${evaluation.respondentId}/${evaluation.questionId}`], run.request.providerSelection?.unitOverrides?.[evaluation.questionId]].filter((id): id is string => id !== undefined))];
  if (pins.length > 1 || (lockedProvider && pins[0] && lockedProvider !== pins[0])) throw new NoEligibleJourneyProviderError('The reached unit has conflicting binding provider constraints.');
  const candidates = await Promise.all(snapshot.catalogue.entries.map(async (entry) => {
    if (!entry.enabled) return { id: entry.id, ready: false, plannedCalls: 1 };
    if (lockedProvider && entry.id !== lockedProvider) return { id: entry.id, ready: false, plannedCalls: 1 };
    if (lockedModel && providerModelIdentity(entry.provider) !== lockedModel) return { id: entry.id, ready: false, plannedCalls: 1 };
    try {
      await assertProviderReady?.(entry.provider);
      const provider = providerFactory(entry.provider, providerOptions);
      const fit = provider.measure ? await provider.measure(evaluation.packet) : undefined;
      return { id: entry.id, ready: true, plannedCalls: 1, ...(fit ? { fit } : {}) };
    } catch { return { id: entry.id, ready: false, plannedCalls: 1 }; }
  }));
  const requiredCapabilities = [...new Set(['text', ...(run.request.providerSelection?.requiredCapabilities ?? []),
    ...((evaluation.packet.visualMaterials?.length ?? 0) > 0 ? ['pixels'] : [])])];
  const selected = selectProvider({ catalogue: { revision: snapshot.catalogueRevision, entries: snapshot.catalogue.entries }, preferences: snapshot.preferences,
    unitId, requiredCapabilities, questionType: evaluation.packet.question.type,
    candidates, remainingCalls, ...(run.request.providerSelection?.preferredOrder === undefined ? {} : { preferredOrder: run.request.providerSelection.preferredOrder }),
    ...((lockedProvider ?? pins[0]) ? { unitOverride: lockedProvider ?? pins[0] } : {}) });
  if (!selected.selected) throw new NoEligibleJourneyProviderError('No eligible provider fits the reached journey unit.');
  return providerSelectionInitialChoiceSchema.parse({ respondentId: evaluation.respondentId, questionId: evaluation.questionId, branchId: evaluation.branchId,
    ...(lock ? { comparisonLockId: lock.id } : {}), providerId: selected.selected.id,
    modelIdentity: providerModelIdentity(selected.selected.provider!), decisionReason: selected.decisionReason,
    candidates: selected.candidates.map(({ id, eligible, selected: isSelected, fit, cost, exclusion, preferenceRank }) => ({ id, eligible, selected: isSelected,
      ...(fit ? { fit } : {}), ...(cost ? { cost } : {}), ...(exclusion ? { exclusion } : {}), ...(preferenceRank ? { preferenceRank } : {}) })) });
}

function batchVisualMaterials(groups: readonly (readonly NonNullable<DecisionBatchRequest['visualMaterials']>[number][])[]): NonNullable<DecisionBatchRequest['visualMaterials']> {
  const byId = new Map<string, NonNullable<DecisionBatchRequest['visualMaterials']>[number]>();
  for (const group of groups) for (const material of group) {
    const previous = byId.get(material.id);
    if (previous && hashCanonical(previous) !== hashCanonical(material)) throw new Error('Frozen visual material changed within the accepted batch.');
    byId.set(material.id, material);
  }
  return [...byId.values()];
}

function failureScope(error: unknown): 'evaluation' | 'run' {
  return error instanceof ProviderCallError ? error.failureScope : 'evaluation';
}

function failureDetails(error: unknown, scope: 'evaluation' | 'run'): EvaluationFailure & { providerAttempts?: number } {
  if (!(error instanceof ProviderCallError)) return { code: scope === 'run' ? 'provider_unavailable' : 'decision_failed', message: 'The respondent evaluation did not produce a valid answer.' };
  const evidence = { providerAttempts: error.attempts, providerFailure: error.evidence };
  if (error.validationFailure) return { ...error.validationFailure, ...evidence };
  if (error.contextFit) return { code: error.contextFit.status === 'overflow' ? 'provider_context_overflow' : 'provider_context_unavailable', message: error.contextFit.status === 'overflow' ? 'The decision packet exceeds the provider context allowance.' : 'Provider context fit could not be verified.', ...evidence };
  const code = scope === 'run' ? error.failureCode : `provider_${error.evidence.category}_failed`;
  return { code, message: scope === 'run' ? 'Provider authentication or service access failed.' : 'The provider could not complete this evaluation.', ...evidence };
}
